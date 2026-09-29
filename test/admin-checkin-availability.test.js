const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');
const av = require('../api/_availability');
const store = require('../api/_blob-store');
const { loadCheckinTemplate } = require('../api/_load-checkin-template');
const handler = require('../api/admin/checkin-availability.js');

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
  return { method, headers: { cookie: cookieValueOf(auth.issueSessionCookie()) }, body };
}

function cloneTemplate() {
  return JSON.parse(JSON.stringify(av.DEFAULT_TEMPLATE));
}

test('loadCheckinTemplate reads CHECKIN_AVAILABILITY_BLOB, never the applicant blob', async () => {
  envSetup();
  const readSpy = spyStub({ ok: true, data: null });
  await withStubs([{ obj: store, key: 'readJson', value: readSpy }], async () => {
    await loadCheckinTemplate();
    assert.equal(readSpy.calls.length, 1);
    assert.equal(readSpy.calls[0][0], 'checkin-availability-template.json');
    assert.equal(readSpy.calls[0][0], store.CHECKIN_AVAILABILITY_BLOB);
    assert.notEqual(readSpy.calls[0][0], store.AVAILABILITY_BLOB);
  });
});

test('loadCheckinTemplate falls back to the normalized default when never written', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: null }) },
  ], async () => {
    const r = await loadCheckinTemplate();
    assert.equal(r.ok, true);
    assert.equal(r.usedDefault, true);
    assert.deepEqual(r.template, av.normalizeTemplate(av.DEFAULT_TEMPLATE));
  });
});

test('loadCheckinTemplate normalizes a stored document and reports usedDefault:false', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: {
      timezone: 'Europe/Istanbul',
      days: { mon: { enabled: true, start: '9:00', end: '12:00' } },
      slotMinutes: 20, bufferMinutes: 5, minNoticeHours: 24,
    } }) },
  ], async () => {
    const r = await loadCheckinTemplate();
    assert.equal(r.ok, true);
    assert.equal(r.usedDefault, false);
    assert.equal(r.template.timezone, 'Europe/Istanbul');
    assert.equal(r.template.slotMinutes, 20);
    assert.equal(r.template.bufferMinutes, 5);
    assert.equal(r.template.days.mon.start, '09:00', 'normalizeTemplate zero-pads');
    // Days absent from the document come back disabled -- availability fails closed.
    assert.equal(r.template.days.tue.enabled, false);
    assert.deepEqual(Object.keys(r.template.days).sort(),
      ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
  });
});

test('loadCheckinTemplate still returns a usable default template on a read failure', async () => {
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, data: null }) },
  ], async () => {
    const r = await loadCheckinTemplate();
    assert.equal(r.ok, false);
    assert.equal(r.reason, store.BLOB_NOT_CONFIGURED);
    assert.deepEqual(r.template, av.normalizeTemplate(av.DEFAULT_TEMPLATE));
  });
});

test('GET with no session -> 401', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res._status, 401);
});

test('POST with no session -> 401, and writeJson is NOT called', async () => {
  envSetup();
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { template: cloneTemplate() } }, res);
    assert.equal(res._status, 401);
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated GET -> 200 with all seven day keys', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('GET'), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.deepEqual(Object.keys(res._json.template.days).sort(),
    ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
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

test('authenticated POST writes to CHECKIN_AVAILABILITY_BLOB, never the applicant blob', async () => {
  envSetup();
  const writeSpy = spyStub({ ok: true });
  await withStubs([{ obj: store, key: 'writeJson', value: writeSpy }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: cloneTemplate() }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(writeSpy.calls.length, 1);
    assert.equal(writeSpy.calls[0][0], store.CHECKIN_AVAILABILITY_BLOB);
    assert.notEqual(writeSpy.calls[0][0], store.AVAILABILITY_BLOB,
      'saving check-in hours must never overwrite the new-applicant hours');
  });
});

test('authenticated POST saves an independent timezone and slot length', async () => {
  envSetup();
  const writeSpy = spyStub({ ok: true });
  const tpl = cloneTemplate();
  tpl.timezone = 'Europe/Istanbul';
  tpl.slotMinutes = 15;
  tpl.bufferMinutes = 0;
  tpl.minNoticeHours = 24;
  await withStubs([{ obj: store, key: 'writeJson', value: writeSpy }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: tpl }), res);
    assert.equal(res._status, 200);
    const saved = writeSpy.calls[0][1];
    assert.equal(saved.timezone, 'Europe/Istanbul');
    assert.equal(saved.slotMinutes, 15);
    assert.equal(saved.bufferMinutes, 0);
    assert.equal(res._json.template.slotMinutes, 15);
  });
});

test('authenticated POST with mon.end before mon.start -> 400 mentioning mon, writeJson NOT called', async () => {
  envSetup();
  const bad = cloneTemplate();
  bad.days.mon.enabled = true;
  bad.days.mon.start = '17:00';
  bad.days.mon.end = '09:00';
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: bad }), res);
    assert.equal(res._status, 400);
    assert.equal(res._json.ok, false);
    assert.ok(res._json.errors.some(e => e.includes('mon')));
    // Validate BEFORE normalize: normalizing alone would silently rewrite the
    // mistake into hours Omar never chose.
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated POST with an invalid timezone or slot length -> 400', async () => {
  envSetup();
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const badTz = cloneTemplate(); badTz.timezone = 'Not/AZone';
    const badSlot = cloneTemplate(); badSlot.slotMinutes = 7;
    for (const tpl of [badTz, badSlot]) {
      const res = makeRes();
      await handler(authedReq('POST', { template: tpl }), res);
      assert.equal(res._status, 400);
    }
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated POST with no template at all -> 400', async () => {
  envSetup();
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', {}), res);
    assert.equal(res._status, 400);
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated POST when the write fails with BLOB_NOT_CONFIGURED -> 503', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'writeJson', value: spyStub({ ok: false, reason: store.BLOB_NOT_CONFIGURED }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: cloneTemplate() }), res);
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
