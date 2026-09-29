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

function normalizeEntry(c) {
  return {
    name: String((c && c.name) || '').trim(),
    email: normalizeEmail(c && c.email),
    phone: String((c && c.phone) || '').trim(),
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

function validateClient(entry) {
  const errors = [];
  const src = (entry && typeof entry === 'object') ? entry : {};
  const email = normalizeEmail(src.email);
  if (!email) errors.push('email is required -- it is the only channel booking notices go through');
  else if (!EMAIL_RE.test(email)) errors.push('email is not a valid address');
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
};
