// R2: the spec allows no bookings database, so a visitor's right to reschedule
// or cancel cannot be a stored session. A stateless HMAC over eventId+email is
// the whole authorisation: it needs no storage, and rotating the secret revokes
// every outstanding link at once.
const crypto = require('crypto');
const { sessionSecret } = require('./_admin-auth');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function makeBookingToken(eventId, email) {
  const secret = sessionSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret)
    .update(`booking-v1|${eventId}|${normalizeEmail(email)}`)
    .digest('base64url');
}

// Constant-time comparison so a wrong token leaks nothing through timing.
// timingSafeEqual THROWS on mismatched buffer lengths, so the length check
// must come first -- otherwise a wrong-length token turns into a 500 instead
// of a clean rejection.
function verifyBookingToken(eventId, email, token) {
  if (typeof token !== 'string' || !token) return false;
  const expected = makeBookingToken(eventId, email);
  if (!expected) return false;
  const a = Buffer.from(token, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { makeBookingToken, verifyBookingToken, normalizeEmail };
