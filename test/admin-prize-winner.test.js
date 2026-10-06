const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');
const prizeEmail = require('../api/_prize-email');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

function envSetup() {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_PASSCODE = 'test-passcode';
}

function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }
function authedReq(method, body) {
  return { method, headers: { cookie: cookieValueOf(auth.issueSessionCookie()) }, body, query: {} };
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// api/admin/checkin.js destructures `sendPrizeWinnerNotice` from _prize-email
// at require-time (same reason api/_checkin-email.js's tests re-require after
// stubbing `send` from _email.js), so the module must be re-required AFTER
// the stub is installed, not just monkey-patched on the already-cached export.
const handlerPath = require.resolve('../api/admin/checkin.js');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath).prizeWinner;
}

async function withStubbedSend(result, fn) {
  const orig = prizeEmail.sendPrizeWinnerNotice;
  prizeEmail.sendPrizeWinnerNotice = result instanceof Function ? result : spyStub(result);
  try {
    return await fn(prizeEmail.sendPrizeWinnerNotice);
  } finally {
    prizeEmail.sendPrizeWinnerNotice = orig;
    delete require.cache[handlerPath];
  }
}

test('exported from api/admin/checkin.js as prizeWinner', () => {
  assert.equal(typeof require('../api/admin/checkin.js').prizeWinner, 'function');
});

test('rejects without a valid admin session', async () => {
  envSetup();
  const handler = freshHandler();
  const res = makeRes();
  await handler({ method: 'POST', headers: {}, body: {}, query: {} }, res);
  assert.equal(res._status, 401);
});

test('rejects any method other than POST', async () => {
  envSetup();
  const handler = freshHandler();
  const res = makeRes();
  await handler(authedReq('GET'), res);
  assert.equal(res._status, 405);
});

test('400s when email or code is missing', async () => {
  envSetup();
  const handler = freshHandler();

  const res1 = makeRes();
  await handler(authedReq('POST', { code: 'ABC123' }), res1);
  assert.equal(res1._status, 400);
  assert.match(res1._json.errors[0], /email/i);

  const res2 = makeRes();
  await handler(authedReq('POST', { email: 'winner@example.com' }), res2);
  assert.equal(res2._status, 400);
  assert.match(res2._json.errors[0], /code/i);
});

test('400s on a malformed email (no @)', async () => {
  envSetup();
  const handler = freshHandler();
  const res = makeRes();
  await handler(authedReq('POST', { email: 'not-an-email', code: 'ABC123' }), res);
  assert.equal(res._status, 400);
});

test('on success, calls sendPrizeWinnerNotice with the trimmed fields and returns 200', async () => {
  envSetup();
  await withStubbedSend({ ok: true }, async (spy) => {
    const handler = freshHandler();
    const res = makeRes();
    await handler(authedReq('POST', {
      email: '  winner@example.com  ', code: ' ABC123 ', name: 'Alex', prize: '10K Pro',
    }), res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0][0], {
      email: 'winner@example.com', code: 'ABC123', name: 'Alex', prize: '10K Pro',
    });
  });
});

test('a send failure is surfaced as 502 with the reason, never thrown', async () => {
  envSetup();
  await withStubbedSend({ ok: false, reason: 'resend 422' }, async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler(authedReq('POST', { email: 'winner@example.com', code: 'ABC123' }), res);
    assert.equal(res._status, 502);
    assert.deepEqual(res._json.errors, ['resend 422']);
  });
});

test('name and prize are optional on the request', async () => {
  envSetup();
  await withStubbedSend({ ok: true }, async (spy) => {
    const handler = freshHandler();
    const res = makeRes();
    await handler(authedReq('POST', { email: 'winner@example.com', code: 'ABC123' }), res);
    assert.equal(res._status, 200);
    assert.equal(spy.calls[0][0].name, undefined);
    assert.equal(spy.calls[0][0].prize, undefined);
  });
});
