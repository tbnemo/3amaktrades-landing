const { test } = require('node:test');
const assert = require('node:assert/strict');
const email = require('../api/_email');
const { safeUrl } = require('../api/_html');

// formatWhen must never throw: it runs while building the html string, before
// send() is even invoked, so a throw here would reject a sender's whole
// promise instead of the sender resolving to {ok:false, reason}.
test('formatWhen returns a string and does not throw for non-finite or missing startMs', () => {
  const nonFinite = [NaN, Infinity, -Infinity, undefined, null];
  for (const startMs of nonFinite) {
    assert.doesNotThrow(() => {
      const result = email.formatWhen(startMs, 'America/Toronto', 'en');
      assert.equal(typeof result, 'string');
    }, `formatWhen threw for startMs=${String(startMs)}`);
  }
});

// Guards against the guard collapsing to "always return ''" -- a valid
// instant must still render, and different timezones must produce different
// wall-clock renderings of the same instant.
test('formatWhen still renders a valid instant, and differs across timezones', () => {
  const startMs = Date.parse('2026-06-15T14:00:00Z');
  const toronto = email.formatWhen(startMs, 'America/Toronto', 'en');
  const istanbul = email.formatWhen(startMs, 'Europe/Istanbul', 'en');
  assert.notEqual(toronto, '');
  assert.notEqual(istanbul, '');
  assert.notEqual(toronto, istanbul);
});

// The contract test that matters most: a non-finite startMs must not turn a
// sender's promise into a rejection. RESEND_API_KEY is unset locally, so each
// sender resolves {ok:false, reason:'RESEND_API_KEY not set'} regardless --
// the point being tested is resolve, not reject.
test('all four senders resolve (never reject) when startMs is NaN', async () => {
  delete process.env.RESEND_API_KEY;
  const b = {
    eventId: 'evt-1',
    name: 'Test Visitor',
    email: 'visitor@example.com',
    phone: '555-0100',
    startMs: NaN,
    endMs: NaN,
    visitorTimeZone: 'America/Toronto',
    templateTimeZone: 'Asia/Riyadh',
    manageToken: 'tok',
    meetLink: 'https://meet.google.com/abc-defg-hij',
    lang: 'en',
  };

  const senders = [
    email.sendBookingConfirmation,
    email.sendRescheduleNotice,
    email.sendCancellationNotice,
    email.sendReminder,
  ];

  for (const sendFn of senders) {
    const result = await sendFn(b);
    assert.equal(typeof result, 'object');
    assert.equal(result.ok, false);
  }
});

test('safeUrl accepts http(s) and rejects everything else', () => {
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  assert.equal(safeUrl('https://example.com'), 'https://example.com');

  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('JavaScript:alert(1)'), '');
  assert.equal(safeUrl(' javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeUrl('vbscript:msgbox(1)'), '');
  assert.equal(safeUrl(''), '');
  assert.equal(safeUrl(null), '');
  assert.equal(safeUrl(undefined), '');
});
