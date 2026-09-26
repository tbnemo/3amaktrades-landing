const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../api/_booking-guard');

const S = '2026-09-28T13:00:00Z', E = '2026-09-28T13:30:00Z';
const startMs = Date.parse(S), endMs = Date.parse(E);

function evt(id, start, end, extra = {}) {
  return { id, start: { dateTime: start }, end: { dateTime: end }, status: 'confirmed', ...extra };
}

// An event THIS system created: it carries the bookingSource marker, which is the
// only evidence that the other side of a race is also running this guard.
function ours(id, start = S, end = E, priv = {}) {
  return evt(id, start, end, {
    extendedProperties: { private: { bookingSource: guard.EVENT_MARKER, ...priv } },
  });
}

test('finds events intersecting the window', () => {
  const events = [
    evt('a', S, E),                                                   // exact
    evt('b', '2026-09-28T13:15:00Z', '2026-09-28T13:45:00Z'),         // partial
    evt('c', '2026-09-28T12:00:00Z', '2026-09-28T13:00:00Z'),         // ends exactly at start
    evt('d', '2026-09-28T13:30:00Z', '2026-09-28T14:00:00Z'),         // starts exactly at end
  ];
  const hit = guard.overlapping(events, startMs, endMs).map(e => e.id);
  // Touching at a boundary is not an overlap -- back-to-back slots must be legal.
  assert.deepEqual(hit, ['a', 'b']);
});

test('ignores cancelled and transparent events', () => {
  const events = [
    evt('cancelled', S, E, { status: 'cancelled' }),
    evt('free', S, E, { transparency: 'transparent' }),
    evt('real', S, E),
  ];
  assert.deepEqual(guard.overlapping(events, startMs, endMs).map(e => e.id), ['real']);
});

test('ignores all-day events, which carry date not dateTime', () => {
  const events = [
    { id: 'allday', start: { date: '2026-09-28' }, end: { date: '2026-09-29' }, status: 'confirmed' },
    evt('real', S, E),
  ];
  assert.deepEqual(guard.overlapping(events, startMs, endMs).map(e => e.id), ['real']);
});

test('does not roll back when ours is the only event in the window', () => {
  assert.equal(guard.shouldRollBack('evt-b', [ours('evt-b')]), false);
  assert.equal(guard.shouldRollBack('evt-b', []), false);
  assert.equal(guard.shouldRollBack('evt-b', null), false);
  assert.equal(guard.shouldRollBack('evt-b', undefined), false);
});

test('R5: two of OUR bookings race -- the lexicographically smallest id wins and the other rolls back', () => {
  const both = [ours('evt-a'), ours('evt-b')];
  // Deterministic tie-break: a plain "more than one exists, so roll back" rule
  // makes BOTH sides cancel and leaves nobody booked. It is only sound because
  // both of these events are ours, so both sides run this same guard.
  assert.equal(guard.shouldRollBack('evt-a', both), false, 'our id sorts first -> we keep it');
  assert.equal(guard.shouldRollBack('evt-b', both), true, 'our id sorts last -> we withdraw');
});

// THE fix for R5's blind spot. The tie-break assumed both racers run this guard.
// When the clashing event is not ours -- Omar booked on his phone, another Google
// client wrote, or freeBusy lagged a just-created event -- nobody withdraws on the
// other side. Winning the tie-break there means keeping a genuine double-booking
// while telling the visitor "confirmed". So a foreign clash must yield outright,
// EVEN WHEN our id sorts first.
test('R5 refined: an overlapping event with NO bookingSource forces a rollback even when our id sorts first', () => {
  const events = [
    ours('aaa-ours'),                 // sorts FIRST -- the old tie-break would keep it
    evt('zzz-foreign', S, E),         // no extendedProperties at all
  ];
  assert.equal(guard.shouldRollBack('aaa-ours', events), true);
});

test('R5 refined: an overlapping event whose bookingSource is some other string also forces a rollback', () => {
  const events = [
    ours('aaa-ours'),
    evt('zzz-other-system', S, E, {
      extendedProperties: { private: { bookingSource: 'some-other-integration' } },
    }),
  ];
  assert.equal(guard.shouldRollBack('aaa-ours', events), true);

  // Also when the private bag exists but carries unrelated keys only.
  const events2 = [
    ours('aaa-ours'),
    evt('zzz-empty-private', S, E, { extendedProperties: { private: { note: 'hi' } } }),
  ];
  assert.equal(guard.shouldRollBack('aaa-ours', events2), true);
});

test('rolls back when someone else already held the slot and our id sorts last', () => {
  const events = [evt('omar-existing', S, E), ours('zzz-ours')];
  assert.equal(guard.shouldRollBack('zzz-ours', events), true);
});

test('a null entry in the overlapping list does not throw', () => {
  assert.doesNotThrow(() => {
    assert.equal(guard.shouldRollBack('evt-b', [null, ours('evt-b')]), false);
  });
  assert.doesNotThrow(() => {
    // Two real events plus a null: still a genuine race between two of ours.
    assert.equal(guard.shouldRollBack('evt-b', [ours('evt-a'), null, ours('evt-b')]), true);
  });
  assert.doesNotThrow(() => {
    assert.equal(guard.shouldRollBack('evt-b', [null, null]), false);
  });
});
