// Per-identifier rate limiting for /api/checkin-verify -- see Task 6's
// "Why rate limiting is per-identifier, not global" note for the full
// reasoning. Mirrors api/_login-rate-limit.js's constants and fail-closed
// discipline exactly, but keys state on a hash of the SUBMITTED IDENTIFIER
// (the email or phone being tested) rather than on one global counter, since
// this endpoint serves a whole client roster rather than one admin.
const crypto = require('crypto');
const store = require('./_blob-store');

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
// Entries this stale are dropped on write. A failure this old no longer
// counts toward a lock anyway (see the `stale` check below) -- pruning here
// just keeps a low-traffic blob from growing forever.
const PRUNE_AFTER_MS = LOCKOUT_MS;
// A hard ceiling on top of the age-based prune. Age alone caps growth only
// across time; within one lockout window, an attacker rotating through many
// different submitted identifiers can still grow the table arbitrarily,
// and every failed attempt does a full read-modify-write of the whole
// table -- a cost/latency amplification, not a bypass (per-identifier
// lockouts still work correctly either way). Oldest-by-lastFailureMs is
// dropped first once the table exceeds this.
const MAX_ENTRIES = 500;

function keyFor(identifier) {
  return crypto.createHash('sha256')
    .update(String(identifier || '').trim().toLowerCase())
    .digest('hex');
}

function coerceEntry(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    failures: Math.max(0, num(src.failures)),
    lastFailureMs: Math.max(0, num(src.lastFailureMs)),
    lockedUntilMs: Math.max(0, num(src.lockedUntilMs)),
  };
}

function pruneStale(table, nowMs) {
  const out = {};
  for (const [k, v] of Object.entries(table || {})) {
    const entry = coerceEntry(v);
    const stillLocked = entry.lockedUntilMs > nowMs;
    const recentFailure = (nowMs - entry.lastFailureMs) < PRUNE_AFTER_MS;
    if (stillLocked || recentFailure) out[k] = entry;
  }
  return capEntries(out);
}

// Drops the OLDEST entries (by lastFailureMs) once the table exceeds
// MAX_ENTRIES, after age-based pruning has already run. A still-locked entry
// can still be dropped here -- the cap is a hard ceiling, not a second
// lockout check -- but that only matters once traffic is already far outside
// anything this endpoint sees in practice.
function capEntries(table) {
  const keys = Object.keys(table);
  if (keys.length <= MAX_ENTRIES) return table;
  keys.sort((a, b) => table[a].lastFailureMs - table[b].lastFailureMs);
  const drop = keys.length - MAX_ENTRIES;
  const out = {};
  for (let i = drop; i < keys.length; i++) out[keys[i]] = table[keys[i]];
  return out;
}

function secondsUntil(untilMs, nowMs) {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
}

// Called BEFORE looking the submitted identifier up against the roster.
// Same three-shape contract as _login-rate-limit.js's check(). Fails CLOSED
// on an unreadable store for the same reason as the admin gate: letting
// lookups through when the counter can't be read hands back unlimited
// guessing just by making the Blob store flaky.
async function check(identifier, nowMs = Date.now()) {
  const read = await store.readJson(store.CHECKIN_VERIFY_ATTEMPTS_BLOB);
  if (!read.ok) return { allowed: false, unavailable: true, reason: read.reason };

  const table = (read.data && typeof read.data === 'object') ? read.data : {};
  const entry = coerceEntry(table[keyFor(identifier)]);
  if (entry.lockedUntilMs > nowMs) {
    return { allowed: false, locked: true, retryAfterSec: secondsUntil(entry.lockedUntilMs, nowMs) };
  }
  return { allowed: true };
}

// Called after a failed lookup (the identifier matched nobody on the roster).
async function recordFailure(identifier, nowMs = Date.now()) {
  const read = await store.readJson(store.CHECKIN_VERIFY_ATTEMPTS_BLOB);
  // Unreadable: check() already refused this request, so there is nothing new
  // to count. Report locked anyway rather than implying the attempt was free.
  if (!read.ok) return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };

  const table = pruneStale((read.data && typeof read.data === 'object') ? read.data : {}, nowMs);
  const key = keyFor(identifier);
  const prev = coerceEntry(table[key]);
  // Failures decay: one 15 minutes after the last starts a fresh run rather
  // than stacking onto an old one forever.
  const stale = prev.lastFailureMs === 0 || (nowMs - prev.lastFailureMs) >= LOCKOUT_MS;
  const failures = (stale ? 0 : prev.failures) + 1;
  const locked = failures >= MAX_FAILURES;

  table[key] = {
    failures: locked ? 0 : failures,
    lastFailureMs: nowMs,
    lockedUntilMs: locked ? nowMs + LOCKOUT_MS : 0,
  };
  await store.writeJson(store.CHECKIN_VERIFY_ATTEMPTS_BLOB, table);

  return locked
    ? { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) }
    : { locked: false, remaining: MAX_FAILURES - failures };
}

// Called after a SUCCESSFUL match, so a correct guess wipes that identifier's
// own history -- a client who mistyped their email a couple of times isn't
// left one bad guess away from a lockout for the rest of the window.
async function clear(identifier, nowMs = Date.now()) {
  const read = await store.readJson(store.CHECKIN_VERIFY_ATTEMPTS_BLOB);
  if (!read.ok) return; // best-effort; nothing to clear if the store can't be read
  const table = pruneStale((read.data && typeof read.data === 'object') ? read.data : {}, nowMs);
  delete table[keyFor(identifier)];
  await store.writeJson(store.CHECKIN_VERIFY_ATTEMPTS_BLOB, table);
}

module.exports = { check, recordFailure, clear, MAX_FAILURES, LOCKOUT_MS };
