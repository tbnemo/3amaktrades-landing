const { test } = require('node:test');
const assert = require('node:assert/strict');
const bt = require('../api/_booking-token');

test('a booking token round-trips for its own event and email', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', token), true);
});

test('a token does not transfer to another event or another person', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  assert.equal(bt.verifyBookingToken('evt-2', 'a@example.com', token), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'b@example.com', token), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', 'forged'), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', ''), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', null), false);
});

test('email comparison is case- and whitespace-insensitive', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'A@Example.com');
  assert.equal(bt.verifyBookingToken('evt-1', ' a@example.COM ', token), true);
});

test('rotating the secret invalidates every existing token', () => {
  process.env.ADMIN_SESSION_SECRET = 'secret-a';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  process.env.ADMIN_SESSION_SECRET = 'secret-b';
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', token), false);
});

// The timingSafeEqual trap: it THROWS when the two buffers are different
// lengths. A wrong-length token must come back false, never an uncaught
// exception that would surface as a 500 to the visitor.
test('verifyBookingToken returns false (not throws) for a wrong-length token', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  assert.doesNotThrow(() => {
    assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', token + 'x'), false);
  });
  assert.doesNotThrow(() => {
    assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', token.slice(0, -1)), false);
  });
  assert.doesNotThrow(() => {
    assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', 'x'), false);
  });
});

// _email.js must use the SHARED escaper from api/_html.js rather than a
// private copy -- otherwise a future XSS fix to one escaper leaves the other
// vulnerable. Assert this indirectly: the escaper _email.js exports (which
// must be the imported one, per its module.exports) neutralises a hostile
// value rather than passing it through raw.
test('_email.js exposes the shared HTML escaper and it neutralises hostile input', () => {
  const email = require('../api/_email');
  const html = require('../api/_html');
  assert.equal(typeof email.escapeHtml, 'function');
  // Must be the SAME function reference as api/_html.js exports, not a
  // second, divergent implementation.
  assert.equal(email.escapeHtml, html.escapeHtml);
  const hostile = '<script>alert(1)</script>';
  const escaped = email.escapeHtml(hostile);
  assert.ok(!escaped.includes('<script>'));
  assert.match(escaped, /&lt;script&gt;/);
});
