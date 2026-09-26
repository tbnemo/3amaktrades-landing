const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const auth = require('../api/_admin-auth');

function reqWithCookie(cookie) { return { headers: cookie ? { cookie } : {} }; }
function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }

test('fails closed when ADMIN_PASSCODE is not configured', () => {
  delete process.env.ADMIN_PASSCODE;
  assert.equal(auth.checkPasscode('anything'), false);
  assert.equal(auth.checkPasscode(''), false);
});

test('accepts only the exact passcode', () => {
  process.env.ADMIN_PASSCODE = 'correct-horse';
  assert.equal(auth.checkPasscode('correct-horse'), true);
  assert.equal(auth.checkPasscode('wrong'), false);
  assert.equal(auth.checkPasscode('correct-horse '), false);
  assert.equal(auth.checkPasscode(undefined), false);
  assert.equal(auth.checkPasscode(null), false);
});

test('a session cookie round-trips and is hardened', () => {
  process.env.ADMIN_PASSCODE = 'correct-horse';
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const setCookie = auth.issueSessionCookie();
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.equal(auth.verifySession(reqWithCookie(cookieValueOf(setCookie))), true);
});

test('rejects a tampered or forged cookie', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const good = cookieValueOf(auth.issueSessionCookie());
  assert.equal(auth.verifySession(reqWithCookie(good)), true);
  assert.equal(auth.verifySession(reqWithCookie(`${good}tampered`)), false);
  assert.equal(auth.verifySession(reqWithCookie('amak_admin=garbage.signature')), false);
  assert.equal(auth.verifySession(reqWithCookie('amak_admin=')), false);
  assert.equal(auth.verifySession(reqWithCookie('')), false);
  assert.equal(auth.verifySession({ headers: {} }), false);
});

test('a cookie signed with a different secret does not verify', () => {
  process.env.ADMIN_SESSION_SECRET = 'secret-a';
  const cookie = cookieValueOf(auth.issueSessionCookie());
  process.env.ADMIN_SESSION_SECRET = 'secret-b';
  assert.equal(auth.verifySession(reqWithCookie(cookie)), false);
});

test('an expired session is rejected', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const cookie = cookieValueOf(auth.issueSessionCookie(-1000)); // already expired
  assert.equal(auth.verifySession(reqWithCookie(cookie)), false);
});

test('falls back to a derived secret so only ADMIN_PASSCODE is strictly required', () => {
  delete process.env.ADMIN_SESSION_SECRET;
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  const cookie = cookieValueOf(auth.issueSessionCookie());
  assert.equal(auth.verifySession(reqWithCookie(cookie)), true);
});

test('OAuth state round-trips and rejects forgery', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const s = auth.signState();
  assert.equal(auth.verifyState(s), true);
  assert.equal(auth.verifyState(`${s}x`), false);
  assert.equal(auth.verifyState('nope'), false);
  assert.equal(auth.verifyState(''), false);
});

test('verifyState rejects an expired state', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  // Build an already-expired state payload the same way signState does,
  // signed with the same secret, without changing signState's signature.
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000, n: 'deadbeef' }), 'utf8')
    .toString('base64url');
  const sig = crypto.createHmac('sha256', auth.sessionSecret()).update(payload).digest('base64url');
  assert.equal(auth.verifyState(`${payload}.${sig}`), false);
});

test('a state signed with a different secret does not verify', () => {
  process.env.ADMIN_SESSION_SECRET = 'secret-a';
  const s = auth.signState();
  process.env.ADMIN_SESSION_SECRET = 'secret-b';
  assert.equal(auth.verifyState(s), false);
});

test('requireAdmin writes a 401 and returns false when unauthorised', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  let status = null, payload = null;
  const res = { status(c) { status = c; return this; }, json(p) { payload = p; return this; } };
  assert.equal(auth.requireAdmin({ headers: {} }, res), false);
  assert.equal(status, 401);
  assert.deepEqual(payload, { error: 'unauthorized' });
});
