// The manually-maintained roster of mentorship clients allowed to book a
// check-in call. Omar adds an entry when someone signs on and removes it when
// they stop -- no CRM sync, no import.
//
// EMAIL IS THE RECORD KEY. It is required on every entry because it is the only
// channel confirmation/reschedule/cancellation notices go through, so a
// phone-only entry would silently receive none. Phone is optional and exists
// solely as a second way for a visitor to identify themselves, for clients who
// would rather not type an email on a phone keyboard.
const store = require('./_blob-store');

// Matches the address check in api/calendar-book.js, deliberately: an entry
// that would be accepted here but rejected there is a client who can be added
// and can never be emailed.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Digits only, so '+1 (555) 010-0100' and '5550100100' reach the same record.
// Country-code prefixes are NOT stripped -- '15550100100' and '5550100100' stay
// different numbers -- because guessing which leading digits are a country code
// is how one client's verification hands back another client's record.
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Adds `months` calendar months to an epoch-ms instant, in UTC (this is
// coarse "package length" math, not scheduling -- UTC sidesteps DST
// entirely, the same way the rest of this file treats dates as plain values).
function addMonths(ms, months) {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

// "YYYY-MM-DD" + a package length -> the epoch-ms instant it expires.
// durationMonths === 0 is the explicit "No package" sentinel (an admin-chosen
// ongoing/indefinite client) -- it ALWAYS expires at null, regardless of
// startDate, rather than at addMonths(start, 0) which would just equal start
// itself and read as "expired on day one."
function computeExpiresAt(startDate, durationMonths) {
  if (Number(durationMonths) === 0) return null;
  const parts = String(startDate || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  return addMonths(Date.UTC(y, m - 1, d), durationMonths);
}

// Extends from whichever is LATER: their current expiry, or right now. This
// handles both an early renewal (extends from the existing expiry, so paid
// time is never shortened) and a lapsed renewal (extends from today, so a
// client who renews after lapsing doesn't retroactively get back-dated).
//
// A durationMonths === 0 ("No package") client has nothing to renew -- a
// no-op, same reference, matching pauseClient/resumeClient's own no-op
// convention for an action that does not apply.
function renewClient(client, nowMs = Date.now()) {
  if (Number(client.durationMonths) === 0) return client;
  const base = Math.max(client.expiresAt || 0, nowMs);
  return { ...client, expiresAt: addMonths(base, client.durationMonths) };
}

// Blocks access immediately. A no-op if already paused (idempotent).
function pauseClient(client, nowMs = Date.now()) {
  if (client.pausedAt != null) return client;
  return { ...client, pausedAt: nowMs };
}

// Shifts expiresAt forward by exactly how long they were paused, so frozen
// time is never lost. A no-op if not currently paused (idempotent).
function resumeClient(client, nowMs = Date.now()) {
  if (client.pausedAt == null) return client;
  const pausedMs = nowMs - client.pausedAt;
  return {
    ...client,
    pausedAt: null,
    expiresAt: client.expiresAt == null ? null : client.expiresAt + pausedMs,
  };
}

// Whether this client currently has booking access. A null expiresAt means
// "no package configured yet" (e.g. a client added before this feature
// existed) -- NOT expired; it stays active until an admin sets a real
// package via Edit or Renew. This must NEVER be trusted from a request body
// -- it's only ever computed server-side from the stored record.
function isAccessActive(client, nowMs = Date.now()) {
  if (!client) return false;
  if (client.pausedAt != null) return false;
  if (client.expiresAt == null) return true;
  return nowMs < client.expiresAt;
}

// 0 is the explicit "No package" sentinel and must survive normalization
// exactly -- NOT get clamped up to the usual minimum of 1. Only a genuinely
// missing/invalid/negative value falls back to 1; a non-zero value still
// rounds and floors at 1 the same way it always has.
function normalizeDurationMonths(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n === 0) return 0;
  return Math.max(1, Math.round(n));
}

// Payments are manual tracking only -- never validated against a processor,
// never used to charge anyone. Defensive normalization only, matching the
// pattern already used for pausedAt/expiresAt: keep a well-formed entry,
// substitute a safe default for anything else, and NEVER drop the field
// entirely (that is the exact bug class this feature set has hit twice
// already -- a field normalizeEntry does not carry through vanishes on the
// next save).
function normalizePaymentsByMonth(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    const entry = raw[key];
    const amountOwed = Number.isFinite(Number(entry && entry.amountOwed))
      ? Math.max(0, Number(entry.amountOwed))
      : 0;
    out[key] = { amountOwed, paid: !!(entry && entry.paid === true) };
  }
  return out;
}

function normalizeEntry(c) {
  const startDate = String((c && c.startDate) || '').trim();
  const durationMonths = normalizeDurationMonths(c && c.durationMonths);
  const pausedAt = Number.isFinite(c && c.pausedAt) ? c.pausedAt : null;
  const rawExpiresAt = c && c.expiresAt;
  // An already-finite expiresAt is the normal case: an existing record's
  // expiresAt is already the tracked source of truth, mutated only by
  // renewClient/resumeClient/a fresh admin add. Only compute it fresh when
  // there is nothing stored yet. computeExpiresAt itself handles the
  // durationMonths === 0 ("No package") case by always returning null.
  const expiresAt = Number.isFinite(rawExpiresAt)
    ? rawExpiresAt
    : (startDate ? computeExpiresAt(startDate, durationMonths) : null);
  const paymentsByMonth = normalizePaymentsByMonth(c && c.paymentsByMonth);
  return {
    name: String((c && c.name) || '').trim(),
    email: normalizeEmail(c && c.email),
    phone: String((c && c.phone) || '').trim(),
    startDate,
    durationMonths,
    pausedAt,
    expiresAt,
    paymentsByMonth,
  };
}

// A missing blob is not an error: it is a deployment where no client has been
// added yet. An empty roster simply means nobody verifies.
async function loadClients() {
  const read = await store.readJson(store.CHECKIN_CLIENTS_BLOB);
  if (!read.ok) return { ok: false, reason: read.reason, clients: [] };
  const raw = (read.data && Array.isArray(read.data.clients)) ? read.data.clients : [];
  // Entries are normalized on READ as well as on write, so a hand-edited blob
  // (or one written before this normalization existed) still matches correctly.
  const clients = raw.map(normalizeEntry).filter(c => c.email);
  return { ok: true, clients, usedDefault: !read.data };
}

async function saveClients(clients) {
  return store.writeJson(store.CHECKIN_CLIENTS_BLOB, { clients });
}

const START_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateClient(entry) {
  const errors = [];
  const src = (entry && typeof entry === 'object') ? entry : {};
  const email = normalizeEmail(src.email);
  if (!email) errors.push('email is required -- it is the only channel booking notices go through');
  else if (!EMAIL_RE.test(email)) errors.push('email is not a valid address');

  const startDate = String(src.startDate || '').trim();
  if (!startDate || !START_DATE_RE.test(startDate)) {
    errors.push('startDate is required and must be YYYY-MM-DD');
  }

  // 0 is a valid, explicit value -- "No package" (an admin-chosen
  // ongoing/indefinite client) -- distinct from a missing/negative/NaN value,
  // which is still rejected.
  const durationMonths = Number(src.durationMonths);
  if (!Number.isFinite(durationMonths) || durationMonths < 0) {
    errors.push('durationMonths is required and must be zero ("No package") or a positive number');
  }

  return { ok: errors.length === 0, errors };
}

// Email first, in its own full pass: it is the record key, so an email hit is
// exact and must win outright over any phone coincidence further down the list.
function findClient(clients, { email, phone } = {}) {
  const list = clients || [];
  const e = normalizeEmail(email);
  if (e) {
    for (const c of list) {
      if (c && normalizeEmail(c.email) === e) return c;
    }
  }
  const p = normalizePhone(phone);
  // The `p &&` guard is load-bearing: without it, a visitor submitting a blank
  // phone would match the first client stored with no phone at all.
  if (p) {
    for (const c of list) {
      if (c && normalizePhone(c.phone) === p) return c;
    }
  }
  return null;
}

// Replaces IN PLACE when the email is already present -- adding an existing
// client is an edit, not a duplicate -- and keeps the original position so the
// admin table does not reshuffle under an edit. Pure: returns a new array.
function upsertClient(clients, entry) {
  const list = (clients || []).map(normalizeEntry);
  const next = normalizeEntry(entry);
  const at = list.findIndex(c => c.email === next.email);
  if (at === -1) return [...list, next];
  const out = list.slice();
  out[at] = next;
  return out;
}

function removeClient(clients, email) {
  const list = (clients || []).map(normalizeEntry);
  const target = normalizeEmail(email);
  if (!target) return { clients: list, removed: false };
  const out = list.filter(c => c.email !== target);
  return { clients: out, removed: out.length !== list.length };
}

module.exports = {
  loadClients, saveClients, findClient, upsertClient, removeClient,
  validateClient, normalizeEmail, normalizePhone,
  addMonths, computeExpiresAt, renewClient, pauseClient, resumeClient, isAccessActive,
};
