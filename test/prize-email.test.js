const { test } = require('node:test');
const assert = require('node:assert/strict');
const baseEmail = require('../api/_email');
const { DEFAULT_PRIZE } = require('../api/_prize-email');

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// _prize-email.js destructures `send` from _email at require-time (same
// reason _checkin-email.js's own tests re-require after stubbing), so the
// module must be re-required AFTER the stub is installed.
const prizeEmailPath = require.resolve('../api/_prize-email');
function freshPrizeEmail() {
  delete require.cache[prizeEmailPath];
  return require(prizeEmailPath);
}

async function withStubbedSend(result, fn) {
  const orig = baseEmail.send;
  const spy = spyStub(result);
  baseEmail.send = spy;
  try {
    const { sendPrizeWinnerNotice } = freshPrizeEmail();
    return await fn(sendPrizeWinnerNotice, spy);
  } finally {
    baseEmail.send = orig;
    delete require.cache[prizeEmailPath];
  }
}

test('sends to the given email with a non-empty subject and html, using the shared shell', async () => {
  await withStubbedSend({ ok: true }, async (sendPrizeWinnerNotice, spy) => {
    const r = await sendPrizeWinnerNotice({ email: 'winner@example.com', name: 'Alex', code: 'ABC123' });
    assert.equal(r.ok, true);
    assert.equal(spy.calls.length, 1);
    const { to, subject, html } = spy.calls[0][0];
    assert.equal(to, 'winner@example.com');
    assert.ok(subject.length > 0);
    assert.match(html, /3AMAK TRADES/);
    assert.match(html, /wa\.me\/14382259193/);
  });
});

test('the code and a custom prize label both appear in the body', async () => {
  await withStubbedSend({ ok: true }, async (sendPrizeWinnerNotice, spy) => {
    await sendPrizeWinnerNotice({ email: 'winner@example.com', name: 'Alex', code: 'ABC123', prize: '10K Pro' });
    const { html } = spy.calls[0][0];
    assert.match(html, /ABC123/);
    assert.match(html, /10K Pro/);
  });
});

test('missing name falls back to "there", missing prize falls back to the default account', async () => {
  await withStubbedSend({ ok: true }, async (sendPrizeWinnerNotice, spy) => {
    await sendPrizeWinnerNotice({ email: 'winner@example.com', code: 'ABC123' });
    const { html } = spy.calls[0][0];
    assert.match(html, /Hi there,/);
    assert.match(html, new RegExp(DEFAULT_PRIZE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('a name or code containing HTML is escaped, not injected', async () => {
  await withStubbedSend({ ok: true }, async (sendPrizeWinnerNotice, spy) => {
    await sendPrizeWinnerNotice({
      email: 'winner@example.com', name: '<script>alert(1)</script>', code: '<b>x</b>',
    });
    const { html } = spy.calls[0][0];
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('<b>x</b>'), false);
    assert.match(html, /&lt;script&gt;/);
  });
});

test('a send failure is returned, never thrown', async () => {
  await withStubbedSend({ ok: false, reason: 'resend 422' }, async (sendPrizeWinnerNotice) => {
    const r = await sendPrizeWinnerNotice({ email: 'winner@example.com', code: 'ABC123' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'resend 422');
  });
});
