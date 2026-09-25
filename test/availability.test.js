const { test } = require('node:test');
const assert = require('node:assert/strict');
const av = require('../api/_availability');
const tz = require('../api/_timezone');

const TPL = {
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '11:00' },
    tue: { enabled: true, start: '09:00', end: '11:00' },
    wed: { enabled: true, start: '09:00', end: '11:00' },
    thu: { enabled: true, start: '09:00', end: '11:00' },
    fri: { enabled: true, start: '09:00', end: '11:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 30, bufferMinutes: 0, minNoticeHours: 0,
};

// 2026-09-28 is a Monday.
const MON = { y: 2026, mo: 9, d: 28 };
const at = (h, mi) => tz.zonedWallTimeToUtc(2026, 9, 28, h, mi, 'America/Toronto');

test('generates a slot grid inside the day window', () => {
  const slots = av.computeSlotsForDay({ template: TPL, ymd: MON, busy: [], nowMs: 0 });
  assert.equal(slots.length, 4); // 09:00 09:30 10:00 10:30
  assert.equal(slots[0].startMs, at(9, 0));
  assert.equal(slots[0].endMs, at(9, 30));
  assert.equal(slots[3].startMs, at(10, 30));
  // Never runs past the end of the window.
  assert.equal(slots[3].endMs, at(11, 0));
});

test('returns nothing for a disabled day', () => {
  const sat = { y: 2026, mo: 10, d: 3 }; // Saturday
  assert.deepEqual(av.computeSlotsForDay({ template: TPL, ymd: sat, busy: [], nowMs: 0 }), []);
});

test('drops slots that overlap a busy interval', () => {
  const busy = [{ start: at(9, 30), end: at(10, 0) }];
  const slots = av.computeSlotsForDay({ template: TPL, ymd: MON, busy, nowMs: 0 });
  assert.deepEqual(slots.map(s => s.startMs), [at(9, 0), at(10, 0), at(10, 30)]);
});

test('an event partially covering a slot still removes the whole slot', () => {
  const busy = [{ start: at(9, 10), end: at(9, 20) }];
  const slots = av.computeSlotsForDay({ template: TPL, ymd: MON, busy, nowMs: 0 });
  assert.equal(slots.some(s => s.startMs === at(9, 0)), false);
});

test('bufferMinutes pads busy intervals rather than widening the grid (R1)', () => {
  const template = { ...TPL, bufferMinutes: 15 };
  const busy = [{ start: at(10, 0), end: at(10, 30) }];
  const slots = av.computeSlotsForDay({ template, ymd: MON, busy, nowMs: 0 });
  // 09:30-10:00 now falls inside the 15-minute pad before the event, and
  // 10:30-11:00 inside the pad after it. The grid itself stays on :00/:30.
  assert.deepEqual(slots.map(s => s.startMs), [at(9, 0)]);
});

test('honours minNoticeHours', () => {
  const template = { ...TPL, minNoticeHours: 2 };
  const nowMs = at(8, 0); // 08:00 local, so 09:00 and 09:30 are inside 2h notice
  const slots = av.computeSlotsForDay({ template, ymd: MON, busy: [], nowMs });
  assert.deepEqual(slots.map(s => s.startMs), [at(10, 0), at(10, 30)]);
});

test('omitting nowMs does not silently lose the minNoticeHours rule', () => {
  const template = { ...TPL, minNoticeHours: 12 };
  // Without the guard, undefined becomes NaN, and startMs < NaN is always false,
  // bypassing the notice filter. With the guard, it uses Date.now() and the filter works.
  // Use a past date to verify: an old date should be filtered out by the notice window.
  const pastDate = { y: 2026, mo: 1, d: 1 }; // 2026-01-01 is well before today
  const slots = av.computeSlotsForDay({
    template, ymd: pastDate, busy: [],
    // Intentionally omit nowMs to test the guard
    nowMs: undefined,
  });
  // With the guard in place, Date.now() is used, and this old date gets filtered by minNoticeHours.
  assert.equal(slots.length, 0, 'omitting nowMs should not bypass the minNoticeHours rule');
});

test('skips wall times lost to the spring-forward gap (R9)', () => {
  // Toronto jumps 02:00 -> 03:00 on 2026-03-08 (a Sunday).
  const template = {
    ...TPL,
    days: { ...TPL.days, sun: { enabled: true, start: '01:00', end: '04:00' } },
  };
  const slots = av.computeSlotsForDay({
    template, ymd: { y: 2026, mo: 3, d: 8 }, busy: [], nowMs: 0,
  });
  // With the DST guard removed this test must FAIL. Asserting "no slot says
  // 02:xx" does not achieve that: the nonexistent 02:00/02:30 collapse onto the
  // same instants as the real 01:00/01:30, so a broken implementation emits
  // duplicates that all read back as hour 1 or 3. The duplicate count is the
  // real signal.
  const starts = slots.map(s => s.startMs);
  assert.equal(new Set(starts).size, starts.length, 'emitted duplicate slot instants');
  assert.deepEqual(
    slots.map(s => {
      const p = tz.zoneDateParts(s.startMs, 'America/Toronto');
      return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    }),
    ['01:00', '01:30', '03:00', '03:30']);
  // Every emitted slot must read back at the wall time it claims.
  for (const s of slots) {
    const p = tz.zoneDateParts(s.startMs, 'America/Toronto');
    assert.equal(p.day, 8);
    assert.ok(p.hour !== 2, `emitted a 02:xx slot that does not exist: ${p.hour}`);
  }
  assert.ok(slots.length > 0);
});

test('slot boundaries follow the template timezone, not the server', () => {
  const istanbul = { ...TPL, timezone: 'Europe/Istanbul' };
  const slots = av.computeSlotsForDay({ template: istanbul, ymd: MON, busy: [], nowMs: 0 });
  assert.equal(
    new Date(slots[0].startMs).toISOString(), '2026-09-28T06:00:00.000Z'); // 09:00 +03
});

test('computeSlotsForRange keys results by date and spans days', () => {
  const out = av.computeSlotsForRange({
    template: TPL, startYmd: { y: 2026, mo: 10, d: 2 }, days: 3, busy: [], nowMs: 0,
  });
  assert.deepEqual(Object.keys(out), ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(out['2026-10-02'].length, 4); // Friday
  assert.equal(out['2026-10-03'].length, 0); // Saturday, disabled
  assert.equal(out['2026-10-04'].length, 0); // Sunday, disabled
});

test('slotExists agrees with the generated grid', () => {
  assert.equal(av.slotExists({ template: TPL, startMs: at(9, 30), busy: [], nowMs: 0 }), true);
  assert.equal(av.slotExists({ template: TPL, startMs: at(9, 7),  busy: [], nowMs: 0 }), false);
  assert.equal(av.slotExists({ template: TPL, startMs: at(12, 0), busy: [], nowMs: 0 }), false);
  assert.equal(av.slotExists({
    template: TPL, startMs: at(9, 30),
    busy: [{ start: at(9, 30), end: at(10, 0) }], nowMs: 0,
  }), false);
});

test('normalizeTemplate repairs junk without throwing', () => {
  const n = av.normalizeTemplate({
    timezone: 'Mars/Olympus',                       // invalid -> default
    days: { mon: { enabled: true, start: '9:00', end: 'nonsense' } },
    slotMinutes: 7,                                 // not allowed -> default
    bufferMinutes: -5,                              // clamped
    minNoticeHours: 9999,                           // clamped
  });
  assert.equal(n.timezone, 'America/Toronto');
  assert.equal(n.days.mon.end, '17:00');
  assert.equal(n.slotMinutes, 30);
  assert.equal(n.bufferMinutes, 0);
  assert.ok(n.minNoticeHours <= 720);
  for (const k of tz.WEEKDAY_KEYS) assert.ok(n.days[k], `missing day ${k}`);
  assert.doesNotThrow(() => av.normalizeTemplate(null));
  assert.doesNotThrow(() => av.normalizeTemplate('garbage'));
});

test('a template with no days block fails closed rather than opening default hours', () => {
  const n = av.normalizeTemplate({
    timezone: 'America/Toronto', slotMinutes: 30, bufferMinutes: 15, minNoticeHours: 12,
  });
  // Deliberate: hours nobody configured must never become bookable.
  for (const k of tz.WEEKDAY_KEYS) assert.equal(n.days[k].enabled, false, `${k} should be disabled`);
  // start/end still get sane defaults so downstream never sees undefined.
  assert.equal(n.days.mon.start, '09:00');
  assert.equal(n.days.mon.end, '17:00');
});

test('validateTemplate rejects an end at or before its start', () => {
  const bad = { ...TPL, days: { ...TPL.days, mon: { enabled: true, start: '17:00', end: '09:00' } } };
  const res = av.validateTemplate(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => /mon/.test(e)));
  assert.equal(av.validateTemplate(TPL).ok, true);
});
