const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const handler = require('../api/calendar-availability');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

// Every blob read comes back "not written yet" (ok:true, data:null), which is
// how loadTemplate() falls back to the normalized DEFAULT_TEMPLATE.
function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  store.__setClientForTests(emptyBlobClient());
}

// gcal.freeBusy is monkey-patched directly (rather than stubbing its fetch
// layer) because the endpoint only cares about freeBusy's {ok, busy, reason}
// contract, not how it gets there. Every test that patches it MUST restore
// the original afterward or later tests silently inherit the stub.
function withFreeBusy(stub, fn) {
  const orig = gcal.freeBusy;
  gcal.freeBusy = stub;
  return Promise.resolve(fn()).finally(() => { gcal.freeBusy = orig; });
}

test('happy path: days=3 returns 3 date keys of parseable ISO slots plus template fields', async () => {
  envSetup();
  await withFreeBusy(async () => ({ ok: true, busy: [] }), async () => {
    const req = { method: 'GET', query: { date: '2026-09-28', days: '3' } };
    const res = makeRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(typeof res._json.timezone, 'string');
    assert.equal(typeof res._json.slotMinutes, 'number');

    const keys = Object.keys(res._json.days);
    assert.equal(keys.length, 3, `expected 3 date keys, got ${keys.length}: ${keys}`);
    for (const k of keys) {
      const slots = res._json.days[k];
      assert.ok(Array.isArray(slots), `days[${k}] must be an array`);
      for (const s of slots) {
        assert.ok(Number.isFinite(Date.parse(s.start)), `start "${s.start}" must be parseable ISO`);
        assert.ok(Number.isFinite(Date.parse(s.end)), `end "${s.end}" must be parseable ISO`);
      }
    }
  });
});

// THE most important test in this file. It proves the endpoint's busy interval
// actually blocks a slot using NUMERIC epoch ms end to end -- not just that
// computeSlotsForRange works in isolation, but that this handler feeds it
// numbers. If someone later "cleans up" freeBusy's pass-through by converting
// busy.start/busy.end to ISO strings before handing them to computeSlotsForRange,
// every overlap comparison in _availability.js becomes a NaN comparison (NaN <
// anything is always false), which means overlapsBusy() never matches and every
// slot silently reads as free -- i.e. the endpoint would offer times that are
// already booked. Do not "simplify" this test by skipping the second call.
test('a busy interval reported in numeric epoch ms removes exactly that slot', async () => {
  envSetup();

  // Pass 1: no busy intervals at all -- capture the very first open slot.
  let firstSlot;
  await withFreeBusy(async () => ({ ok: true, busy: [] }), async () => {
    const req = { method: 'GET', query: { date: '2026-09-28' } };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    const slots = res._json.days['2026-09-28'];
    assert.ok(slots.length > 0, 'need at least one open slot for this test to mean anything');
    firstSlot = slots[0];
  });

  // Pass 2: report that exact interval as busy, using NUMERIC epoch ms (as
  // the real _google-calendar.js freeBusy() does) -- not ISO strings.
  const busyStart = Date.parse(firstSlot.start);
  const busyEnd = Date.parse(firstSlot.end);
  assert.ok(Number.isFinite(busyStart) && Number.isFinite(busyEnd));

  await withFreeBusy(
    async () => ({ ok: true, busy: [{ start: busyStart, end: busyEnd }] }),
    async () => {
      const req = { method: 'GET', query: { date: '2026-09-28' } };
      const res = makeRes();
      await handler(req, res);
      assert.equal(res._status, 200);
      const slots = res._json.days['2026-09-28'];
      const stillThere = slots.some(s => s.start === firstSlot.start && s.end === firstSlot.end);
      assert.equal(stillThere, false,
        'the slot matching the reported busy interval must be removed');
    },
  );
});

test('Cache-Control: no-store is set on success and on error responses', async () => {
  envSetup();

  await withFreeBusy(async () => ({ ok: true, busy: [] }), async () => {
    const req = { method: 'GET', query: { date: '2026-09-28' } };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.equal(res._headers['Cache-Control'], 'no-store');
  });

  // BAD_DATE error response.
  const badRes = makeRes();
  await handler({ method: 'GET', query: { date: 'garbage' } }, badRes);
  assert.equal(badRes._status, 400);
  assert.equal(badRes._headers['Cache-Control'], 'no-store');

  // CALENDAR_NOT_CONNECTED error response.
  await withFreeBusy(async () => ({ ok: false, reason: gcal.NOT_CONNECTED }), async () => {
    const req = { method: 'GET', query: { date: '2026-09-28' } };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 503);
    assert.equal(res._headers['Cache-Control'], 'no-store');
  });
});

test('BAD_DATE (400) rejects malformed and impossible calendar dates', async () => {
  envSetup();
  for (const bad of ['garbage', '2026-02-31', '2026-13-01']) {
    const res = makeRes();
    await handler({ method: 'GET', query: { date: bad } }, res);
    assert.equal(res._status, 400, `date "${bad}" should be 400`);
    assert.equal(res._json.error, 'BAD_DATE', `date "${bad}" should report BAD_DATE`);
  }
});

test('BLOB_NOT_CONFIGURED (503) when the blob store has no credentials', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  store.__setClientForTests(emptyBlobClient());

  const res = makeRes();
  await handler({ method: 'GET', query: { date: '2026-09-28' } }, res);
  assert.equal(res._status, 503);
  assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');

  process.env.BLOB_READ_WRITE_TOKEN = 'test-token'; // restore for later tests
});

test('CALENDAR_NOT_CONNECTED (503) when freeBusy reports the calendar is not connected', async () => {
  envSetup();
  await withFreeBusy(async () => ({ ok: false, reason: gcal.NOT_CONNECTED }), async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: { date: '2026-09-28' } }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
});

test('UPSTREAM (502) when freeBusy fails for any other reason', async () => {
  envSetup();
  await withFreeBusy(async () => ({ ok: false, reason: 'some google 500 error' }), async () => {
    const res = makeRes();
    await handler({ method: 'GET', query: { date: '2026-09-28' } }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
});

test('days is clamped into [1, 31] for out-of-range and non-numeric input', async () => {
  envSetup();
  await withFreeBusy(async () => ({ ok: true, busy: [] }), async () => {
    const cases = [
      ['99', 31], ['0', 1], ['-5', 1], ['abc', 1], [undefined, 1],
    ];
    for (const [daysParam, expectedKeys] of cases) {
      const query = { date: '2026-09-28' };
      if (daysParam !== undefined) query.days = daysParam;
      const res = makeRes();
      await handler({ method: 'GET', query }, res);
      assert.equal(res._status, 200, `days=${daysParam} should still succeed`);
      const keyCount = Object.keys(res._json.days).length;
      assert.equal(keyCount, expectedKeys,
        `days=${daysParam} should clamp to ${expectedKeys} keys, got ${keyCount}`);
    }
  });
});

test('non-GET requests return 405', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'POST', query: {} }, res);
  assert.equal(res._status, 405);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});
