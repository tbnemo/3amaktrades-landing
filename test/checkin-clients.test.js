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

const ALICE = { name: 'Alice', email: 'alice@example.com', phone: '+1 (555) 010-0100' };
const BOB = { name: 'Bob', email: 'bob@example.com', phone: '' };

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
    assert.deepEqual(r.clients, [{ name: 'Alice', email: 'alice@example.com', phone: '555-0100' }]);
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
  assert.deepEqual(cc.validateClient({ name: 'A', email: 'a@b.co' }), { ok: true, errors: [] });
  assert.deepEqual(cc.validateClient({ name: '', email: 'a@b.co', phone: '' }), { ok: true, errors: [] });

  const noEmail = cc.validateClient({ name: 'A', phone: '5550100' });
  assert.equal(noEmail.ok, false);
  assert.ok(noEmail.errors.some(e => /email/i.test(e)));

  const blank = cc.validateClient({ name: 'A', email: '   ' });
  assert.equal(blank.ok, false);

  const bad = cc.validateClient({ name: 'A', email: 'not-an-email' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => /email/i.test(e)));

  assert.equal(cc.validateClient(null).ok, false);
});

test('upsertClient appends a new entry, normalized', () => {
  const out = cc.upsertClient([ALICE], { name: ' Bob ', email: ' BOB@Example.com ', phone: ' 555-0199 ' });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], ALICE, 'the existing entry is carried through unchanged');
  assert.deepEqual(out[1], { name: 'Bob', email: 'bob@example.com', phone: '555-0199' });
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
