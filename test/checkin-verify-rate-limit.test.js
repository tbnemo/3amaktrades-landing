const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const rl = require('../api/_checkin-verify-rate-limit');

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
}

// A tiny in-memory fake standing in for the real Blob store, keyed by pathname
// -- exactly like the pattern used for admin-login-rate-limit's own tests.
function fakeBlobClient() {
  const docs = new Map();
  return {
    get: async (pathname) => {
      if (!docs.has(pathname)) return null;
      const text = docs.get(pathname);
      return { stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }) };
    },
    put: async (pathname, body) => { docs.set(pathname, body); return {}; },
  };
}

test('a fresh identifier is always allowed', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const result = await rl.check('nobody@example.com');
  assert.deepEqual(result, { allowed: true });
});

test('MAX_FAILURES=5 and LOCKOUT_MS=15 minutes, matching the admin gate', () => {
  assert.equal(rl.MAX_FAILURES, 5);
  assert.equal(rl.LOCKOUT_MS, 15 * 60 * 1000);
});

test('after 5 failures for ONE identifier, that identifier is locked and check() reports it', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const now = Date.now();
  let last;
  for (let i = 0; i < 5; i++) last = await rl.recordFailure('target@example.com', now + i);

  assert.equal(last.locked, true);
  assert.ok(last.retryAfterSec > 0);

  const blocked = await rl.check('target@example.com', now + 5);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.locked, true);
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 900);
});

test('failures against one identifier do NOT lock a different identifier', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const now = Date.now();
  for (let i = 0; i < 5; i++) await rl.recordFailure('victim-target@example.com', now + i);

  const other = await rl.check('someone-else@example.com', now + 5);
  assert.deepEqual(other, { allowed: true },
    'one identifier being locked must never affect a different identifier');
});

test('identifiers are compared case- and whitespace-insensitively, like email matching elsewhere', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const now = Date.now();
  for (let i = 0; i < 5; i++) await rl.recordFailure('  Target@Example.COM  ', now + i);

  const blocked = await rl.check('target@example.com', now + 5);
  assert.equal(blocked.allowed, false);
});

test('a lock expires on its own after LOCKOUT_MS', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const now = Date.now();
  for (let i = 0; i < 5; i++) await rl.recordFailure('expiring@example.com', now + i);

  const stillLocked = await rl.check('expiring@example.com', now + rl.LOCKOUT_MS - 1000);
  assert.equal(stillLocked.allowed, false);

  const clearedByTime = await rl.check('expiring@example.com', now + rl.LOCKOUT_MS + 1000);
  assert.deepEqual(clearedByTime, { allowed: true });
});

test('failures older than LOCKOUT_MS do not accumulate toward a new lock', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const now = Date.now();
  await rl.recordFailure('decays@example.com', now);
  await rl.recordFailure('decays@example.com', now + 1000);
  // A failure long after the first two -- they must not still be counted.
  const third = await rl.recordFailure('decays@example.com', now + rl.LOCKOUT_MS + 5000);
  assert.equal(third.locked, false);
  assert.equal(third.remaining, rl.MAX_FAILURES - 1, 'the stale pair must not still be counted');
});

test('clear() wipes an identifier\'s history so a later failure starts fresh', async () => {
  envSetup();
  store.__setClientForTests(fakeBlobClient());
  const now = Date.now();
  await rl.recordFailure('recovers@example.com', now);
  await rl.recordFailure('recovers@example.com', now + 1000);
  await rl.clear('recovers@example.com', now + 2000);

  const after = await rl.recordFailure('recovers@example.com', now + 3000);
  assert.equal(after.locked, false);
  assert.equal(after.remaining, rl.MAX_FAILURES - 1, 'clear() must reset the count, not just unlock it');
});

test('check() fails CLOSED when the store cannot be read', async () => {
  envSetup();
  store.__setClientForTests({ get: async () => { throw new Error('blob get 500'); }, put: async () => ({}) });
  const result = await rl.check('anyone@example.com');
  assert.equal(result.allowed, false);
  assert.equal(result.unavailable, true);
});

test('recordFailure() reports locked when the store cannot be read, matching the admin gate\'s fail-closed shape', async () => {
  envSetup();
  store.__setClientForTests({ get: async () => { throw new Error('blob get 500'); }, put: async () => ({}) });
  const result = await rl.recordFailure('anyone@example.com');
  assert.equal(result.locked, true);
});
