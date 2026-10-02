const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const ap = require('../api/_applicants');

// _blob-store reads through `new Response(result.stream).text()`, which a plain
// object cannot stand in for, so these tests stub readJson/writeJson -- the same
// module boundary test/checkin-clients.test.js stubs.
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

const ALICE = {
  name: 'Alice', email: 'alice@example.com', phone: '5550100100',
  country: 'US', experience: 'beginner', budget: '1k-3k', budgetCode: '1k-3k',
  looking: 'community', goal: 'side-income', lang: 'en',
};

test('normalizeEmail/normalizePhone: lowercase+trim email, digits-only phone', () => {
  assert.equal(ap.normalizeEmail('  Alice@Example.com '), 'alice@example.com');
  assert.equal(ap.normalizePhone('+1 (555) 010-0100'), '15550100100');
});

test('findApplicant: no match in an empty or unrelated list', () => {
  assert.equal(ap.findApplicant([], { email: 'alice@example.com' }), null);
  assert.equal(ap.findApplicant([{ email: 'bob@example.com', phone: '1', previousEmails: [], previousPhones: [] }],
    { email: 'alice@example.com', phone: '5550100100' }), null);
});

test('findApplicant: matches on current email', () => {
  const a = { email: 'alice@example.com', phone: '', previousEmails: [], previousPhones: [] };
  assert.equal(ap.findApplicant([a], { email: 'Alice@Example.com' }), a);
});

test('findApplicant: matches on current phone', () => {
  // No leading country code here, matching the stored value exactly once
  // digits are extracted -- normalizePhone does NOT strip a country code
  // prefix (same rule as api/_checkin-clients.js), so '+1 555-010-0100'
  // would normalize to a DIFFERENT digit string than '5550100100'.
  const a = { email: '', phone: '5550100100', previousEmails: [], previousPhones: [] };
  assert.equal(ap.findApplicant([a], { phone: '(555) 010-0100' }), a);
});

test('findApplicant: matches on a HISTORICAL email even when the current email differs', () => {
  const a = { email: 'new@example.com', phone: '5550100100', previousEmails: ['old@example.com'], previousPhones: [] };
  assert.equal(ap.findApplicant([a], { email: 'old@example.com' }), a);
});

test('findApplicant: matches on a HISTORICAL phone even when the current phone differs', () => {
  const a = { email: 'alice@example.com', phone: '5550100999', previousEmails: [], previousPhones: ['5550100100'] };
  assert.equal(ap.findApplicant([a], { phone: '5550100100' }), a);
});

test('findApplicant: a blank submitted phone must not match a record with no phone on file', () => {
  const a = { email: 'bob@example.com', phone: '', previousEmails: [], previousPhones: [] };
  assert.equal(ap.findApplicant([a], { email: 'someone-else@example.com', phone: '' }), null);
});

test('upsertApplicant: a brand-new applicant is appended, not matched as an update', () => {
  const result = ap.upsertApplicant([], ALICE);
  assert.equal(result.isUpdate, false);
  assert.equal(result.applicants.length, 1);
  assert.equal(result.record.email, 'alice@example.com');
  assert.equal(result.record.submissionCount, 1);
  assert.deepEqual(result.record.previousEmails, []);
  assert.deepEqual(result.record.previousPhones, []);
});

test('upsertApplicant: a resubmission with the SAME email/phone updates in place', () => {
  const first = ap.upsertApplicant([], ALICE);
  const second = ap.upsertApplicant(first.applicants, { ...ALICE, goal: 'full-time' });
  assert.equal(second.isUpdate, true);
  assert.equal(second.applicants.length, 1, 'must not create a second record');
  assert.equal(second.record.goal, 'full-time', 'the new answers must win');
  assert.equal(second.record.submissionCount, 2);
});

test('upsertApplicant: changing ONLY the email still matches as the same applicant, and the old email is remembered', () => {
  const first = ap.upsertApplicant([], ALICE);
  const second = ap.upsertApplicant(first.applicants, { ...ALICE, email: 'alice.new@example.com' });
  assert.equal(second.isUpdate, true);
  assert.equal(second.applicants.length, 1);
  assert.equal(second.record.email, 'alice.new@example.com');
  assert.deepEqual(second.record.previousEmails, ['alice@example.com']);
  assert.equal(second.record.phone, ALICE.phone, 'the unchanged phone is untouched');
});

test('upsertApplicant: changing ONLY the phone still matches as the same applicant, and the old phone is remembered', () => {
  const first = ap.upsertApplicant([], ALICE);
  const second = ap.upsertApplicant(first.applicants, { ...ALICE, phone: '5559998888' });
  assert.equal(second.isUpdate, true);
  assert.equal(second.applicants.length, 1);
  assert.equal(second.record.phone, '5559998888');
  assert.deepEqual(second.record.previousPhones, [ALICE.phone]);
});

test('upsertApplicant: a THIRD submission under a THIRD email still resolves to the one record, accumulating history', () => {
  const first = ap.upsertApplicant([], ALICE);
  const second = ap.upsertApplicant(first.applicants, { ...ALICE, email: 'alice2@example.com' });
  const third = ap.upsertApplicant(second.applicants, { ...ALICE, email: 'alice3@example.com' });
  assert.equal(third.applicants.length, 1);
  assert.equal(third.record.email, 'alice3@example.com');
  assert.deepEqual(third.record.previousEmails.sort(), ['alice2@example.com', 'alice@example.com']);
  assert.equal(third.record.submissionCount, 3);
});

test('upsertApplicant: resubmitting with an UNCHANGED email never adds it to its own history', () => {
  const first = ap.upsertApplicant([], ALICE);
  const second = ap.upsertApplicant(first.applicants, { ...ALICE });
  assert.deepEqual(second.record.previousEmails, []);
  assert.deepEqual(second.record.previousPhones, []);
});

test('upsertApplicant: an unrelated new applicant is appended alongside, not merged', () => {
  const first = ap.upsertApplicant([], ALICE);
  const second = ap.upsertApplicant(first.applicants, {
    name: 'Bob', email: 'bob@example.com', phone: '5551112222',
  });
  assert.equal(second.isUpdate, false);
  assert.equal(second.applicants.length, 2);
});

test('loadApplicants: a missing blob is not an error -- returns an empty list', async () => {
  await withStubs([{ obj: store, key: 'readJson', value: async () => ({ ok: true, data: null }) }], async () => {
    const read = await ap.loadApplicants();
    assert.equal(read.ok, true);
    assert.deepEqual(read.applicants, []);
  });
});

test('loadApplicants: a genuine read failure is surfaced, not swallowed as empty', async () => {
  await withStubs([{ obj: store, key: 'readJson', value: async () => ({ ok: false, reason: 'boom' }) }], async () => {
    const read = await ap.loadApplicants();
    assert.equal(read.ok, false);
    assert.equal(read.reason, 'boom');
  });
});

test('saveApplicants: writes to the dedicated APPLICANTS_BLOB document', async () => {
  const putSpy = spyStub({ ok: true });
  await withStubs([{ obj: store, key: 'writeJson', value: putSpy }], async () => {
    await ap.saveApplicants([ALICE]);
    assert.equal(putSpy.calls.length, 1);
    assert.equal(putSpy.calls[0][0], store.APPLICANTS_BLOB);
  });
});
