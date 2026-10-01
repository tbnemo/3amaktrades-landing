const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const cc = require('../api/_checkin-clients');

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
}

// _blob-store reads through `new Response(result.stream).text()`, which a plain
// object cannot stand in for, so these tests stub readJson/writeJson -- the same
// module boundary the rest of the codebase stubs.
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

// Canonical, already-normalized fixtures: expiresAt matches exactly what
// normalizeEntry/computeExpiresAt would derive from startDate+durationMonths,
// so round-tripping either fixture through normalizeEntry is a no-op and
// identity-style assertions below (e.g. "carried through unchanged") hold.
const ALICE = {
  name: 'Alice', email: 'alice@example.com', phone: '+1 (555) 010-0100',
  startDate: '2026-01-01', durationMonths: 3, pausedAt: null,
  expiresAt: Date.UTC(2026, 3, 1), paymentsByMonth: {},
};
const BOB = {
  name: 'Bob', email: 'bob@example.com', phone: '',
  startDate: '2026-02-15', durationMonths: 1, pausedAt: null,
  expiresAt: Date.UTC(2026, 2, 15), paymentsByMonth: {},
};

test('normalizeEmail trims and lowercases; normalizePhone keeps digits only', () => {
  assert.equal(cc.normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
  assert.equal(cc.normalizeEmail(null), '');
  assert.equal(cc.normalizePhone('+1 (555) 010-0100'), '15550100100');
  assert.equal(cc.normalizePhone('555.010.0100'), '5550100100');
  assert.equal(cc.normalizePhone(''), '');
  assert.equal(cc.normalizePhone(null), '');
});

test('loadClients returns [] when the document has never been written', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: null }) },
  ], async () => {
    const r = await cc.loadClients();
    assert.equal(r.ok, true);
    assert.deepEqual(r.clients, []);
    assert.equal(r.usedDefault, true);
  });
});

test('loadClients reads CHECKIN_CLIENTS_BLOB, not the applicant blob', async () => {
  envSetup();
  const readSpy = spyStub({ ok: true, data: { clients: [] } });
  await withStubs([{ obj: store, key: 'readJson', value: readSpy }], async () => {
    await cc.loadClients();
    assert.equal(readSpy.calls.length, 1);
    assert.equal(readSpy.calls[0][0], 'checkin-clients.json');
    assert.equal(readSpy.calls[0][0], store.CHECKIN_CLIENTS_BLOB);
  });
});

test('loadClients normalizes entries and drops any with no email', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: { clients: [
      { name: '  Alice  ', email: ' Alice@Example.COM ', phone: ' 555-0100 ' },
      { name: 'Ghost', phone: '5550199' },        // no email -> dropped
      { name: 'Empty', email: '   ', phone: '' }, // blank email -> dropped
      null,                                        // junk -> dropped
    ] } }) },
  ], async () => {
    const r = await cc.loadClients();
    assert.equal(r.ok, true);
    assert.deepEqual(r.clients, [{
      name: 'Alice', email: 'alice@example.com', phone: '555-0100',
      startDate: '', durationMonths: 1, pausedAt: null, expiresAt: null,
      paymentsByMonth: {},
    }]);
  });
});

test('loadClients tolerates a document whose clients field is not an array', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: { clients: 'nope' } }) },
  ], async () => {
    const r = await cc.loadClients();
    assert.equal(r.ok, true);
    assert.deepEqual(r.clients, []);
  });
});

test('loadClients passes a read failure through with clients:[]', async () => {
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, data: null }) },
  ], async () => {
    const r = await cc.loadClients();
    assert.equal(r.ok, false);
    assert.equal(r.reason, store.BLOB_NOT_CONFIGURED);
    assert.deepEqual(r.clients, []);
  });
});

test('saveClients writes { clients } to CHECKIN_CLIENTS_BLOB', async () => {
  envSetup();
  const writeSpy = spyStub({ ok: true });
  await withStubs([{ obj: store, key: 'writeJson', value: writeSpy }], async () => {
    const r = await cc.saveClients([ALICE]);
    assert.equal(r.ok, true);
    assert.equal(writeSpy.calls.length, 1);
    assert.equal(writeSpy.calls[0][0], store.CHECKIN_CLIENTS_BLOB);
    assert.deepEqual(writeSpy.calls[0][1], { clients: [ALICE] });
  });
});

test('findClient matches email case-insensitively', () => {
  const list = [ALICE, BOB];
  assert.equal(cc.findClient(list, { email: 'ALICE@EXAMPLE.COM' }).name, 'Alice');
  assert.equal(cc.findClient(list, { email: '  bob@example.com  ' }).name, 'Bob');
});

test('findClient matches phone on digits only, in both directions', () => {
  const list = [ALICE, BOB];
  assert.equal(cc.findClient(list, { phone: '15550100100' }).name, 'Alice');
  assert.equal(cc.findClient(list, { phone: '+1-555-010-0100' }).name, 'Alice');
  assert.equal(cc.findClient(list, { phone: '1 (555) 010 0100' }).name, 'Alice');
});

test('findClient never matches an empty phone against a stored empty phone', () => {
  // Bob has no phone. A visitor submitting an empty/blank phone must not be
  // handed Bob's record just because '' === ''.
  assert.equal(cc.findClient([BOB], { phone: '' }), null);
  assert.equal(cc.findClient([BOB], { phone: '   ' }), null);
  assert.equal(cc.findClient([BOB], { phone: '---' }), null);
  assert.equal(cc.findClient([BOB], {}), null);
});

test('findClient returns null for an unknown email or phone', () => {
  const list = [ALICE, BOB];
  assert.equal(cc.findClient(list, { email: 'nobody@example.com' }), null);
  assert.equal(cc.findClient(list, { phone: '5559999999' }), null);
  assert.equal(cc.findClient([], { email: 'alice@example.com' }), null);
  assert.equal(cc.findClient(null, { email: 'alice@example.com' }), null);
});

test('findClient prefers an email hit over a phone hit', () => {
  // Email is the record key, so an email match is exact and wins outright.
  const list = [
    { name: 'PhoneOwner', email: 'phone@example.com', phone: '5550100100' },
    { name: 'EmailOwner', email: 'email@example.com', phone: '5550100999' },
  ];
  const found = cc.findClient(list, { email: 'email@example.com', phone: '5550100100' });
  assert.equal(found.name, 'EmailOwner');
});

test('validateClient requires a well-formed, non-empty email and allows a missing phone', () => {
  const pkg = { startDate: '2026-01-01', durationMonths: 3 };
  assert.deepEqual(cc.validateClient({ name: 'A', email: 'a@b.co', ...pkg }), { ok: true, errors: [] });
  assert.deepEqual(cc.validateClient({ name: '', email: 'a@b.co', phone: '', ...pkg }), { ok: true, errors: [] });

  const noEmail = cc.validateClient({ name: 'A', phone: '5550100', ...pkg });
  assert.equal(noEmail.ok, false);
  assert.ok(noEmail.errors.some(e => /email/i.test(e)));

  const blank = cc.validateClient({ name: 'A', email: '   ', ...pkg });
  assert.equal(blank.ok, false);

  const bad = cc.validateClient({ name: 'A', email: 'not-an-email', ...pkg });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /email/i.test(e)));

  assert.equal(cc.validateClient(null).ok, false);
});

test('validateClient requires startDate as YYYY-MM-DD and durationMonths as a positive number', () => {
  const base = { name: 'A', email: 'a@b.co' };

  const noStart = cc.validateClient({ ...base, durationMonths: 3 });
  assert.equal(noStart.ok, false);
  assert.ok(noStart.errors.some(e => /startDate/i.test(e)));

  const badStart = cc.validateClient({ ...base, startDate: '01/01/2026', durationMonths: 3 });
  assert.equal(badStart.ok, false);
  assert.ok(badStart.errors.some(e => /startDate/i.test(e)));

  const noDuration = cc.validateClient({ ...base, startDate: '2026-01-01' });
  assert.equal(noDuration.ok, false);
  assert.ok(noDuration.errors.some(e => /durationMonths/i.test(e)));

  // durationMonths === 0 is the explicit "No package" sentinel (an
  // admin-chosen ongoing/indefinite client), not an invalid value.
  const zeroDuration = cc.validateClient({ ...base, startDate: '2026-01-01', durationMonths: 0 });
  assert.deepEqual(zeroDuration, { ok: true, errors: [] });

  const negDuration = cc.validateClient({ ...base, startDate: '2026-01-01', durationMonths: -1 });
  assert.equal(negDuration.ok, false);

  assert.deepEqual(
    cc.validateClient({ ...base, startDate: '2026-01-01', durationMonths: 6 }),
    { ok: true, errors: [] },
  );
});

test('upsertClient appends a new entry, normalized', () => {
  const out = cc.upsertClient([ALICE], { name: ' Bob ', email: ' BOB@Example.com ', phone: ' 555-0199 ' });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], ALICE, 'the existing entry is carried through unchanged');
  assert.deepEqual(out[1], {
    name: 'Bob', email: 'bob@example.com', phone: '555-0199',
    startDate: '', durationMonths: 1, pausedAt: null, expiresAt: null,
    paymentsByMonth: {},
  });
});

test('upsertClient does not mutate the array it was given', () => {
  const list = [ALICE];
  cc.upsertClient(list, BOB);
  assert.equal(list.length, 1);
});

test('upsertClient REPLACES an existing email in place rather than duplicating it', () => {
  const list = [ALICE, BOB];
  const out = cc.upsertClient(list, { name: 'Alice Updated', email: 'ALICE@example.com', phone: '5550000000' });
  assert.equal(out.length, 2, 'the list must not grow when the email already exists');
  assert.equal(out[0].name, 'Alice Updated', 'the replacement keeps the original position');
  assert.equal(out[0].email, 'alice@example.com');
  assert.equal(out[0].phone, '5550000000');
  assert.equal(out[1].email, 'bob@example.com');
});

test('removeClient removes by email case-insensitively and reports removed:true', () => {
  const list = [ALICE, BOB];
  const r = cc.removeClient(list, 'ALICE@EXAMPLE.COM');
  assert.equal(r.removed, true);
  assert.equal(r.clients.length, 1);
  assert.equal(r.clients[0].email, 'bob@example.com');
  assert.equal(list.length, 2, 'the input array must not be mutated');
});

test('removeClient reports removed:false for an email that is not on the list', () => {
  const r = cc.removeClient([ALICE], 'nobody@example.com');
  assert.equal(r.removed, false);
  assert.equal(r.clients.length, 1);
});

test('removeClient with an empty email removes nothing', () => {
  const r = cc.removeClient([ALICE], '');
  assert.equal(r.removed, false);
  assert.equal(r.clients.length, 1);
});

// ===========================================================================
// Package lifecycle: addMonths, computeExpiresAt, renewClient, pauseClient,
// resumeClient, isAccessActive.
// ===========================================================================

test('addMonths adds N calendar months to an epoch instant, in UTC', () => {
  const start = Date.UTC(2025, 0, 15); // 2025-01-15T00:00:00Z
  assert.equal(cc.addMonths(start, 2), Date.UTC(2025, 2, 15));
  assert.equal(cc.addMonths(start, 0), start);
});

test('computeExpiresAt converts a YYYY-MM-DD start + duration into an epoch expiry', () => {
  assert.equal(cc.computeExpiresAt('2026-01-01', 3), Date.UTC(2026, 3, 1));
  assert.equal(cc.computeExpiresAt('2026-12-01', 1), Date.UTC(2027, 0, 1));
});

test('computeExpiresAt returns null for a malformed or missing startDate', () => {
  assert.equal(cc.computeExpiresAt('', 3), null);
  assert.equal(cc.computeExpiresAt('not-a-date', 3), null);
  assert.equal(cc.computeExpiresAt(null, 3), null);
});

test('renewClient extends from the CURRENT expiry when renewing before it lapses', () => {
  const nowMs = Date.UTC(2026, 1, 1); // Feb 1 2026 -- still active
  const client = { ...ALICE, durationMonths: 1, expiresAt: Date.UTC(2026, 2, 1) }; // expires Mar 1
  const renewed = cc.renewClient(client, nowMs);
  // Extends from the EXISTING expiry (Mar 1), not from now (Feb 1) -- paid
  // time already on the books is never shortened by an early renewal.
  assert.equal(renewed.expiresAt, Date.UTC(2026, 3, 1));
});

test('renewClient extends from NOW when renewing after the package has already lapsed', () => {
  const nowMs = Date.UTC(2026, 4, 1); // May 1 2026
  const client = { ...ALICE, durationMonths: 1, expiresAt: Date.UTC(2026, 1, 1) }; // expired Feb 1
  const renewed = cc.renewClient(client, nowMs);
  // Extends from NOW (May 1), not from the stale Feb 1 expiry -- a lapsed
  // renewal must not retroactively back-date the new expiry.
  assert.equal(renewed.expiresAt, Date.UTC(2026, 5, 1));
});

test('pauseClient sets pausedAt, and is a no-op (same reference) if already paused', () => {
  const client = { ...ALICE, pausedAt: null };
  const paused = cc.pauseClient(client, 1000);
  assert.equal(paused.pausedAt, 1000);
  assert.notEqual(paused, client, 'pausing an active client returns a new object');

  const alreadyPaused = { ...client, pausedAt: 500 };
  const again = cc.pauseClient(alreadyPaused, 9999);
  assert.equal(again, alreadyPaused, 'pausing an already-paused client is a true no-op');
});

test('resumeClient shifts expiresAt forward by exactly the paused duration, and is a no-op when not paused', () => {
  const client = { ...ALICE, pausedAt: 1000, expiresAt: 10000 };
  const resumed = cc.resumeClient(client, 5000); // paused for 4000ms
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.expiresAt, 14000);

  const notPaused = { ...client, pausedAt: null };
  const again = cc.resumeClient(notPaused, 5000);
  assert.equal(again, notPaused, 'resuming a non-paused client is a true no-op');
});

test('resumeClient leaves a null expiresAt as null (no package configured yet)', () => {
  const client = { ...ALICE, pausedAt: 1000, expiresAt: null };
  const resumed = cc.resumeClient(client, 5000);
  assert.equal(resumed.expiresAt, null);
  assert.equal(resumed.pausedAt, null);
});

test('pauseClient/resumeClient preserve exact remaining time across multiple pause/resume cycles', () => {
  let client = { ...ALICE, pausedAt: null, expiresAt: 10000 };

  client = cc.pauseClient(client, 2000);
  client = cc.resumeClient(client, 3000); // paused 1000ms -> expiresAt shifts to 11000
  assert.equal(client.expiresAt, 11000);
  assert.equal(client.pausedAt, null);

  client = cc.pauseClient(client, 4000);
  client = cc.resumeClient(client, 4500); // paused 500ms -> expiresAt shifts to 11500
  assert.equal(client.expiresAt, 11500);
  assert.equal(client.pausedAt, null);
});

test('isAccessActive covers active, paused, expired, and legacy null-expiresAt states', () => {
  const nowMs = 10000;
  assert.equal(cc.isAccessActive({ pausedAt: null, expiresAt: 20000 }, nowMs), true, 'active');
  assert.equal(cc.isAccessActive({ pausedAt: 5000, expiresAt: 20000 }, nowMs), false, 'paused blocks access even before expiry');
  assert.equal(cc.isAccessActive({ pausedAt: null, expiresAt: 5000 }, nowMs), false, 'expired');
  assert.equal(cc.isAccessActive({ pausedAt: null, expiresAt: null }, nowMs), true, 'legacy null expiresAt means active, not expired');
  assert.equal(cc.isAccessActive(null, nowMs), false, 'no client at all is never active');
});

// ===========================================================================
// durationMonths === 0 ("No package"): an explicit, admin-chosen
// ongoing/indefinite client -- distinct from the legacy null-expiresAt
// migration case, but it must behave identically for isAccessActive's
// purposes (always active unless paused).
// ===========================================================================

test('computeExpiresAt returns null for durationMonths === 0 regardless of startDate', () => {
  assert.equal(cc.computeExpiresAt('2026-01-01', 0), null);
  assert.equal(cc.computeExpiresAt('', 0), null);
  assert.equal(cc.computeExpiresAt('not-a-date', 0), null);
});

test('normalizeEntry (via upsertClient) preserves durationMonths === 0 exactly -- it is never clamped up to 1', () => {
  const out = cc.upsertClient([], {
    name: 'Omar', email: 'omar@example.com', startDate: '2026-01-01', durationMonths: 0,
  });
  assert.equal(out[0].durationMonths, 0);
  assert.equal(out[0].expiresAt, null, 'a "No package" client always normalizes to a null expiresAt');
});

test('isAccessActive treats a durationMonths:0 / expiresAt:null client the same as the legacy null-expiresAt case: always active unless paused', () => {
  const nowMs = 10000;
  assert.equal(cc.isAccessActive({ durationMonths: 0, pausedAt: null, expiresAt: null }, nowMs), true);
  assert.equal(cc.isAccessActive({ durationMonths: 0, pausedAt: 5000, expiresAt: null }, nowMs), false,
    'pause still wins outright over a "No package" client');
});

test('validateClient accepts durationMonths === 0 but still rejects negative/NaN/missing values', () => {
  const base = { name: 'A', email: 'a@b.co', startDate: '2026-01-01' };
  assert.deepEqual(cc.validateClient({ ...base, durationMonths: 0 }), { ok: true, errors: [] });
  assert.equal(cc.validateClient({ ...base, durationMonths: -1 }).ok, false);
  assert.equal(cc.validateClient({ ...base, durationMonths: NaN }).ok, false);
  assert.equal(cc.validateClient({ ...base }).ok, false, 'durationMonths is still required');
});

// CRITICAL regression (code review): Number(null) === 0, Number(false) === 0,
// and Number([]) === 0 -- without an explicit type check BEFORE that
// coercion, every one of these would have silently qualified as the new "No
// package" sentinel and granted indefinite booking access, on the one field
// that controls it, where they previously (correctly) 400'd.
test('validateClient rejects null/\'\'/false/[]/objects for durationMonths rather than letting them coerce to 0', () => {
  const base = { name: 'A', email: 'a@b.co', startDate: '2026-01-01' };
  for (const bad of [null, '', false, true, [], {}, [0], { a: 1 }]) {
    const r = cc.validateClient({ ...base, durationMonths: bad });
    assert.equal(r.ok, false, `durationMonths: ${JSON.stringify(bad)} must be rejected`);
    assert.ok(r.errors.some(e => /durationMonths/i.test(e)));
  }
  // A whitespace-only string must not slip through as blank-coerces-to-0 either.
  assert.equal(cc.validateClient({ ...base, durationMonths: '   ' }).ok, false);

  // A genuine numeric string must still work (Number("0") === 0, Number("3") === 3).
  assert.deepEqual(cc.validateClient({ ...base, durationMonths: '0' }), { ok: true, errors: [] });
  assert.deepEqual(cc.validateClient({ ...base, durationMonths: '3' }), { ok: true, errors: [] });
});

test('renewClient is a no-op (same reference) for a durationMonths === 0 client', () => {
  const client = {
    name: 'Omar', email: 'omar@example.com', startDate: '2026-01-01',
    durationMonths: 0, pausedAt: null, expiresAt: null, paymentsByMonth: {},
  };
  const renewed = cc.renewClient(client, Date.UTC(2026, 5, 1));
  assert.equal(renewed, client, 'renewing a "No package" client must be a true no-op');
});

// ===========================================================================
// paymentsByMonth: manual payment tracking, keyed by "YYYY-MM".
// ===========================================================================

test('normalizeEntry defaults paymentsByMonth to {} when absent', () => {
  const out = cc.upsertClient([], { name: 'Omar', email: 'omar@example.com' });
  assert.deepEqual(out[0].paymentsByMonth, {});
});

test('normalizeEntry round-trips a well-formed paymentsByMonth through save/reload (upsertClient then loadClients-style re-normalization)', () => {
  const withPayments = cc.upsertClient([], {
    name: 'Omar', email: 'omar@example.com',
    paymentsByMonth: { '2026-01': { amountOwed: 250, paid: true }, '2026-02': { amountOwed: 100, paid: false } },
  });
  assert.deepEqual(withPayments[0].paymentsByMonth, {
    '2026-01': { amountOwed: 250, paid: true },
    '2026-02': { amountOwed: 100, paid: false },
  });

  // Simulate a reload: loadClients re-normalizes every stored entry, so the
  // field must survive a second pass through normalizeEntry unchanged --
  // this is the exact round-trip a save-then-reload performs in production.
  const reloaded = cc.upsertClient([], withPayments[0]);
  assert.deepEqual(reloaded[0].paymentsByMonth, withPayments[0].paymentsByMonth);
});

test('normalizeEntry sanitizes a malformed paymentsByMonth rather than dropping the whole field', () => {
  const out = cc.upsertClient([], {
    name: 'Omar', email: 'omar@example.com',
    paymentsByMonth: {
      '2026-01': { amountOwed: -50, paid: 'yes' }, // negative amount, non-boolean paid
      'not-a-month': { amountOwed: 10, paid: true }, // malformed key, dropped
      '2026-03': 'garbage', // non-object entry
    },
  });
  assert.deepEqual(out[0].paymentsByMonth, {
    '2026-01': { amountOwed: 0, paid: false },
    '2026-03': { amountOwed: 0, paid: false },
  });
});

test('upsertClient editing an existing client preserves paymentsByMonth when the edit body carries it through', () => {
  const withPayments = cc.upsertClient([ALICE], {
    ...ALICE, paymentsByMonth: { '2026-01': { amountOwed: 500, paid: true } },
  });
  assert.deepEqual(withPayments[0].paymentsByMonth, { '2026-01': { amountOwed: 500, paid: true } });
});
