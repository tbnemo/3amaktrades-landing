const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const cslack = require('../api/_checkin-slack');
const cemail = require('../api/_checkin-email');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const loadMod = require('../api/_load-checkin-template');
const av = require('../api/_availability');

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

const handlerPath = require.resolve('../api/calendar-checkin');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath).cancel;
}

const CHECKIN_TEMPLATE = av.normalizeTemplate({
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '12:00' },
    tue: { enabled: true, start: '09:00', end: '12:00' },
    wed: { enabled: true, start: '09:00', end: '12:00' },
    thu: { enabled: true, start: '09:00', end: '12:00' },
    fri: { enabled: true, start: '09:00', end: '12:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 15, bufferMinutes: 0, minNoticeHours: 24,
});

const EVENT_ID = 'evt-checkin-cancel-1';
const EMAIL = 'alice@example.com';
const START_MS = Date.UTC(2026, 10, 12, 14, 0, 0);
const END_MS = START_MS + 15 * 60 * 1000;

function checkinEvent(overrides = {}) {
  return {
    id: EVENT_ID,
    start: { dateTime: new Date(START_MS).toISOString() },
    end: { dateTime: new Date(END_MS).toISOString() },
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        audience: 'checkin',
        visitorEmail: EMAIL,
        visitorName: 'Alice Client',
        visitorPhone: '5550100100',
        visitorTimeZone: 'Europe/Istanbul',
        lang: 'en',
        slackTs: 'slack-ts-original',
        ...(overrides.privateExtra || {}),
      },
    },
    ...(overrides.event || {}),
  };
}

function applicantEvent() {
  const e = checkinEvent();
  delete e.extendedProperties.private.audience;
  return e;
}

function goodBody(overrides = {}) {
  return {
    eventId: EVENT_ID,
    email: EMAIL,
    token: bt.makeBookingToken(EVENT_ID, EMAIL),
    ...overrides,
  };
}

function baseStubs(extra = []) {
  return [
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => ({ ts: null }) },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

test('happy path: 200 {ok:true} and deleteEvent is called with the event id', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
    assert.equal(deleteSpy.calls.length, 1);
    assert.equal(deleteSpy.calls[0][0], EVENT_ID);
  });
  delete require.cache[handlerPath];
});

// The audience check has to run BEFORE the delete: a 403 that arrives after the
// event is already gone is not a rejection.
test('an APPLICANT event -> 403 FORBIDDEN and deleteEvent is NEVER called', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: applicantEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(deleteSpy.calls.length, 0,
      'a check-in link must never cancel an applicant booking');
  });
  delete require.cache[handlerPath];
});

test('an event tagged with some OTHER audience -> 403 and no delete', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: checkinEvent({ privateExtra: { audience: 'something-else' } }) }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 403);
    assert.equal(deleteSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('the CHECK-IN Slack and email senders are called with the cancelled Booking; applicant ones never are', async () => {
  envSetup();
  const ciSlack = spyStub({ ts: null });
  const ciEmail = spyStub({ ok: true });
  const appSlack = spyStub({ ts: null });
  const appEmail = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: ciSlack },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: ciEmail },
    { obj: bslack, key: 'postBookingChanged', value: appSlack },
    { obj: email, key: 'sendCancellationNotice', value: appEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);

    assert.equal(ciSlack.calls.length, 1);
    assert.equal(ciSlack.calls[0][1], 'cancelled');
    assert.equal(ciSlack.calls[0][2], 'slack-ts-original');
    assert.equal(ciEmail.calls.length, 1);
    assert.equal(appSlack.calls.length, 0);
    assert.equal(appEmail.calls.length, 0);

    const b = ciEmail.calls[0][0];
    assert.equal(b.eventId, EVENT_ID);
    assert.equal(b.name, 'Alice Client');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '5550100100');
    assert.equal(b.startMs, START_MS);
    assert.equal(b.endMs, END_MS);
    assert.equal(b.visitorTimeZone, 'Europe/Istanbul');
    assert.equal(b.templateTimeZone, 'America/Toronto');
    assert.equal(b.lang, 'en');
    // Nothing to manage after a cancellation.
    assert.equal(b.manageToken, '');
    assert.equal(b.meetLink, '');
  });
  delete require.cache[handlerPath];
});

test('a wrong token -> 403, a missing field -> 400, a vanished event -> 404 (loadBooking passthrough)', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();

    const wrong = makeRes();
    await h({ method: 'POST', body: goodBody({ token: 'wrong-token' }) }, wrong);
    assert.equal(wrong._status, 403);
    assert.equal(wrong._json.error, 'FORBIDDEN');

    for (const missing of ['eventId', 'email', 'token']) {
      const body = goodBody();
      delete body[missing];
      const res = makeRes();
      await h({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `missing ${missing} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
    assert.equal(deleteSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: 'not found' }) },
    { obj: gcal, key: 'deleteEvent', value: spyStub({ ok: true }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'NOT_FOUND');
  });
  delete require.cache[handlerPath];
});

test('an email whose case differs from the stored one still cancels', async () => {
  envSetup();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    // makeBookingToken normalizes the email, so an upper-case address produces
    // the same token and loadBooking's own comparison is normalized too.
    await h({ method: 'POST', body: {
      eventId: EVENT_ID,
      email: 'ALICE@EXAMPLE.COM',
      token: bt.makeBookingToken(EVENT_ID, 'ALICE@EXAMPLE.COM'),
    } }, res);
    assert.equal(res._status, 200);
  });
  delete require.cache[handlerPath];
});

test('a failed deleteEvent -> 502 UPSTREAM, and no cancellation notice is sent', async () => {
  envSetup();
  const ciEmail = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: false, reason: 'delete refused' }) },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: ciEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
    assert.equal(ciEmail.calls.length, 0,
      'never tell a client their call is cancelled when it is still on the calendar');
  });
  delete require.cache[handlerPath];
});

test('CALENDAR_NOT_CONNECTED -> 503 (loadBooking passthrough)', async () => {
  envSetup();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
    { obj: gcal, key: 'deleteEvent', value: spyStub({ ok: true }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
  delete require.cache[handlerPath];
});

// The slot is already freed, which is what the client asked for, so notification
// failures must not turn a successful cancellation into an error.
test('a throwing Slack stub and a throwing email stub still result in a 200', async () => {
  envSetup();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => { throw new Error('slack is down'); } },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: async () => { throw new Error('email is down'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
  });
  delete require.cache[handlerPath];
});

// A resolved {ok:false} is not a throw -- the cancellation notice was sent
// without error and simply failed. That silent failure must still surface,
// not just the throwing case above.
test('a cancellation notice that returns {ok:false} raises a system alert but keeps the 200', async () => {
  envSetup();
  const alertSpy = spyStub(undefined);
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: async () => ({ ok: false, reason: 'resend 422' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
    assert.equal(alertSpy.calls.length, 1, 'a silently undelivered cancellation notice must be visible');
    assert.match(String(alertSpy.calls[0][0]), new RegExp(EVENT_ID));
    assert.match(String(alertSpy.calls[0][0]), /resend 422/);
  });
  delete require.cache[handlerPath];
});

test('an all-day event still cancels without throwing', async () => {
  envSetup();
  const allDay = checkinEvent();
  allDay.start = { date: '2026-12-01' };
  allDay.end = { date: '2026-12-02' };
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: allDay }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await assert.doesNotReject(() => h({ method: 'POST', body: goodBody() }, res));
    assert.equal(res._status, 200);
    assert.equal(deleteSpy.calls.length, 1);
  });
  delete require.cache[handlerPath];
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await require('../api/calendar-checkin').cancel({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
