const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseEmail = require('../api/_email');
const ce = require('../api/_checkin-email');

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

// _checkin-email.js destructures `send` from _email at require-time, so the
// module must be re-required AFTER the stub is installed.
const cePath = require.resolve('../api/_checkin-email');
function freshCe() {
  delete require.cache[cePath];
  return require(cePath);
}

const START_MS = Date.UTC(2026, 10, 12, 15, 0, 0);

function booking(overrides = {}) {
  return {
    eventId: 'evt-checkin-1',
    name: 'Alice Client',
    email: 'alice@example.com',
    phone: '5550100100',
    startMs: START_MS,
    endMs: START_MS + 15 * 60000,
    visitorTimeZone: 'Europe/Istanbul',
    templateTimeZone: 'America/Toronto',
    manageToken: 'tok',
    meetLink: 'https://meet.example/checkin',
    lang: 'en',
    ...overrides,
  };
}

const SENDERS = [
  'sendCheckinConfirmation',
  'sendCheckinRescheduleNotice',
  'sendCheckinCancellationNotice',
  'sendCheckinReminder',
];

test('all four senders are exported', () => {
  for (const name of SENDERS) {
    assert.equal(typeof ce[name], 'function', `${name} must be exported`);
  }
});

test('each sender addresses the client email and passes a subject and html through send', async () => {
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      const r = await mod[name](booking());
      assert.equal(r.ok, true, `${name} should resolve ok`);
      assert.equal(sendSpy.calls.length, 1, `${name} should call send exactly once`);
      const arg = sendSpy.calls[0][0];
      assert.equal(arg.to, 'alice@example.com');
      assert.equal(typeof arg.subject, 'string');
      assert.ok(arg.subject.length > 0);
      assert.equal(typeof arg.html, 'string');
      assert.ok(arg.html.length > 0);
    });
    delete require.cache[cePath];
  }
});

test('every subject and body is marked [PLACEHOLDER], and the shell carries the footer', async () => {
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      const { subject, html } = sendSpy.calls[0][0];
      assert.match(subject, /\[PLACEHOLDER\]/, `${name} subject must be marked placeholder`);
      assert.match(html, /\[PLACEHOLDER\]/, `${name} body must be marked placeholder`);
      assert.match(html, /PLACEHOLDER EMAIL — final copy pending\./,
        `${name} must use the shared placeholder shell`);
    });
    delete require.cache[cePath];
  }
});

// The convention markers are what stop this copy being mistaken for finished
// text in a later pass, so they are asserted against the file itself.
test('the source file carries the PLACEHOLDER banner and a per-sender marker comment', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_checkin-email.js'), 'utf8');
  assert.match(src, /ALL COPY IN THIS FILE IS PLACEHOLDER/);
  const markers = src.match(/PLACEHOLDER COPY — collaborative design pass pending/g) || [];
  assert.ok(markers.length >= 8,
    `expected a marker above every subject and body (>=8), found ${markers.length}`);
});

test('the booking time is rendered in the CLIENT timezone, the one load-bearing value', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinConfirmation(booking());
    const { html } = sendSpy.calls[0][0];
    const expected = baseEmail.formatWhen(START_MS, 'Europe/Istanbul', 'en');
    assert.ok(expected.length > 0, 'formatWhen must produce something to look for');
    assert.ok(html.includes(expected),
      `expected the Istanbul rendering "${expected}" in the body`);
    assert.match(html, /Europe\/Istanbul/);
  });
  delete require.cache[cePath];
});

test('the Meet link is linked when present and omitted entirely when absent', async () => {
  for (const name of ['sendCheckinConfirmation', 'sendCheckinRescheduleNotice', 'sendCheckinReminder']) {
    const withLink = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: withLink }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      assert.match(withLink.calls[0][0].html, /href="https:\/\/meet\.example\/checkin"/,
        `${name} should link the Meet URL`);
    });
    delete require.cache[cePath];

    const withoutLink = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: withoutLink }], async () => {
      const mod = freshCe();
      await mod[name](booking({ meetLink: '' }));
      assert.equal(/Join link/.test(withoutLink.calls[0][0].html), false,
        `${name} must omit the join line when there is no link`);
    });
    delete require.cache[cePath];
  }
});

// safeUrl exists precisely so escaping alone cannot let a javascript: URL into
// an href rendered inside a mail client.
test('a javascript: Meet link is refused rather than escaped into an href', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinConfirmation(booking({ meetLink: 'javascript:alert(1)' }));
    const { html } = sendSpy.calls[0][0];
    assert.equal(/javascript:/i.test(html), false);
    assert.equal(/Join link/.test(html), false);
  });
  delete require.cache[cePath];
});

test('a name containing HTML is escaped', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinConfirmation(booking({ name: '<script>alert(1)</script>' }));
    const { html } = sendSpy.calls[0][0];
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;script&gt;/);
  });
  delete require.cache[cePath];
});

test('a send failure is returned, never thrown', async () => {
  for (const name of SENDERS) {
    await withStubs([
      { obj: baseEmail, key: 'send', value: async () => ({ ok: false, reason: 'resend 422' }) },
    ], async () => {
      const mod = freshCe();
      const r = await mod[name](booking());
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'resend 422');
    });
    delete require.cache[cePath];
  }
});

// The formatter must never be able to cost a booking that is already on the
// calendar, so a non-finite instant and a nonsense zone both have to survive.
test('a non-finite startMs and an invalid timezone still produce a sent email', async () => {
  for (const b of [booking({ startMs: NaN }), booking({ visitorTimeZone: 'Not/AZone' })]) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      const r = await mod.sendCheckinConfirmation(b);
      assert.equal(r.ok, true);
      assert.equal(sendSpy.calls.length, 1);
    });
    delete require.cache[cePath];
  }
});

test('the four subjects are distinct, so an inbox thread is not ambiguous', async () => {
  const subjects = [];
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      subjects.push(sendSpy.calls[0][0].subject);
    });
    delete require.cache[cePath];
  }
  assert.equal(new Set(subjects).size, 4, `subjects must differ: ${JSON.stringify(subjects)}`);
});

// A check-in email landing in a client's inbox must be unmistakable from an
// applicant one. Asserting the subjects NAME the audience is the check that
// survives a later copy pass, whereas comparing against _email.js's literal
// strings would not (its `send` is a module-local call, so stubbing the export
// does not intercept it anyway).
test('every check-in subject names it as a check-in', async () => {
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      assert.match(sendSpy.calls[0][0].subject, /check-?in/i,
        `${name} subject must name it as a check-in`);
    });
    delete require.cache[cePath];
  }
});
