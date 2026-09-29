// GET /api/calendar-checkin-availability?date=YYYY-MM-DD[&days=N]
//
// Mirrors calendar-availability.js exactly, reading the CHECK-IN template
// instead of the applicant one. Free/busy still comes from the single shared
// Google Calendar, which is the point: an applicant's booked slot correctly
// disappears from this grid, and a check-in booking disappears from theirs.
//
// No verify token is required here. Availability is not sensitive -- it is the
// same class of information the applicant widget already serves publicly -- and
// gating it would mean the page could not draw a grid before a token round
// trip. The token gate lives on calendar-checkin-book.js, where it matters.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const { loadCheckinTemplate } = require('./_load-checkin-template');

const MAX_DAYS = 31;

module.exports = async function handler(req, res) {
  // Set once, up front, so every branch -- including 405 and every error
  // response -- carries it. A cached error is worse than a cached success: a
  // stale CALENDAR_NOT_CONNECTED would keep telling clients booking is
  // unavailable long after it was connected.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const dateRaw = (req.query && req.query.date) || '';
  const ymd = tz.parseYmd(String(dateRaw));
  if (!ymd) {
    return res.status(400).json({ ok: false, error: 'BAD_DATE',
      message: 'date must be YYYY-MM-DD' });
  }
  let days = parseInt((req.query && req.query.days) || '1', 10);
  if (!Number.isFinite(days) || days < 1) days = 1;
  if (days > MAX_DAYS) days = MAX_DAYS;

  const tplRes = await loadCheckinTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
    return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
      message: 'Booking storage is not set up yet.' });
  }
  const template = tplRes.template;

  // One free/busy call for the whole range, padded by a day on each side so an
  // event starting before the range but running into it still blocks.
  const rangeStart = tz.zonedWallTimeToUtc(ymd.y, ymd.mo, ymd.d, 0, 0, template.timezone);
  const rangeEnd = rangeStart + (days + 1) * 86400000;
  const busyRes = await gcal.freeBusy(
    new Date(rangeStart - 86400000).toISOString(), new Date(rangeEnd).toISOString());

  if (!busyRes.ok) {
    const notConnected = busyRes.reason === gcal.NOT_CONNECTED;
    return res.status(notConnected ? 503 : 502).json({
      ok: false,
      error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: notConnected
        ? 'The calendar has not been connected yet.'
        : 'Could not read the calendar right now.',
    });
  }

  const byDate = av.computeSlotsForRange({
    template, startYmd: ymd, days, busy: busyRes.busy, nowMs: Date.now(),
  });

  const out = {};
  for (const [date, slots] of Object.entries(byDate)) {
    out[date] = slots.map(s => ({
      start: new Date(s.startMs).toISOString(),
      end: new Date(s.endMs).toISOString(),
    }));
  }

  return res.status(200).json({
    ok: true,
    timezone: template.timezone,
    slotMinutes: template.slotMinutes,
    days: out,
  });
};
