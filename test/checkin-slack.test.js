const { test } = require('node:test');
const assert = require('node:assert/strict');
const slack = require('../api/_slack');
const cs = require('../api/_checkin-slack');

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

// _checkin-slack.js reaches _slack through the namespace (slack.postToSlack),
// so stubbing those exports takes effect without any require-cache work. It
// DOES destructure formatWhen, though, so the fresh-require dance is kept: it
// makes the suite correct whichever of the two a future edit changes.
const csPath = require.resolve('../api/_checkin-slack');
function freshCs() {
  delete require.cache[csPath];
  return require(csPath);
}

const START_MS = Date.UTC(2026, 10, 12, 15, 0, 0); // 2026-11-12 15:00Z

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

function textOf(message) {
  return (message.blocks || [])
    .map(b => (b.text && b.text.text) || (b.elements || []).map(e => e.text).join(' ') || '')
    .join('\n');
}

test('postCheckinBookingCreated posts to CHANNEL_CHECKIN_BOOKED and returns its ts', async () => {
  const postSpy = spyStub({ ts: 'ts-created' });
  await withStubs([{ obj: slack, key: 'postToSlack', value: postSpy }], async () => {
    const mod = freshCs();
    const r = await mod.postCheckinBookingCreated(booking());
    assert.deepEqual(r, { ts: 'ts-created' });
    assert.equal(postSpy.calls.length, 1);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_CHECKIN_BOOKED);
    assert.notEqual(postSpy.calls[0][0], slack.CHANNEL_NEW_CALLS_BOOKED,
      'a check-in must never land in the applicant booking channel');
  });
  delete require.cache[csPath];
});

test('the created message carries the name, email, phone, both zones and the Meet link', async () => {
  const postSpy = spyStub({ ts: 'ts-created' });
  await withStubs([{ obj: slack, key: 'postToSlack', value: postSpy }], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingCreated(booking());
    const text = textOf(postSpy.calls[0][1]);
    assert.match(text, /Alice Client/);
    assert.match(text, /alice@example\.com/);
    assert.match(text, /5550100100/);
    assert.match(text, /America\/Toronto/, "Omar's own zone must appear -- it is the one he acts on");
    assert.match(text, /Europe\/Istanbul/);
    assert.match(text, /https:\/\/meet\.example\/checkin/);
    // Named as a check-in, so #8 is never mistaken for #4 at a glance.
    assert.match(text, /check-?in/i);
  });
  delete require.cache[csPath];
});

test('a booking with no phone and no Meet link still posts cleanly', async () => {
  const postSpy = spyStub({ ts: null });
  await withStubs([{ obj: slack, key: 'postToSlack', value: postSpy }], async () => {
    const mod = freshCs();
    const r = await mod.postCheckinBookingCreated(booking({ phone: '', meetLink: '' }));
    assert.deepEqual(r, { ts: null });
    const text = textOf(postSpy.calls[0][1]);
    assert.match(text, /—/, 'an absent phone renders as an em dash, not "undefined"');
    assert.equal(/undefined/.test(text), false);
    assert.equal(/\*Meet:\*/.test(text), false, 'no Meet line when there is no link');
  });
  delete require.cache[csPath];
});

test("postCheckinBookingChanged('rescheduled') posts to CHANNEL_CHECKIN_RESCHEDULED", async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: async () => null },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'rescheduled', null);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_CHECKIN_RESCHEDULED);
    assert.match(textOf(postSpy.calls[0][1]), /rescheduled/i);
  });
  delete require.cache[csPath];
});

test("postCheckinBookingChanged('cancelled') posts to CHANNEL_CHECKIN_CANCELLED", async () => {
  const postSpy = spyStub({ ts: 'ts-cancel' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: async () => null },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'cancelled', null);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_CHECKIN_CANCELLED);
    assert.match(textOf(postSpy.calls[0][1]), /cancelled/i);
  });
  delete require.cache[csPath];
});

// Slack cannot thread across channels, so the link back to #8 is a permalink.
test('an originalTs is resolved to a permalink against CHANNEL_CHECKIN_BOOKED and linked', async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  const permaSpy = spyStub('https://slack.example/archives/C1/p123');
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: permaSpy },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'rescheduled', 'ts-original');
    assert.equal(permaSpy.calls.length, 1);
    assert.equal(permaSpy.calls[0][0], slack.CHANNEL_CHECKIN_BOOKED,
      'the original check-in message lives in #8, not #4');
    assert.equal(permaSpy.calls[0][1], 'ts-original');
    assert.match(textOf(postSpy.calls[0][1]), /https:\/\/slack\.example\/archives\/C1\/p123/);
  });
  delete require.cache[csPath];
});

test('no originalTs means getPermalink is never called and no link line appears', async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  const permaSpy = spyStub('https://should-not-be-used.example');
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: permaSpy },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'cancelled', null);
    assert.equal(permaSpy.calls.length, 0);
    assert.equal(/should-not-be-used/.test(textOf(postSpy.calls[0][1])), false);
  });
  delete require.cache[csPath];
});

test('a permalink lookup that returns null still posts the message', async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: async () => null },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'rescheduled', 'ts-original');
    assert.equal(postSpy.calls.length, 1, 'a missing permalink must not cost the notification');
  });
  delete require.cache[csPath];
});
