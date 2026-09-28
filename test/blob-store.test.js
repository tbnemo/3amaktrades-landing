const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');

function fakeClient({ body = null, throwOnGet = null } = {}) {
  const calls = { get: [], put: [] };
  return {
    calls,
    get: async (pathname, options) => {
      calls.get.push({ pathname, options });
      if (throwOnGet) throw throwOnGet;
      if (body === null) return null;
      return { stream: new Response(body).body, blob: {}, headers: new Headers() };
    },
    put: async (pathname, content, options) => {
      calls.put.push({ pathname, content, options });
      return { pathname };
    },
  };
}

test('readJson returns data:null when the blob does not exist', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  store.__setClientForTests(fakeClient({ body: null }));
  const res = await store.readJson('availability-template.json');
  assert.equal(res.ok, true);
  assert.equal(res.data, null);
});

test('readJson parses JSON and always bypasses the CDN cache', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const c = fakeClient({ body: JSON.stringify({ timezone: 'America/Toronto' }) });
  store.__setClientForTests(c);
  const res = await store.readJson('availability-template.json');
  assert.equal(res.ok, true);
  assert.equal(res.data.timezone, 'America/Toronto');
  // A stale read here would serve an old refresh token or old hours.
  assert.equal(c.calls.get[0].options.useCache, false);
  assert.equal(c.calls.get[0].options.access, 'private');
});

test('writeJson writes privately, overwritably, with a stable pathname', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const c = fakeClient();
  store.__setClientForTests(c);
  const res = await store.writeJson('availability-template.json', { a: 1 });
  assert.equal(res.ok, true);
  const put = c.calls.put[0];
  assert.equal(put.options.access, 'private');       // public == credential leak
  assert.equal(put.options.allowOverwrite, true);
  assert.equal(put.options.addRandomSuffix, false);  // else we can never read it back
  assert.equal(put.options.contentType, 'application/json');
  assert.deepEqual(JSON.parse(put.content), { a: 1 });
});

test('reports BLOB_NOT_CONFIGURED instead of throwing when there is no store', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  store.__setClientForTests(fakeClient());
  const read = await store.readJson('availability-template.json');
  assert.equal(read.ok, false);
  assert.equal(read.reason, store.BLOB_NOT_CONFIGURED);
  const write = await store.writeJson('availability-template.json', {});
  assert.equal(write.ok, false);
  assert.equal(write.reason, store.BLOB_NOT_CONFIGURED);
});

test('a throwing client surfaces as ok:false, never an exception', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  store.__setClientForTests(fakeClient({ throwOnGet: new Error('network down') }));
  const res = await store.readJson('availability-template.json');
  assert.equal(res.ok, false);
  assert.match(res.reason, /network down/);
});
