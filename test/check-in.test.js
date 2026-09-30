const { test } = require('node:test');
const assert = require('node:assert/strict');
const { __test: h } = require('../check-in.js');

// ---------------------------------------------------------------------
// pad2
// ---------------------------------------------------------------------

test('pad2: zero-pads single digits, leaves two-plus-digit numbers alone', () => {
  assert.equal(h.pad2(0), '00');
  assert.equal(h.pad2(9), '09');
  assert.equal(h.pad2(10), '10');
  assert.equal(h.pad2(31), '31');
});

// ---------------------------------------------------------------------
// localDateKey
// ---------------------------------------------------------------------

test('localDateKey: formats a Date as zero-padded YYYY-MM-DD', () => {
  assert.equal(h.localDateKey(new Date(2026, 2, 5)), '2026-03-05'); // March 5 -- month and day both need padding
  assert.equal(h.localDateKey(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(h.localDateKey(new Date(2026, 0, 1)), '2026-01-01');
});

test('localDateKey: defaults to "now" when no Date is passed', () => {
  const key = h.localDateKey();
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
});

// ---------------------------------------------------------------------
// dayLabel -- weekday/day-number for a day-strip chip, pinned to UTC noon
// so the label always matches the 'YYYY-MM-DD' key regardless of the
// runner's own system timezone.
// ---------------------------------------------------------------------

test('dayLabel: 2026-09-28 formats with day number 28', () => {
  const parts = h.dayLabel('2026-09-28');
  assert.equal(parts.dayNum, '28');
  assert.equal(typeof parts.weekday, 'string');
  assert.ok(parts.weekday.length > 0);
});

test('dayLabel: 2026-01-15 is a Thursday', () => {
  const parts = h.dayLabel('2026-01-15');
  assert.equal(parts.weekday, 'Thu');
  assert.equal(parts.dayNum, '15');
});

test('dayLabel: is stable regardless of the host system timezone (pinned to UTC noon)', () => {
  const a = h.dayLabel('2026-06-01');
  const b = h.dayLabel('2026-06-01');
  assert.deepEqual(a, b);
  assert.equal(a.dayNum, '1');
});

// ---------------------------------------------------------------------
// formatTime -- must format the server's absolute ISO instant using Intl
// only, with no manual offset arithmetic, and must never throw even on an
// unrecognised timezone (falls back to UTC instead of blanking the page).
// ---------------------------------------------------------------------

test('formatTime: formats an absolute instant in the given IANA zone', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  assert.equal(h.formatTime(iso, 'UTC'), '15:30');
});

test('formatTime: two different timezones for the same instant produce different labels', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const utc = h.formatTime(iso, 'UTC');
  const nyc = h.formatTime(iso, 'America/New_York'); // UTC-5 in January
  assert.notEqual(utc, nyc);
  assert.equal(nyc, '10:30');
});

test('formatTime: an invalid timezone name falls back to UTC instead of throwing', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const fallback = h.formatTime(iso, 'Not/A_Real_Zone');
  assert.equal(fallback, h.formatTime(iso, 'UTC'));
});

// ---------------------------------------------------------------------
// formatFull -- the confirm-bar / done-step summary line: a full date and
// time in the visitor's zone, with the same never-throw fallback.
// ---------------------------------------------------------------------

test('formatFull: formats an absolute instant as a full date and time', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const full = h.formatFull(iso, 'UTC');
  assert.match(full, /2026/);
  assert.match(full, /15:30/);
  assert.match(full, /January/);
});

test('formatFull: two different timezones for the same instant produce different labels', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const utc = h.formatFull(iso, 'UTC');
  const nyc = h.formatFull(iso, 'America/New_York');
  assert.notEqual(utc, nyc);
});

test('formatFull: an invalid timezone name falls back rather than throwing', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  assert.doesNotThrow(() => h.formatFull(iso, 'Not/A_Real_Zone'));
});

// ---------------------------------------------------------------------
// firstDayWithOpenings -- the auto-select rule. Today's hours may already
// have passed, so the picker must never just pick the first day key; it
// must pick the first key (sorted ascending) whose slot array is
// non-empty. Unlike booking-widget.js's firstDayWithOpenings(range), this
// page's version takes no argument -- it reads state.dayKeys/state.days
// straight out of its own closure, exactly as the page itself calls it.
// The exported `state` is the SAME object reference the page's own
// functions close over, so mutating it here sets up the scenario the
// real page would have reached via loadAvailability().
// ---------------------------------------------------------------------

test('firstDayWithOpenings: skips an empty first day and returns the next day that has slots', () => {
  h.state.dayKeys = ['2026-09-28', '2026-09-29', '2026-09-30'];
  h.state.days = {
    '2026-09-28': [],
    '2026-09-29': [{ start: '2026-09-29T14:00:00.000Z', end: '2026-09-29T14:30:00.000Z' }],
    '2026-09-30': [{ start: '2026-09-30T14:00:00.000Z', end: '2026-09-30T14:30:00.000Z' }],
  };
  assert.equal(h.firstDayWithOpenings(), '2026-09-29');
});

test('firstDayWithOpenings: returns "" when every day in dayKeys is empty', () => {
  h.state.dayKeys = ['2026-09-28', '2026-09-29', '2026-09-30'];
  h.state.days = { '2026-09-28': [], '2026-09-29': [], '2026-09-30': [] };
  assert.equal(h.firstDayWithOpenings(), '');
});

test('firstDayWithOpenings: returns "" when dayKeys is empty', () => {
  h.state.dayKeys = [];
  h.state.days = {};
  assert.equal(h.firstDayWithOpenings(), '');
});

test('firstDayWithOpenings: follows dayKeys order, not alphabetical/insertion order of the days map', () => {
  // dayKeys is the sorted list the page itself builds (Object.keys(...).sort())
  // before calling this -- the function just walks it in order.
  h.state.dayKeys = ['2026-09-28', '2026-10-01', '2026-10-05'];
  h.state.days = {
    '2026-10-05': [{ start: '2026-10-05T14:00:00.000Z', end: '2026-10-05T14:30:00.000Z' }],
    '2026-09-28': [],
    '2026-10-01': [{ start: '2026-10-01T14:00:00.000Z', end: '2026-10-01T14:30:00.000Z' }],
  };
  assert.equal(h.firstDayWithOpenings(), '2026-10-01');
});
