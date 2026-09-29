const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
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

const handlerPath = require.resolve('../api/calendar-checkin-reschedule');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

// 15-minute slots, mon-fri 09:00-12:00 America/Toronto, no buffer, 24h notice.
// A three-hour window so a "four hours later" move has somewhere to land.
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
  slotMinutes: 15,
  bufferMinutes: 0,
  minNoticeHours: 24,
});

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

const EVENT_ID = 'evt-checkin-reschedule-1';
const EMAIL = 'alice@example.com';

// A check-in event as getEvent returns it: the SHARED marker plus audience.
function checkinEvent({ startMs, endMs, extra = {}, overrides = {} }) {
  return {
    id: EVENT_ID,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs).toISOString() },
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
        ...extra,
      },
    },
    ...overrides,
  };
}

// The SAME event with no audience tag at all: an APPLICANT booking. A check-in
// manage link must never be able to act on it.
function applicantEvent({ startMs, endMs }) {
  const e = checkinEvent({ startMs, endMs });
  delete e.extendedProperties.private.audience;
  return e;
}

function listedOurs(id, isoStart, isoEnd) {
  return {
    id,
    start: { dateTime: isoStart },
    end: { dateTime: isoEnd },
    status: 'confirmed',
    extendedProperties: { private: { bookingSource: guard.EVENT_MARKER } },
  };
}

function goodBody(newStartMs, overrides = {}) {
  return {
    eventId: EVENT_ID,
    email: EMAIL,
    token: bt.makeBookingToken(EVENT_ID, EMAIL),
    start: new Date(newStartMs).toISOString(),
    visitorTimeZone: 'Europe/Istanbul',
    ...overrides,
  };
}

function baseStubs(extra = []) {
  return [
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => ({ ts: null }) },
    { obj: cemail, key: 'sendCheckinRescheduleNotice', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

test('happy path: 200, and patchEvent is called with the NEW start/end at the CHECK-IN slot length', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000; // 11:00, still inside 09:00-12:00
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: 'https://meet.example/moved' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, isoNewStart, isoNewEnd)] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, EVENT_ID);
    assert.equal(res._json.start, isoNewStart);
    assert.equal(res._json.end, isoNewEnd, 'endMs must use the CHECK-IN slotMinutes (15)');

    assert.equal(patchSpy.calls.length, 1);
    const [, payload] = patchSpy.calls[0];
    assert.equal(payload.start.dateTime, isoNewStart);
    assert.equal(payload.end.dateTime, isoNewEnd);
  });
  delete require.cache[handlerPath];
});

// THE defense-in-depth check. manageToken is an HMAC over eventId+email only --
// it encodes no audience -- so a token that is genuinely valid for an APPLICANT
// booking must still be refused here.
test('an APPLICANT event (no audience tag) -> 403 FORBIDDEN, and patchEvent is never called', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: applicantEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    // The token here is genuinely valid for this eventId+email pair.
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(patchSpy.calls.length, 0,
      'a check-in link must never move an applicant booking');
  });
  delete require.cache[handlerPath];
});

test('an event tagged with some OTHER audience value -> 403 FORBIDDEN', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: checkinEvent({ startMs: oldStart, endMs: oldEnd, extra: { audience: 'something-else' } }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 403);
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// The self-blocking regression, re-proved on this path: the event being moved is
// itself on the calendar, so its own busy interval must be filtered out before
// checking the new slot.
test('reschedule does not block on its own current busy interval', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldEnd; // back-to-back
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    // ONLY the booking's own interval is reported busy.
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [{ start: oldStart, end: oldEnd }] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, isoNewStart, isoNewEnd)] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200, `expected 200, got ${res._status} (${JSON.stringify(res._json)})`);
  });
  delete require.cache[handlerPath];
});

test('reminderSent is cleared on a successful reschedule so a moved call is reminded again', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, new Date(newStart).toISOString(), new Date(newEnd).toISOString())] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 1);
    const [, payload] = patchSpy.calls[0];
    assert.ok(payload.extendedProperties && payload.extendedProperties.private);
    assert.equal(payload.extendedProperties.private.reminderSent, '');
  });
  delete require.cache[handlerPath];
});

test('lost race: 409, and patchEvent is called a second time restoring the ORIGINAL start/end', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const isoOldStart = new Date(oldStart).toISOString();
  const isoOldEnd = new Date(oldEnd).toISOString();
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    // 'aaa-other' sorts first -> ours loses. Both carry the marker, so this
    // exercises the id tie-break rather than the foreign-clash shortcut.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 2, 'the move must be undone');
    const [, restore] = patchSpy.calls[1];
    assert.equal(restore.start.dateTime, isoOldStart);
    assert.equal(restore.end.dateTime, isoOldEnd);
    assert.equal(restore.extendedProperties.private.reminderSent, '');
  });
  delete require.cache[handlerPath];
});

// A rolled-back move must not re-arm a reminder that was already sent, or the
// client gets a second reminder for a time the call was never moved to.
test('lost race: the rollback restores an already-sent reminderSent flag', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: checkinEvent({ startMs: oldStart, endMs: oldEnd, extra: { reminderSent: '1' } }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 409);
    assert.equal(patchSpy.calls.length, 2);
    assert.equal(patchSpy.calls[0][1].extendedProperties.private.reminderSent, '');
    assert.equal(patchSpy.calls[1][1].extendedProperties.private.reminderSent, '1');
  });
  delete require.cache[handlerPath];
});

// Omar converted the booking to an all-day event, so start.dateTime is absent
// and Date.parse yields NaN. new Date(NaN).toISOString() THROWS, which would
// 500 the request AND leave the event parked at the clashing new time.
test('lost race on an all-day event: a clean 409 without throwing, and no restoring patch', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const allDay = checkinEvent({ startMs: oldStart, endMs: oldEnd });
  allDay.start = { date: '2026-12-01' };
  allDay.end = { date: '2026-12-02' };

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: allDay }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ] }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: spyStub(undefined) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await assert.doesNotReject(() => h({ method: 'POST', body: goodBody(newStart) }, res));
    assert.equal(res._status, 409, 'must be a clean 409, not an unhandled RangeError');
    assert.equal(patchSpy.calls.length, 1,
      'only the move patch may run -- there is no valid original time to restore');
  });
  delete require.cache[handlerPath];
});

test('a failing listEvents keeps the move (fail-open) and alerts that the guard was skipped', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const alertSpy = spyStub(undefined);
  const logged = [];
  const realError = console.error;

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'google 500' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(newStart) }, res);
      assert.equal(res._status, 200, 'fail-open is deliberate');
    } finally {
      console.error = realError;
    }
    assert.ok(logged.some(l => /guard/i.test(l)));
    assert.equal(alertSpy.calls.length, 1);
    assert.match(String(alertSpy.calls[0][0]), new RegExp(EVENT_ID));
  });
  delete require.cache[handlerPath];
});

test('the CHECK-IN Slack and email senders are called, and the applicant ones never are', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;

  const ciSlack = spyStub({ ts: null });
  const ciEmail = spyStub({ ok: true });
  const appSlack = spyStub({ ts: null });
  const appEmail = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: { hangoutLink: 'https://meet.example/m' } }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, new Date(newStart).toISOString(), new Date(newEnd).toISOString())] }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: ciSlack },
    { obj: cemail, key: 'sendCheckinRescheduleNotice', value: ciEmail },
    { obj: bslack, key: 'postBookingChanged', value: appSlack },
    { obj: email, key: 'sendRescheduleNotice', value: appEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200);

    assert.equal(ciSlack.calls.length, 1);
    assert.equal(ciSlack.calls[0][1], 'rescheduled');
    assert.equal(ciSlack.calls[0][2], 'slack-ts-original', 'the original #8 message ts must be passed through');
    assert.equal(ciEmail.calls.length, 1);
    assert.equal(appSlack.calls.length, 0);
    assert.equal(appEmail.calls.length, 0);

    // The Booking object handed to both senders.
    const b = ciEmail.calls[0][0];
    assert.equal(b.eventId, EVENT_ID);
    assert.equal(b.name, 'Alice Client');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '5550100100');
    assert.equal(b.startMs, newStart);
    assert.equal(b.endMs, newEnd);
    assert.equal(b.visitorTimeZone, 'Europe/Istanbul');
    assert.equal(b.templateTimeZone, 'America/Toronto');
    assert.equal(b.meetLink, 'https://meet.example/m');
    assert.equal(b.lang, 'en');
    assert.equal(bt.verifyBookingToken(EVENT_ID, EMAIL, b.manageToken), true);
  });
  delete require.cache[handlerPath];
});

test('a wrong manage token -> 403 FORBIDDEN (loadBooking passthrough)', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs, endMs: startMs + 900000 }) }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs + 2 * 3600 * 1000, { token: 'wrong-token' }) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
  });
  delete require.cache[handlerPath];
});

test('a missing eventId/email/token -> 400 BAD_REQUEST (loadBooking passthrough)', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs, endMs: startMs + 900000 }) }) },
  ]), async () => {
    const h = freshHandler();
    for (const missing of ['eventId', 'email', 'token']) {
      const body = goodBody(startMs + 2 * 3600 * 1000);
      delete body[missing];
      const res = makeRes();
      await h({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `missing ${missing} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
  delete require.cache[handlerPath];
});

test('an event that no longer exists -> 404 NOT_FOUND (loadBooking passthrough)', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: 'not found' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs + 2 * 3600 * 1000) }, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'NOT_FOUND');
  });
  delete require.cache[handlerPath];
});

test('a malformed start -> 400 BAD_REQUEST', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs, endMs: startMs + 900000 }) }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true, event: {} }) },
  ]), async () => {
    const h = freshHandler();
    for (const start of ['not-a-date', '']) {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs, { start }) }, res);
      assert.equal(res._status, 400);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
  delete require.cache[handlerPath];
});

test('a slot that fails the re-verify -> 409 without calling patchEvent', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({
        ok: true, busy: [{ start: newStart - 3600000, end: newEnd + 3600000 }] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a failed patchEvent -> 502 UPSTREAM', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: false, reason: 'patch refused' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(oldStart + 2 * 3600 * 1000) }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
  delete require.cache[handlerPath];
});

test('BLOB_NOT_CONFIGURED -> 503 without calling patchEvent', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });
  await withStubs(baseStubs([
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, template: CHECKIN_TEMPLATE }) },
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(oldStart + 2 * 3600 * 1000) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a throwing Slack stub and a throwing email stub still result in a 200', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, new Date(newStart).toISOString(), new Date(newEnd).toISOString())] }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => { throw new Error('slack is down'); } },
    { obj: cemail, key: 'sendCheckinRescheduleNotice', value: async () => { throw new Error('email is down'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
  });
  delete require.cache[handlerPath];
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await require('../api/calendar-checkin-reschedule')({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
