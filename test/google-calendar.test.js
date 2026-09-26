const { test } = require('node:test');
const assert = require('node:assert/strict');
const gcal = require('../api/_google-calendar');
const store = require('../api/_blob-store');

function envSetup() {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.PUBLIC_BASE_URL = 'https://3amaktrades.com';
  gcal.__resetTokenCacheForTests();
}

function memoryBlob(initial = {}) {
  const docs = { ...initial };
  return {
    get: async (pathname) => docs[pathname] === undefined
      ? null
      : { stream: new Response(docs[pathname]).body, blob: {}, headers: new Headers() },
    put: async (pathname, content) => { docs[pathname] = content; return { pathname }; },
    __docs: docs,
  };
}

test('the redirect URI matches the value registered in Google Cloud', () => {
  envSetup();
  // Renaming this path silently breaks OAuth -- Google rejects unregistered URIs.
  assert.equal(gcal.redirectUri(), 'https://3amaktrades.com/api/calendar-oauth-callback');
});

test('the consent URL requests offline access and forces a refresh token', () => {
  envSetup();
  const u = new URL(gcal.consentUrl('state123'));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  // Without prompt=consent, reconnecting returns no refresh token.
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar');
  assert.equal(u.searchParams.get('state'), 'state123');
  assert.equal(u.searchParams.get('response_type'), 'code');
});

test('reports NOT_CONNECTED when no refresh token has been stored', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob());
  const res = await gcal.getAccessToken();
  assert.equal(res.ok, false);
  assert.equal(res.reason, gcal.NOT_CONNECTED);
  assert.equal(await gcal.isConnected(), false);
});

test('caches the access token, then re-fetches when the refresh token changes', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  let calls = 0;
  gcal.__setFetchForTests(async () => {
    calls++;
    return { ok: true, status: 200,
      json: async () => ({ access_token: `at-${calls}`, expires_in: 3600 }) };
  });

  const a = await gcal.getAccessToken();
  const b = await gcal.getAccessToken();
  assert.equal(a.accessToken, 'at-1');
  assert.equal(b.accessToken, 'at-1', 'second call should hit the cache');
  assert.equal(calls, 1);

  // Omar reconnects with a different Google account: the cached token belongs to
  // the old one and must not be served. Keying the cache on the refresh token's
  // own value (not just an expiry) is what catches this.
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-2' }),
  }));
  const c = await gcal.getAccessToken();
  assert.equal(c.accessToken, 'at-2');
  assert.equal(calls, 2);
});

test('freeBusy converts Google timestamps to epoch ms', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  gcal.__setFetchForTests(async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({
      calendars: { primary: { busy: [
        { start: '2026-09-28T13:00:00Z', end: '2026-09-28T14:00:00Z' },
      ] } },
    }) };
  });
  const res = await gcal.freeBusy('2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z');
  assert.equal(res.ok, true);
  assert.deepEqual(res.busy, [{
    start: Date.parse('2026-09-28T13:00:00Z'),
    end: Date.parse('2026-09-28T14:00:00Z'),
  }]);
});

test('insertEvent retries without conferencing if Meet creation is rejected (R7)', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  const bodies = [];
  gcal.__setFetchForTests(async (url, opts) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return { ok: false, status: 400,
        text: async () => 'Invalid conference type value',
        json: async () => ({ error: { message: 'Invalid conference type value' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'evt-1' }) };
  });
  const res = await gcal.insertEvent({
    summary: 'Call', start: { dateTime: '2026-09-28T13:00:00Z' },
    end: { dateTime: '2026-09-28T13:30:00Z' },
    conferenceData: { createRequest: { requestId: 'r1' } },
  });
  assert.equal(res.ok, true);
  assert.equal(res.event.id, 'evt-1');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].conferenceData, 'first attempt should ask for Meet');
  assert.equal(bodies[1].conferenceData, undefined, 'retry should drop conferenceData');
});

test('a Google error surfaces as ok:false rather than throwing', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  gcal.__setFetchForTests(async () => ({
    ok: false, status: 401, text: async () => 'invalid_grant',
    json: async () => ({ error: 'invalid_grant' }),
  }));
  const res = await gcal.getAccessToken();
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid_grant/);
});
