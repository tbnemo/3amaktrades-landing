const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');
const av = require('../api/_availability');
const store = require('../api/_blob-store');
const loadTemplateMod = require('../api/_load-template');
const handler = require('../api/admin/availability.js');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

// Every blob read comes back "not written yet" (ok:true, data:null), which is
// how loadTemplate() falls back to the normalized DEFAULT_TEMPLATE.
function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_PASSCODE = 'test-passcode';
  store.__setClientForTests(emptyBlobClient());
}

function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }
function reqWithCookie(method, cookie, body) {
  return { method, headers: cookie ? { cookie } : {}, body };
}
function authedReq(method, body) {
  const cookie = cookieValueOf(auth.issueSessionCookie());
  return reqWithCookie(method, cookie, body);
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// Applies a set of {obj, key, value} monkey-patches, runs fn, then restores
// every original value -- even if fn throws or an assertion fails -- so a
// stub installed by one test can never leak into the next.
async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try {
    return await fn();
  } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function cloneTemplate() {
  return JSON.parse(JSON.stringify(av.DEFAULT_TEMPLATE));
}

// availability.js destructures `const { loadTemplate } = require('../_load-template');`
// at require-time, binding a local const to whatever function object was on
// the module at that moment. Reassigning loadTemplateMod.loadTemplate later does
// NOT change that captured reference -- so to spy on loadTemplate itself (rather
// than on one of its internal dependencies), the handler module must be deleted
// from the require cache and re-required AFTER the stub is installed, forcing a
// fresh destructure of the current (stubbed) value. The module-level `handler`
// above was required once, before any test ran, so it is permanently bound to
// the real loadTemplate and is unaffected by this dance.
const availabilityPath = require.resolve('../api/admin/availability.js');
function freshHandlerWithStubbedLoadTemplate(stubFn) {
  loadTemplateMod.loadTemplate = stubFn;
  delete require.cache[availabilityPath];
  return require(availabilityPath);
}
function restoreRealLoadTemplate(originalLoadTemplate) {
  loadTemplateMod.loadTemplate = originalLoadTemplate;
  delete require.cache[availabilityPath]; // discard the stub-bound instance
}

test('GET with no session -> 401, and loadTemplate is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true, template: cloneTemplate(), usedDefault: true });
  const original = loadTemplateMod.loadTemplate;
  const freshHandler = freshHandlerWithStubbedLoadTemplate(spy);
  try {
    const res = makeRes();
    await freshHandler({ method: 'GET', headers: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0, 'loadTemplate must not be called before auth passes');
  } finally {
    restoreRealLoadTemplate(original);
  }
});

test('POST with no session -> 401, and writeJson is NOT called', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'writeJson', value: spyStub({ ok: true }) },
  ], async () => {
    const res = makeRes();
    const body = { template: cloneTemplate() };
    await handler({ method: 'POST', headers: {}, body }, res);
    assert.equal(res._status, 401);
    assert.equal(store.writeJson.calls.length, 0, 'writeJson must not be called before auth passes');
  });
});

test('authenticated GET -> 200 with a template containing all seven day keys', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('GET'), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  const dayKeys = Object.keys(res._json.template.days).sort();
  assert.deepEqual(dayKeys, ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
});

test('authenticated GET with BLOB_NOT_CONFIGURED -> 200 with storageMissing:true (not a 5xx)', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  store.__setClientForTests(emptyBlobClient());

  const res = makeRes();
  await handler(authedReq('GET'), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.storageMissing, true);

  process.env.BLOB_READ_WRITE_TOKEN = 'test-token'; // restore for later tests
});

test('authenticated POST with days.mon.end earlier than start -> 400, errors mention mon, writeJson NOT called', async () => {
  envSetup();
  const bad = cloneTemplate();
  bad.days.mon.enabled = true;
  bad.days.mon.start = '17:00';
  bad.days.mon.end = '09:00'; // end before start
  await withStubs([
    { obj: store, key: 'writeJson', value: spyStub({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: bad }), res);
    assert.equal(res._status, 400);
    assert.equal(res._json.ok, false);
    assert.ok(Array.isArray(res._json.errors));
    assert.ok(res._json.errors.some(e => e.includes('mon')), `expected an error mentioning "mon", got: ${JSON.stringify(res._json.errors)}`);
    // The 400 alone doesn't prove validate-before-normalize -- this does: a bad
    // save must never reach the store.
    assert.equal(store.writeJson.calls.length, 0, 'writeJson must not be called when validation fails');
  });
});

test('authenticated POST with a valid template -> 200 and writeJson called once', async () => {
  envSetup();
  const good = cloneTemplate();
  await withStubs([
    { obj: store, key: 'writeJson', value: spyStub({ ok: true }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: good }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(store.writeJson.calls.length, 1);
  });
});

test('authenticated POST when the write fails with BLOB_NOT_CONFIGURED -> 503', async () => {
  envSetup();
  const good = cloneTemplate();
  await withStubs([
    { obj: store, key: 'writeJson', value: spyStub({ ok: false, reason: store.BLOB_NOT_CONFIGURED }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: good }), res);
    assert.equal(res._status, 503);
    assert.equal(res._json.ok, false);
  });
});

test('an unsupported method (DELETE) while authenticated -> 405', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('DELETE'), res);
  assert.equal(res._status, 405);
});

// The bug this guards against: loadTemplate() returns {ok:false, reason:X,
// template:<defaults>} for BOTH "blob store never configured" (a legitimate
// first-run state) AND a genuine read failure (corrupted JSON, a real Blob API
// error). Before this fix, the handler only special-cased BLOB_NOT_CONFIGURED
// and let every OTHER failure reason fall through to the same 200 response
// used for a real successful load -- silently handing back fabricated
// defaults as if they were Omar's saved hours. If he saved without noticing,
// that overwrote his real hours. A genuine read failure must come back as a
// clear error, never as a fabricated-but-disguised-as-real 200.
test('authenticated GET when the read fails for a reason OTHER than BLOB_NOT_CONFIGURED -> 502, not a fabricated 200', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: spyStub({ ok: false, reason: 'some-genuine-blob-error' }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    assert.equal(res._status, 502);
    assert.equal(res._json.ok, false);
    assert.ok(Array.isArray(res._json.errors) && res._json.errors.length > 0);
    assert.ok(res._json.errors.some(e => /some-genuine-blob-error/.test(e)),
      `expected the failure reason to surface in the error message, got: ${JSON.stringify(res._json.errors)}`);
    // The whole point: no fabricated template must be handed back as if real.
    assert.equal(res._json.template, undefined);
    assert.equal(res._json.storageMissing, undefined);
  });
});
