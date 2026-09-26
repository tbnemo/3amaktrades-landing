const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const email = require('../api/_email');
const handler = require('../api/calendar-reminders');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

// Every blob read comes back "not written yet" (ok:true, data:null), which is
// how loadTemplate() falls back to the normalized DEFAULT_TEMPLATE.
function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
}

const SECRET = 'test-cron-secret';

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.CRON_SECRET = SECRET;
  store.__setClientForTests(emptyBlobClient());
}

// Applies a set of {obj, key, value} monkey-patches, runs fn, then restores
// every original value -- even if fn throws or an assertion fails -- so a
// stub installed by one test can never leak into the next.
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

function reqGet(bearer) {
  const headers = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return { method: 'GET', headers };
}

const EMAIL = 'jane@example.com';

function futureMs(hoursFromNow = 2) { return Date.now() + hoursFromNow * 3600000; }
function pastMs(hoursAgo = 1) { return Date.now() - hoursAgo * 3600000; }

function makeEvent({ id, startMs, endMs, visitorEmail = EMAIL, reminderSent, extra = {} }) {
  const priv = {
    bookingSource: guard.EVENT_MARKER,
    visitorName: 'Jane Doe',
    visitorPhone: '555-0100',
    visitorTimeZone: 'America/Toronto',
    lang: 'en',
    ...extra,
  };
  if (visitorEmail !== undefined && visitorEmail !== null) priv.visitorEmail = visitorEmail;
  if (reminderSent !== undefined) priv.reminderSent = reminderSent;
  return {
    id,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs || (startMs + 30 * 60000)).toISOString() },
    hangoutLink: 'https://meet.example/abc',
    extendedProperties: { private: priv },
  };
}

test('CRON_SECRET unset -> 401 with a message mentioning "CRON_SECRET not set", and listEvents is never called', async () => {
  delete process.env.CRON_SECRET;
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  store.__setClientForTests(emptyBlobClient());

  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(reqGet('anything'), res);
    assert.equal(res._status, 401);
    assert.match(JSON.stringify(res._json), /CRON_SECRET not set/);
    assert.equal(listSpy.calls.length, 0, 'listEvents must not run without CRON_SECRET');
  });

  process.env.CRON_SECRET = SECRET; // restore for later tests
});

test('wrong bearer token -> 401, and listEvents is never called', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(reqGet('not-the-secret'), res);
    assert.equal(res._status, 401);
    assert.equal(listSpy.calls.length, 0, 'listEvents must not run with a wrong token');
  });
});

test('correct bearer -> 200 with {ok:true, considered, sent, skipped}', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.considered, 0);
    assert.equal(res._json.sent, 0);
    assert.equal(res._json.skipped, 0);
  });
});

test('listEvents is called with privateExtendedProperty containing bookingSource=3amak-booking', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(listSpy.calls.length, 1);
    const arg = listSpy.calls[0][0];
    assert.equal(arg.privateExtendedProperty, `bookingSource=${guard.EVENT_MARKER}`);
    assert.equal(arg.privateExtendedProperty, 'bookingSource=3amak-booking');
  });
});

test('an event with reminderSent === "1" is skipped: sendReminder is not called, skipped increments', async () => {
  envSetup();
  const event = makeEvent({ id: 'evt-already', startMs: futureMs(), reminderSent: '1' });
  const sendSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: sendSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.skipped, 1);
    assert.equal(res._json.sent, 0);
    assert.equal(sendSpy.calls.length, 0);
  });
});

test('an event with no visitorEmail is skipped', async () => {
  envSetup();
  const event = makeEvent({ id: 'evt-noemail', startMs: futureMs(), visitorEmail: null });
  const sendSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: sendSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.skipped, 1);
    assert.equal(res._json.sent, 0);
    assert.equal(sendSpy.calls.length, 0);
  });
});

test('an event whose startMs is in the past is skipped', async () => {
  envSetup();
  const event = makeEvent({ id: 'evt-past', startMs: pastMs(), endMs: pastMs(0.5) });
  const sendSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: sendSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.skipped, 1);
    assert.equal(res._json.sent, 0);
    assert.equal(sendSpy.calls.length, 0);
  });
});

test('ORDERING: a successful sendReminder results in patchEvent being called setting reminderSent to "1"', async () => {
  envSetup();
  const event = makeEvent({ id: 'evt-success', startMs: futureMs() });
  const patchSpy = spyStub({ ok: true, event: {} });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 1);
    assert.equal(patchSpy.calls.length, 1, 'patchEvent must be called after a successful send');
    const [patchedId, patch] = patchSpy.calls[0];
    assert.equal(patchedId, 'evt-success');
    assert.equal(patch.extendedProperties.private.reminderSent, '1');
  });
});

test('ORDERING (inverse): a FAILED sendReminder results in patchEvent NOT being called, so the next run retries', async () => {
  envSetup();
  const event = makeEvent({ id: 'evt-failure', startMs: futureMs() });
  const patchSpy = spyStub({ ok: true, event: {} });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: async () => ({ ok: false, reason: 'resend down' }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 0);
    assert.equal(res._json.skipped, 1);
    assert.equal(patchSpy.calls.length, 0,
      'a failed send must never mark reminderSent -- that would lose the reminder forever');
  });
});

test('BATCH ISOLATION: a throwing sendReminder does not abort the run -- the handler still resolves 200, the throwing event is skipped without being marked reminded, and a LATER event in the same batch is still processed', async () => {
  envSetup();
  const throwingEvent = makeEvent({ id: 'evt-throws', startMs: futureMs(1) });
  const laterEvent = makeEvent({ id: 'evt-after-throw', startMs: futureMs(3) });
  const patchSpy = spyStub({ ok: true, event: {} });

  const sendStub = async (b) => {
    if (b.eventId === 'evt-throws') throw new Error('boom: malformed event data');
    return { ok: true };
  };

  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [throwingEvent, laterEvent] }) },
    { obj: email, key: 'sendReminder', value: sendStub },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);

    assert.equal(res._status, 200,
      'the handler must still resolve and produce a response, not throw out of the exported function');
    assert.equal(res._json.ok, true);
    assert.equal(res._json.skipped, 1, 'the throwing event must be counted as skipped');
    assert.equal(res._json.sent, 1,
      'a LATER event in the same batch must still be processed -- this is what proves batch isolation, not merely "it did not crash"');
    assert.equal(patchSpy.calls.length, 1, 'only the successfully-sent later event may be patched');
    assert.equal(patchSpy.calls[0][0], 'evt-after-throw');
  });
});

// The reminder used to read only event.hangoutLink, so a Meet link that lives ONLY
// in conferenceData.entryPoints was silently dropped from the reminder email -- the
// one email whose entire job is to get the visitor to the call.
test('the reminder carries a Meet link that exists only in conferenceData.entryPoints', async () => {
  envSetup();
  const event = makeEvent({ id: 'evt-entrypoints', startMs: futureMs() });
  delete event.hangoutLink;
  event.conferenceData = { entryPoints: [
    { entryPointType: 'phone', uri: 'tel:+15550100' },
    { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
  ] };

  const sendSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: sendSpy },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 1);
    assert.equal(sendSpy.calls[0][0].meetLink, 'https://meet.google.com/abc-defg-hij');
  });
});

test('a wrong-LENGTH bearer header returns 401 and does not throw', async () => {
  envSetup(); // CRON_SECRET = SECRET ('test-cron-secret')
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    // Deliberately a different length than `Bearer ${SECRET}` -- a naive
    // crypto.timingSafeEqual call without a length guard would throw on this
    // instead of cleanly returning false.
    await assert.doesNotReject(() => handler(reqGet('x'), res));
    assert.equal(res._status, 401);
    assert.equal(listSpy.calls.length, 0, 'listEvents must not run with a wrong-length token');
  });
});

test('listEvents returning CALENDAR_NOT_CONNECTED -> 503; a generic failure -> 502', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });

  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'some upstream 500' }) },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
});

test('a non-GET method returns 405', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, res);
  assert.equal(res._status, 405);
});
