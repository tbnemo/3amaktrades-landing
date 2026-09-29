const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const handler = require('../api/calendar-cancel');

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

const EVENT_ID = 'evt-cancel-1';
const EMAIL = 'jane@example.com';
const START_MS = Date.UTC(2026, 10, 12, 14, 0, 0);
const END_MS = START_MS + 30 * 60 * 1000;

// An event as getEvent returns it: the SHARED marker, no audience tag (an
// APPLICANT booking).
function ourEvent(overrides = {}) {
  return {
    id: EVENT_ID,
    start: { dateTime: new Date(START_MS).toISOString() },
    end: { dateTime: new Date(END_MS).toISOString() },
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        visitorEmail: EMAIL,
        visitorName: 'Jane Doe',
        visitorPhone: '555-0100',
        visitorTimeZone: 'America/Toronto',
        lang: 'en',
        slackTs: 'slack-ts-original',
        ...(overrides.privateExtra || {}),
      },
    },
    ...(overrides.event || {}),
  };
}

function goodBody(overrides = {}) {
  return {
    eventId: EVENT_ID,
    email: EMAIL,
    token: bt.makeBookingToken(EVENT_ID, EMAIL),
    ...overrides,
  };
}

test('happy path: 200 {ok:true} and deleteEvent is called with the event id', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  const slackSpy = spyStub({ ts: null });
  const emailSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: bslack, key: 'postBookingChanged', value: slackSpy },
    { obj: email, key: 'sendCancellationNotice', value: emailSpy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody() }, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
    assert.equal(deleteSpy.calls.length, 1);
    assert.equal(deleteSpy.calls[0][0], EVENT_ID);

    // Best-effort notifications: the shared booking-slack and email senders.
    assert.equal(slackSpy.calls.length, 1);
    assert.equal(slackSpy.calls[0][1], 'cancelled');
    assert.equal(slackSpy.calls[0][2], 'slack-ts-original');
    assert.equal(emailSpy.calls.length, 1);
    const b = emailSpy.calls[0][0];
    assert.equal(b.eventId, EVENT_ID);
    assert.equal(b.name, 'Jane Doe');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '555-0100');
    assert.equal(b.startMs, START_MS);
    assert.equal(b.endMs, END_MS);
    assert.equal(b.visitorTimeZone, 'America/Toronto');
    assert.equal(b.templateTimeZone, 'America/Toronto');
    assert.equal(b.lang, 'en');
    // Nothing left to manage after a cancellation.
    assert.equal(b.manageToken, '');
    assert.equal(b.meetLink, '');
  });
});

// THE mirror-image defense-in-depth check, and it MUST come before the
// delete: a 403 that arrives after the event is already gone is not a
// rejection. manageToken is an HMAC over eventId+email only -- it encodes no
// audience -- so a token that is genuinely valid for a CHECK-IN booking must
// still be refused here: the applicant endpoint must never cancel a check-in
// booking.
test('an event tagged audience: "checkin" -> 403 FORBIDDEN, and deleteEvent is never called', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  const checkinTaggedEvent = ourEvent({ privateExtra: { audience: 'checkin' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinTaggedEvent }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ], async () => {
    const res = makeRes();
    // The token here is genuinely valid for this eventId+email pair.
    await handler({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(res._json.message, 'That booking is not managed here.');
    assert.equal(deleteSpy.calls.length, 0,
      'the applicant endpoint must never cancel a check-in booking');
  });
});

test('a rejected token/ownership check (loadBooking failure) is passed through, e.g. 403 FORBIDDEN', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody({ token: 'wrong-token' }) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(deleteSpy.calls.length, 0);
  });
});

test('a missing eventId/email/token -> 400 BAD_REQUEST (loadBooking passthrough)', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ], async () => {
    for (const missing of ['eventId', 'email', 'token']) {
      const body = goodBody();
      delete body[missing];
      const res = makeRes();
      await handler({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `missing ${missing} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
    assert.equal(deleteSpy.calls.length, 0);
  });
});

test('an event that no longer exists -> 404 NOT_FOUND (loadBooking passthrough)', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: 'not found' }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'NOT_FOUND');
  });
});

test('CALENDAR_NOT_CONNECTED -> 503 (loadBooking passthrough)', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
});

test('a failed deleteEvent -> 502 UPSTREAM, and no cancellation notice is sent', async () => {
  envSetup();
  const slackSpy = spyStub({ ts: null });
  const emailSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: false, reason: 'delete refused' }) },
    { obj: bslack, key: 'postBookingChanged', value: slackSpy },
    { obj: email, key: 'sendCancellationNotice', value: emailSpy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
    assert.equal(slackSpy.calls.length, 0,
      'never notify a cancellation while the booking is still on the calendar');
    assert.equal(emailSpy.calls.length, 0,
      'never tell a visitor their call is cancelled when it is still on the calendar');
  });
});

// The slot is already freed, which is what the visitor asked for, so a thrown
// notification error must not turn a successful cancellation into an error.
test('a throwing Slack stub and a throwing email stub still result in a 200', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => { throw new Error('slack is down'); } },
    { obj: email, key: 'sendCancellationNotice', value: async () => { throw new Error('email is down'); } },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
  });
});

test('an all-day event still cancels without throwing', async () => {
  envSetup();
  const allDay = ourEvent();
  allDay.start = { date: '2026-12-01' };
  allDay.end = { date: '2026-12-02' };
  const deleteSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: allDay }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ], async () => {
    const res = makeRes();
    await assert.doesNotReject(() => handler({ method: 'POST', body: goodBody() }, res));
    assert.equal(res._status, 200);
    assert.equal(deleteSpy.calls.length, 1);
  });
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await handler({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
