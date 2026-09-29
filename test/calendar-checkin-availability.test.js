const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const loadMod = require('../api/_load-checkin-template');
const handler = require('../api/calendar-checkin-availability');

function makeRes() {
  return {
    _status: null, _json: null, _headers: {}, _ended: false,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { this._ended = true; return this; },
  };
}

function emptyBlobClient() {
  return { get: async () => null, put: async () => ({}) };
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

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// A weekday at least 60 days out, so the default template's 24h minimum notice
// can never suppress the whole day, and far from any DST boundary.
function futureWeekdayYmd() {
  const base = new Date(Date.now() + 60 * 86400000);
  let y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  while (true) {
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) break; // Mon-Fri
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return { y, mo, d };
}

function dateParam() {
  const { y, mo, d } = futureWeekdayYmd();
  return tz.formatYmd(y, mo, d);
}

// A check-in template distinct from the applicant default in every field that
// matters, so a handler wired to the WRONG loader fails this suite loudly.
const CHECKIN_TEMPLATE = {
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '10:00' },
    tue: { enabled: true, start: '09:00', end: '10:00' },
    wed: { enabled: true, start: '09:00', end: '10:00' },
    thu: { enabled: true, start: '09:00', end: '10:00' },
    fri: { enabled: true, start: '09:00', end: '10:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 15,
  bufferMinutes: 0,
  minNoticeHours: 24,
};

function withCheckinTemplate(fn) {
  return withStubs([
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
  ], fn);
}

// calendar-checkin-availability.js destructures loadCheckinTemplate at
// require-time, so the module must be re-required AFTER the stub is installed
// for the stub to take effect -- the same dance test/admin-availability.test.js
// performs for admin/availability.js.
const handlerPath = require.resolve('../api/calendar-checkin-availability');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

test('happy path: 200 with the CHECK-IN template timezone, slotMinutes and day keys', async () => {
  envSetup();
  const date = dateParam();
  await withCheckinTemplate(async () => {
    const h = freshHandler();
    await withStubs([
      { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    ], async () => {
      const res = makeRes();
      await h({ method: 'GET', query: { date, days: '3' } }, res);

      assert.equal(res._status, 200);
      assert.equal(res._json.ok, true);
      assert.equal(res._json.timezone, 'America/Toronto');
      assert.equal(res._json.slotMinutes, 15, 'must come from the CHECK-IN template, not the applicant default of 30');
      assert.equal(Object.keys(res._json.days).length, 3);
      assert.ok(Object.prototype.hasOwnProperty.call(res._json.days, date));

      // 09:00-10:00 at 15 minutes with no buffer is exactly four slots.
      const slots = res._json.days[date];
      assert.equal(slots.length, 4, `expected 4 slots, got ${JSON.stringify(slots)}`);
      for (const s of slots) {
        assert.match(s.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(Date.parse(s.end) - Date.parse(s.start), 15 * 60 * 1000);
      }
    });
  });
  delete require.cache[handlerPath]; // discard the stub-bound instance
});

test('a busy interval covering the window removes those slots', async () => {
  envSetup();
  const date = dateParam();
  const { y, mo, d } = futureWeekdayYmd();
  const nine = tz.zonedWallTimeToUtc(y, mo, d, 9, 0, 'America/Toronto');
  await withCheckinTemplate(async () => {
    const h = freshHandler();
    await withStubs([
      { obj: gcal, key: 'freeBusy', value: async () => ({
          ok: true, busy: [{ start: nine, end: nine + 30 * 60000 }],
        }) },
    ], async () => {
      const res = makeRes();
      await h({ method: 'GET', query: { date, days: '1' } }, res);
      assert.equal(res._status, 200);
      // The first two 15-minute slots are covered; the last two survive.
      assert.equal(res._json.days[date].length, 2);
    });
  });
  delete require.cache[handlerPath];
});

test('the free/busy query spans the whole range padded by a day on each side', async () => {
  envSetup();
  const date = dateParam();
  await withCheckinTemplate(async () => {
    const h = freshHandler();
    const fbSpy = spyStub({ ok: true, busy: [] });
    await withStubs([{ obj: gcal, key: 'freeBusy', value: fbSpy }], async () => {
      const res = makeRes();
      await h({ method: 'GET', query: { date, days: '5' } }, res);
      assert.equal(res._status, 200);
      assert.equal(fbSpy.calls.length, 1, 'one freeBusy call for the whole range, not one per day');
      const [minIso, maxIso] = fbSpy.calls[0];
      assert.ok(Date.parse(maxIso) - Date.parse(minIso) >= 7 * 86400000,
        'the window must cover 5 days plus a day of padding on each side');
    });
  });
  delete require.cache[handlerPath];
});

test('days defaults to 1 and is clamped to 31', async () => {
  envSetup();
  const date = dateParam();
  await withCheckinTemplate(async () => {
    const h = freshHandler();
    await withStubs([
      { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    ], async () => {
      for (const [days, expected] of [[undefined, 1], ['0', 1], ['-4', 1], ['abc', 1], ['31', 31], ['999', 31]]) {
        const res = makeRes();
        await h({ method: 'GET', query: { date, days } }, res);
        assert.equal(res._status, 200);
        assert.equal(Object.keys(res._json.days).length, expected,
          `days=${days} should yield ${expected} day keys`);
      }
    });
  });
  delete require.cache[handlerPath];
});

test('a missing or malformed date -> 400 BAD_DATE', async () => {
  envSetup();
  for (const date of [undefined, '', 'tomorrow', '2026-13-01', '2026-02-31', '26-01-01']) {
    const res = makeRes();
    await handler({ method: 'GET', query: { date } }, res);
    assert.equal(res._status, 400, `${JSON.stringify(date)} should be 400`);
    assert.equal(res._json.error, 'BAD_DATE');
  }
});

test('BLOB_NOT_CONFIGURED -> 503 without ever calling freeBusy', async () => {
  envSetup();
  const date = dateParam();
  await withStubs([
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, template: CHECKIN_TEMPLATE }) },
  ], async () => {
    const h = freshHandler();
    const fbSpy = spyStub({ ok: true, busy: [] });
    await withStubs([{ obj: gcal, key: 'freeBusy', value: fbSpy }], async () => {
      const res = makeRes();
      await h({ method: 'GET', query: { date } }, res);
      assert.equal(res._status, 503);
      assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
      assert.equal(fbSpy.calls.length, 0);
    });
  });
  delete require.cache[handlerPath];
});

test('CALENDAR_NOT_CONNECTED -> 503; any other freeBusy failure -> 502 UPSTREAM', async () => {
  envSetup();
  const date = dateParam();
  await withCheckinTemplate(async () => {
    const h = freshHandler();
    await withStubs([
      { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
    ], async () => {
      const res = makeRes();
      await h({ method: 'GET', query: { date } }, res);
      assert.equal(res._status, 503);
      assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
    });
    await withStubs([
      { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: 'google 500' }) },
    ], async () => {
      const res = makeRes();
      await h({ method: 'GET', query: { date } }, res);
      assert.equal(res._status, 502);
      assert.equal(res._json.error, 'UPSTREAM');
    });
  });
  delete require.cache[handlerPath];
});

test('Cache-Control: no-store is set on EVERY branch, including 405 and errors', async () => {
  envSetup();
  const cases = [
    { method: 'POST', query: {} },
    { method: 'GET', query: { date: 'nonsense' } },
    { method: 'GET', query: { date: dateParam() } },
  ];
  await withCheckinTemplate(async () => {
    const h = freshHandler();
    await withStubs([
      { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    ], async () => {
      for (const req of cases) {
        const res = makeRes();
        await h(req, res);
        assert.equal(res._headers['Cache-Control'], 'no-store',
          `no-store missing for ${JSON.stringify(req)}`);
      }
    });
  });
  delete require.cache[handlerPath];
});

test('non-GET requests return 405', async () => {
  envSetup();
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = makeRes();
    await handler({ method, query: {} }, res);
    assert.equal(res._status, 405);
  }
});
