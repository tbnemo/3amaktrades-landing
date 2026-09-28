// The two JSON documents holding every piece of persistent state for the
// booking system. Both are PRIVATE: oauth-refresh-token.json holds a Google
// refresh token, which at a public blob URL would be a credential leak.
//
// Reads always pass useCache:false. Vercel Blob's cacheControlMaxAge cannot be
// set below 60s (and defaults to a month), so a CDN-cached read of a mutable
// document can serve hours-old availability, or a refresh token Omar has
// already replaced. useCache:false reads origin storage instead.
const vercelBlob = require('@vercel/blob');

const BLOB_NOT_CONFIGURED = 'BLOB_NOT_CONFIGURED';
const AVAILABILITY_BLOB = 'availability-template.json';
const OAUTH_BLOB = 'oauth-refresh-token.json';
// Failed admin passcode attempts. Its own document rather than a field on either
// of the two above: those are read on the visitor-facing hot path, and a login
// counter has no business being rewritten there. Also private -- it reveals when
// someone is guessing.
const LOGIN_ATTEMPTS_BLOB = 'login-attempts.json';

let client = { get: vercelBlob.get, put: vercelBlob.put };

// Tests inject a fake so the suite never needs a real Blob store.
function __setClientForTests(c) { client = c; }

// The Blob store does not exist on this project yet (the user creates it from
// the Vercel dashboard). Detect that up front so callers can return a readable
// "storage not set up" message instead of a 500 from deep inside the SDK.
function isConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN
    || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));
}

async function readJson(pathname) {
  if (!isConfigured()) return { ok: false, reason: BLOB_NOT_CONFIGURED, data: null };
  try {
    const result = await client.get(pathname, { access: 'private', useCache: false });
    if (!result) return { ok: true, data: null }; // not written yet -- normal first run
    const text = await new Response(result.stream).text();
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, reason: e.message || String(e), data: null };
  }
}

async function writeJson(pathname, data) {
  if (!isConfigured()) return { ok: false, reason: BLOB_NOT_CONFIGURED };
  try {
    await client.put(pathname, JSON.stringify(data, null, 2), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false, // a random suffix changes the pathname every write
      cacheControlMaxAge: 60, // the SDK's floor; reads bypass the cache anyway
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

module.exports = {
  readJson, writeJson, isConfigured, __setClientForTests,
  BLOB_NOT_CONFIGURED, AVAILABILITY_BLOB, OAUTH_BLOB, LOGIN_ATTEMPTS_BLOB,
};
