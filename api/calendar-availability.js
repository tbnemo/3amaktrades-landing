// GET /api/calendar-availability?date=YYYY-MM-DD[&days=N]
//
// Slots are computed per request from the template plus live free/busy data and
// never stored. `days` (R6) lets the widget draw its whole day strip and pick the
// first day with real openings in ONE round trip instead of N.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const { loadTemplate } = require('./_load-template');

const MAX_DAYS = 31;

module.exports = async function handler(req, res) {
  // Set once, up front, so every branch -- including 405 and every error
  // response -- carries it. Availability changes the moment anything lands on
  // the calendar, and a cached error is worse than a cached success: a stale
  // CALENDAR_NOT_CONNECTED would keep telling visitors booking is unavailable
  // long after it was connected.
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

  const tplRes = await loadTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
    return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
      message: 'Booking storage is not set up yet.' });
  }
  const template = tplRes.template;

  // Query free/busy across the whole range in one call, padded by a day on each
  // side so an event that starts before the range but runs into it still blocks.
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
