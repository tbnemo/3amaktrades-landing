const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const handler = require('../api/calendar-reschedule');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  store.__setClientForTests(emptyBlobClient());
}

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try {
    return await fn();
  } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// A weekday far enough in the future to clear the 12h minimum-notice rule and
// stay well clear of any DST boundary, at 10:00 America/Toronto -- inside the
// default template's 09:00-17:00 window and aligned to the 30-minute grid.
function validSlotStartMs() {
  const base = new Date(Date.now() + 60 * 86400000);
  let y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  while (true) {
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) break; // Mon-Fri
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return tz.zonedWallTimeToUtc(y, mo, d, 10, 0, 'America/Toronto');
}

const EVENT_ID = 'evt-reschedule-1';
const EMAIL = 'jane@example.com';

function ourEvent({ startMs, endMs, overrides = {} }) {
  return {
    id: EVENT_ID,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs).toISOString() },
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        visitorEmail: EMAIL,
        visitorName: 'Jane Doe',
        visitorPhone: '555-0100',
        visitorTimeZone: 'America/Toronto',
        lang: 'en',
        slackTs: 'slack-ts-original',
      },
    },
    ...overrides,
  };
}

function goodBody(newStartMs, overrides = {}) {
  return {
    eventId: EVENT_ID,
    email: EMAIL,
    token: bt.makeBookingToken(EVENT_ID, EMAIL),
    start: new Date(newStartMs).toISOString(),
    visitorTimeZone: 'America/Toronto',
    ...overrides,
  };
}

test('happy path: 200, and patchEvent is called with the NEW start/end', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  // Same day, four hours later: a different slot, well clear of the old one.
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: 'https://meet.example/xyz' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [{ id: EVENT_ID, start: { dateTime: isoNewStart }, end: { dateTime: isoNewEnd }, status: 'confirmed' }],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: 'slack-ts-2' }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, EVENT_ID);
    assert.equal(res._json.start, isoNewStart);
    assert.equal(res._json.end, isoNewEnd);

    assert.equal(patchSpy.calls.length, 1);
    const [, payload] = patchSpy.calls[0];
    assert.equal(payload.start.dateTime, isoNewStart);
    assert.equal(payload.end.dateTime, isoNewEnd);
  });
});

// The self-blocking regression: the event being moved is itself on the
// calendar, so its OWN current busy interval must be filtered out of the
// free/busy result before checking the new slot. Here freeBusy returns
// ONLY the booking's current interval as busy, and the requested new slot
// sits inside that interval's buffer padding (10:00-10:30 -> 10:30-11:00
// with a 15-minute buffer around busy intervals). Without the own-interval
// filter, av.slotExists() sees the old interval as still busy and this
// returns 409 -- an inexplicable failure to move a call by half an hour.
// With the filter, the busy list is empty and this must return 200.
test('reschedule does not block on its own current busy interval (self-blocking regression)', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldEnd; // back-to-back slot, inside the old interval's buffer
  const newEnd = newStart + 30 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: '' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    // ONLY the booking's own current interval is reported busy.
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [{ start: oldStart, end: oldEnd }] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [{ id: EVENT_ID, start: { dateTime: isoNewStart }, end: { dateTime: isoNewEnd }, status: 'confirmed' }],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200, `expected 200, got ${res._status} (${JSON.stringify(res._json)})`);
    assert.equal(res._json.ok, true);
  });
});

// Lost race: after the patch, another event now occupies the new window and
// wins the deterministic tie-break. The response must be 409 AND the booking
// must be restored to its ORIGINAL time -- asserting only the 409 would still
// pass even if the booking were left sitting at the new (conflicting) time.
test('lost race: 409, and patchEvent is called a second time restoring the ORIGINAL start/end', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;
  const isoOldStart = new Date(oldStart).toISOString();
  const isoOldEnd = new Date(oldEnd).toISOString();
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: '' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    // 'aaa-other' sorts first -> ours (EVENT_ID = 'evt-reschedule-1') loses.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          { id: 'aaa-other', start: { dateTime: isoNewStart }, end: { dateTime: isoNewEnd }, status: 'confirmed' },
          { id: EVENT_ID, start: { dateTime: isoNewStart }, end: { dateTime: isoNewEnd }, status: 'confirmed' },
        ],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.ok, false);
    assert.equal(res._json.error, 'SLOT_TAKEN');

    assert.equal(patchSpy.calls.length, 2, 'patchEvent must be called a second time to restore the original time');
    const [, restorePayload] = patchSpy.calls[1];
    assert.equal(restorePayload.start.dateTime, isoOldStart);
    assert.equal(restorePayload.end.dateTime, isoOldEnd);
  });
});

test('reminderSent is cleared (set to empty string) on a successful reschedule', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: '' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [{ id: EVENT_ID, start: { dateTime: new Date(newStart).toISOString() }, end: { dateTime: new Date(newEnd).toISOString() }, status: 'confirmed' }],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 1);
    const [, payload] = patchSpy.calls[0];
    assert.ok(payload.extendedProperties && payload.extendedProperties.private, 'patch payload must set extendedProperties.private');
    assert.equal(payload.extendedProperties.private.reminderSent, '');
  });
});

test('a throwing Slack stub and a throwing email stub still result in a 200, confirmed reschedule', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [{ id: EVENT_ID, start: { dateTime: new Date(newStart).toISOString() }, end: { dateTime: new Date(newEnd).toISOString() }, status: 'confirmed' }],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => { throw new Error('slack is down'); } },
    { obj: email, key: 'sendRescheduleNotice', value: async () => { throw new Error('email is down'); } },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, EVENT_ID);
  });
});

test('a rejected token/ownership check (loadBooking failure) is passed through, e.g. 403 FORBIDDEN', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs, endMs: startMs + 1800000 }) }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs, { token: 'wrong-token' }) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
  });
});

test('a slot that fails the re-verify (genuinely busy elsewhere) returns 409 without calling patchEvent', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    // A genuinely different busy interval that fully covers the new slot.
    { obj: gcal, key: 'freeBusy', value: async () => ({
        ok: true, busy: [{ start: newStart - 3600000, end: newEnd + 3600000 }],
      }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 0, 'patchEvent must never be reached');
  });
});

test('non-POST requests return 405', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'GET', body: {} }, res);
  assert.equal(res._status, 405);
});
