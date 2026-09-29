// A short-lived proof that a visitor matched an entry in checkin-clients.json.
//
// NOT a reuse of _booking-token.js: that helper is a stateless HMAC over
// (eventId, email) with no expiry field at all -- deliberately, since rotating
// the secret is its only revocation path -- and at verify time there is no
// eventId yet. A non-expiring credential minted from nothing but an email
// address is precisely what must not exist on this path, so this primitive
// signs an expiry INTO the HMAC and carries it in the clear beside the
// signature so it can be checked before any comparison happens.
const crypto = require('crypto');
const { sessionSecret } = require('./_admin-auth');

// Long enough to complete one booking, short enough that a token leaked into a
// log, a screenshot or a shared URL is useless very soon after.
const VERIFY_TOKEN_TTL_MS = 10 * 60 * 1000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// `expiryPart` is always the STRING form that appears in the token, never a
// Number. Signing and verifying therefore operate on byte-identical input with
// no number round-trip in between, which removes a whole class of
// canonicalisation bug ('1700000000000' vs '1.7e12' vs '01700000000000').
function signature(email, expiryPart) {
  const secret = sessionSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret)
    .update(`checkin-verify-v1|${normalizeEmail(email)}|${expiryPart}`)
    .digest('base64url');
}

// ttlMs is overridable so tests can mint an already-expired token (pass a
// negative value) without stubbing the clock.
function makeVerifyToken(email, ttlMs = VERIFY_TOKEN_TTL_MS) {
  const expiryPart = String(Date.now() + ttlMs);
  const sig = signature(email, expiryPart);
  if (!sig) return '';
  return `${sig}.${expiryPart}`;
}

function verifyVerifyToken(email, token) {
  if (typeof token !== 'string' || !token) return false;

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const sig = token.slice(0, dot);
  const expiryPart = token.slice(dot + 1);

  // Bounded digits only: rejects '1e15', '+1700000000000', ' 1700000000000',
  // and anything long enough to be an overflow probe.
  if (!/^\d{1,15}$/.test(expiryPart)) return false;

  // Expiry FIRST, before any HMAC work: an expired token is rejected on a
  // cheap integer comparison and never reaches the comparison path at all.
  if (!(Date.now() < Number(expiryPart))) return false;

  const expected = signature(email, expiryPart);
  if (!expected) return false;

  // Constant-time, with the length check first -- timingSafeEqual THROWS on a
  // length mismatch, which would turn a wrong-length token into a 500 instead
  // of a clean rejection.
  const a = Buffer.from(sig, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Recovers WHICH client a token was issued for. The email is inside the HMAC,
// not readable from the token, so the only way back to it is to test the token
// against each known client. The list is a hand-maintained mentorship roster
// (tens of entries), so this is a few dozen HMACs -- and it has a second,
// deliberate benefit: a client removed from the list between verifying and
// booking no longer resolves, so a stale token cannot book.
function resolveVerifyToken(clients, token) {
  if (typeof token !== 'string' || !token) return null;
  for (const c of (clients || [])) {
    if (c && c.email && verifyVerifyToken(c.email, token)) return c;
  }
  return null;
}

module.exports = {
  makeVerifyToken, verifyVerifyToken, resolveVerifyToken,
  normalizeEmail, VERIFY_TOKEN_TTL_MS,
};
