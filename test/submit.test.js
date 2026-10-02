const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
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

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// submit.js destructures postToSlack/postSystemAlert at require() time, so a
// monkey-patch of the _slack module object is only visible to it if the
// patch is installed BEFORE the handler is (re-)required -- same pattern as
// test/calendar-book.test.js's freshHandler(). Every test below therefore
// calls freshHandler() from INSIDE its withStubs callback, never before it.
const handlerPath = require.resolve('../api/submit');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_WEBHOOK_URL; // postToSlack safely no-ops with neither set
}

function fullBody(overrides = {}) {
  return {
    name: 'Alice', country: 'US', experience: 'beginner', budget: '1k-3k',
    budgetCode: '1k-3k', looking: 'community', goal: 'side-income',
    phone: '5550100100', email: 'alice@example.com', lang: 'en',
    ...overrides,
  };
}

// In-memory applicants list, read/written through store.readJson/writeJson --
// the same module boundary test/checkin-clients.test.js and
// test/applicants.test.js stub, so submit.js's real _applicants.js logic runs
// for real against it, round-tripping across the two submit() calls a
// "resubmission" test makes.
function statefulApplicantsStore(initial = []) {
  let data = { applicants: initial };
  return {
    readJson: async (path) => (path === store.APPLICANTS_BLOB ? { ok: true, data } : { ok: true, data: null }),
    writeJson: async (path, next) => {
      if (path === store.APPLICANTS_BLOB) data = next;
      return { ok: true };
    },
  };
}

test('honeypot: a filled website field drops silently with 200, no Slack post', async () => {
  envSetup();
  const postSpy = spyStub({ ts: null });
  await withStubs([{ obj: require('../api/_slack'), key: 'postToSlack', value: postSpy }], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: { ...fullBody(), website: 'spam' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(postSpy.calls.length, 0, 'a bot submission must never reach Slack');
  });
  delete require.cache[handlerPath];
});

test('a brand-new applicant posts "New Application" with no update tag', async () => {
  envSetup();
  const { readJson, writeJson } = statefulApplicantsStore();
  const postSpy = spyStub({ ts: 'ts-1' });
  await withStubs([
    { obj: store, key: 'readJson', value: readJson },
    { obj: store, key: 'writeJson', value: writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: postSpy },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: fullBody() }, res);
    assert.equal(res._status, 200);
    assert.equal(postSpy.calls.length, 1);
    const headerText = postSpy.calls[0][1].blocks[0].text.text;
    assert.doesNotMatch(headerText, /Updated/);
    assert.match(headerText, /New Application$/);
  });
  delete require.cache[handlerPath];
});

test('resubmitting with the SAME email updates the stored record and tags the Slack post', async () => {
  envSetup();
  const backing = statefulApplicantsStore();

  await withStubs([
    { obj: store, key: 'readJson', value: backing.readJson },
    { obj: store, key: 'writeJson', value: backing.writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: spyStub({ ts: null }) },
  ], async () => {
    const handler = freshHandler();
    await handler.submit({ method: 'POST', body: fullBody() }, makeRes());
  });
  delete require.cache[handlerPath];

  const postSpy = spyStub({ ts: null });
  await withStubs([
    { obj: store, key: 'readJson', value: backing.readJson },
    { obj: store, key: 'writeJson', value: backing.writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: postSpy },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: fullBody({ goal: 'full-time' }) }, res);
    assert.equal(res._status, 200);
    assert.equal(postSpy.calls.length, 1);
    const headerText = postSpy.calls[0][1].blocks[0].text.text;
    assert.match(headerText, /^🔁 Updated \(2x\)/);
    const bodyText = postSpy.calls[0][1].blocks[1].text.text;
    assert.match(bodyText, /full-time/, 'the resubmitted answers must win');
  });
  delete require.cache[handlerPath];
});

test('resubmitting with a DIFFERENT email but the SAME phone is still recognized as an update', async () => {
  envSetup();
  const backing = statefulApplicantsStore();

  await withStubs([
    { obj: store, key: 'readJson', value: backing.readJson },
    { obj: store, key: 'writeJson', value: backing.writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: spyStub({ ts: null }) },
  ], async () => {
    const handler = freshHandler();
    await handler.submit({ method: 'POST', body: fullBody() }, makeRes());
  });
  delete require.cache[handlerPath];

  const postSpy = spyStub({ ts: null });
  await withStubs([
    { obj: store, key: 'readJson', value: backing.readJson },
    { obj: store, key: 'writeJson', value: backing.writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: postSpy },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: fullBody({ email: 'alice.new@example.com' }) }, res);
    assert.equal(res._status, 200);
    const headerText = postSpy.calls[0][1].blocks[0].text.text;
    assert.match(headerText, /^🔁 Updated \(2x\)/, 'same phone, different email must still match as one applicant');
  });
  delete require.cache[handlerPath];
});

test('a genuinely unrelated second applicant is never tagged as an update', async () => {
  envSetup();
  const backing = statefulApplicantsStore();

  await withStubs([
    { obj: store, key: 'readJson', value: backing.readJson },
    { obj: store, key: 'writeJson', value: backing.writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: spyStub({ ts: null }) },
  ], async () => {
    const handler = freshHandler();
    await handler.submit({ method: 'POST', body: fullBody() }, makeRes());
  });
  delete require.cache[handlerPath];

  const postSpy = spyStub({ ts: null });
  await withStubs([
    { obj: store, key: 'readJson', value: backing.readJson },
    { obj: store, key: 'writeJson', value: backing.writeJson },
    { obj: require('../api/_slack'), key: 'postToSlack', value: postSpy },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: fullBody({ name: 'Bob', email: 'bob@example.com', phone: '5559998888' }) }, res);
    assert.equal(res._status, 200);
    const headerText = postSpy.calls[0][1].blocks[0].text.text;
    assert.doesNotMatch(headerText, /Updated/);
    assert.match(headerText, /New Application$/);
  });
  delete require.cache[handlerPath];
});

test('a PARTIAL (incomplete) submission never touches the applicants store', async () => {
  envSetup();
  const readSpy = spyStub({ ok: true, data: null });
  const writeSpy = spyStub({ ok: true });
  await withStubs([
    { obj: store, key: 'readJson', value: readSpy },
    { obj: store, key: 'writeJson', value: writeSpy },
    { obj: require('../api/_slack'), key: 'postToSlack', value: spyStub({ ts: null }) },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: { ...fullBody(), partial: true } }, res);
    assert.equal(res._status, 200);
    assert.equal(readSpy.calls.length, 0, 'a partial lead must not be matched against the applicants store');
    assert.equal(writeSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('the applicants store being unconfigured never blocks the Slack post (fail open)', async () => {
  envSetup();
  const postSpy = spyStub({ ts: null });
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED }) },
    { obj: require('../api/_slack'), key: 'postToSlack', value: postSpy },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: fullBody() }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(postSpy.calls.length, 1, 'the lead must still reach Slack even with no dedup store configured');
  });
  delete require.cache[handlerPath];
});

test('a real (non-config) applicants store failure still posts to Slack and alerts, never drops the lead', async () => {
  envSetup();
  const postSpy = spyStub({ ts: null });
  const alertSpy = spyStub(undefined);
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: false, reason: 'blob API down' }) },
    { obj: require('../api/_slack'), key: 'postToSlack', value: postSpy },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ], async () => {
    const handler = freshHandler();
    const res = makeRes();
    await handler.submit({ method: 'POST', body: fullBody() }, res);
    assert.equal(res._status, 200);
    assert.equal(postSpy.calls.length, 1, 'the lead must still reach Slack');
    assert.equal(alertSpy.calls.length, 1, 'a genuine read failure must be alerted, unlike the not-configured case');
  });
  delete require.cache[handlerPath];
});
