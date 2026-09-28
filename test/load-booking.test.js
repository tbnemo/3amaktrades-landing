const { test } = require('node:test');
const assert = require('node:assert/strict');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const bt = require('../api/_booking-token');
const { loadBooking } = require('../api/_load-booking');

function envSetup() {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
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

// A plausible event this system created: our marker, the visitor's own email,
// and dateTime start/end (all-day fields would never appear on a booking).
function ourEvent(overrides = {}) {
  return {
    id: 'evt-1',
    start: { dateTime: '2026-01-01T10:00:00.000Z' },
    end: { dateTime: '2026-01-01T10:30:00.000Z' },
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        visitorEmail: 'jane@example.com',
        visitorName: 'Jane Doe',
      },
    },
    ...overrides,
  };
}

test('a valid token + matching email + our-marker event returns ok:true with the event', async () => {
  envSetup();
  const token = bt.makeBookingToken('evt-1', 'jane@example.com');
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
  ], async () => {
    const result = await loadBooking({ eventId: 'evt-1', email: 'jane@example.com', token });
    assert.equal(result.ok, true);
    assert.equal(result.event.id, 'evt-1');
    assert.equal(result.meta.visitorEmail, 'jane@example.com');
  });
});

test('wrong token returns 403 FORBIDDEN', async () => {
  envSetup();
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent() }) },
  ], async () => {
    const result = await loadBooking({
      eventId: 'evt-1', email: 'jane@example.com', token: 'not-the-real-token',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'FORBIDDEN');
  });
});

// Token non-transferability: the same visitor owns two events (evt-A and
// evt-B, both under jane@example.com), but a token minted for one must not
// unlock the other -- the HMAC has to bind to the specific eventId, not just
// the email.
test('a valid token for event A used against event B returns 403', async () => {
  envSetup();
  const tokenForA = bt.makeBookingToken('evt-A', 'jane@example.com');
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: ourEvent({ id: 'evt-B' }) }) },
  ], async () => {
    const result = await loadBooking({ eventId: 'evt-B', email: 'jane@example.com', token: tokenForA });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'FORBIDDEN');
  });
});

// This is the check that stops a booking token from ever reaching the owner's
// own personal meetings -- an event this system did not create must be
// unreachable even when the token itself validates cleanly.
test('an event without bookingSource === EVENT_MARKER returns 403 even with an otherwise-valid token', async () => {
  envSetup();
  const token = bt.makeBookingToken('evt-1', 'jane@example.com');
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({
        ok: true,
        event: ourEvent({
          extendedProperties: {
            private: { bookingSource: 'some-other-calendar-app', visitorEmail: 'jane@example.com' },
          },
        }),
      }) },
  ], async () => {
    const result = await loadBooking({ eventId: 'evt-1', email: 'jane@example.com', token });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'FORBIDDEN');
  });
});

// Even when the HMAC validates for the supplied email (i.e. someone minted a
// token for their own address), the event's own stored visitorEmail must
// still match -- otherwise a token for "attacker@example.com" could be
// pointed at an eventId that actually belongs to someone else.
test('a stored visitorEmail that differs from the supplied email returns 403', async () => {
  envSetup();
  const token = bt.makeBookingToken('evt-1', 'attacker@example.com');
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({
        ok: true,
        event: ourEvent({
          extendedProperties: {
            private: { bookingSource: guard.EVENT_MARKER, visitorEmail: 'realvisitor@example.com' },
          },
        }),
      }) },
  ], async () => {
    const result = await loadBooking({ eventId: 'evt-1', email: 'attacker@example.com', token });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'FORBIDDEN');
  });
});

test('missing eventId, email, or token each return 400 BAD_REQUEST', async () => {
  envSetup();
  const cases = [
    { eventId: '', email: 'jane@example.com', token: 'tok' },
    { eventId: 'evt-1', email: '', token: 'tok' },
    { eventId: 'evt-1', email: 'jane@example.com', token: '' },
    {},
  ];
  for (const body of cases) {
    const result = await loadBooking(body);
    assert.equal(result.ok, false, `body ${JSON.stringify(body)} should fail`);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'BAD_REQUEST');
  }
});

test('getEvent failing (event gone) returns 404 NOT_FOUND', async () => {
  envSetup();
  const token = bt.makeBookingToken('evt-1', 'jane@example.com');
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: 'HTTP 404' }) },
  ], async () => {
    const result = await loadBooking({ eventId: 'evt-1', email: 'jane@example.com', token });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.error, 'NOT_FOUND');
  });
});

test('getEvent returning NOT_CONNECTED returns 503 CALENDAR_NOT_CONNECTED', async () => {
  envSetup();
  const token = bt.makeBookingToken('evt-1', 'jane@example.com');
  await withStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ], async () => {
    const result = await loadBooking({ eventId: 'evt-1', email: 'jane@example.com', token });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.error, 'CALENDAR_NOT_CONNECTED');
  });
});
