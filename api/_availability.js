// Pure slot computation: weekly template + live busy intervals + "now" in,
// bookable slots out. No I/O, no clock reads -- nowMs is always passed in, which
// is what makes every rule here testable.
//
// Slots are computed per request and never stored. The only persistent state is
// the template itself.
const tz = require('./_timezone');

const ALLOWED_SLOT_MINUTES = [15, 20, 30, 45, 60, 90, 120];

const DEFAULT_DAY = { enabled: false, start: '09:00', end: '17:00' };

const DEFAULT_TEMPLATE = {
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '17:00' },
    tue: { enabled: true, start: '09:00', end: '17:00' },
    wed: { enabled: true, start: '09:00', end: '17:00' },
    thu: { enabled: true, start: '09:00', end: '17:00' },
    fri: { enabled: true, start: '09:00', end: '17:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 30,
  bufferMinutes: 15,
  // 24, not 12, and the reason was originally reminder delivery rather than
  // scheduling taste. The reminder cron can only run ONCE A DAY (Vercel Hobby
  // caps cron frequency), so a booking is reminded BY THE CRON only if some
  // daily tick falls inside [max(bookedAt, start - REMINDER_LEAD_HOURS), start].
  // That interval is min(noticeHours, leadHours) long, so a daily tick is
  // guaranteed to land in it only when min(noticeHours, leadHours) >= 24. At 12
  // the interval could be 12h long and miss every tick entirely -- a booking
  // that silently got no reminder at all.
  //
  // That hole is now CLOSED independently of this number. A booking made with
  // less notice than the cron can be relied on for gets its reminder sent at
  // booking time instead: api/calendar-book.js, api/calendar-reschedule.js and
  // both check-in handlers call needsImmediateReminder() from
  // api/calendar-reminders.js and, when it is true, send the reminder themselves
  // and set reminderSent so the cron skips the event rather than double-sending.
  // So LOWERING this to allow same-day booking is safe -- which is exactly what
  // the clamp below has always permitted, and what used to be a silent trap.
  //
  // 24 stays the shipped default because it is also a scheduling choice (a day's
  // warning before a call), and because at 24 every booking takes the plain cron
  // path with no immediate send at all. See
  // test/reminder-delivery-guarantee.test.js, which proves delivery for ANY
  // admin-settable value -- including 1 -- against the live cron schedule in
  // vercel.json, and pins that the default still needs no immediate sends.
  minNoticeHours: 24,
};

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

// Accepts whatever is in the blob (possibly hand-edited, possibly an older
// shape) and returns something every downstream function can rely on.
function normalizeTemplate(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const days = {};
  for (const key of tz.WEEKDAY_KEYS) {
    const d = (src.days && typeof src.days === 'object' && src.days[key]) || {};
    const start = tz.parseHm(d.start) ? d.start : DEFAULT_TEMPLATE.days[key].start;
    const end = tz.parseHm(d.end) ? d.end : DEFAULT_TEMPLATE.days[key].end;
    days[key] = {
      // Absence or non-true value means DISABLED, deliberately. Availability fails closed,
      // because opening hours nobody configured would produce real unwanted bookings, whereas
      // showing no times is visible and recoverable from the admin page. The legitimate
      // first-run path is covered by loadTemplate() substituting the whole DEFAULT_TEMPLATE,
      // and validateTemplate is the strict gate on the admin save path.
      enabled: d.enabled === true,
      start: start.length === 4 ? `0${start}` : start, // '9:00' -> '09:00'
      end: end.length === 4 ? `0${end}` : end,
    };
  }
  const slotMinutes = ALLOWED_SLOT_MINUTES.includes(Number(src.slotMinutes))
    ? Number(src.slotMinutes) : DEFAULT_TEMPLATE.slotMinutes;
  return {
    timezone: tz.isValidTimeZone(src.timezone) ? src.timezone : DEFAULT_TEMPLATE.timezone,
    days,
    slotMinutes,
    bufferMinutes: clamp(src.bufferMinutes, 0, 240, DEFAULT_TEMPLATE.bufferMinutes),
    minNoticeHours: clamp(src.minNoticeHours, 0, 720, DEFAULT_TEMPLATE.minNoticeHours),
  };
}

// Used by the admin POST to reject a bad save with a readable message, rather
// than silently normalizing Omar's hours into something he did not ask for.
function validateTemplate(raw) {
  const errors = [];
  const src = (raw && typeof raw === 'object') ? raw : {};
  if (!tz.isValidTimeZone(src.timezone)) errors.push('timezone is not a valid IANA zone name');
  if (!ALLOWED_SLOT_MINUTES.includes(Number(src.slotMinutes))) {
    errors.push(`slotMinutes must be one of ${ALLOWED_SLOT_MINUTES.join(', ')}`);
  }
  for (const key of tz.WEEKDAY_KEYS) {
    const d = (src.days && src.days[key]) || null;
    if (!d) { errors.push(`${key} is missing`); continue; }
    const s = tz.parseHm(d.start), e = tz.parseHm(d.end);
    if (!s) { errors.push(`${key} start time is not HH:MM`); continue; }
    if (!e) { errors.push(`${key} end time is not HH:MM`); continue; }
    if (d.enabled && (e.h * 60 + e.mi) <= (s.h * 60 + s.mi)) {
      errors.push(`${key} end time must be after its start time`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// R1: bufferMinutes pads each busy interval instead of widening the slot grid.
// This is the standard "buffer around my events" semantic, and because a new
// booking becomes a busy interval it also gives back-to-back protection free.
function overlapsBusy(startMs, endMs, busy, bufferMs) {
  for (const b of busy) {
    if (startMs < b.end + bufferMs && endMs > b.start - bufferMs) return true;
  }
  return false;
}

function computeSlotsForDay({ template, ymd, busy = [], nowMs }) {
  const tpl = normalizeTemplate(template);
  const day = tpl.days[tz.weekdayKeyFromYmd(ymd.y, ymd.mo, ymd.d)];
  if (!day || !day.enabled) return [];

  const start = tz.parseHm(day.start), end = tz.parseHm(day.end);
  if (!start || !end) return [];

  const slotMs = tpl.slotMinutes * 60 * 1000;
  const bufferMs = tpl.bufferMinutes * 60 * 1000;
  // A caller that forgets nowMs must not silently lose the minimum-notice rule:
  // NaN comparisons are always false, which would make every slot bookable.
  // An explicitly passed nowMs (including 0) still wins, keeping tests pure.
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const earliest = now + tpl.minNoticeHours * 60 * 60 * 1000;

  // The window's edges are wall times in the template's zone, so they move with
  // DST rather than being a fixed number of ms from midnight.
  const windowEnd = tz.zonedWallTimeToUtc(ymd.y, ymd.mo, ymd.d, end.h, end.mi, tpl.timezone);

  const slots = [];
  const startMinutes = start.h * 60 + start.mi;
  const endMinutes = end.h * 60 + end.mi;
  for (let m = startMinutes; m + tpl.slotMinutes <= endMinutes; m += tpl.slotMinutes) {
    const h = Math.floor(m / 60), mi = m % 60;
    // R9: on a spring-forward day this wall time may not exist at all. Emitting
    // it anyway would offer a slot at a time that never happens.
    if (!tz.wallTimeExistsInZone(ymd.y, ymd.mo, ymd.d, h, mi, tpl.timezone)) continue;
    const startMs = tz.zonedWallTimeToUtc(ymd.y, ymd.mo, ymd.d, h, mi, tpl.timezone);
    const endMs = startMs + slotMs;
    if (endMs > windowEnd) continue;         // DST can shorten the real window
    if (startMs < earliest) continue;        // minimum notice
    if (overlapsBusy(startMs, endMs, busy, bufferMs)) continue;
    slots.push({ startMs, endMs });
  }
  return slots.sort((a, b) => a.startMs - b.startMs);
}

function computeSlotsForRange({ template, startYmd, days, busy = [], nowMs }) {
  const out = {};
  const base = Date.UTC(startYmd.y, startYmd.mo - 1, startYmd.d);
  for (let i = 0; i < days; i++) {
    const cur = new Date(base + i * 86400000);
    const ymd = {
      y: cur.getUTCFullYear(), mo: cur.getUTCMonth() + 1, d: cur.getUTCDate(),
    };
    out[tz.formatYmd(ymd.y, ymd.mo, ymd.d)] =
      computeSlotsForDay({ template, ymd, busy, nowMs });
  }
  return out;
}

// Re-verifies a requested start before booking. Derives the calendar date from
// the instant in the TEMPLATE's zone, so a visitor in another zone whose local
// date differs still lands on the right day's rules.
function slotExists({ template, startMs, busy = [], nowMs }) {
  const tpl = normalizeTemplate(template);
  const p = tz.zoneDateParts(startMs, tpl.timezone);
  const slots = computeSlotsForDay({
    template: tpl, ymd: { y: p.year, mo: p.month, d: p.day }, busy, nowMs,
  });
  return slots.some(s => s.startMs === startMs);
}

module.exports = {
  DEFAULT_TEMPLATE, DEFAULT_DAY, ALLOWED_SLOT_MINUTES,
  normalizeTemplate, validateTemplate,
  computeSlotsForDay, computeSlotsForRange, slotExists,
};
