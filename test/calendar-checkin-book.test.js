const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const cc = require('../api/_checkin-clients');
const ct = require('../api/_checkin-token');
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
  return require(handlerPath).book;
}

// The check-in template used throughout: 15-minute slots, no buffer, mon-fri
// 09:00-10:00 America/Toronto, 24h notice. Deliberately DIFFERENT from the
// applicant default (30 minutes, 09:00-17:00), so a handler wired to the wrong
// loader produces a wrong endMs and fails loudly.
const CHECKIN_TEMPLATE = av.normalizeTemplate({
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '10:00' },
    tue: { enabled: true, start: '09:00', end: '10:00' },
    wed: { enabled: true, start: '09:00', end: '10:00' },
    thu: { enabled: true, start: '09:00', end: '10:00' },
    fri: { enabled: true, start: '09:00', end: '10:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 15,
  bufferMinutes: 0,
  minNoticeHours: 24,
});

// A weekday 60+ days out at 09:00 America/Toronto: inside the window, on the
// 15-minute grid, well clear of the 24h notice rule and any DST boundary.
function validSlotStartMs() {
  const base = new Date(Date.now() + 60 * 86400000);
  let y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  while (true) {
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) break; // Mon-Fri
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return tz.zonedWallTimeToUtc(y, mo, d, 9, 0, 'America/Toronto');
}

const ROSTER = [
  { name: 'Alice Client', email: 'alice@example.com', phone: '5550100100' },
  { name: 'Bob Client', email: 'bob@example.com', phone: '' },
];

// An event as listEvents returns it for a booking THIS system created. Both
// audiences write the SAME bookingSource marker -- that is what makes the id
// tie-break legitimate between them. `audience` is carried too, so a fixture
// can stand in for either side of a cross-audience race.
function listedOurs(id, isoStart, isoEnd, audience) {
  const priv = { bookingSource: guard.EVENT_MARKER };
  if (audience) priv.audience = audience;
  return {
    id,
    start: { dateTime: isoStart },
    end: { dateTime: isoEnd },
    status: 'confirmed',
    extendedProperties: { private: priv },
  };
}

function goodBody(startMs, overrides = {}) {
  return {
    verifyToken: ct.makeVerifyToken('alice@example.com'),
    start: new Date(startMs).toISOString(),
    visitorTimeZone: 'Europe/Istanbul',
    lang: 'en',
    ...overrides,
  };
}

// The stub set every happy-path test needs. `extra` appends or overrides.
function baseStubs(extra = []) {
  return [
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: ROSTER, usedDefault: false }) },
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => ({ ts: null }) },
    { obj: cemail, key: 'sendCheckinConfirmation', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

test('happy path: 200 with eventId, a valid manageToken, start, end and meetLink', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000; // the CHECK-IN slot length, not 30
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-checkin-happy', hangoutLink: 'https://meet.example/ci' } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-checkin-happy', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, 'evt-checkin-happy');
    assert.equal(res._json.start, isoStart);
    assert.equal(res._json.end, isoEnd, 'endMs must come from the CHECK-IN slotMinutes (15)');
    assert.equal(res._json.meetLink, 'https://meet.example/ci');
    // The manage token is minted for the TOKEN's email, which is the roster's.
    assert.equal(bt.verifyBookingToken('evt-checkin-happy', 'alice@example.com', res._json.manageToken), true);
    assert.equal(deleteSpy.calls.length, 0, 'a clean booking must never roll itself back');
  });
  delete require.cache[handlerPath];
});

// The WRITE side of extendedProperties.private, asserted key by key. Every
// reader test hand-builds its own event object, so without this the suite stays
// green while a renamed key silently 403s every manage link, stops every
// reminder, and -- for `audience` specifically -- routes check-ins into the
// applicant templates.
test('the insert payload carries the shared marker AND audience:checkin, with exactly seven private keys', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-props' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-props', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);

    assert.equal(insertSpy.calls.length, 1);
    const payload = insertSpy.calls[0][0];
    assert.ok(payload.extendedProperties && payload.extendedProperties.private,
      'the insert payload must carry extendedProperties.private');
    const priv = payload.extendedProperties.private;
    assert.equal(priv.bookingSource, '3amak-booking');
    assert.equal(priv.bookingSource, guard.EVENT_MARKER,
      'the marker must be the SHARED constant so the guard sees both audiences');
    assert.equal(priv.audience, 'checkin');
    assert.equal(priv.visitorEmail, 'alice@example.com');
    assert.equal(priv.visitorName, 'Alice Client');
    assert.equal(priv.visitorPhone, '5550100100');
    assert.equal(priv.visitorTimeZone, 'Europe/Istanbul');
    assert.equal(priv.lang, 'en');
    assert.deepEqual(Object.keys(priv).sort(),
      ['audience', 'bookingSource', 'lang', 'visitorEmail', 'visitorName', 'visitorPhone', 'visitorTimeZone']);

    // The event's own times must be the requested slot, in UTC.
    assert.equal(payload.start.dateTime, isoStart);
    assert.equal(payload.end.dateTime, isoEnd);
    assert.equal(payload.start.timeZone, 'UTC');
  });
  delete require.cache[handlerPath];
});

// The whole reason the token exists: without server-side enforcement anyone
// could skip the verification UI and POST straight here.
test('a missing, forged, or expired verifyToken -> 403 NOT_VERIFIED and insertEvent is never called', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });
  const freeBusySpy = spyStub({ ok: true, busy: [] });

  const bad = [
    goodBody(startMs, { verifyToken: undefined }),
    goodBody(startMs, { verifyToken: '' }),
    goodBody(startMs, { verifyToken: 'not-a-token' }),
    goodBody(startMs, { verifyToken: `${'x'.repeat(43)}.${Date.now() + 600000}` }),
    goodBody(startMs, { verifyToken: ct.makeVerifyToken('alice@example.com', -1000) }),
  ];

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: freeBusySpy },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    for (const body of bad) {
      const res = makeRes();
      await h({ method: 'POST', body }, res);
      assert.equal(res._status, 403, `${JSON.stringify(body.verifyToken)} should be 403`);
      assert.equal(res._json.error, 'NOT_VERIFIED');
    }
    assert.equal(freeBusySpy.calls.length, 0, 'an unverified caller must never reach freeBusy');
    assert.equal(insertSpy.calls.length, 0, 'an unverified caller must never reach the calendar');
  });
  delete require.cache[handlerPath];
});

test('a token for someone no longer on the roster -> 403 NOT_VERIFIED', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });
  const freeBusySpy = spyStub({ ok: true, busy: [] });

  await withStubs(baseStubs([
    // Alice verified, then Omar removed her before she confirmed.
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ROSTER[1]], usedDefault: false }) },
    { obj: gcal, key: 'freeBusy', value: freeBusySpy },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'NOT_VERIFIED');
    assert.equal(freeBusySpy.calls.length, 0, 'a removed-client token must never reach freeBusy');
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// Defense in depth for the race window between verifying (minting a token)
// and confirming the booking: an admin could pause the client in between.
test('a client paused AFTER verifying but BEFORE booking -> 403 ACCESS_INACTIVE, and the calendar is never touched', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });
  const freeBusySpy = spyStub({ ok: true, busy: [] });
  const pausedAlice = { ...ROSTER[0], pausedAt: Date.now() };

  await withStubs(baseStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [pausedAlice, ROSTER[1]], usedDefault: false }) },
    { obj: gcal, key: 'freeBusy', value: freeBusySpy },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'ACCESS_INACTIVE');
    assert.equal(freeBusySpy.calls.length, 0, 'a paused client must never reach freeBusy');
    assert.equal(insertSpy.calls.length, 0, 'a paused client must never reach the calendar');
  });
  delete require.cache[handlerPath];
});

// An arbitrary email in the body must be ignored outright -- not merely
// rejected -- since the token alone decides whose booking this is.
test('an email in the request body is ignored: the booking uses the TOKEN owner', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-token-wins' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-token-wins', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs, {
      email: 'attacker@example.com',
      name: 'Attacker',
      phone: '5559999999',
      verifyToken: ct.makeVerifyToken('bob@example.com'),
    }) }, res);

    assert.equal(res._status, 200);
    const priv = insertSpy.calls[0][0].extendedProperties.private;
    assert.equal(priv.visitorEmail, 'bob@example.com');
    assert.equal(priv.visitorName, 'Bob Client');
    assert.equal(priv.visitorPhone, '');
    assert.equal(JSON.stringify(priv).includes('attacker@example.com'), false);
    assert.equal(JSON.stringify(priv).includes('Attacker'), false);
  });
  delete require.cache[handlerPath];
});

test('the confirmation email and Slack post are addressed to the token owner', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const slackSpy = spyStub({ ts: 'ts-1' });
  const emailSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-notify', hangoutLink: 'https://meet.example/n' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-notify', isoStart, isoEnd, 'checkin')] }) },
    { obj: cslack, key: 'postCheckinBookingCreated', value: slackSpy },
    { obj: cemail, key: 'sendCheckinConfirmation', value: emailSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);

    assert.equal(slackSpy.calls.length, 1);
    assert.equal(emailSpy.calls.length, 1);
    // Both receive the SAME Booking object shape.
    for (const b of [slackSpy.calls[0][0], emailSpy.calls[0][0]]) {
      assert.equal(b.eventId, 'evt-notify');
      assert.equal(b.name, 'Alice Client');
      assert.equal(b.email, 'alice@example.com');
      assert.equal(b.phone, '5550100100');
      assert.equal(b.startMs, startMs);
      assert.equal(b.endMs, endMs);
      assert.equal(b.visitorTimeZone, 'Europe/Istanbul');
      assert.equal(b.templateTimeZone, 'America/Toronto');
      assert.equal(b.meetLink, 'https://meet.example/n');
      assert.equal(b.lang, 'en');
      assert.equal(typeof b.manageToken, 'string');
      assert.ok(b.manageToken.length > 0);
    }
  });
  delete require.cache[handlerPath];
});

// The applicant senders must never fire for a check-in, or a mentorship client
// gets the new-applicant copy and the booking lands in #4.
test('the APPLICANT Slack and email senders are never called', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const appSlack = spyStub({ ts: null });
  const appEmail = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-sep' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-sep', isoStart, isoEnd, 'checkin')] }) },
    { obj: bslack, key: 'postBookingCreated', value: appSlack },
    { obj: email, key: 'sendBookingConfirmation', value: appEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(appSlack.calls.length, 0);
    assert.equal(appEmail.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a Slack ts is stored back onto the event so a later change can link to it', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-ts' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-ts', isoStart, isoEnd, 'checkin')] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => ({ ts: 'slack-ts-8' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 1);
    assert.equal(patchSpy.calls[0][0], 'evt-ts');
    assert.equal(patchSpy.calls[0][1].extendedProperties.private.slackTs, 'slack-ts-8');
  });
  delete require.cache[handlerPath];
});

test('no Slack ts means no patch call at all', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-nots' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-nots', isoStart, isoEnd, 'checkin')] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => ({ ts: null }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// The shared-marker property, exercised across audiences: an APPLICANT booking
// racing this one carries the same marker, so the id tie-break is legitimate
// and exactly one of the two survives.
test('an applicant booking racing this check-in resolves by the id tie-break: ours loses and is deleted', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'zzz-ours'; // 'aaa-applicant' sorts first -> ours loses
  const insertSpy = spyStub({ ok: true, event: { id: ourEventId } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          // No `audience` -- an applicant booking. Same marker, so its side runs
          // the same guard and will withdraw if it loses.
          listedOurs('aaa-applicant', isoStart, isoEnd, null),
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(deleteSpy.calls.length, 1, 'our event must actually be withdrawn');
    assert.equal(deleteSpy.calls[0][0], ourEventId);
  });
  delete require.cache[handlerPath];
});

test('the inverse: ours wins the cross-audience tie-break and is kept', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'aaa-ours';
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: ourEventId } }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
          listedOurs('zzz-applicant', isoStart, isoEnd, null),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.eventId, ourEventId);
    assert.equal(deleteSpy.calls.length, 0, 'the winner must not roll itself back');
  });
  delete require.cache[handlerPath];
});

test('a genuinely FOREIGN overlapping event rolls us back even when our id sorts first', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'aaa-ours'; // sorts FIRST, and must still yield
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: ourEventId } }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
          // Omar booked this on his phone: no marker, no guard on its side, so
          // nobody withdraws there and winning the tie-break would leave a real
          // double-booking standing while the client is told "confirmed".
          { id: 'zzz-omars-own', start: { dateTime: isoStart }, end: { dateTime: isoEnd }, status: 'confirmed' },
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 409);
    assert.equal(deleteSpy.calls.length, 1);
    assert.equal(deleteSpy.calls[0][0], ourEventId);
  });
  delete require.cache[handlerPath];
});

// The counterpart of the declined-invite fix already shipped for the applicant
// flow: freeBusy ignores an invite Omar declined, events.list still returns it.
// Without the guard's skip, the slot would be permanently unbookable here too.
test('a slot holding an invite Omar DECLINED still books', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'zzz-ours'; // sorts LAST, so a surviving clash would roll us back
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: ourEventId } }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
          {
            id: 'aaa-declined-invite',
            start: { dateTime: isoStart },
            end: { dateTime: isoEnd },
            status: 'confirmed',
            attendees: [
              { email: 'organizer@example.com', organizer: true, responseStatus: 'accepted' },
              { email: 'omar@example.com', self: true, responseStatus: 'declined' },
            ],
          },
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200, 'a declined invite must not block the booking');
    assert.equal(deleteSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a failing listEvents keeps the booking (fail-open) but logs and alerts that the guard was skipped', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const logged = [];
  const realError = console.error;
  const alertSpy = spyStub(undefined);

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-unguarded' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'upstream 500 from Google' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs) }, res);
      assert.equal(res._status, 200, 'fail-open is deliberate and must not change');
      assert.equal(res._json.eventId, 'evt-unguarded');
    } finally {
      console.error = realError;
    }
    const line = logged.find(l => /guard/i.test(l));
    assert.ok(line, `expected a logged line about the skipped guard, got: ${JSON.stringify(logged)}`);
    assert.match(line, /evt-unguarded/);
    assert.match(line, /upstream 500 from Google/);
  });
  delete require.cache[handlerPath];
});

test('a slot that fails the pre-insert re-verify -> 409 without ever calling insertEvent', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({
        ok: true, busy: [{ start: startMs - 3600000, end: endMs + 3600000 }] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// The check-in template's window is 09:00-10:00, so 11:00 is outside it even
// though it would be a perfectly valid APPLICANT slot (09:00-17:00). This is
// what proves the handler reads the check-in template.
test('a time valid for applicant hours but outside CHECK-IN hours -> 409', async () => {
  envSetup();
  const nine = validSlotStartMs();
  const eleven = nine + 2 * 3600 * 1000;
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(eleven) }, res);
    assert.equal(res._status, 409);
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a malformed or missing start -> 400 BAD_REQUEST', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: spyStub({ ok: true, event: { id: 'x' } }) },
  ]), async () => {
    const h = freshHandler();
    for (const start of ['not-a-date', '', undefined]) {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs, { start }) }, res);
      assert.equal(res._status, 400, `${JSON.stringify(start)} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
  delete require.cache[handlerPath];
});

test('an invalid visitorTimeZone falls back to UTC rather than failing', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();
  const insertSpy = spyStub({ ok: true, event: { id: 'evt-tz' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-tz', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs, { visitorTimeZone: 'Not/AZone' }) }, res);
    assert.equal(res._status, 200);
    assert.equal(insertSpy.calls[0][0].extendedProperties.private.visitorTimeZone, 'UTC');
  });
  delete require.cache[handlerPath];
});

test('lang is normalized to en unless it is exactly "ar"', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  for (const [given, expected] of [['ar', 'ar'], ['en', 'en'], ['fr', 'en'], [undefined, 'en']]) {
    const insertSpy = spyStub({ ok: true, event: { id: 'evt-lang' } });
    await withStubs(baseStubs([
      { obj: gcal, key: 'insertEvent', value: insertSpy },
      { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
      { obj: gcal, key: 'listEvents', value: async () => ({
          ok: true, events: [listedOurs('evt-lang', isoStart, isoEnd, 'checkin')] }) },
    ]), async () => {
      const h = freshHandler();
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs, { lang: given }) }, res);
      assert.equal(res._status, 200);
      assert.equal(insertSpy.calls[0][0].extendedProperties.private.lang, expected);
    });
    delete require.cache[handlerPath];
  }
});

test('BLOB_NOT_CONFIGURED on the client-list read -> 503 and no token work at all', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'x' } });
  await withStubs(baseStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('BLOB_NOT_CONFIGURED on the template read -> 503', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, template: CHECKIN_TEMPLATE }) },
    { obj: gcal, key: 'insertEvent', value: spyStub({ ok: true, event: { id: 'x' } }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
  });
  delete require.cache[handlerPath];
});

test('CALENDAR_NOT_CONNECTED -> 503; another freeBusy failure -> 502; a failed insert -> 502', async () => {
  envSetup();
  const startMs = validSlotStartMs();

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
  delete require.cache[handlerPath];

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: 'google 500' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
  delete require.cache[handlerPath];

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: false, reason: 'insert refused' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
  delete require.cache[handlerPath];
});

test('a throwing Slack stub and a throwing email stub still result in a 200, confirmed booking', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-survives' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-survives', isoStart, isoEnd, 'checkin')] }) },
    { obj: gcal, key: 'patchEvent', value: async () => { throw new Error('patch also down'); } },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => { throw new Error('slack is down'); } },
    { obj: cemail, key: 'sendCheckinConfirmation', value: async () => { throw new Error('email is down'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, 'evt-survives');
  });
  delete require.cache[handlerPath];
});

test('a confirmation email that returns {ok:false} raises a system alert but keeps the 200', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();
  const alertSpy = spyStub(undefined);

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-mailfail' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-mailfail', isoStart, isoEnd, 'checkin')] }) },
    { obj: cemail, key: 'sendCheckinConfirmation', value: async () => ({ ok: false, reason: 'resend 422' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(alertSpy.calls.length, 1, 'a silently undelivered confirmation must be visible');
    assert.match(String(alertSpy.calls[0][0]), /evt-mailfail/);
    assert.match(String(alertSpy.calls[0][0]), /resend 422/);
  });
  delete require.cache[handlerPath];
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await require('../api/calendar-checkin').book({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
