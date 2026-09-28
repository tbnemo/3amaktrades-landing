const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseUrl } = require('../api/_site-url');
const gcal = require('../api/_google-calendar');

const VARS = ['PUBLIC_BASE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL'];

// Sets exactly the given vars (deleting the rest), runs fn, then restores every
// original value -- including "was not set at all" -- so one case cannot leak into
// the next or into any other test file.
function withEnv(values, fn) {
  const saved = {};
  for (const k of VARS) saved[k] = process.env[k];
  try {
    for (const k of VARS) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    }
    return fn();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// THE precedence that matters: VERCEL_URL is ALWAYS set on Vercel and is the
// per-DEPLOYMENT hostname -- a different host on every deploy. Google requires the
// redirect URI to byte-match the single value registered in its console, so if
// VERCEL_URL ever wins, OAuth fails with redirect_uri_mismatch on every attempt.
// PUBLIC_BASE_URL first, then the STABLE production domain, and only then the
// per-deployment host as a local/preview last resort.
test('PUBLIC_BASE_URL wins over both Vercel-provided hostnames', () => {
  withEnv({
    PUBLIC_BASE_URL: 'https://3amaktrades.com',
    VERCEL_PROJECT_PRODUCTION_URL: 'prod.vercel.app',
    VERCEL_URL: 'deployment-hash-abc123.vercel.app',
  }, () => {
    assert.equal(baseUrl(), 'https://3amaktrades.com');
  });
});

test('the stable production domain beats the per-deployment hostname', () => {
  withEnv({
    VERCEL_PROJECT_PRODUCTION_URL: 'prod.vercel.app',
    VERCEL_URL: 'deployment-hash-abc123.vercel.app',
  }, () => {
    assert.equal(baseUrl(), 'https://prod.vercel.app');
  });
});

test('the per-deployment hostname is used only when nothing stabler is set', () => {
  withEnv({ VERCEL_URL: 'deployment-hash-abc123.vercel.app' }, () => {
    assert.equal(baseUrl(), 'https://deployment-hash-abc123.vercel.app');
  });
});

test('falls back to the production domain when no env var is set', () => {
  withEnv({}, () => {
    assert.equal(baseUrl(), 'https://3amaktrades.com');
  });
});

// A trailing slash would produce '...com//api/calendar-oauth-callback', which is a
// different string from the registered URI and therefore a mismatch.
test('a trailing slash on PUBLIC_BASE_URL is stripped', () => {
  withEnv({ PUBLIC_BASE_URL: 'https://3amaktrades.com/' }, () => {
    assert.equal(baseUrl(), 'https://3amaktrades.com');
  });
  withEnv({ PUBLIC_BASE_URL: 'https://staging.3amaktrades.com/' }, () => {
    assert.equal(baseUrl(), 'https://staging.3amaktrades.com');
  });
});

// Both the OAuth helper and the email helper must resolve through this ONE
// function: a divergent copy breaks either OAuth or every emailed link, and
// whichever copy is fixed later, the other stays broken.
test('redirectUri() composes the shared base with the locked callback path', () => {
  withEnv({ PUBLIC_BASE_URL: 'https://3amaktrades.com' }, () => {
    assert.equal(gcal.redirectUri(), 'https://3amaktrades.com/api/calendar-oauth-callback');
    assert.equal(gcal.baseUrl(), baseUrl());
  });
  withEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'prod.vercel.app' }, () => {
    assert.equal(gcal.redirectUri(), 'https://prod.vercel.app/api/calendar-oauth-callback');
    assert.equal(gcal.baseUrl(), baseUrl());
  });
});

test('_google-calendar re-exports the shared baseUrl rather than keeping a local copy', () => {
  // Identity, not merely "they agree today": the same function object cannot drift.
  // (_email.js imports the same module but does not re-export it, so its use is
  // covered by the senders' own tests rather than an identity check here.)
  assert.equal(gcal.baseUrl, baseUrl);
});
