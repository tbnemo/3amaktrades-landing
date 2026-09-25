const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');

function inZone(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(ms);
}

test('converts wall time to UTC across a DST boundary', () => {
  // Toronto is EST (-5) in January, EDT (-4) in July.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 1, 15, 9, 0, 'America/Toronto')).toISOString(),
    '2026-01-15T14:00:00.000Z');
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 7, 15, 9, 0, 'America/Toronto')).toISOString(),
    '2026-07-15T13:00:00.000Z');
});

test('Istanbul has no DST, so summer and winter share an offset', () => {
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 1, 15, 9, 0, 'Europe/Istanbul')).toISOString(),
    '2026-01-15T06:00:00.000Z');
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 7, 15, 9, 0, 'Europe/Istanbul')).toISOString(),
    '2026-07-15T06:00:00.000Z');
});

test('round-trips wall times in zones with odd offsets and odd DST', () => {
  // Kathmandu is +05:45; Lord Howe shifts by only 30 minutes.
  for (const zone of ['America/Toronto', 'Europe/Istanbul', 'Asia/Riyadh',
                      'Australia/Lord_Howe', 'Asia/Kathmandu']) {
    for (let day = 0; day < 365; day++) {
      const base = new Date(Date.UTC(2026, 0, 1 + day));
      const y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
      for (const h of [0, 9, 13, 23]) {
        if (!tz.wallTimeExistsInZone(y, mo, d, h, 30, zone)) continue;
        const ms = tz.zonedWallTimeToUtc(y, mo, d, h, 30, zone);
        const want = `${String(h).padStart(2, '0')}:30`;
        assert.ok(inZone(ms, zone).endsWith(want),
          `${zone} ${y}-${mo}-${d} ${want} -> ${inZone(ms, zone)}`);
      }
    }
  }
});

test('flags the spring-forward gap, where a wall time does not exist', () => {
  // Toronto jumps 02:00 -> 03:00 on 2026-03-08. 02:30 never happens.
  assert.equal(tz.wallTimeExistsInZone(2026, 3, 8, 1, 30, 'America/Toronto'), true);
  assert.equal(tz.wallTimeExistsInZone(2026, 3, 8, 2, 30, 'America/Toronto'), false);
  assert.equal(tz.wallTimeExistsInZone(2026, 3, 8, 3, 30, 'America/Toronto'), true);
});

test('resolves an ambiguous fall-back wall time to the earlier occurrence', () => {
  // 01:30 happens twice on 2026-11-01. 05:30Z is the first (EDT) one.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 11, 1, 1, 30, 'America/Toronto')).toISOString(),
    '2026-11-01T05:30:00.000Z');
});

test('reads back the wall-clock parts of an instant in a zone', () => {
  assert.deepEqual(
    tz.zoneDateParts(Date.UTC(2026, 6, 15, 13, 0), 'America/Toronto'),
    { year: 2026, month: 7, day: 15, hour: 9, minute: 0 });
});

test('maps a calendar date to a weekday key', () => {
  assert.equal(tz.weekdayKeyFromYmd(2026, 9, 25), 'fri');
  assert.equal(tz.weekdayKeyFromYmd(2026, 9, 27), 'sun');
  assert.equal(tz.weekdayKeyFromYmd(2026, 9, 28), 'mon');
});

test('parses and formats dates and times, rejecting malformed input', () => {
  assert.deepEqual(tz.parseYmd('2026-09-25'), { y: 2026, mo: 9, d: 25 });
  assert.equal(tz.parseYmd('25-09-2026'), null);
  assert.equal(tz.parseYmd('2026-13-01'), null);
  assert.equal(tz.parseYmd('2026-02-31'), null);
  assert.equal(tz.parseYmd('not a date'), null);
  assert.equal(tz.formatYmd(2026, 9, 5), '2026-09-05');
  assert.deepEqual(tz.parseHm('09:30'), { h: 9, mi: 30 });
  assert.deepEqual(tz.parseHm('9:30'), { h: 9, mi: 30 });
  assert.equal(tz.parseHm('24:00'), null);
  assert.equal(tz.parseHm('garbage'), null);
});

test('validates IANA zone names', () => {
  assert.equal(tz.isValidTimeZone('America/Toronto'), true);
  assert.equal(tz.isValidTimeZone('Europe/Istanbul'), true);
  assert.equal(tz.isValidTimeZone('Mars/Olympus'), false);
  assert.equal(tz.isValidTimeZone(''), false);
  assert.equal(tz.isValidTimeZone(null), false);
});
