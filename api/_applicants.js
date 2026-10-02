// Persisted record of full (non-partial) application-form submissions, so a
// second submission from the same person updates their existing answers
// instead of silently becoming a second lead -- and so changing just one of
// email/phone can't be used to dodge that and keep resubmitting as if fresh.
//
// There is no admin UI for this store (unlike checkin-clients.json) -- it
// exists purely so api/submit.js can tell a genuine resubmission from a new
// applicant. Omar sees the result as a Slack message header, not a page.
const store = require('./_blob-store');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Digits only, matching api/_checkin-clients.js's own normalizePhone --
// country-code prefixes are NOT stripped, for the same reason: guessing
// which leading digits are a country code is how two different people's
// numbers end up looking like the same one.
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function normalizeEntry(a) {
  const src = (a && typeof a === 'object') ? a : {};
  const now = Date.now();
  const firstSubmittedAt = Number.isFinite(src.firstSubmittedAt) ? src.firstSubmittedAt : now;
  const lastSubmittedAt = Number.isFinite(src.lastSubmittedAt) ? src.lastSubmittedAt : now;
  const submissionCount = Number.isFinite(src.submissionCount) && src.submissionCount > 0
    ? Math.floor(src.submissionCount) : 1;
  return {
    email: normalizeEmail(src.email),
    phone: normalizePhone(src.phone),
    // Contact values this same applicant used to submit under, before they
    // changed it -- never the CURRENT email/phone, which live in the two
    // fields above instead of being duplicated in here.
    previousEmails: Array.isArray(src.previousEmails)
      ? Array.from(new Set(src.previousEmails.map(normalizeEmail).filter(Boolean))) : [],
    previousPhones: Array.isArray(src.previousPhones)
      ? Array.from(new Set(src.previousPhones.map(normalizePhone).filter(Boolean))) : [],
    name: String(src.name || '').trim(),
    country: String(src.country || '').trim(),
    experience: String(src.experience || '').trim(),
    budget: String(src.budget || '').trim(),
    budgetCode: String(src.budgetCode || '').trim(),
    looking: String(src.looking || '').trim(),
    goal: String(src.goal || '').trim(),
    lang: String(src.lang || '').trim(),
    firstSubmittedAt,
    lastSubmittedAt,
    submissionCount,
  };
}

// A missing blob is not an error: it is a deployment with no stored
// applicants yet (or one from before this feature existed).
async function loadApplicants() {
  const read = await store.readJson(store.APPLICANTS_BLOB);
  if (!read.ok) return { ok: false, reason: read.reason, applicants: [] };
  const raw = (read.data && Array.isArray(read.data.applicants)) ? read.data.applicants : [];
  const applicants = raw.map(normalizeEntry).filter(a => a.email || a.phone);
  return { ok: true, applicants };
}

async function saveApplicants(applicants) {
  return store.writeJson(store.APPLICANTS_BLOB, { applicants });
}

// Matches on the incoming email OR phone against a stored record's CURRENT
// email/phone OR its previousEmails/previousPhones history -- deliberately
// broader than checkin-clients.js's email-only findClient, since the whole
// point here is catching someone who changed one contact field to look new.
function findApplicant(applicants, { email, phone } = {}) {
  const list = applicants || [];
  const e = normalizeEmail(email);
  const p = normalizePhone(phone);
  for (const a of list) {
    if (!a) continue;
    if (e && (a.email === e || a.previousEmails.indexOf(e) !== -1)) return a;
    if (p && (a.phone === p || a.previousPhones.indexOf(p) !== -1)) return a;
  }
  return null;
}

// Upserts by the SAME broadened match rule as findApplicant. Returns
// { applicants, record, isUpdate } rather than just the array -- the caller
// (api/submit.js) needs to know whether this was a resubmission to pick the
// right Slack wording, and re-deriving that with its own findApplicant call
// would risk drifting from whichever record upsert actually touched.
function upsertApplicant(applicants, incoming) {
  const list = (applicants || []).map(normalizeEntry);
  const existing = findApplicant(list, incoming);
  const e = normalizeEmail(incoming && incoming.email);
  const p = normalizePhone(incoming && incoming.phone);

  if (!existing) {
    const fresh = normalizeEntry({
      ...incoming, email: e, phone: p,
      previousEmails: [], previousPhones: [],
      firstSubmittedAt: Date.now(), lastSubmittedAt: Date.now(), submissionCount: 1,
    });
    return { applicants: [...list, fresh], record: fresh, isUpdate: false };
  }

  // Only the value being REPLACED goes into history -- never the incoming
  // one, or a resubmission with an unchanged email would start flagging
  // itself as its own "previous" contact.
  const previousEmails = new Set(existing.previousEmails);
  if (existing.email && existing.email !== e) previousEmails.add(existing.email);
  previousEmails.delete(e);
  const previousPhones = new Set(existing.previousPhones);
  if (existing.phone && existing.phone !== p) previousPhones.add(existing.phone);
  previousPhones.delete(p);

  const updated = normalizeEntry({
    ...incoming, email: e, phone: p,
    previousEmails: Array.from(previousEmails),
    previousPhones: Array.from(previousPhones),
    firstSubmittedAt: existing.firstSubmittedAt,
    lastSubmittedAt: Date.now(),
    submissionCount: existing.submissionCount + 1,
  });
  const at = list.indexOf(existing); // `existing` is a reference into `list` itself
  const out = list.slice();
  out[at] = updated;
  return { applicants: out, record: updated, isUpdate: true };
}

module.exports = {
  loadApplicants, saveApplicants, findApplicant, upsertApplicant,
  normalizeEmail, normalizePhone,
};
