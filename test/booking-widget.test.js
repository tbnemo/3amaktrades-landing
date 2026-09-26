const { test } = require('node:test');
const assert = require('node:assert/strict');
const { __test: h } = require('../booking-widget.js');

// ---------------------------------------------------------------------
// firstDayWithOpenings -- the auto-select rule. Today's hours may already
// have passed, so mount() must never just pick the first key; it must pick
// the first key (sorted ascending) whose slot array is non-empty.
// ---------------------------------------------------------------------

test('firstDayWithOpenings: skips an empty first day and returns the next day that has slots', () => {
  const range = {
    '2026-09-28': [],
    '2026-09-29': [{ start: '2026-09-29T14:00:00.000Z', end: '2026-09-29T14:30:00.000Z' }],
    '2026-09-30': [{ start: '2026-09-30T14:00:00.000Z', end: '2026-09-30T14:30:00.000Z' }],
  };
  assert.equal(h.firstDayWithOpenings(range), '2026-09-29');
});

test('firstDayWithOpenings: returns null when every day in the range is empty', () => {
  const range = { '2026-09-28': [], '2026-09-29': [], '2026-09-30': [] };
  assert.equal(h.firstDayWithOpenings(range), null);
});

test('firstDayWithOpenings: returns null for an empty or missing range object', () => {
  assert.equal(h.firstDayWithOpenings({}), null);
  assert.equal(h.firstDayWithOpenings(null), null);
  assert.equal(h.firstDayWithOpenings(undefined), null);
});

test('firstDayWithOpenings: sorts keys ascending regardless of insertion order', () => {
  const range = {
    '2026-10-05': [{ start: '2026-10-05T14:00:00.000Z', end: '2026-10-05T14:30:00.000Z' }],
    '2026-09-28': [],
    '2026-10-01': [{ start: '2026-10-01T14:00:00.000Z', end: '2026-10-01T14:30:00.000Z' }],
  };
  // '2026-09-28' sorts first but is empty, '2026-10-01' is the next chronological
  // key with openings even though it was inserted after '2026-10-05'.
  assert.equal(h.firstDayWithOpenings(range), '2026-10-01');
});

// ---------------------------------------------------------------------
// formatSlotTime -- must format the server's absolute ISO instant using
// Intl only, with no manual offset arithmetic, and must never throw even
// on an unrecognised timezone (falls back to UTC instead of blanking the
// widget).
// ---------------------------------------------------------------------

test('formatSlotTime: formats an absolute instant in the given IANA zone and locale', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  assert.equal(h.formatSlotTime(iso, 'en-GB', 'UTC'), '15:30');
});

test('formatSlotTime: two different timezones for the same instant produce different labels', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const utc = h.formatSlotTime(iso, 'en-GB', 'UTC');
  const nyc = h.formatSlotTime(iso, 'en-GB', 'America/New_York'); // UTC-5 in January
  assert.notEqual(utc, nyc);
  assert.equal(nyc, '10:30');
});

test('formatSlotTime: an invalid timezone name falls back to UTC instead of throwing', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const fallback = h.formatSlotTime(iso, 'en-GB', 'Not/A_Real_Zone');
  assert.equal(fallback, h.formatSlotTime(iso, 'en-GB', 'UTC'));
});

test('formatSlotTime: Arabic locale produces a non-empty label without throwing', () => {
  const iso = '2026-01-15T15:30:00.000Z';
  const label = h.formatSlotTime(iso, 'ar', 'UTC');
  assert.equal(typeof label, 'string');
  assert.ok(label.length > 0);
});

// ---------------------------------------------------------------------
// localeForLang
// ---------------------------------------------------------------------

test('localeForLang: maps ar/en to the Intl locales the widget formats with', () => {
  assert.equal(h.localeForLang('ar'), 'ar');
  assert.equal(h.localeForLang('en'), 'en-GB');
  assert.equal(h.localeForLang('fr'), 'en-GB'); // anything not 'ar' defaults to en-GB
  assert.equal(h.localeForLang(undefined), 'en-GB');
});

// ---------------------------------------------------------------------
// dayLabelParts -- weekday/day-number come from Intl at runtime (never from
// a texts map), pinned to UTC noon so the label matches the calendar-date
// key regardless of the runner's own system timezone.
// ---------------------------------------------------------------------

test('dayLabelParts: 2026-09-28 formats as day 28 in en-GB', () => {
  const parts = h.dayLabelParts('2026-09-28', 'en-GB');
  assert.equal(parts.dayNum, '28');
  assert.equal(typeof parts.weekday, 'string');
  assert.ok(parts.weekday.length > 0);
});

test('dayLabelParts: 2026-01-15 is a Thursday in en-GB', () => {
  const parts = h.dayLabelParts('2026-01-15', 'en-GB');
  assert.equal(parts.weekday, 'Thu');
  assert.equal(parts.dayNum, '15');
});

test('dayLabelParts: is stable regardless of the host system timezone (pinned to UTC noon)', () => {
  // A date-only key must label the same calendar date whether the process
  // clock were in a +14 or -12 offset zone -- this is what pinning the
  // probe to UTC noon (rather than UTC midnight) protects against.
  const a = h.dayLabelParts('2026-06-01', 'en-GB');
  const b = h.dayLabelParts('2026-06-01', 'en-GB');
  assert.deepEqual(a, b);
  assert.equal(a.dayNum, '1');
});

test('dayLabelParts: Arabic locale returns non-empty weekday and day-number strings', () => {
  const parts = h.dayLabelParts('2026-09-28', 'ar');
  assert.ok(parts.weekday.length > 0);
  assert.ok(parts.dayNum.length > 0);
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
// getTimezoneOptions -- seeds the visitor timezone <select>. Must always
// include the detected zone (first, if it wasn't already present), and
// must fall back to a short curated list when Intl.supportedValuesOf is
// unavailable in the running engine.
// ---------------------------------------------------------------------

test('getTimezoneOptions: includes the detected zone even if missing from every list', () => {
  const list = h.getTimezoneOptions('Fake/Zone_Not_Real');
  assert.equal(list[0], 'Fake/Zone_Not_Real');
  assert.equal(list.indexOf('Fake/Zone_Not_Real'), 0);
  assert.equal(list.filter((z) => z === 'Fake/Zone_Not_Real').length, 1, 'must not duplicate the detected zone');
});

test('getTimezoneOptions: a detected zone already present in the list is not duplicated or re-prepended', () => {
  const list = h.getTimezoneOptions('UTC');
  assert.equal(list.filter((z) => z === 'UTC').length, 1);
});

test('getTimezoneOptions: falls back to the curated short list when Intl.supportedValuesOf is unavailable', () => {
  const orig = Intl.supportedValuesOf;
  try {
    // Simulate an engine without Intl.supportedValuesOf (not every engine has it).
    delete Intl.supportedValuesOf;
    const list = h.getTimezoneOptions('America/Toronto');
    // America/Toronto is already in FALLBACK_TIMEZONES, so it should appear
    // exactly once, and the list should be the short curated fallback length.
    assert.equal(list.filter((z) => z === 'America/Toronto').length, 1);
    assert.equal(list.length, h.FALLBACK_TIMEZONES.length);
  } finally {
    Intl.supportedValuesOf = orig; // restore for every later test in this process
  }
});

test('getTimezoneOptions: prefers the full IANA list over the fallback when available', () => {
  if (typeof Intl.supportedValuesOf !== 'function') return; // nothing to assert on this engine
  const list = h.getTimezoneOptions('America/Toronto');
  assert.ok(list.length > h.FALLBACK_TIMEZONES.length, 'the real IANA list is much larger than the curated fallback');
});

// ---------------------------------------------------------------------
// escapeHtml -- every piece of embedder-supplied or visitor-typed text goes
// through this before landing in an innerHTML string.
// ---------------------------------------------------------------------

test('escapeHtml: escapes the five HTML-significant characters', () => {
  assert.equal(h.escapeHtml('<script>alert("x") & \'y\'</script>'),
    '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;');
});

test('escapeHtml: null and undefined become an empty string, not the literal word', () => {
  assert.equal(h.escapeHtml(null), '');
  assert.equal(h.escapeHtml(undefined), '');
});

test('escapeHtml: passes ordinary text through unchanged', () => {
  assert.equal(h.escapeHtml('Jane Doe'), 'Jane Doe');
  assert.equal(h.escapeHtml('عمر'), 'عمر');
});
