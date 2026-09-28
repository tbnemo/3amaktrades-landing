// Rate limiting for the admin passcode gate.
//
// The gate itself was already sound -- one shared passcode, constant-time
// comparison, fails closed when unset -- but it accepted unlimited attempts with
// no delay, which makes a short passcode brute-forceable at whatever rate the
// network allows. There is no in-memory option here: each request may land in a
// fresh serverless invocation, so a module-level counter resets constantly and
// protects nothing. The state has to be persisted, so it lives in the Blob store
// alongside everything else persistent in this system.
//
// DELIBERATELY SIMPLE, and specifically NOT per-IP. One passcode guards one
// person's calendar, so a single global counter is both enough and strictly
// harder to evade than per-IP buckets, which anyone can walk around by rotating
// source addresses (and `x-forwarded-for` is caller-supplied anyway). The cost is
// that a stranger making 5 bad guesses can keep Omar out for 15 minutes. That is
// a deliberate trade: a short, self-clearing nuisance in exchange for closing
// unlimited guessing. It buys the attacker nothing.
//
// IF OMAR IS EVER LOCKED OUT, in order of effort:
//   1. Wait. The lockout is 15 minutes and expires on its own -- `lockedUntilMs`
//      is an absolute timestamp that is only ever compared against now, so there
//      is no state that can wedge it permanently.
//   2. Delete login-attempts.json from the Vercel Blob dashboard. A missing blob
//      reads as "no failures", which is the clean slate.
//   3. Change ADMIN_PASSCODE and redeploy -- worth doing anyway if the attempts
//      were not his own typos.
const store = require('./_blob-store');

// 5 wrong guesses, then 15 minutes of nothing. That caps an attacker at 5 attempts
// per quarter hour (~480/day), which makes brute force hopeless against any real
// passcode, while leaving room for Omar to fat-finger his a few times.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const EMPTY = { failures: 0, lastFailureMs: 0, lockedUntilMs: 0 };

function coerce(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    failures: Math.max(0, num(src.failures)),
    lastFailureMs: Math.max(0, num(src.lastFailureMs)),
    lockedUntilMs: Math.max(0, num(src.lockedUntilMs)),
  };
}

function secondsUntil(untilMs, nowMs) {
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
}

// Called BEFORE the passcode is compared. Returns:
//   { allowed: true }
//   { allowed: false, locked: true, retryAfterSec }  -- too many recent failures
//   { allowed: false, unavailable: true, reason }    -- the store could not be read
//
// The unavailable case fails CLOSED. Letting logins through when the counter
// cannot be read would hand an attacker the old unlimited-guessing behaviour just
// by making the Blob store unreachable, which is the exact hole being closed.
// Closed here is also cheap: without the Blob store there is no availability
// template to administer, so a working login would lead to an empty admin page
// regardless. It is a transient state tied only to store health -- nothing
// persists, and it clears the moment reads work again.
async function check(nowMs = Date.now()) {
  const read = await store.readJson(store.LOGIN_ATTEMPTS_BLOB);
  if (!read.ok) return { allowed: false, unavailable: true, reason: read.reason };

  const state = coerce(read.data);
  if (state.lockedUntilMs > nowMs) {
    return { allowed: false, locked: true, retryAfterSec: secondsUntil(state.lockedUntilMs, nowMs) };
  }
  return { allowed: true };
}

// Called after a WRONG passcode. Returns { locked, retryAfterSec } describing the
// state the caller should now report.
//
// Concurrent failures can race and lose a count, because Vercel Blob has no
// compare-and-set. Worst case an attacker firing in parallel gets a few extra
// guesses inside one window -- which is nothing next to the unlimited guessing
// this replaces, and not worth a locking scheme to close.
async function recordFailure(nowMs = Date.now()) {
  const read = await store.readJson(store.LOGIN_ATTEMPTS_BLOB);
  // Unreadable: check() already refused this request, so there is nothing to
  // count. Report locked anyway rather than implying the attempt was free.
  if (!read.ok) return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) };

  const prev = coerce(read.data);
  // Failures decay: a wrong guess 15 minutes after the last one starts a fresh
  // run rather than stacking onto an old one forever. Without this, five typos
  // spread over a year would lock the account.
  const stale = prev.lastFailureMs === 0 || (nowMs - prev.lastFailureMs) >= LOCKOUT_MS;
  const failures = (stale ? 0 : prev.failures) + 1;

  const locked = failures >= MAX_FAILURES;
  const next = {
    // Reset the count when locking: the lockout timestamp is what gates the next
    // attempts, and leaving the count at its maximum would make the first guess
    // after the window expires re-lock immediately.
    failures: locked ? 0 : failures,
    lastFailureMs: nowMs,
    lockedUntilMs: locked ? nowMs + LOCKOUT_MS : 0,
  };
  await store.writeJson(store.LOGIN_ATTEMPTS_BLOB, next);

  return locked
    ? { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) }
    : { locked: false, remaining: MAX_FAILURES - failures };
}

// Called after a CORRECT passcode, so a successful login wipes the slate and a few
// typos on the way in never count against the next session.
async function clear() {
  return store.writeJson(store.LOGIN_ATTEMPTS_BLOB, { ...EMPTY });
}

module.exports = { check, recordFailure, clear, MAX_FAILURES, LOCKOUT_MS };
