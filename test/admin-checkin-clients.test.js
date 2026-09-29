const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');
const store = require('../api/_blob-store');
const cc = require('../api/_checkin-clients');
const handler = require('../api/admin/checkin-clients.js');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_PASSCODE = 'test-passcode';
  store.__setClientForTests(emptyBlobClient());
}

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try {
    return await fn();
  } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }
function authedReq(method, body) {
  return { method, headers: { cookie: cookieValueOf(auth.issueSessionCookie()) }, body, query: {} };
}

const ALICE = { name: 'Alice', email: 'alice@example.com', phone: '5550100100' };
const BOB = { name: 'Bob', email: 'bob@example.com', phone: '' };

test('GET with no session -> 401, and loadClients is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true, clients: [] });
  await withStubs([{ obj: cc, key: 'loadClients', value: spy }], async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0, 'the client list must not be read before auth passes');
  });
});

test('POST with no session -> 401, and saveClients is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: spyStub({ ok: true, clients: [] }) },
    { obj: cc, key: 'saveClients', value: spy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { client: ALICE }, query: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0);
  });
});

test('DELETE with no session -> 401, and saveClients is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: spyStub({ ok: true, clients: [ALICE] }) },
    { obj: cc, key: 'saveClients', value: spy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'DELETE', headers: {}, body: { email: ALICE.email }, query: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0);
  });
});

test('authenticated GET -> 200 with the client list', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.deepEqual(res._json.clients, [ALICE, BOB]);
    assert.equal(res._json.storageMissing, false);
  });
});

test('authenticated GET with BLOB_NOT_CONFIGURED -> 200, empty list, storageMissing:true', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    // Mirrors admin/availability.js: the manager must still render so Omar can
    // see what is missing rather than the panel failing opaquely.
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.deepEqual(res._json.clients, []);
    assert.equal(res._json.storageMissing, true);
  });
});

test('authenticated POST with a valid client -> 200 and saveClients called once with the appended entry', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: { name: 'Bob', email: 'BOB@Example.com', phone: ' 555-0199 ' } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(saveSpy.calls.length, 1);
    const written = saveSpy.calls[0][0];
    assert.equal(written.length, 2);
    assert.deepEqual(written[1], { name: 'Bob', email: 'bob@example.com', phone: '555-0199' });
    // The response echoes the saved list so the page never needs a second GET.
    assert.deepEqual(res._json.clients, written);
  });
});

test('authenticated POST with an email already on the list REPLACES it instead of duplicating', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: { name: 'Alice Renamed', email: 'alice@example.com', phone: '5559999999' } }), res);
    assert.equal(res._status, 200);
    const written = saveSpy.calls[0][0];
    assert.equal(written.length, 2, 'the list must not grow');
    assert.equal(written[0].name, 'Alice Renamed');
    assert.equal(written[0].phone, '5559999999');
    assert.equal(written[1].email, 'bob@example.com');
  });
});

test('authenticated POST with no valid email -> 400 mentioning email, saveClients NOT called', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    for (const client of [
      { name: 'Ghost', phone: '5550100' },
      { name: 'Ghost', email: '', phone: '5550100' },
      { name: 'Ghost', email: '   ', phone: '5550100' },
      { name: 'Ghost', email: 'not-an-email', phone: '' },
    ]) {
      const res = makeRes();
      await handler(authedReq('POST', { client }), res);
      assert.equal(res._status, 400, `${JSON.stringify(client)} should be 400`);
      assert.equal(res._json.ok, false);
      assert.ok(Array.isArray(res._json.errors));
      assert.ok(res._json.errors.some(e => /email/i.test(e)),
        `expected an error mentioning email, got ${JSON.stringify(res._json.errors)}`);
    }
    assert.equal(saveSpy.calls.length, 0, 'a rejected entry must never reach the store');
  });
});

test('authenticated POST with a missing or non-object client -> 400', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: spyStub({ ok: true }) },
  ], async () => {
    for (const body of [{}, { client: null }, { client: 'alice' }]) {
      const res = makeRes();
      await handler(authedReq('POST', body), res);
      assert.equal(res._status, 400, `${JSON.stringify(body)} should be 400`);
    }
  });
});

test('authenticated POST with no phone is accepted -- phone is optional', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: { name: 'Solo', email: 'solo@example.com' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(saveSpy.calls[0][0], [{ name: 'Solo', email: 'solo@example.com', phone: '' }]);
  });
});

test('authenticated POST when the write fails with BLOB_NOT_CONFIGURED -> 503 with a readable message', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: ALICE }), res);
    assert.equal(res._status, 503);
    assert.equal(res._json.ok, false);
    assert.ok(res._json.errors.some(e => /Blob store/i.test(e)));
  });
});

test('authenticated POST when the write fails for another reason -> 502 carrying that reason', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: async () => ({ ok: false, reason: 'blob put 500' }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: ALICE }), res);
    assert.equal(res._status, 502);
    assert.ok(res._json.errors.includes('blob put 500'));
  });
});

test('authenticated POST when the READ fails with BLOB_NOT_CONFIGURED -> 503 and no write', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: ALICE }), res);
    assert.equal(res._status, 503);
    // Writing a list built on a failed read would replace the whole roster with
    // this one entry -- a silent wipe of every other client.
    assert.equal(saveSpy.calls.length, 0, 'never write a list built on a failed read');
  });
});

test('authenticated DELETE removes the entry and returns the remaining list', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('DELETE', { email: 'ALICE@EXAMPLE.COM' }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(saveSpy.calls.length, 1);
    assert.deepEqual(saveSpy.calls[0][0], [BOB]);
    assert.deepEqual(res._json.clients, [BOB]);
  });
});

test('authenticated DELETE of an email not on the list -> 404 and no write', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('DELETE', { email: 'nobody@example.com' }), res);
    assert.equal(res._status, 404);
    assert.equal(res._json.ok, false);
    assert.equal(saveSpy.calls.length, 0, 'a no-op delete must not rewrite the document');
  });
});

test('authenticated DELETE with no email -> 400 and no write', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    for (const body of [{}, { email: '' }, { email: '   ' }, null]) {
      const res = makeRes();
      await handler(authedReq('DELETE', body), res);
      assert.equal(res._status, 400, `${JSON.stringify(body)} should be 400`);
    }
    assert.equal(saveSpy.calls.length, 0);
  });
});

// Some proxies and fetch implementations drop a body on DELETE, which would
// turn every remove into a 400. The query fallback is what keeps the admin
// page's remove button working regardless.
test('authenticated DELETE reads the email from the query string when the body is absent', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler({
      method: 'DELETE',
      headers: { cookie: cookieValueOf(auth.issueSessionCookie()) },
      body: undefined,
      query: { email: 'bob@example.com' },
    }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(saveSpy.calls[0][0], [ALICE]);
  });
});

test('an unsupported method (PUT) while authenticated -> 405', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('PUT', {}), res);
  assert.equal(res._status, 405);
});

test('every response carries Cache-Control: no-store', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    assert.equal(res._headers['Cache-Control'], 'no-store');
  });
});
