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

// An event as listEvents returns it for a booking THIS system created. The
// bookingSource marker is what makes the id tie-break legitimate: it is evidence
// that the other side of the race runs the same guard and will withdraw. Without
// it the event is foreign and we must yield outright.
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
    // 'aaa-other' sorts first -> ours (EVENT_ID = 'evt-reschedule-1') loses. BOTH
    // carry the marker, so this exercises the id tie-break itself rather than the
    // foreign-clash shortcut.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
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
    // This booking had never been reminded, so the restored flag is the same
    // "not sent" empty string.
    assert.equal(restorePayload.extendedProperties.private.reminderSent, '');
  });
});

// The move patch clears reminderSent so a moved call is reminded again. If the move
// is then rolled back, that clear must be undone too -- otherwise a booking whose
// reminder had ALREADY been sent gets reminded a second time, for a time it was
// never moved to.
test('lost race: the rollback restores reminderSent, so an already-reminded booking is not re-armed', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const alreadyReminded = ourEvent({ startMs: oldStart, endMs: oldEnd });
  alreadyReminded.extendedProperties.private.reminderSent = '1';

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: '' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: alreadyReminded }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 409);
    assert.equal(patchSpy.calls.length, 2);
    // The move cleared it...
    assert.equal(patchSpy.calls[0][1].extendedProperties.private.reminderSent, '');
    // ...and the rollback must put it back.
    assert.equal(patchSpy.calls[1][1].extendedProperties.private.reminderSent, '1',
      'a rolled-back move must not re-arm a reminder that was already sent');
  });
});

// Omar converted the booking to an all-day event in Google Calendar, so
// event.start.dateTime is absent and Date.parse() yields NaN. The rollback used to
// call new Date(NaN).toISOString(), which throws RangeError: the request 500s with
// no body AND the event is left sitting at the clashing new time. There is no
// original time to restore, so the correct behaviour is a clean 409 plus a loud log.
test('lost race on an all-day event: 409 without throwing, and no time-restoring patch is attempted', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const newEnd = newStart + 30 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  // Same metadata, but all-day `date` sides instead of `dateTime`.
  const allDay = ourEvent({ startMs: oldStart, endMs: oldEnd });
  allDay.start = { date: '2026-12-01' };
  allDay.end = { date: '2026-12-02' };

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: '' } });

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: allDay }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await assert.doesNotReject(() => handler({ method: 'POST', body: goodBody(newStart) }, res));

    assert.equal(res._status, 409, 'must be a clean 409, not an unhandled RangeError');
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 1,
      'only the move patch may run -- there is no valid original time to restore');
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

// THE mirror-image defense-in-depth check. manageToken is an HMAC over
// eventId+email only -- it encodes no audience -- so a token that is
// genuinely valid for a CHECK-IN booking must still be refused here: the
// applicant endpoint must never move a check-in booking.
test('an event tagged audience: "checkin" -> 403 FORBIDDEN, and patchEvent is never called', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 30 * 60 * 1000;
  const newStart = oldStart + 4 * 3600 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  const checkinTaggedEvent = ourEvent({ startMs: oldStart, endMs: oldEnd });
  checkinTaggedEvent.extendedProperties.private.audience = 'checkin';

  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinTaggedEvent }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ], async () => {
    const res = makeRes();
    // The token here is genuinely valid for this eventId+email pair.
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(res._json.message, 'That booking is not managed here.');
    assert.equal(patchSpy.calls.length, 0,
      'the applicant endpoint must never move a check-in booking');
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

// ===========================================================================
// SHORT-NOTICE REMINDER on the reschedule path
//
// The move patch clears reminderSent so a moved call is reminded again -- but
// the reminder cron runs once a day, so it can only be RELIED ON to deliver
// that when min(notice, REMINDER_LEAD_HOURS) is at least a full cron period.
// A visitor moving their call to this afternoon therefore re-armed a reminder
// that nothing would ever send: strictly worse than the booking path's version
// of the same hole, because here the flag was cleared deliberately and the
// reminder is owed.
//
// So when remind.needsImmediateReminder() says the cron cannot be trusted with
// the NEW time, this handler sends the reminder itself and re-marks the flag.
//
// Driven through the real template path (a same-day availability document in
// the blob store, so loadTemplate -> slotExists genuinely accept a 1h-notice
// move) with a pinned clock, for the reasons spelled out in
// test/calendar-book.test.js's matching section.
// ===========================================================================

const FIXED_NOW = Date.UTC(2027, 6, 14, 10, 0, 0); // Wednesday 10:00 UTC

function withFixedNow(nowMs, fn) {
  const orig = Date.now;
  Date.now = () => nowMs;
  return Promise.resolve(fn()).finally(() => { Date.now = orig; });
}

// Open every day 00:00-23:30 UTC, 30-minute grid, ONE hour of minimum notice.
const SAME_DAY_TEMPLATE = {
  timezone: 'UTC',
  days: {
    mon: { enabled: true, start: '00:00', end: '23:30' },
    tue: { enabled: true, start: '00:00', end: '23:30' },
    wed: { enabled: true, start: '00:00', end: '23:30' },
    thu: { enabled: true, start: '00:00', end: '23:30' },
    fri: { enabled: true, start: '00:00', end: '23:30' },
    sat: { enabled: true, start: '00:00', end: '23:30' },
    sun: { enabled: true, start: '00:00', end: '23:30' },
  },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 1,
};

// loadTemplate is destructured at require() time in calendar-reschedule.js, so
// the template has to arrive through the blob store the handler really reads.
function blobClientServing(template) {
  return {
    get: async (pathname) => {
      if (pathname !== store.AVAILABILITY_BLOB) return null;
      return {
        stream: new Response(JSON.stringify(template)).body,
        blob: {}, headers: new Headers(),
      };
    },
    put: async () => ({}),
  };
}

// REMINDER_LEAD_HOURS is pinned because it is half of the quantity under test.
function sameDayEnvSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.REMINDER_LEAD_HOURS = '24';
  store.__setClientForTests(blobClientServing(SAME_DAY_TEMPLATE));
}

// postSystemAlert is destructured at require() time too, so the alert tests
// need the handler re-required after the patch is in place.
const handlerPath = require.resolve('../api/calendar-reschedule');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

// The call starts three days out; the visitor moves it to an hour from now.
const ORIGINAL_START = FIXED_NOW + 72 * 3600000;
const SHORT_NOTICE_START = FIXED_NOW + 1 * 3600000;   // 11:00 UTC, 1h of notice
const NORMAL_NOTICE_START = FIXED_NOW + 48 * 3600000; // two days out

function sameDayStubs(newStartMs, extra = []) {
  const newEndMs = newStartMs + 30 * 60 * 1000;
  return [
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: ourEvent({ startMs: ORIGINAL_START, endMs: ORIGINAL_START + 30 * 60 * 1000 }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: { hangoutLink: 'https://meet.example/moved' } }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [listedOurs(EVENT_ID, new Date(newStartMs).toISOString(), new Date(newEndMs).toISOString())],
      }) },
    { obj: bslack, key: 'postBookingChanged', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendRescheduleNotice', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

// Picks the reminderSent value out of a patchEvent call list. The move patch
// sets it to '' and the short-notice patch sets it to '1', so the SEQUENCE is
// what matters, not just the presence of a patch.
function reminderFlagPatches(patchSpy) {
  return patchSpy.calls.filter(c => c[1].extendedProperties
    && c[1].extendedProperties.private
    && c[1].extendedProperties.private.reminderSent !== undefined);
}

test('SHORT NOTICE: moving a call to an hour from now sends the reminder immediately and re-marks reminderSent', async () => {
  sameDayEnvSetup();
  const newStart = SHORT_NOTICE_START;
  const newEnd = newStart + 30 * 60 * 1000;
  const reminderSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true, event: { hangoutLink: 'https://meet.example/moved' } });

  await withStubs(sameDayStubs(newStart, [
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: email, key: 'sendReminder', value: reminderSpy },
  ]), () => withFixedNow(FIXED_NOW, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200, `expected 200, got ${res._status} (${JSON.stringify(res._json)})`);

    assert.equal(reminderSpy.calls.length, 1,
      'a move the daily cron cannot be relied on for must be reminded at reschedule time');

    // Built from the NEW time, with a freshly minted manage token and the Meet
    // link off the patched event -- the same Booking shape the cron would have
    // produced, so the email renders identically either way.
    const b = reminderSpy.calls[0][0];
    assert.equal(b.eventId, EVENT_ID);
    assert.equal(b.name, 'Jane Doe');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '555-0100');
    assert.equal(b.startMs, newStart, 'the reminder must describe the NEW time, not the old one');
    assert.equal(b.endMs, newEnd);
    assert.equal(b.visitorTimeZone, 'America/Toronto');
    assert.equal(b.templateTimeZone, 'UTC');
    assert.equal(b.meetLink, 'https://meet.example/moved');
    assert.equal(b.lang, 'en');
    assert.equal(bt.verifyBookingToken(EVENT_ID, EMAIL, b.manageToken), true);

    // The move cleared the flag, then the immediate send put it back -- in that
    // order, so the cron skips this event instead of sending a second copy.
    const flags = reminderFlagPatches(patchSpy);
    assert.deepEqual(flags.map(c => c[1].extendedProperties.private.reminderSent), ['', '1']);
    assert.equal(flags[1][0], EVENT_ID);
    assert.equal(flags[1][2], undefined,
      'the flag patch must carry no options -- notifyGuests must stay off for a metadata-only change');
  }));
});

test('NORMAL NOTICE: moving a call two days out does NOT trigger an immediate reminder, and leaves reminderSent cleared', async () => {
  sameDayEnvSetup();
  const newStart = NORMAL_NOTICE_START;
  const reminderSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(sameDayStubs(newStart, [
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: email, key: 'sendReminder', value: reminderSpy },
  ]), () => withFixedNow(FIXED_NOW, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200);
    assert.equal(reminderSpy.calls.length, 0,
      'the daily cron is guaranteed to catch this one -- sending now would just be a duplicate');
    assert.deepEqual(reminderFlagPatches(patchSpy).map(c => c[1].extendedProperties.private.reminderSent), [''],
      'only the move patch may touch the flag, and it must leave it cleared for the cron');
  }));
});

// After a rollback the booking is back at its ORIGINAL time -- whose notice was
// already evaluated when it was first created -- and originalReminderSent has
// been restored untouched. Sending a reminder here would describe a time the
// call was never actually moved to.
test('SHORT NOTICE: a reschedule rolled back by the lost-race guard is never reminded', async () => {
  sameDayEnvSetup();
  const newStart = SHORT_NOTICE_START;
  const newEnd = newStart + 30 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();
  const reminderSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(sameDayStubs(newStart, [
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    // 'aaa-other' sorts first -> ours (EVENT_ID) loses and the move is undone.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ],
      }) },
    { obj: email, key: 'sendReminder', value: reminderSpy },
  ]), () => withFixedNow(FIXED_NOW, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 2, 'the move really was undone');
    assert.equal(reminderSpy.calls.length, 0,
      'the booking is back at its original time -- a reminder for the new one would be a lie');
  }));
});

test('SHORT NOTICE: a reminder that returns {ok:false} alerts, leaves the flag cleared, and keeps the 200', async () => {
  sameDayEnvSetup();
  const newStart = SHORT_NOTICE_START;
  const patchSpy = spyStub({ ok: true, event: {} });
  const alertSpy = spyStub(undefined);

  await withStubs(sameDayStubs(newStart, [
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: email, key: 'sendReminder', value: async () => ({ ok: false, reason: 'resend 422' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), () => withFixedNow(FIXED_NOW, async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200,
      'the move is already on the calendar -- a failed reminder must not report it as failed');
    assert.equal(res._json.ok, true);

    assert.equal(alertSpy.calls.length, 1, 'a short-notice reminder that silently failed must be visible');
    assert.match(String(alertSpy.calls[0][0]), new RegExp(EVENT_ID));
    assert.match(String(alertSpy.calls[0][0]), /resend 422/);

    assert.deepEqual(reminderFlagPatches(patchSpy).map(c => c[1].extendedProperties.private.reminderSent), [''],
      'a failed send must leave the flag cleared, so the cron at least gets a chance to retry');
  }));
  delete require.cache[handlerPath];
});

test('SHORT NOTICE: a THROWING reminder alerts and still keeps the 200', async () => {
  sameDayEnvSetup();
  const newStart = SHORT_NOTICE_START;
  const alertSpy = spyStub(undefined);

  await withStubs(sameDayStubs(newStart, [
    { obj: email, key: 'sendReminder', value: async () => { throw new Error('resend unreachable'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), () => withFixedNow(FIXED_NOW, async () => {
    const h = freshHandler();
    const res = makeRes();
    await assert.doesNotReject(() => h({ method: 'POST', body: goodBody(newStart) }, res));
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(alertSpy.calls.length, 1);
    assert.match(String(alertSpy.calls[0][0]), /resend unreachable/);
  }));
  delete require.cache[handlerPath];
});
