const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const email = require('../api/_email');
const handler = require('../api/calendar-reminders');
const auth = require('../api/_admin-auth');
const cemail = require('../api/_checkin-email');
const loadCheckinMod = require('../api/_load-checkin-template');
const av = require('../api/_availability');
const bslack = require('../api/_booking-slack');
const cslack = require('../api/_checkin-slack');

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

// ===========================================================================
// Admin-session catch-up auth: a SECOND, independent way in, for the "Send
// Due Reminders Now" button on admin.html -- recovering from a day the
// once-daily Vercel cron missed entirely. Must not weaken or replace the
// CRON_SECRET path real Vercel cron depends on.
//
// POST-ONLY (code review, CSRF finding): the session cookie is
// SameSite=Lax, which browsers DO attach on a top-level cross-site GET (a
// plain link, a redirect, window.open). A bearer-only endpoint never had
// this exposure. Restricting the session path to POST forces a CORS
// preflight the attacker's page cannot pass (we send no CORS headers), so
// these tests cover both halves: POST+cookie works, GET+cookie (even a
// perfectly valid one) does not.
// ===========================================================================

function reqWithCookie(cookie, method) {
  return { method: method || 'POST', headers: cookie ? { cookie } : {} };
}

function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }

test('a POST with a valid admin session cookie and NO bearer header at all is authorized', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const res = makeRes();
    await handler(reqWithCookie(cookieValueOf(auth.issueSessionCookie())), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
  });
});

// CSRF finding, closed: a GET carrying the EXACT SAME valid session cookie
// must still be rejected -- a GET is exactly what a hostile page's top-level
// navigation or window.open can forge (it rides along automatically on
// SameSite=Lax); a POST with a custom Content-Type cannot be forged the
// same way without a CORS opt-in this server never grants.
test('a GET with a valid admin session cookie is REJECTED -- the session path is POST-only (CSRF)', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(reqWithCookie(cookieValueOf(auth.issueSessionCookie()), 'GET'), res);
    assert.equal(res._status, 401);
    assert.equal(listSpy.calls.length, 0, 'a forgeable GET must never trigger a real send, even with a valid cookie');
  });
});

test('a request with neither a valid session cookie nor the CRON_SECRET bearer is still rejected', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(reqWithCookie(null), res);
    assert.equal(res._status, 401);
    assert.equal(listSpy.calls.length, 0);
  });
});

test('a garbage/forged session cookie is rejected the same as no cookie at all', async () => {
  envSetup();
  const res = makeRes();
  await handler(reqWithCookie('amak_admin=forged.garbage'), res);
  assert.equal(res._status, 401);
});

test('the CRON_SECRET bearer path still works exactly as before, with no session cookie present at all', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true, 'a real Vercel cron request (bearer only, no cookie) must be unaffected');
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

// ---------------------------------------------------------------------------
// The window itself. Until now NOTHING in this file asserted what timeMin/timeMax
// the handler actually asks Google for, because the lead time was a module-load
// constant no test could vary. That window IS the reminder mechanism: if it is
// computed wrongly, every test above still passes (they all hand the handler
// events directly) while production quietly reminds nobody.
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.UTC(2027, 6, 14, 0, 0, 0); // a Wednesday, 00:00 UTC

function withFixedNow(nowMs, fn) {
  const orig = Date.now;
  Date.now = () => nowMs;
  return Promise.resolve(fn()).finally(() => { Date.now = orig; });
}

async function captureWindow(leadEnv) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  if (leadEnv === undefined) delete process.env.REMINDER_LEAD_HOURS;
  else process.env.REMINDER_LEAD_HOURS = leadEnv;

  try {
    envSetup();
    const listSpy = spyStub({ ok: true, events: [] });
    let arg;
    await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], () =>
      withFixedNow(FIXED_NOW, async () => {
        const res = makeRes();
        await handler(reqGet(SECRET), res);
        assert.equal(res._status, 200);
        assert.equal(listSpy.calls.length, 1);
        arg = listSpy.calls[0][0];
      }));
    return arg;
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
}

test('WINDOW: listEvents is asked for exactly [now, now + REMINDER_LEAD_HOURS]', async () => {
  // The deployed value. If the handler ignored the env var, timeMax would land
  // 24h out and this fails -- which is the whole point.
  const arg = await captureWindow('36');
  assert.equal(arg.timeMinIso, new Date(FIXED_NOW).toISOString(),
    'timeMin must be now: a window starting in the past would re-list finished calls');
  assert.equal(arg.timeMaxIso, new Date(FIXED_NOW + 36 * 3600000).toISOString(),
    'timeMax must be now + 36h, read from REMINDER_LEAD_HOURS');
});

test('WINDOW: the lead time falls back to 24h when REMINDER_LEAD_HOURS is absent or unusable', async () => {
  for (const bad of [undefined, '', 'garbage', '0', '-5']) {
    const arg = await captureWindow(bad);
    assert.equal(arg.timeMaxIso, new Date(FIXED_NOW + 24 * 3600000).toISOString(),
      `REMINDER_LEAD_HOURS=${JSON.stringify(bad)} must fall back to 24h, never to 0 or a negative window`);
  }
});

test('WINDOW: leadHours() reads the env var live rather than freezing it at module load', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  try {
    process.env.REMINDER_LEAD_HOURS = '36';
    assert.equal(handler.leadHours(), 36);
    process.env.REMINDER_LEAD_HOURS = '48';
    assert.equal(handler.leadHours(), 48,
      'a module-load constant would still report 36 here -- that is the bug this replaces');
    assert.deepEqual(handler.reminderWindow(1000),
      { timeMinMs: 1000, timeMaxMs: 1000 + 48 * 3600000 });
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
});

test('WINDOW: wouldRemind covers both edges -- inclusive at now and at now+lead, exclusive outside', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  try {
    process.env.REMINDER_LEAD_HOURS = '36';
    const now = FIXED_NOW, lead = 36 * 3600000;
    assert.equal(handler.wouldRemind(now, now), true, 'starting exactly now: still remind');
    assert.equal(handler.wouldRemind(now + lead, now), true, 'the far edge is inside the window');
    assert.equal(handler.wouldRemind(now - 1, now), false, 'already under way: never remind');
    assert.equal(handler.wouldRemind(now + lead + 1, now), false, 'beyond the window: not yet');
    assert.equal(handler.wouldRemind(NaN, now), false, 'an unparseable start is never reminded');
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
});

test('WINDOW: an event starting beyond now+lead is skipped even if listEvents hands it over', async () => {
  // Google's own filter should already have excluded it, so this is belt and
  // braces -- but the handler must not depend on an upstream filter for a rule it
  // states itself, or a Google quirk turns into a reminder sent days too early.
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  process.env.REMINDER_LEAD_HOURS = '24';
  try {
    envSetup();
    const tooFar = makeEvent({ id: 'evt-beyond-window', startMs: futureMs(30) }); // 30h > 24h
    const inWindow = makeEvent({ id: 'evt-inside-window', startMs: futureMs(5) });
    const sendSpy = spyStub({ ok: true });
    await withStubs([
      { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [tooFar, inWindow] }) },
      { obj: email, key: 'sendReminder', value: sendSpy },
      { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    ], async () => {
      const res = makeRes();
      await handler(reqGet(SECRET), res);
      assert.equal(res._status, 200);
      assert.equal(res._json.sent, 1);
      assert.equal(res._json.skipped, 1);
      assert.deepEqual(sendSpy.calls.map(c => c[0].eventId), ['evt-inside-window']);
    });
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
});

// ---------------------------------------------------------------------------
// needsImmediateReminder: the other half of the delivery guarantee.
//
// wouldRemind answers "would a cron run AT THIS INSTANT send this reminder".
// needsImmediateReminder answers the question the four booking/reschedule
// handlers have to ask instead: "can the once-daily cron be RELIED ON to send
// this one at all, or must I send it myself right now?" The two together are
// what make a booking's reminder unconditional regardless of how low an admin
// sets minNoticeHours -- see test/reminder-delivery-guarantee.test.js, which
// proves exactly that composition end to end.
//
// These are direct unit tests on the predicate. The boundary cases are the
// point: it has to agree with the >= in the invariant, down to the edge.
// ---------------------------------------------------------------------------

function withLead(leadEnv, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  if (leadEnv === undefined) delete process.env.REMINDER_LEAD_HOURS;
  else process.env.REMINDER_LEAD_HOURS = String(leadEnv);
  try {
    return fn();
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
}

test('CRON_PERIOD_HOURS is exported as a real 24, not left implicit in comments', () => {
  assert.equal(handler.CRON_PERIOD_HOURS, 24,
    'the cron period is the number the whole guarantee is measured against; '
    + 'test/reminder-delivery-guarantee.test.js cross-checks it against vercel.json');
});

test('IMMEDIATE: a booking made with plenty of notice does NOT need an immediate reminder', () => {
  withLead(undefined, () => { // the 24h fallback
    const now = FIXED_NOW;
    assert.equal(handler.needsImmediateReminder(now + 72 * 3600000, now), false,
      'three days out: a daily tick is certain to land in the eligible window');
    assert.equal(handler.needsImmediateReminder(now + 30 * 24 * 3600000, now), false);
  });
});

test('IMMEDIATE: a booking made with well under a day of notice DOES need one', () => {
  withLead(undefined, () => {
    const now = FIXED_NOW;
    // The case the whole feature exists for: same-day booking.
    assert.equal(handler.needsImmediateReminder(now + 1 * 3600000, now), true,
      'one hour out: the eligible window is 1h long and 24h-apart ticks can miss it entirely');
    assert.equal(handler.needsImmediateReminder(now + 23 * 3600000, now), true);
    assert.equal(handler.needsImmediateReminder(now + 60000, now), true);
    assert.equal(handler.needsImmediateReminder(now, now), true,
      'zero notice is still zero-length coverage, so it still needs sending now');
  });
});

// THE boundary. The invariant that governs the cron path is `>= the cron
// period is safe`, so 24h of notice is exactly enough and must NOT trigger an
// immediate send -- otherwise every normal booking would get a second email and
// the "nothing changes at normal notice" promise would be false.
test('IMMEDIATE: exactly 24h of notice is the safe side of the boundary -- false', () => {
  withLead(undefined, () => {
    const now = FIXED_NOW;
    assert.equal(handler.needsImmediateReminder(now + 24 * 3600000, now), false,
      'at exactly the cron period the eligible window is guaranteed to contain a tick');
    assert.equal(handler.needsImmediateReminder(now + 24 * 3600000 - 1, now), true,
      'one millisecond short of the period is already not guaranteed');
    assert.equal(handler.needsImmediateReminder(now + 24 * 3600000 + 1, now), false);
  });
});

test('IMMEDIATE: the decision reads REMINDER_LEAD_HOURS live, and a lead shorter than the cron period makes EVERY booking need one', () => {
  const now = FIXED_NOW;

  // lead=36 (the deployed value): the lead no longer binds below 24h, so the
  // notice alone decides, same as the default-lead cases above.
  withLead(36, () => {
    assert.equal(handler.leadHours(), 36, 'the module must be reading the env var live');
    assert.equal(handler.needsImmediateReminder(now + 30 * 3600000, now), false);
    assert.equal(handler.needsImmediateReminder(now + 20 * 3600000, now), true);
  });

  // lead=12: the eligible window is at most 12h long no matter how far ahead the
  // booking is made, which is shorter than the 24h between ticks -- so the cron
  // can be relied on for NOTHING and every booking must be sent immediately.
  // This is the same failure the invariant forbids, stated from the other side.
  withLead(12, () => {
    assert.equal(handler.needsImmediateReminder(now + 30 * 24 * 3600000, now), true,
      'a lead shorter than the cron period means no booking, however distant, is guaranteed a tick');
    assert.equal(handler.needsImmediateReminder(now + 2 * 3600000, now), true);
  });

  // A garbage env var falls back to 24, so the boundary is the 24h one again
  // rather than silently becoming 0 and immediate-sending everything.
  withLead('garbage', () => {
    assert.equal(handler.needsImmediateReminder(now + 24 * 3600000, now), false);
    assert.equal(handler.needsImmediateReminder(now + 23 * 3600000, now), true);
  });
});

test('IMMEDIATE: a past start, and an unparseable one, are never immediate-reminded', () => {
  withLead(undefined, () => {
    const now = FIXED_NOW;
    assert.equal(handler.needsImmediateReminder(now - 1, now), false,
      'already under way: wouldRemind drops it too, and a reminder would be worse than useless');
    assert.equal(handler.needsImmediateReminder(now - 5 * 3600000, now), false);
    assert.equal(handler.needsImmediateReminder(NaN, now), false);
    assert.equal(handler.needsImmediateReminder(now + 3600000, NaN), false);
    assert.equal(handler.needsImmediateReminder(undefined, now), false);
    assert.equal(handler.needsImmediateReminder(now + 3600000, undefined), false);
  });
});

// The composition, asserted on the two exported predicates directly: a booking
// the cron can be trusted with is one wouldRemind will eventually accept, and a
// booking it cannot be trusted with is the one needsImmediateReminder catches.
// Neither case leaves a booking with nobody responsible for it.
test('IMMEDIATE: every booking is covered by exactly one of the two paths', () => {
  withLead(undefined, () => {
    const now = FIXED_NOW;
    for (const noticeHours of [0, 0.5, 1, 6, 12, 23.99, 24, 24.01, 36, 72, 240]) {
      const start = now + noticeHours * 3600000;
      const immediate = handler.needsImmediateReminder(start, now);
      // If the cron is trusted, there must be SOME instant at which a run would
      // pick this booking up -- the latest eligible one being the start itself.
      const cronCanEverFire = handler.wouldRemind(start, start)
        || handler.wouldRemind(start, start - handler.leadHours() * 3600000);
      assert.ok(immediate || cronCanEverFire,
        `${noticeHours}h notice: neither path would remind this booking`);
    }
  });
});

// POST is now a legitimate method too (the admin-session catch-up path is
// POST-only, see authorized()'s CSRF comment) -- this must use a method
// that is genuinely never valid, not POST.
test('a method that is neither GET nor POST returns 405', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'PUT', headers: { authorization: `Bearer ${SECRET}` } }, res);
  assert.equal(res._status, 405);
});

test('POST with the correct CRON_SECRET bearer also succeeds (the method gate is not GET-only)', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
  });
});

// ---- audience branching -------------------------------------------------
// calendar-reminders.js is ONE cron job serving both audiences (Vercel Hobby
// caps cron count/frequency, and this project already spends its single daily
// slot here). The loop already walks every event carrying the shared
// bookingSource marker, so the only thing that must be right is which sender
// each event gets.

function makeCheckinEvent({ id, startMs, endMs, visitorEmail = EMAIL, reminderSent }) {
  // The existing makeEvent already merges `extra` into extendedProperties.private,
  // so the only difference from an applicant fixture is the audience tag.
  return makeEvent({ id, startMs, endMs, visitorEmail, reminderSent,
    extra: { audience: 'checkin' } });
}

test('a checkin-tagged event goes to sendCheckinReminder, never to the applicant sendReminder', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 1);
    assert.equal(ciSpy.calls.length, 1, 'the check-in sender must be used');
    assert.equal(appSpy.calls.length, 0, 'the applicant sender must NOT be used');
  });
});

test('an untagged (applicant) event still goes to the applicant sendReminder', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(appSpy.calls.length, 1);
    assert.equal(ciSpy.calls.length, 0);
  });
});

test('a mixed batch routes each event to its own sender in ONE run', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app-1', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci-1', startMs: futureMs(3) }),
        makeEvent({ id: 'evt-app-2', startMs: futureMs(4) }),
        makeCheckinEvent({ id: 'evt-ci-2', startMs: futureMs(5) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.considered, 4);
    assert.equal(res._json.sent, 4);
    assert.deepEqual(appSpy.calls.map(c => c[0].eventId).sort(), ['evt-app-1', 'evt-app-2']);
    assert.deepEqual(ciSpy.calls.map(c => c[0].eventId).sort(), ['evt-ci-1', 'evt-ci-2']);
  });
});

// A check-in booked against a DIFFERENT timezone than the applicant hours must
// be described to Omar in the check-in template's zone, not the applicant one.
test('a check-in reminder carries the CHECK-IN template timezone; an applicant one carries the applicant zone', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  const checkinTpl = av.normalizeTemplate({
    timezone: 'Europe/Istanbul',
    days: av.DEFAULT_TEMPLATE.days,
    slotMinutes: 15, bufferMinutes: 0, minNoticeHours: 24,
  });
  await withStubs([
    { obj: loadCheckinMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: checkinTpl, usedDefault: false }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(ciSpy.calls[0][0].templateTimeZone, 'Europe/Istanbul');
    assert.equal(appSpy.calls[0][0].templateTimeZone, 'America/Toronto');
  });
});

test('a check-in reminder receives the full Booking shape the check-in senders expect', async () => {
  envSetup();
  const ciSpy = spyStub({ ok: true });
  const startMs = futureMs(2);
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-shape', startMs, endMs: startMs + 15 * 60000 }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    const b = ciSpy.calls[0][0];
    assert.equal(b.eventId, 'evt-shape');
    assert.equal(b.name, 'Jane Doe');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '555-0100');
    assert.equal(b.startMs, startMs);
    assert.equal(b.endMs, startMs + 15 * 60000);
    assert.equal(b.visitorTimeZone, 'America/Toronto');
    assert.equal(typeof b.templateTimeZone, 'string');
    assert.equal(typeof b.manageToken, 'string');
    assert.ok(b.manageToken.length > 0);
    assert.equal(b.meetLink, 'https://meet.example/abc');
    assert.equal(b.lang, 'en');
  });
});

test('an already-reminded check-in event is skipped, exactly like an applicant one', async () => {
  envSetup();
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-done', startMs: futureMs(2), reminderSent: '1' }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.sent, 0);
    assert.equal(res._json.skipped, 1);
    assert.equal(ciSpy.calls.length, 0);
  });
});

test('a successful check-in reminder sets reminderSent AFTER the send, never before', async () => {
  envSetup();
  const order = [];
  const patchSpy = async (...args) => { order.push('patch'); return { ok: true, event: {} }; };
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-flag', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: async () => { order.push('send'); return { ok: true }; } },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.sent, 1);
    assert.deepEqual(order, ['send', 'patch'],
      'a duplicate reminder is a far smaller failure than a call the client forgets');
  });
});

test('a failing check-in reminder leaves the flag unset and raises a system alert', async () => {
  envSetup();
  const patchSpy = spyStub({ ok: true, event: {} });
  const alertSpy = spyStub(undefined);
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-mailfail', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: async () => ({ ok: false, reason: 'resend 422' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.sent, 0);
    assert.equal(res._json.skipped, 1);
    assert.equal(patchSpy.calls.length, 0, 'the flag must stay unset so a later run can retry');
    assert.equal(alertSpy.calls.length, 1);
    assert.match(String(alertSpy.calls[0][0]), /evt-mailfail/);
  });
});

// Per-item isolation: one throwing check-in must not sink the applicant events
// in the same batch.
test('a throwing check-in sender does not prevent the other events in the batch from being reminded', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-boom', startMs: futureMs(2) }),
        makeEvent({ id: 'evt-fine', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: async () => { throw new Error('boom'); } },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 1);
    assert.equal(res._json.skipped, 1);
    assert.equal(appSpy.calls.length, 1, 'the applicant event must still be reminded');
  });
});

test('a check-in event with no visitorEmail is skipped without sending', async () => {
  envSetup();
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-noemail', startMs: futureMs(2), visitorEmail: null }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.skipped, 1);
    assert.equal(ciSpy.calls.length, 0);
  });
});

// A failed check-in template read must not stop applicant reminders, and must
// not stop check-in reminders either -- loadCheckinTemplate always returns a
// usable default template alongside its !ok.
test('a failing check-in template read still reminds both audiences', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: loadCheckinMod, key: 'loadCheckinTemplate', value: async () => ({
        ok: false, reason: 'blob get 500', template: av.normalizeTemplate(av.DEFAULT_TEMPLATE) }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 2);
    assert.equal(ciSpy.calls[0][0].templateTimeZone, 'America/Toronto');
  });
});

// ===========================================================================
// bulkCancelAll -- the TEMPORARY one-off bulk-cancel tool. See its own
// comment in api/calendar-reminders.js: reuses the exact per-booking
// cancel/notify primitives the real single-booking cancel handlers use.
// ===========================================================================

function reqBulkCancel(body, cookie) {
  return {
    method: 'POST',
    headers: cookie ? { cookie } : { authorization: `Bearer ${SECRET}` },
    body: body === undefined ? { bulkCancel: true, confirm: 'CANCEL ALL BOOKINGS' } : body,
  };
}

test('bulkCancelAll: refuses without the exact confirm string, and never calls listEvents', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(reqBulkCancel({ bulkCancel: true }), res);
    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'CONFIRM_REQUIRED');
    assert.equal(listSpy.calls.length, 0, 'must not touch the calendar without the exact confirm string');
  });

  const res2 = makeRes();
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    await handler(reqBulkCancel({ bulkCancel: true, confirm: 'cancel all bookings' }), res2);
  });
  assert.equal(res2._status, 400, 'the confirm string is case-sensitive, not fuzzy-matched');
});

test('bulkCancelAll: cancels an applicant AND a check-in booking in one pass, each via its own Slack/email senders', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  const appSlackSpy = spyStub({ ts: null });
  const ciSlackSpy = spyStub({ ts: null });
  const appEmailSpy = spyStub({ ok: true });
  const ciEmailSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: bslack, key: 'postBookingChanged', value: appSlackSpy },
    { obj: cslack, key: 'postCheckinBookingChanged', value: ciSlackSpy },
    { obj: email, key: 'sendCancellationNotice', value: appEmailSpy },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: ciEmailSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqBulkCancel(), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.considered, 2);
    assert.equal(res._json.cancelled, 2);
    assert.equal(res._json.failed, 0);

    assert.equal(deleteSpy.calls.length, 2);
    for (const call of deleteSpy.calls) {
      assert.equal(call[1].notifyGuests, true, 'every cancellation must notify the real guest, same as a real cancel');
    }

    assert.equal(appSlackSpy.calls.length, 1);
    assert.equal(appSlackSpy.calls[0][1], 'cancelled');
    assert.equal(ciSlackSpy.calls.length, 1);
    assert.equal(ciSlackSpy.calls[0][1], 'cancelled');
    assert.equal(appEmailSpy.calls.length, 1);
    assert.equal(ciEmailSpy.calls.length, 1);
  });
});

test('bulkCancelAll: a failed delete is counted as failed and does not stop the rest of the batch', async () => {
  envSetup();
  const deleteSpy = async (eventId) => (eventId === 'evt-bad' ? { ok: false, reason: 'Google 500' } : { ok: true });
  const appSlackSpy = spyStub({ ts: null });
  const appEmailSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-bad', startMs: futureMs(2) }),
        makeEvent({ id: 'evt-ok', startMs: futureMs(4) }),
      ] }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: bslack, key: 'postBookingChanged', value: appSlackSpy },
    { obj: email, key: 'sendCancellationNotice', value: appEmailSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqBulkCancel(), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.considered, 2);
    assert.equal(res._json.cancelled, 1);
    assert.equal(res._json.failed, 1);
    assert.equal(appSlackSpy.calls.length, 1);
    assert.equal(appEmailSpy.calls.length, 1);
    const failedResult = res._json.results.find(r => r.eventId === 'evt-bad');
    assert.equal(failedResult.ok, false);
  });
});

test('bulkCancelAll: a throwing Slack/email sender is swallowed -- the event still counts as cancelled', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => { throw new Error('slack down'); } },
    { obj: email, key: 'sendCancellationNotice', value: async () => { throw new Error('resend down'); } },
  ], async () => {
    const res = makeRes();
    await handler(reqBulkCancel(), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.cancelled, 1, 'the calendar deletion is what counts -- best-effort notification failures must not undo that');
    assert.equal(res._json.failed, 0);
  });
});

test('bulkCancelAll: is reachable via the same admin session cookie as the reminder catch-up button', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const res = makeRes();
    await handler(reqBulkCancel(undefined, cookieValueOf(auth.issueSessionCookie())), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.cancelled, 0);
  });
});

test('bulkCancelAll: listEvents failing surfaces as an error, same shape as the reminder path', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ], async () => {
    const res = makeRes();
    await handler(reqBulkCancel(), res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
});

test('bulkCancelAll: a GET can never trigger it, even with bulkCancel somehow present', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${SECRET}` },
      body: { bulkCancel: true, confirm: 'CANCEL ALL BOOKINGS' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.cancelled, undefined, 'must not be routed to bulkCancelAll on a GET');
  });
});
