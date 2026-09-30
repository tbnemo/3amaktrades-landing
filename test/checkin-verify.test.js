const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const cc = require('../api/_checkin-clients');
const ct = require('../api/_checkin-token');
const rl = require('../api/_checkin-verify-rate-limit');
const handler = require('../api/calendar-checkin').verify;

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

// Starts empty, but (unlike a true no-op) persists what is `put` so that
// the rate-limit scenarios below -- which depend on state surviving across
// several handler() calls within one test -- actually exercise anything.
// Same Map-keyed-by-pathname shape as checkin-verify-rate-limit.test.js's
// own fakeBlobClient().
function emptyBlobClient() {
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

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
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

const ROSTER = [
  { name: 'Alice Client', email: 'alice@example.com', phone: '+1 (555) 010-0100' },
  { name: 'Bob Client', email: 'bob@example.com', phone: '' },
];

function withRoster(clients, fn) {
  return withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients, usedDefault: false }) },
  ], fn);
}

test('a listed email verifies: 200 {ok:true, name, verifyToken} and the token verifies for that email', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.name, 'Alice Client');
    assert.equal(typeof res._json.verifyToken, 'string');
    assert.ok(res._json.verifyToken.length > 0);
    assert.equal(ct.verifyVerifyToken('alice@example.com', res._json.verifyToken), true);
  });
});

test('a listed email verifies regardless of case and surrounding whitespace', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: '  ALICE@Example.COM  ' } }, res);
    assert.equal(res._json.ok, true);
    assert.equal(ct.verifyVerifyToken('alice@example.com', res._json.verifyToken), true);
  });
});

// The whole reason phone is a second channel: the token must still be scoped to
// the record's EMAIL, because email is the only way the confirmation reaches them.
test('a listed phone verifies, and the token is scoped to the record EMAIL not the phone', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { phone: '15550100100' } }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.name, 'Alice Client');
    assert.equal(ct.verifyVerifyToken('alice@example.com', res._json.verifyToken), true,
      'the token must be signed for the matched record email, not the submitted phone');
  });
});

test('a phone typed with formatting still verifies (digits-only comparison)', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (const phone of ['+1 (555) 010-0100', '1-555-010-0100', '1.555.010.0100']) {
      const res = makeRes();
      await handler({ method: 'POST', body: { phone } }, res);
      assert.equal(res._json.ok, true, `${phone} should verify`);
    }
  });
});

test('the response NEVER carries the matched email', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { phone: '15550100100' } }, res);
    assert.deepEqual(Object.keys(res._json).sort(), ['name', 'ok', 'verifyToken'],
      'only ok, name and verifyToken may be returned');
    assert.equal(JSON.stringify(res._json).includes('alice@example.com'), false,
      'the client email must not travel to the browser');
  });
});

test('an unlisted email returns 200 {ok:false} with NOTHING else', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'stranger@example.com' } }, res);

    // 200, not 401/403: the status line must not be an oracle either.
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: false },
      'a non-match must leak no reason, no name, and no token');
  });
});

test('an unlisted phone returns the SAME 200 {ok:false} as an unlisted email', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const byEmail = makeRes();
    await handler({ method: 'POST', body: { email: 'stranger@example.com' } }, byEmail);
    const byPhone = makeRes();
    await handler({ method: 'POST', body: { phone: '5559999999' } }, byPhone);

    assert.equal(byEmail._status, byPhone._status);
    assert.deepEqual(byEmail._json, byPhone._json,
      'the two failure modes must be indistinguishable');
  });
});

test('a blank phone does not match a client stored with no phone', async () => {
  envSetup();
  // BOB has phone ''. Submitting an empty phone must not hand back his record.
  await withRoster(ROSTER, async () => {
    for (const phone of ['', '   ', '---']) {
      const res = makeRes();
      await handler({ method: 'POST', body: { phone } }, res);
      assert.equal(res._status, 400, `${JSON.stringify(phone)} carries no identifier at all`);
    }
  });
});

test('an empty roster verifies nobody', async () => {
  envSetup();
  await withRoster([], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: false });
  });
});

test('a body with neither email nor phone -> 400 BAD_REQUEST', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (const body of [{}, { email: '', phone: '' }, { email: '  ' }, null, undefined]) {
      const res = makeRes();
      await handler({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `${JSON.stringify(body)} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
});

test('BLOB_NOT_CONFIGURED -> 503, and no token is minted', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
    assert.equal(res._json.verifyToken, undefined);
  });
});

test('any other read failure -> 502, and no token is minted', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: 'blob get 500', clients: [] }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.ok, false);
    assert.equal(res._json.verifyToken, undefined);
  });
});

test('every response carries Cache-Control: no-store', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._headers['Cache-Control'], 'no-store');
  });
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await handler({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});

test('a verified client whose name is blank still verifies, with an empty name', async () => {
  envSetup();
  await withRoster([{ name: '', email: 'nameless@example.com', phone: '' }], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'nameless@example.com' } }, res);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.name, '');
    assert.equal(ct.verifyVerifyToken('nameless@example.com', res._json.verifyToken), true);
  });
});

// --- Package lifecycle gating --------------------------------------------

test('a PAUSED client is rejected with 403 ACCESS_INACTIVE even with a correct email/phone match', async () => {
  envSetup();
  const paused = [{ name: 'Alice Client', email: 'alice@example.com', phone: '15550100100', pausedAt: Date.now(), expiresAt: Date.now() + 1e9 }];
  await withRoster(paused, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.ok, false);
    assert.equal(res._json.error, 'ACCESS_INACTIVE');
    assert.equal(res._json.verifyToken, undefined, 'no token is minted for an inactive client');
  });
});

test('an EXPIRED client is rejected with the same 403 ACCESS_INACTIVE', async () => {
  envSetup();
  const expired = [{ name: 'Alice Client', email: 'alice@example.com', phone: '', pausedAt: null, expiresAt: Date.now() - 1000 }];
  await withRoster(expired, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'ACCESS_INACTIVE');
  });
});

test('an ACTIVE client (expiresAt in the future) still succeeds exactly as before', async () => {
  envSetup();
  const active = [{ name: 'Alice Client', email: 'alice@example.com', phone: '', pausedAt: null, expiresAt: Date.now() + 1e9 }];
  await withRoster(active, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
  });
});

test('a legacy client with no expiresAt at all still succeeds exactly as before', async () => {
  envSetup();
  const legacy = [{ name: 'Alice Client', email: 'alice@example.com', phone: '' }];
  await withRoster(legacy, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
  });
});

// --- Rate limiting -----------------------------------------------------

test('after 5 failed guesses at the SAME identifier, the 6th returns 429 RATE_LIMITED', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      await handler({ method: 'POST', body: { email: 'guessed-wrong@example.com' } }, res);
      assert.equal(res._status, 200, `attempt ${i + 1} should still be a normal 200 {ok:false}`);
    }
    const sixth = makeRes();
    await handler({ method: 'POST', body: { email: 'guessed-wrong@example.com' } }, sixth);
    assert.equal(sixth._status, 429);
    assert.equal(sixth._json.error, 'RATE_LIMITED');
    assert.ok(sixth._json.retryAfterSec > 0);
  });
});

test('a lockout on one identifier does not block a different visitor verifying correctly', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (let i = 0; i < 5; i++) {
      await handler({ method: 'POST', body: { email: 'attacker-target@example.com' } }, makeRes());
    }
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true, 'a different identifier must be unaffected by someone else\'s lockout');
  });
});

test('a SUCCESSFUL verification clears that identifier\'s failure history', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    // Three wrong guesses, then the correct one -- a real client fat-fingering
    // their own email a few times before getting it right.
    for (let i = 0; i < 3; i++) {
      await handler({ method: 'POST', body: { email: 'alice@exampl.com' } }, makeRes());
    }
    const good = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, good);
    assert.equal(good._json.ok, true);

    // Confirm the clear was scoped to 'alice@example.com', not 'alice@exampl.com'
    // (the wrong one from above): two more wrong guesses at the typo'd address
    // must not yet trip the limiter, since clear() never touched its count.
    for (let i = 0; i < 2; i++) {
      const res = makeRes();
      await handler({ method: 'POST', body: { email: 'alice@exampl.com' } }, res);
      assert.equal(res._status, 200, 'still under the limit for the typo\'d address');
    }
  });
});

test('the rate limiter is keyed on the SUBMITTED identifier, so email and phone guesses for the same person are tracked separately', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (let i = 0; i < 5; i++) {
      await handler({ method: 'POST', body: { email: 'wrong-email-guess@example.com' } }, makeRes());
    }
    // A DIFFERENT wrong phone guess is a different identifier and must not be
    // pre-locked by the email guesses above.
    const res = makeRes();
    await handler({ method: 'POST', body: { phone: '5550001111' } }, res);
    assert.equal(res._status, 200, 'a different submitted identifier is a separate rate-limit bucket');
  });
});

test('an unreadable rate-limit store fails the request CLOSED with 502, before the roster is even checked', async () => {
  envSetup();
  await withStubs([
    { obj: rl, key: 'check', value: async () => ({ allowed: false, unavailable: true, reason: 'blob get 500' }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.ok, false);
  });
});
