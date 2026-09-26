const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const handler = require('../api/calendar-book');

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
// how loadTemplate() falls back to the normalized DEFAULT_TEMPLATE (America/
// Toronto, mon-fri 09:00-17:00, 30-minute slots, 15-minute buffer, 12h notice).
function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
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

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// An event as listEvents would return it for a booking THIS system created: the
// bookingSource marker is what tells the guard the other side of a race is also
// running the guard. An event built WITHOUT it is a foreign event (Omar's phone,
// another Google client, a lagging freeBusy), and any foreign overlap must make us
// yield outright rather than gamble on id ordering.
function listedOurs(id, isoStart, isoEnd) {
  return {
    id,
    start: { dateTime: isoStart },
    end: { dateTime: isoEnd },
    status: 'confirmed',
    extendedProperties: { private: { bookingSource: guard.EVENT_MARKER } },
  };
}

function goodBody(startMs, overrides = {}) {
  return {
    name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '555-0100',
    start: new Date(startMs).toISOString(),
    visitorTimeZone: 'America/Toronto',
    lang: 'en',
    ...overrides,
  };
}

test('happy path: a valid body returns 200 with eventId, manageToken, start, end', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-happy', hangoutLink: 'https://meet.example/abc' } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [listedOurs('evt-happy', isoStart, isoEnd)],
      }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: bslack, key: 'postBookingCreated', value: async () => ({ ts: 'slack-ts-1' }) },
    { obj: email, key: 'sendBookingConfirmation', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, 'evt-happy');
    assert.equal(typeof res._json.manageToken, 'string');
    assert.ok(res._json.manageToken.length > 0);
    assert.equal(bt.verifyBookingToken('evt-happy', 'jane@example.com', res._json.manageToken), true);
    assert.equal(res._json.start, isoStart);
    assert.equal(res._json.end, isoEnd);
    assert.equal(res._json.meetLink, 'https://meet.example/abc');
    assert.equal(deleteSpy.calls.length, 0, 'a clean booking must never roll itself back');

    // The WRITE side of extendedProperties.private, asserted key by key. Every
    // reader test hand-builds its own event object, so without this the suite
    // stays 150/150 green while a renamed key silently 403s every manage link and
    // stops every reminder in production.
    assert.equal(insertSpy.calls.length, 1);
    const payload = insertSpy.calls[0][0];
    assert.ok(payload.extendedProperties && payload.extendedProperties.private,
      'the insert payload must carry extendedProperties.private');
    const priv = payload.extendedProperties.private;
    assert.equal(priv.bookingSource, '3amak-booking');
    assert.equal(priv.bookingSource, guard.EVENT_MARKER);
    assert.equal(priv.visitorEmail, 'jane@example.com');
    assert.equal(priv.visitorName, 'Jane Doe');
    assert.equal(priv.visitorPhone, '555-0100');
    assert.equal(priv.visitorTimeZone, 'America/Toronto');
    assert.equal(priv.lang, 'en');
    // Exactly these six keys: an extra one is fine to add deliberately, but it
    // should not appear by accident, and none of the six may go missing.
    assert.deepEqual(Object.keys(priv).sort(),
      ['bookingSource', 'lang', 'visitorEmail', 'visitorName', 'visitorPhone', 'visitorTimeZone']);
  });
});

// End to end through the handler, which is what proves the call site actually
// passes each event's extendedProperties into the guard. A foreign overlap must
// roll our booking back EVEN THOUGH our id sorts first -- nobody withdraws on the
// other side, so winning the tie-break here would leave a real double-booking
// standing while the visitor is told "confirmed".
test('a foreign overlapping event rolls our booking back even when our id sorts first', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'aaa-ours';   // sorts FIRST -- the old tie-break kept this
  const insertSpy = spyStub({ ok: true, event: { id: ourEventId } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd),
          // Omar booked this on his phone: no bookingSource, no guard on its side.
          { id: 'zzz-omars-own', start: { dateTime: isoStart }, end: { dateTime: isoEnd }, status: 'confirmed' },
        ],
      }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: bslack, key: 'postBookingCreated', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendBookingConfirmation', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(deleteSpy.calls.length, 1, 'our event must actually be withdrawn');
    assert.equal(deleteSpy.calls[0][0], ourEventId);
  });
});

// The Meet link can arrive ONLY inside conferenceData.entryPoints.
test('the Meet link is resolved from conferenceData.entryPoints when hangoutLink is absent', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: {
        id: 'evt-entrypoints',
        conferenceData: { entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550100' },
          { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
        ] },
      } }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-entrypoints', isoStart, isoEnd)],
      }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: bslack, key: 'postBookingCreated', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendBookingConfirmation', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.meetLink, 'https://meet.google.com/abc-defg-hij');
  });
});

test('rollback path: two overlapping events where ours loses the tie-break returns 409 and actually deletes our event', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'zzz-ours';   // 'aaa-other' sorts first -> ours loses
  const insertSpy = spyStub({ ok: true, event: { id: ourEventId, hangoutLink: '' } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    // BOTH events are ours: another visitor's booking racing this one. That is the
    // only situation in which the id tie-break is sound, so both fixtures carry the
    // marker -- otherwise this would test the foreign-clash path by accident.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoStart, isoEnd),
          listedOurs(ourEventId, isoStart, isoEnd),
        ],
      }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: bslack, key: 'postBookingCreated', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendBookingConfirmation', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.ok, false);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    // The status alone doesn't prove the rollback happened -- this does.
    assert.equal(deleteSpy.calls.length, 1, 'deleteEvent must actually be called');
    assert.equal(deleteSpy.calls[0][0], ourEventId);
  });
});

test('inverse: ours wins the tie-break returns 200 and deleteEvent is never called', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'aaa-ours';   // ours sorts first -> ours wins
  const insertSpy = spyStub({ ok: true, event: { id: ourEventId, hangoutLink: '' } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    // Both ours again -- see the note above. A foreign clash must NOT be winnable,
    // which is asserted separately.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd),
          listedOurs('zzz-other', isoStart, isoEnd),
        ],
      }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: bslack, key: 'postBookingCreated', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendBookingConfirmation', value: async () => ({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, ourEventId);
    assert.equal(deleteSpy.calls.length, 0, 'the winner must not roll itself back');
  });
});

// When listEvents fails, the post-write overlap check cannot run. It deliberately
// fails OPEN -- the event already exists, and answering "not booked" about a booking
// that IS on the calendar would be worse. But this is the only double-booking
// protection there is, so a skipped check must be visible in the logs rather than
// silent.
test('a failing listEvents keeps the booking (fail-open) but logs that the guard was skipped', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const logged = [];
  const realError = console.error;

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-unguarded' } }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'upstream 500 from Google' }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: bslack, key: 'postBookingCreated', value: async () => ({ ts: null }) },
    { obj: email, key: 'sendBookingConfirmation', value: async () => ({ ok: true }) },
  ], async () => {
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      const res = makeRes();
      await handler({ method: 'POST', body: goodBody(startMs) }, res);

      assert.equal(res._status, 200, 'fail-open is deliberate and must not change');
      assert.equal(res._json.eventId, 'evt-unguarded');
    } finally {
      console.error = realError;
    }

    const line = logged.find(l => /guard/i.test(l));
    assert.ok(line, `expected a logged line about the skipped guard, got: ${JSON.stringify(logged)}`);
    assert.match(line, /evt-unguarded/, 'the log must name the event id');
    assert.match(line, /upstream 500 from Google/, 'the log must name the reason');
  });
});

test('a slot that fails the pre-insert re-verify returns 409 without ever calling insertEvent', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;

  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs([
    // A busy interval that fully covers the requested slot (well past the
    // 15-minute buffer on both sides) makes av.slotExists() reject it.
    { obj: gcal, key: 'freeBusy', value: async () => ({
        ok: true, busy: [{ start: startMs - 3600000, end: endMs + 3600000 }],
      }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.ok, false);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(insertSpy.calls.length, 0, 'insertEvent must never be reached');
  });
});

test('honeypot: a truthy website field returns 200 silently and never calls insertEvent', async () => {
  envSetup();
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { ...goodBody(validSlotStartMs()), website: 'https://spam.example' } }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(insertSpy.calls.length, 0);
  });
});

test('missing/invalid name, email, and start each return 400 BAD_REQUEST', async () => {
  envSetup();
  const startMs = validSlotStartMs();

  const cases = [
    goodBody(startMs, { name: '' }),
    goodBody(startMs, { name: '   ' }),
    goodBody(startMs, { email: 'not-an-email' }),
    goodBody(startMs, { email: '' }),
    goodBody(startMs, { start: 'not-a-date' }),
    goodBody(startMs, { start: '' }),
  ];

  for (const body of cases) {
    const res = makeRes();
    await handler({ method: 'POST', body }, res);
    assert.equal(res._status, 400, `body ${JSON.stringify(body)} should be 400`);
    assert.equal(res._json.error, 'BAD_REQUEST');
  }
});

test('a throwing Slack stub and a throwing email stub still result in a 200, confirmed booking', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 30 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-survives' } }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [listedOurs('evt-survives', isoStart, isoEnd)],
      }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'patchEvent', value: async () => { throw new Error('patch also down'); } },
    { obj: bslack, key: 'postBookingCreated', value: async () => { throw new Error('slack is down'); } },
    { obj: email, key: 'sendBookingConfirmation', value: async () => { throw new Error('email is down'); } },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, 'evt-survives');
  });
});

test('BLOB_NOT_CONFIGURED (503) when the blob store has no credentials', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  store.__setClientForTests(emptyBlobClient());

  const res = makeRes();
  await handler({ method: 'POST', body: goodBody(validSlotStartMs()) }, res);
  assert.equal(res._status, 503);
  assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');

  process.env.BLOB_READ_WRITE_TOKEN = 'test-token'; // restore for later tests
});

test('CALENDAR_NOT_CONNECTED (503) when freeBusy reports the calendar is not connected', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: goodBody(validSlotStartMs()) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
});

test('non-POST requests return 405', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'GET', body: {} }, res);
  assert.equal(res._status, 405);
});
