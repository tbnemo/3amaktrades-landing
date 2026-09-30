// The admin passcode gate accepted unlimited attempts. Everything else about it
// was right -- one shared passcode, constant-time comparison, fails closed when
// unset -- but with no lockout a short passcode is brute-forceable at whatever
// rate the network allows, and nothing in the logs would distinguish a thousand
// guesses from one.
//
// Serverless rules out an in-memory counter (a fresh invocation resets it), so the
// state is persisted in the Blob store. These tests drive the real endpoint against
// a fake blob client that behaves like the real one: writes land, reads come back,
// and a missing document reads as null rather than throwing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const rateLimit = require('../api/_login-rate-limit');
const handler = require('../api/admin/auth').login;

const PASSCODE = 'correct-horse-battery';

function makeRes() {
  return {
    _status: null, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

// An in-memory stand-in for Vercel Blob with the shape _blob-store.js expects:
// get() resolves to null for a document that was never written, and to an object
// exposing a readable `stream` otherwise.
function fakeBlob() {
  const docs = new Map();
  const client = {
    docs,
    reads: 0,
    writes: 0,
    failReads: false,
    async get(pathname) {
      client.reads++;
      if (client.failReads) throw new Error('blob store unreachable');
      if (!docs.has(pathname)) return null;
      return { stream: new Response(docs.get(pathname)).body };
    },
    async put(pathname, body) {
      client.writes++;
      docs.set(pathname, body);
      return {};
    },
  };
  return client;
}

function setup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_PASSCODE = PASSCODE;
  const blob = fakeBlob();
  store.__setClientForTests(blob);
  return blob;
}

function post(passcode) {
  return { method: 'POST', body: { passcode } };
}

async function attempt(passcode) {
  const res = makeRes();
  await handler(post(passcode), res);
  return res;
}

function attemptsDoc(blob) {
  const raw = blob.docs.get(store.LOGIN_ATTEMPTS_BLOB);
  return raw ? JSON.parse(raw) : null;
}

test('the attempt counter is its own blob, not squatting in the availability or oauth document', () => {
  assert.equal(store.LOGIN_ATTEMPTS_BLOB, 'login-attempts.json');
  assert.notEqual(store.LOGIN_ATTEMPTS_BLOB, store.AVAILABILITY_BLOB);
  assert.notEqual(store.LOGIN_ATTEMPTS_BLOB, store.OAUTH_BLOB);
});

test('the correct passcode still logs in and sets the session cookie', async () => {
  setup();
  const res = await attempt(PASSCODE);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.match(res._headers['Set-Cookie'], /amak_admin=/);
  assert.match(res._headers['Set-Cookie'], /HttpOnly/);
});

test('a wrong passcode is still 401 while attempts remain', async () => {
  setup();
  for (let i = 1; i < rateLimit.MAX_FAILURES; i++) {
    const res = await attempt('nope');
    assert.equal(res._status, 401, `attempt ${i} should still be a plain 401`);
    assert.equal(res._json.error, 'wrong passcode');
  }
});

// THE fix. Before it, this loop would return 401 forever.
test('LOCKOUT: after MAX_FAILURES wrong guesses the gate stops answering with 401 and returns 429', async () => {
  const blob = setup();

  for (let i = 1; i < rateLimit.MAX_FAILURES; i++) {
    assert.equal((await attempt('nope'))._status, 401);
  }
  // The attempt that trips the threshold reports the lockout itself.
  const tripping = await attempt('nope');
  assert.equal(tripping._status, 429,
    `guess number ${rateLimit.MAX_FAILURES} must be refused, not answered with another 401`);
  assert.ok(tripping._headers['Retry-After'], 'a 429 must carry Retry-After');
  assert.ok(Number(tripping._headers['Retry-After']) > 0);
  assert.match(tripping._json.error, /too many failed attempts/i);

  // And every attempt after it, including one with the RIGHT passcode: a lockout
  // that the correct passcode walks straight through would not be a lockout at all,
  // since guessing is exactly how an attacker arrives at the correct passcode.
  const stillLocked = await attempt('nope');
  assert.equal(stillLocked._status, 429);
  const rightButLocked = await attempt(PASSCODE);
  assert.equal(rightButLocked._status, 429,
    'the lockout must hold even for the correct passcode');
  assert.equal(rightButLocked._headers['Set-Cookie'], undefined,
    'no session may be issued while locked out');

  const doc = attemptsDoc(blob);
  assert.ok(doc.lockedUntilMs > Date.now(), 'the lockout must be persisted, not in memory');
});

test('LOCKOUT EXPIRES: once the window passes, logging in works again', async () => {
  const blob = setup();
  for (let i = 0; i < rateLimit.MAX_FAILURES; i++) await attempt('nope');
  assert.equal((await attempt(PASSCODE))._status, 429);

  // Rewind the persisted lockout to just before now -- the same thing the passage
  // of time does. This is the recovery path Omar depends on: "wait 15 minutes".
  const doc = attemptsDoc(blob);
  doc.lockedUntilMs = Date.now() - 1;
  blob.docs.set(store.LOGIN_ATTEMPTS_BLOB, JSON.stringify(doc));

  const res = await attempt(PASSCODE);
  assert.equal(res._status, 200, 'an expired lockout must not keep Omar out of his own admin page');
  assert.match(res._headers['Set-Cookie'], /amak_admin=/);
});

test('LOCKOUT EXPIRES: the first guess after the window is a fresh 401, not an instant re-lock', async () => {
  const blob = setup();
  for (let i = 0; i < rateLimit.MAX_FAILURES; i++) await attempt('nope');

  const doc = attemptsDoc(blob);
  doc.lockedUntilMs = Date.now() - 1;
  blob.docs.set(store.LOGIN_ATTEMPTS_BLOB, JSON.stringify(doc));

  // If the failure count were left at its maximum when locking, this single wrong
  // guess would re-lock immediately and 15 minutes would become forever.
  const res = await attempt('nope');
  assert.equal(res._status, 401,
    'one wrong guess after the window expired must not re-lock the gate straight away');
});

test('a successful login clears the counter, so earlier typos do not carry over', async () => {
  const blob = setup();
  await attempt('nope');
  await attempt('nope');
  assert.equal((await attempt(PASSCODE))._status, 200);

  const doc = attemptsDoc(blob);
  assert.equal(doc.failures, 0);
  assert.equal(doc.lockedUntilMs, 0);

  // Proof the reset is real and not just a tidier document: a full fresh run of
  // wrong guesses is needed to lock again.
  for (let i = 1; i < rateLimit.MAX_FAILURES; i++) {
    assert.equal((await attempt('nope'))._status, 401, `post-reset attempt ${i} should be 401`);
  }
});

test('failures DECAY: guesses spread further apart than the window never accumulate into a lockout', async () => {
  const blob = setup();
  // Four separate wrong guesses, each long after the previous one. Without decay
  // these would stack and a fifth typo months later would lock the account.
  for (let i = 0; i < 4; i++) {
    const res = await attempt('nope');
    assert.equal(res._status, 401);
    const doc = attemptsDoc(blob);
    assert.equal(doc.failures, 1, 'each stale attempt must start a fresh run');
    doc.lastFailureMs = Date.now() - (rateLimit.LOCKOUT_MS + 60000);
    blob.docs.set(store.LOGIN_ATTEMPTS_BLOB, JSON.stringify(doc));
  }
  assert.equal((await attempt(PASSCODE))._status, 200);
});

// Fails CLOSED. If an unreadable counter let logins through, an attacker who can
// make the Blob store unreachable gets the old unlimited-guessing behaviour back
// for free -- so this is the case that decides whether the fix is worth anything.
test('FAIL CLOSED: an unreadable Blob store refuses the login rather than skipping the check', async () => {
  const blob = setup();
  blob.failReads = true;

  const res = await attempt(PASSCODE);
  assert.equal(res._status, 503,
    'an unreadable attempt log must refuse the login, never wave it through');
  assert.equal(res._headers['Set-Cookie'], undefined, 'no session may be issued');
  assert.match(res._json.error, /temporarily unavailable/i);

  // Self-healing: nothing was persisted, so the moment reads work the gate opens.
  blob.failReads = false;
  assert.equal((await attempt(PASSCODE))._status, 200,
    'recovery must need nothing but a working store -- no stuck state');
});

test('FAIL CLOSED: an unconfigured Blob store refuses the login too', async () => {
  setup();
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  try {
    const res = await attempt(PASSCODE);
    assert.equal(res._status, 503);
    assert.match(res._json.error, /Blob store/i,
      'the message must name the actual cause so it is fixable');
  } finally {
    process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  }
});

test('the rate limiter never runs before the ADMIN_PASSCODE check, and costs no blob read there', async () => {
  const blob = setup();
  delete process.env.ADMIN_PASSCODE;
  try {
    const before = blob.reads;
    const res = await attempt('anything');
    assert.equal(res._status, 503);
    assert.match(res._json.error, /ADMIN_PASSCODE is not set/);
    assert.equal(blob.reads, before,
      'an unconfigured passcode must be reported plainly, not turned into a rate-limit read');
  } finally {
    process.env.ADMIN_PASSCODE = PASSCODE;
  }
});

test('a non-POST request is still 405 and never touches the store', async () => {
  const blob = setup();
  const before = blob.reads + blob.writes;
  const res = makeRes();
  await handler({ method: 'GET' }, res);
  assert.equal(res._status, 405);
  assert.equal(blob.reads + blob.writes, before);
});

test('a garbled attempts document is treated as a clean slate rather than throwing', async () => {
  const blob = setup();
  for (const junk of ['null', '"nope"', '{"failures":"lots","lockedUntilMs":null}', '{}']) {
    blob.docs.set(store.LOGIN_ATTEMPTS_BLOB, junk);
    const res = await attempt(PASSCODE);
    assert.equal(res._status, 200, `junk document ${junk} must not break login`);
  }
});

test('a lockout timestamp far in the future still reports a sane Retry-After', async () => {
  const blob = setup();
  blob.docs.set(store.LOGIN_ATTEMPTS_BLOB,
    JSON.stringify({ failures: 0, lastFailureMs: Date.now(), lockedUntilMs: Date.now() + 90 * 60000 }));
  const res = await attempt(PASSCODE);
  assert.equal(res._status, 429);
  assert.ok(Number(res._headers['Retry-After']) > 0);
  assert.ok(res._json.retryAfterSec > 0);
});
