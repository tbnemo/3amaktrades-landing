const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../api/_booking-guard');

const S = '2026-09-28T13:00:00Z', E = '2026-09-28T13:30:00Z';
const startMs = Date.parse(S), endMs = Date.parse(E);

function evt(id, start, end, extra = {}) {
  return { id, start: { dateTime: start }, end: { dateTime: end }, status: 'confirmed', ...extra };
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
  assert.equal(guard.shouldRollBack('evt-b', [evt('evt-b', S, E)]), false);
  assert.equal(guard.shouldRollBack('evt-b', []), false);
});

test('R5: on a race, the lexicographically smallest id wins and others roll back', () => {
  const both = [evt('evt-a', S, E), evt('evt-b', S, E)];
  // Deterministic tie-break: a plain "more than one exists, so roll back" rule
  // makes BOTH sides cancel and leaves nobody booked.
  assert.equal(guard.shouldRollBack('evt-b', both), true);
  assert.equal(guard.shouldRollBack('evt-a', both), false);
});

test('rolls back when someone else already held the slot', () => {
  const events = [evt('omar-existing', S, E), evt('zzz-ours', S, E)];
  assert.equal(guard.shouldRollBack('zzz-ours', events), true);
});
