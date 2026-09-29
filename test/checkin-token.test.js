const { test } = require('node:test');
const assert = require('node:assert/strict');
const ct = require('../api/_checkin-token');

function envSetup() {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
}

const EMAIL = 'client@example.com';

test('a freshly minted token verifies for the same email', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  assert.equal(ct.verifyVerifyToken(EMAIL, token), true);
});

test('the token is <base64url signature>.<expiryEpochMs> and the expiry is ~10 minutes out', () => {
  envSetup();
  const before = Date.now();
  const token = ct.makeVerifyToken(EMAIL);
  const dot = token.lastIndexOf('.');
  assert.ok(dot > 0, `expected one dot separator in "${token}"`);
  const sig = token.slice(0, dot);
  const expiryRaw = token.slice(dot + 1);
  assert.match(sig, /^[A-Za-z0-9_-]+$/, 'the signature half must be base64url');
  assert.match(expiryRaw, /^\d+$/, 'the expiry half must be a bare epoch-ms integer');
  const expiry = Number(expiryRaw);
  assert.ok(expiry >= before + ct.VERIFY_TOKEN_TTL_MS - 2000, `expiry ${expiry} is too early`);
  assert.ok(expiry <= Date.now() + ct.VERIFY_TOKEN_TTL_MS + 2000, `expiry ${expiry} is too late`);
  assert.equal(ct.VERIFY_TOKEN_TTL_MS, 10 * 60 * 1000);
});

test('a token minted for one email does not verify for another', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  assert.equal(ct.verifyVerifyToken('someone.else@example.com', token), false);
});

test('email comparison is case- and whitespace-insensitive', () => {
  envSetup();
  const token = ct.makeVerifyToken('  Client@Example.COM ');
  assert.equal(ct.verifyVerifyToken('client@example.com', token), true);
  assert.equal(ct.verifyVerifyToken('CLIENT@EXAMPLE.COM', token), true);
});

test('an expired token is rejected even though its signature is genuine', () => {
  envSetup();
  const expired = ct.makeVerifyToken(EMAIL, -1000); // minted already 1s past its expiry
  assert.equal(ct.verifyVerifyToken(EMAIL, expired), false);
  // Prove the signature itself was valid: the SAME signature with a future
  // expiry pasted on would be a forgery and must also fail, which is what
  // shows the expiry is inside the HMAC rather than beside it.
  const sig = expired.slice(0, expired.lastIndexOf('.'));
  const forged = `${sig}.${Date.now() + 600000}`;
  assert.equal(ct.verifyVerifyToken(EMAIL, forged), false,
    'moving the expiry must invalidate the signature -- the expiry is signed');
});

test('a token expiring one second from now is still accepted', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL, 1000);
  assert.equal(ct.verifyVerifyToken(EMAIL, token), true);
});

test('malformed tokens are rejected cleanly rather than throwing', () => {
  envSetup();
  const cases = [
    '', null, undefined, 42, {}, [],
    'no-dot-at-all',
    '.123456789',
    'abc.',
    'abc.notanumber',
    'abc.12.34',
    `${'x'.repeat(43)}.${Date.now() + 600000}`, // right shape, wrong signature
  ];
  for (const bad of cases) {
    assert.doesNotThrow(() => ct.verifyVerifyToken(EMAIL, bad), `threw on ${JSON.stringify(bad)}`);
    assert.equal(ct.verifyVerifyToken(EMAIL, bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

// timingSafeEqual THROWS on mismatched buffer lengths, so a wrong-LENGTH token
// must be length-checked out before it ever reaches the comparison.
test('a wrong-length signature is rejected without throwing', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  const dot = token.lastIndexOf('.');
  const short = `${token.slice(0, dot - 5)}.${token.slice(dot + 1)}`;
  assert.doesNotThrow(() => ct.verifyVerifyToken(EMAIL, short));
  assert.equal(ct.verifyVerifyToken(EMAIL, short), false);
});

test('with no signing secret at all, minting returns "" and verification always fails', () => {
  const hadSession = process.env.ADMIN_SESSION_SECRET;
  const hadGoogle = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    assert.equal(ct.makeVerifyToken(EMAIL), '');
    assert.equal(ct.verifyVerifyToken(EMAIL, 'anything.9999999999999'), false);
  } finally {
    if (hadSession !== undefined) process.env.ADMIN_SESSION_SECRET = hadSession;
    if (hadGoogle !== undefined) process.env.GOOGLE_CLIENT_SECRET = hadGoogle;
  }
});

test('rotating the signing secret invalidates outstanding tokens', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  process.env.ADMIN_SESSION_SECRET = 'a-different-secret';
  try {
    assert.equal(ct.verifyVerifyToken(EMAIL, token), false);
  } finally {
    process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  }
});

test('resolveVerifyToken returns the client record the token was issued for', () => {
  envSetup();
  const clients = [
    { name: 'Alice', email: 'alice@example.com', phone: '5550100100' },
    { name: 'Bob', email: 'bob@example.com', phone: '' },
    { name: 'Cara', email: 'cara@example.com', phone: '5550100300' },
  ];
  const token = ct.makeVerifyToken('bob@example.com');
  const found = ct.resolveVerifyToken(clients, token);
  assert.ok(found, 'expected a match');
  assert.equal(found.email, 'bob@example.com');
  assert.equal(found.name, 'Bob');
});

test('resolveVerifyToken returns null once the client is off the list', () => {
  envSetup();
  const token = ct.makeVerifyToken('bob@example.com');
  const without = [{ name: 'Alice', email: 'alice@example.com', phone: '' }];
  assert.equal(ct.resolveVerifyToken(without, token), null);
});

test('resolveVerifyToken tolerates empty, missing and malformed client lists', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  assert.equal(ct.resolveVerifyToken([], token), null);
  assert.equal(ct.resolveVerifyToken(null, token), null);
  assert.equal(ct.resolveVerifyToken(undefined, token), null);
  assert.equal(ct.resolveVerifyToken([null, {}, { email: '' }], token), null);
  assert.equal(ct.resolveVerifyToken([{ email: EMAIL }], ''), null);
  assert.equal(ct.resolveVerifyToken([{ email: EMAIL }], null), null);
});

test('resolveVerifyToken refuses an expired token even for a listed client', () => {
  envSetup();
  const clients = [{ name: 'Alice', email: 'alice@example.com', phone: '' }];
  const expired = ct.makeVerifyToken('alice@example.com', -1000);
  assert.equal(ct.resolveVerifyToken(clients, expired), null);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(ct.normalizeEmail('  A@B.CO '), 'a@b.co');
  assert.equal(ct.normalizeEmail(null), '');
  assert.equal(ct.normalizeEmail(undefined), '');
});
