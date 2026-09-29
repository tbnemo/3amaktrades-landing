# Mentorship Check-In Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Existing mentorship clients verify themselves on a standalone `/check-in` page and book a check-in call on Omar's calendar, on hours he configures independently of his new-applicant hours.

**Architecture:** A second booking audience layered on the existing `api/` serverless-function system. It adds two private Vercel Blob documents (`checkin-availability-template.json`, `checkin-clients.json`), a new short-lived HMAC verify-token primitive, a parallel set of `calendar-checkin-*` endpoints, dedicated Slack channels and email templates, and a standalone `check-in.html`. The only two things shared with the new-applicant system are the underlying Google Calendar — so the double-booking guard sees both audiences via the single shared `EVENT_MARKER` — and the once-daily reminders cron, which branches on a new `extendedProperties.private.audience` field to pick the right email sender.

**Tech Stack:** Node.js CommonJS serverless functions on Vercel, `@vercel/blob` (private access, `useCache:false`), Google Calendar REST v3 via `node-fetch`, Resend REST for email, Slack `chat.postMessage` via bot token, `node:test` + `node:assert/strict` for tests, zero-build static HTML/CSS/JS for the frontend.

**Spec:** `docs/superpowers/specs/2026-09-29-checkin-booking-design.md` (on the `internal-docs` branch; read with `git show internal-docs:docs/superpowers/specs/2026-09-29-checkin-booking-design.md`)

## Global Constraints

- **Do not modify `api/_booking-guard.js`.** `EVENT_MARKER` (`'3amak-booking'`) stays a single shared constant written by both audiences. The guard is audience-blind by design.
- **Do not modify the existing new-applicant flow**: `api/calendar-book.js`, `api/calendar-reschedule.js`, `api/calendar-cancel.js`, `api/_booking-slack.js`, `api/_booking-token.js`, `api/_load-booking.js`, `api/admin/availability.js`, `api/_availability.js`, `api/_load-template.js`. The only existing files this plan edits are `api/_blob-store.js`, `api/_slack.js`, `api/_email.js` (additive exports/constants only), `api/calendar-reminders.js` (one audience branch), and `admin.html`.
- **Do not touch `index.html` or `booking-widget.js`.** `/check-in` is fully independent and shares no code with the applicant booking widget.
- **Blob names, verbatim:** `checkin-availability-template.json` and `checkin-clients.json`. Both PRIVATE, both read with `useCache:false`, via the existing `api/_blob-store.js` helpers.
- **Slack channel constant names, verbatim:** `CHANNEL_CHECKIN_BOOKED` (`#8-checkin-booked`), `CHANNEL_CHECKIN_RESCHEDULED` (`#9-checkin-rescheduled`), `CHANNEL_CHECKIN_CANCELLED` (`#10-checkin-cancelled`). Backend-failure alerts reuse the existing `postSystemAlert` / `CHANNEL_SYSTEM_ALERTS` (`#7-system-alerts`) — no new alert channel.
- **Audience tag, verbatim:** `extendedProperties.private.audience === 'checkin'`. The applicant flow never sets this field; its absence means "applicant".
- **Verify token format, verbatim:** `<base64url signature>.<expiryEpochMs>`, signing `checkin-verify-v1|<normalizedEmail>|<expiryEpochMs>` with `sessionSecret()`. Expiry is checked (`Date.now() < expiryEpochMs`) **before** the HMAC comparison, and the HMAC comparison is constant-time. TTL is 10 minutes.
- **Email is the client record's key.** Every `checkin-clients.json` entry has a non-empty email; phone is optional. Email matching is case-insensitive; phone matching compares digits only.
- **Failed verification copy, verbatim:** "We couldn't verify that email or phone. If you're a current client, contact Omar directly." No hint about what did not match.
- **All check-in email copy is PLACEHOLDER**, marked with the same `// PLACEHOLDER COPY — collaborative design pass pending` comment convention already used in `api/_email.js`, and the same `PLACEHOLDER EMAIL — final copy pending.` footer line. Final copy is a separate collaborative pass.
- **No self-serve manage-booking UI.** The reschedule/cancel endpoints are built and tested; nothing links to them from `check-in.html` or from any email.
- **Visual identity:** `check-in.html` reuses the site's existing CSS custom property names by name — `--void`, `--band`, `--band-2`, `--gold`, `--gold-lo`, `--bone`, `--dim`, `--ink`, `--slab` — with the same values as `index.html`'s `:root`. Fonts: `Big Shoulders Display` (headings) + `Inter` (body). Zero border-radius throughout. Logical properties (`margin-block-end`, `border-inline-start`, `padding-inline`) everywhere, never physical ones.
- **Test style:** `node:test` + `node:assert/strict`, CommonJS `require`, local `makeRes()` / `withStubs()` / `spyStub()` / `emptyBlobClient()` / `envSetup()` helpers copied into each test file (this repo duplicates them per file rather than sharing a helper module — follow that). Run with `npm test` (which is `node --test`).
- **Node runtime:** CommonJS only (`require` / `module.exports`). No TypeScript, no ESM, no build step, no new npm dependencies.

---

## File Structure

**New API files**

| File | Responsibility |
| --- | --- |
| `api/_checkin-audience.js` | The `audience` tag constant + `isCheckinEvent(meta)` predicate. One constant, three readers. |
| `api/_checkin-token.js` | The short-lived verify-token primitive: mint, verify, and resolve-back-to-a-client. |
| `api/_checkin-clients.js` | Load/save `checkin-clients.json` plus the pure matching and mutation helpers. |
| `api/_load-checkin-template.js` | `loadCheckinTemplate()` — the blob-store + availability-defaults wrapper for the check-in hours. |
| `api/_checkin-slack.js` | The three check-in Slack posts. Mirrors `api/_booking-slack.js`. |
| `api/_checkin-email.js` | The four check-in email senders. Placeholder copy; reuses `send`/`formatWhen` from `api/_email.js`. |
| `api/checkin-verify.js` | `POST` — match a visitor against the client list, mint a verify token. |
| `api/calendar-checkin-availability.js` | `GET` — slots from the check-in template against the shared calendar. |
| `api/calendar-checkin-book.js` | `POST` — verify-token-gated insert, tagged `audience:'checkin'`. |
| `api/calendar-checkin-reschedule.js` | `POST` — move a check-in booking, with the audience-mismatch 403. |
| `api/calendar-checkin-cancel.js` | `POST` — cancel a check-in booking, with the audience-mismatch 403. |
| `api/admin/checkin-availability.js` | Passcode-gated GET/POST of the check-in hours template. |
| `api/admin/checkin-clients.js` | Passcode-gated GET/POST/DELETE of the client list. |

**New frontend file**

| File | Responsibility |
| --- | --- |
| `check-in.html` | Standalone verify → day/time picker → confirm page. No shared code with `booking-widget.js`. |

**Modified files (additive only, except the one reminders branch)**

| File | Change |
| --- | --- |
| `api/_blob-store.js` | `+ CHECKIN_AVAILABILITY_BLOB`, `+ CHECKIN_CLIENTS_BLOB` |
| `api/_slack.js` | `+ CHANNEL_CHECKIN_BOOKED`, `+ CHANNEL_CHECKIN_RESCHEDULED`, `+ CHANNEL_CHECKIN_CANCELLED` |
| `api/_email.js` | export the existing private `send` so `_checkin-email.js` can reuse the Resend transport |
| `api/calendar-reminders.js` | branch on `meta.audience` to pick applicant vs. check-in reminder sender + template zone |
| `admin.html` | tab bar, check-in hours form, client-list manager |

**New test files:** `test/checkin-constants.test.js`, `test/checkin-token.test.js`, `test/checkin-clients.test.js`, `test/admin-checkin-clients.test.js`, `test/admin-checkin-availability.test.js`, `test/checkin-verify.test.js`, `test/calendar-checkin-availability.test.js`, `test/checkin-slack.test.js`, `test/checkin-email.test.js`, `test/calendar-checkin-book.test.js`, `test/calendar-checkin-reschedule.test.js`, `test/calendar-checkin-cancel.test.js`, `test/admin-page-structure.test.js`, `test/checkin-page-structure.test.js`. Plus additions to `test/calendar-reminders.test.js`.

**Task ordering rationale (not arbitrary):** Tasks 1–3 are pure data/crypto primitives with no consumers, so they can be tested in complete isolation. Tasks 4–5 (admin CRUD + the template loader) come next because they are what *writes* the two blobs every later task reads. Tasks 8–9 (the Slack and email sender modules) deliberately land **before** the endpoints that call them (10–13): this repo's tests stub collaborators with `withStubs`, which monkey-patches an existing property on an already-required module — a stub for a module that does not exist yet cannot be installed, so every endpoint task after 9 has a runnable test suite the moment it is written. Task 13 (the reminders edit) lands after Task 9 for exactly that reason and after Task 10 so a real check-in-tagged event fixture is already an established shape. The two frontend tasks land last because each one exercises endpoints that must already exist.

---

### Task 1: Shared constants and exports

**Files:**
- Modify: `api/_blob-store.js:11-18` (constant block) and `api/_blob-store.js:61-64` (exports)
- Modify: `api/_slack.js:3-9` (channel constants) and `api/_slack.js:103-107` (exports)
- Modify: `api/_email.js:132-135` (exports)
- Create: `api/_checkin-audience.js`
- Test: `test/checkin-constants.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `store.CHECKIN_AVAILABILITY_BLOB === 'checkin-availability-template.json'` (string)
  - `store.CHECKIN_CLIENTS_BLOB === 'checkin-clients.json'` (string)
  - `slack.CHANNEL_CHECKIN_BOOKED`, `slack.CHANNEL_CHECKIN_RESCHEDULED`, `slack.CHANNEL_CHECKIN_CANCELLED` (Slack channel-ID strings)
  - `email.send({ to, subject, html }) -> Promise<{ok:true} | {ok:false, reason:string}>` (newly exported, implementation unchanged)
  - `require('./_checkin-audience')` → `{ AUDIENCE_CHECKIN: 'checkin', isCheckinEvent(meta) -> boolean }`

**PREREQUISITE — real Slack channel IDs — already done.** The three channels were created in the workspace before this plan was finalized:

- `#8-checkin-booked` → `C0C5FTTA081`
- `#9-checkin-rescheduled` → `C0C5FTTP1J5`
- `#10-checkin-cancelled` → `C0C5C1U12DC`

These are the exact values already substituted into Step 5 below. Do not re-create the channels or re-derive the IDs — just verify the values below match these before moving on, and if Slack notifications from this system are silently missing in testing, confirm the bot app has actually joined all three (a bot with `chat:write` but not `chat:write.public` must join a public channel before posting to it, same as the existing `#4`–`#7` channels required).

Paste the three printed IDs into the constants below. Do **not** invent IDs and do not leave a fake value in — the test in Step 1 fails on anything that is not Slack's channel-ID shape, and a wrong-but-well-shaped ID silently posts bookings into the wrong channel.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-constants.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const slack = require('../api/_slack');
const email = require('../api/_email');
const audience = require('../api/_checkin-audience');

test('the two check-in blob names are exported with their exact spec values', () => {
  assert.equal(store.CHECKIN_AVAILABILITY_BLOB, 'checkin-availability-template.json');
  assert.equal(store.CHECKIN_CLIENTS_BLOB, 'checkin-clients.json');
});

test('the check-in blob names do not collide with the existing three', () => {
  const all = [
    store.AVAILABILITY_BLOB, store.OAUTH_BLOB, store.LOGIN_ATTEMPTS_BLOB,
    store.CHECKIN_AVAILABILITY_BLOB, store.CHECKIN_CLIENTS_BLOB,
  ];
  assert.equal(new Set(all).size, all.length, `blob names must be unique: ${all.join(', ')}`);
});

// The IDs themselves are workspace data this test cannot know, but their SHAPE
// and their distinctness are exactly the two ways a copy-paste goes wrong: a
// placeholder left in, or the same channel pasted twice.
test('the three check-in Slack channel constants are real, distinct Slack channel IDs', () => {
  const ids = [
    slack.CHANNEL_CHECKIN_BOOKED,
    slack.CHANNEL_CHECKIN_RESCHEDULED,
    slack.CHANNEL_CHECKIN_CANCELLED,
  ];
  for (const id of ids) {
    assert.equal(typeof id, 'string');
    assert.match(id, /^C[A-Z0-9]{7,}$/, `"${id}" is not a Slack channel ID`);
  }
  assert.equal(new Set(ids).size, 3, 'the three check-in channels must be three different channels');
});

test('the check-in channels are distinct from all seven existing channels', () => {
  const existing = [
    slack.CHANNEL_NEW_APPLICATIONS, slack.CHANNEL_INCOMPLETE_LEADS, slack.CHANNEL_WARM_LEADS,
    slack.CHANNEL_NEW_CALLS_BOOKED, slack.CHANNEL_RESCHEDULED_CALLS,
    slack.CHANNEL_CANCELLED_CALLS, slack.CHANNEL_SYSTEM_ALERTS,
  ];
  const added = [
    slack.CHANNEL_CHECKIN_BOOKED, slack.CHANNEL_CHECKIN_RESCHEDULED, slack.CHANNEL_CHECKIN_CANCELLED,
  ];
  for (const id of added) {
    assert.ok(!existing.includes(id), `${id} is already one of the applicant/system channels`);
  }
});

test('_email exports send so the check-in senders can reuse the Resend transport', () => {
  assert.equal(typeof email.send, 'function');
  assert.equal(typeof email.formatWhen, 'function');
});

test('send with no RESEND_API_KEY resolves to {ok:false} rather than throwing', async () => {
  const had = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const r = await email.send({ to: 'a@b.co', subject: 's', html: '<p>h</p>' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /RESEND_API_KEY/);
  } finally {
    if (had !== undefined) process.env.RESEND_API_KEY = had;
  }
});

test('AUDIENCE_CHECKIN is the exact string "checkin"', () => {
  assert.equal(audience.AUDIENCE_CHECKIN, 'checkin');
});

test('isCheckinEvent is true only for meta tagged checkin', () => {
  assert.equal(audience.isCheckinEvent({ audience: 'checkin' }), true);
  assert.equal(audience.isCheckinEvent({ audience: 'applicant' }), false);
  // The applicant flow sets no audience field at all -- absence means applicant.
  assert.equal(audience.isCheckinEvent({ bookingSource: '3amak-booking' }), false);
  assert.equal(audience.isCheckinEvent({}), false);
  assert.equal(audience.isCheckinEvent(null), false);
  assert.equal(audience.isCheckinEvent(undefined), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-constants.test.js`
Expected: FAIL — `Cannot find module '../api/_checkin-audience'`.

- [ ] **Step 3: Create `api/_checkin-audience.js`**

```js
// The one field that distinguishes the two booking audiences sharing a single
// Google Calendar. Deliberately NOT part of _booking-guard.js: the guard is
// audience-blind on purpose (both audiences write the same EVENT_MARKER so a
// race between them still resolves), and giving it an audience opinion is
// exactly how the shared-marker property would get broken later.
//
// The applicant flow does not write this field at all -- its ABSENCE means
// "applicant" -- so calendar-book.js needs no change.
const AUDIENCE_CHECKIN = 'checkin';

// `meta` is always an event's `extendedProperties.private` object (or the empty
// object callers substitute when it is missing), never the event itself.
function isCheckinEvent(meta) {
  return !!meta && meta.audience === AUDIENCE_CHECKIN;
}

module.exports = { AUDIENCE_CHECKIN, isCheckinEvent };
```

- [ ] **Step 4: Add the two blob-name constants**

In `api/_blob-store.js`, immediately after the `LOGIN_ATTEMPTS_BLOB` declaration (line 18), add:

```js
// The check-in audience's two documents. Same shape discipline as the pair
// above -- both private, both read with useCache:false. The availability
// template is an INDEPENDENT document from AVAILABILITY_BLOB, not a section of
// it: check-in slot length, buffer, notice and timezone are set separately.
const CHECKIN_AVAILABILITY_BLOB = 'checkin-availability-template.json';
// { clients: [{ name, email, phone }] }. `email` is the record key and is always
// present; `phone` is optional.
const CHECKIN_CLIENTS_BLOB = 'checkin-clients.json';
```

Then replace the export block at the bottom of the file:

```js
module.exports = {
  readJson, writeJson, isConfigured, __setClientForTests,
  BLOB_NOT_CONFIGURED, AVAILABILITY_BLOB, OAUTH_BLOB, LOGIN_ATTEMPTS_BLOB,
  CHECKIN_AVAILABILITY_BLOB, CHECKIN_CLIENTS_BLOB,
};
```

- [ ] **Step 5: Add the three Slack channel constants**

In `api/_slack.js`, immediately after the `CHANNEL_SYSTEM_ALERTS` declaration (line 9), add — substituting the three real IDs read in the PREREQUISITE step above:

```js
// The check-in audience's own three channels, mirroring #4/#5/#6 exactly.
// Backend FAILURES from the check-in endpoints do NOT get a channel here --
// they reuse postSystemAlert/#7-system-alerts, which is infra-level and
// audience-agnostic; a duplicate would split one signal across two places.
const CHANNEL_CHECKIN_BOOKED = 'C0C5FTTA081';      // #8-checkin-booked
const CHANNEL_CHECKIN_RESCHEDULED = 'C0C5FTTP1J5'; // #9-checkin-rescheduled
const CHANNEL_CHECKIN_CANCELLED = 'C0C5C1U12DC';   // #10-checkin-cancelled
```

Then replace the export block at the bottom:

```js
module.exports = {
  postToSlack, getPermalink, isRepeatSubmission, postSystemAlert,
  CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS, CHANNEL_WARM_LEADS,
  CHANNEL_NEW_CALLS_BOOKED, CHANNEL_RESCHEDULED_CALLS, CHANNEL_CANCELLED_CALLS, CHANNEL_SYSTEM_ALERTS,
  CHANNEL_CHECKIN_BOOKED, CHANNEL_CHECKIN_RESCHEDULED, CHANNEL_CHECKIN_CANCELLED,
};
```

- [ ] **Step 6: Export `send` from `api/_email.js`**

Replace the export block at the bottom of `api/_email.js` (leave the `send` function body and everything else untouched):

```js
module.exports = {
  sendBookingConfirmation, sendRescheduleNotice, sendCancellationNotice,
  sendReminder, formatWhen, escapeHtml,
  // Exported for api/_checkin-email.js. The Resend POST and the timezone
  // formatting are transport-layer plumbing, not audience-facing copy, so the
  // check-in templates share them rather than growing a second HTTP path that
  // would later need the same retry/env handling fixed twice.
  send,
};
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/checkin-constants.test.js`
Expected: PASS (8 tests). If the Slack-ID test fails, the three IDs were not pasted in — go back to the PREREQUISITE.

- [ ] **Step 8: Run the whole suite to prove nothing regressed**

Run: `npm test`
Expected: every pre-existing test still passes. These were additive edits; a failure here means an export was dropped from `_blob-store.js`, `_slack.js`, or `_email.js`.

- [ ] **Step 9: Commit**

```bash
git add api/_blob-store.js api/_slack.js api/_email.js api/_checkin-audience.js test/checkin-constants.test.js
git commit -m "feat: add check-in blob names, Slack channels, audience tag, and shared send export"
```

---

### Task 2: The verify-token primitive

**Files:**
- Create: `api/_checkin-token.js`
- Test: `test/checkin-token.test.js`

**Interfaces:**
- Consumes: `sessionSecret()` from `api/_admin-auth.js`.
- Produces:
  - `makeVerifyToken(email, ttlMs = VERIFY_TOKEN_TTL_MS) -> string` — `'<base64url signature>.<expiryEpochMs>'`, or `''` when no signing secret is configured.
  - `verifyVerifyToken(email, token) -> boolean`
  - `resolveVerifyToken(clients, token) -> client | null` — `clients` is a plain array of `{ name, email, phone }`; returns the entry the token was issued for.
  - `normalizeEmail(email) -> string`
  - `VERIFY_TOKEN_TTL_MS === 600000`

**Why a new primitive rather than reusing `makeBookingToken`:** `api/_booking-token.js` is a stateless HMAC over `(eventId, email)` with **no expiry field at all** (deliberately — rotating the secret is its only revocation). At verify time there is no `eventId` yet, and a non-expiring credential minted from nothing but an email address is exactly what must not exist here. Leave `_booking-token.js` untouched.

**Why `resolveVerifyToken` exists:** the token carries a signature and an expiry, not the email — the email is *inside* the HMAC and is not recoverable from it. `calendar-checkin-book.js` must nonetheless learn which client it belongs to, without trusting an email from the request body. It does that by testing the token against each known client: the client list is a hand-maintained mentorship roster (tens of entries), so this is a few dozen HMACs. It has a second, deliberate benefit — a client removed from the list between verifying and booking no longer resolves, so a stale token cannot book.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-token.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ct = require('../api/_checkin-token');

function envSetup() {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
}

const EMAIL = 'client@example.com';

test('a freshly minted token verifies for the same email', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  assert.equal(ct.verifyVerifyToken(EMAIL, token), true);
});

test('the token is <base64url signature>.<expiryEpochMs> and the expiry is ~10 minutes out', () => {
  envSetup();
  const before = Date.now();
  const token = ct.makeVerifyToken(EMAIL);
  const dot = token.lastIndexOf('.');
  assert.ok(dot > 0, `expected one dot separator in "${token}"`);
  const sig = token.slice(0, dot);
  const expiryRaw = token.slice(dot + 1);
  assert.match(sig, /^[A-Za-z0-9_-]+$/, 'the signature half must be base64url');
  assert.match(expiryRaw, /^\d+$/, 'the expiry half must be a bare epoch-ms integer');
  const expiry = Number(expiryRaw);
  assert.ok(expiry >= before + ct.VERIFY_TOKEN_TTL_MS - 2000, `expiry ${expiry} is too early`);
  assert.ok(expiry <= Date.now() + ct.VERIFY_TOKEN_TTL_MS + 2000, `expiry ${expiry} is too late`);
  assert.equal(ct.VERIFY_TOKEN_TTL_MS, 10 * 60 * 1000);
});

test('a token minted for one email does not verify for another', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  assert.equal(ct.verifyVerifyToken('someone.else@example.com', token), false);
});

test('email comparison is case- and whitespace-insensitive', () => {
  envSetup();
  const token = ct.makeVerifyToken('  Client@Example.COM ');
  assert.equal(ct.verifyVerifyToken('client@example.com', token), true);
  assert.equal(ct.verifyVerifyToken('CLIENT@EXAMPLE.COM', token), true);
});

test('an expired token is rejected even though its signature is genuine', () => {
  envSetup();
  const expired = ct.makeVerifyToken(EMAIL, -1000); // minted already 1s past its expiry
  assert.equal(ct.verifyVerifyToken(EMAIL, expired), false);
  // Prove the signature itself was valid: the SAME signature with a future
  // expiry pasted on would be a forgery and must also fail, which is what
  // shows the expiry is inside the HMAC rather than beside it.
  const sig = expired.slice(0, expired.lastIndexOf('.'));
  const forged = `${sig}.${Date.now() + 600000}`;
  assert.equal(ct.verifyVerifyToken(EMAIL, forged), false,
    'moving the expiry must invalidate the signature -- the expiry is signed');
});

test('a token expiring one second from now is still accepted', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL, 1000);
  assert.equal(ct.verifyVerifyToken(EMAIL, token), true);
});

test('malformed tokens are rejected cleanly rather than throwing', () => {
  envSetup();
  const cases = [
    '', null, undefined, 42, {}, [],
    'no-dot-at-all',
    '.123456789',
    'abc.',
    'abc.notanumber',
    'abc.12.34',
    `${'x'.repeat(43)}.${Date.now() + 600000}`, // right shape, wrong signature
  ];
  for (const bad of cases) {
    assert.doesNotThrow(() => ct.verifyVerifyToken(EMAIL, bad), `threw on ${JSON.stringify(bad)}`);
    assert.equal(ct.verifyVerifyToken(EMAIL, bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

// timingSafeEqual THROWS on mismatched buffer lengths, so a wrong-LENGTH token
// must be length-checked out before it ever reaches the comparison.
test('a wrong-length signature is rejected without throwing', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  const dot = token.lastIndexOf('.');
  const short = `${token.slice(0, dot - 5)}.${token.slice(dot + 1)}`;
  assert.doesNotThrow(() => ct.verifyVerifyToken(EMAIL, short));
  assert.equal(ct.verifyVerifyToken(EMAIL, short), false);
});

test('with no signing secret at all, minting returns "" and verification always fails', () => {
  const hadSession = process.env.ADMIN_SESSION_SECRET;
  const hadGoogle = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    assert.equal(ct.makeVerifyToken(EMAIL), '');
    assert.equal(ct.verifyVerifyToken(EMAIL, 'anything.9999999999999'), false);
  } finally {
    if (hadSession !== undefined) process.env.ADMIN_SESSION_SECRET = hadSession;
    if (hadGoogle !== undefined) process.env.GOOGLE_CLIENT_SECRET = hadGoogle;
  }
});

test('rotating the signing secret invalidates outstanding tokens', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  process.env.ADMIN_SESSION_SECRET = 'a-different-secret';
  try {
    assert.equal(ct.verifyVerifyToken(EMAIL, token), false);
  } finally {
    process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  }
});

test('resolveVerifyToken returns the client record the token was issued for', () => {
  envSetup();
  const clients = [
    { name: 'Alice', email: 'alice@example.com', phone: '5550100100' },
    { name: 'Bob', email: 'bob@example.com', phone: '' },
    { name: 'Cara', email: 'cara@example.com', phone: '5550100300' },
  ];
  const token = ct.makeVerifyToken('bob@example.com');
  const found = ct.resolveVerifyToken(clients, token);
  assert.ok(found, 'expected a match');
  assert.equal(found.email, 'bob@example.com');
  assert.equal(found.name, 'Bob');
});

test('resolveVerifyToken returns null once the client is off the list', () => {
  envSetup();
  const token = ct.makeVerifyToken('bob@example.com');
  const without = [{ name: 'Alice', email: 'alice@example.com', phone: '' }];
  assert.equal(ct.resolveVerifyToken(without, token), null);
});

test('resolveVerifyToken tolerates empty, missing and malformed client lists', () => {
  envSetup();
  const token = ct.makeVerifyToken(EMAIL);
  assert.equal(ct.resolveVerifyToken([], token), null);
  assert.equal(ct.resolveVerifyToken(null, token), null);
  assert.equal(ct.resolveVerifyToken(undefined, token), null);
  assert.equal(ct.resolveVerifyToken([null, {}, { email: '' }], token), null);
  assert.equal(ct.resolveVerifyToken([{ email: EMAIL }], ''), null);
  assert.equal(ct.resolveVerifyToken([{ email: EMAIL }], null), null);
});

test('resolveVerifyToken refuses an expired token even for a listed client', () => {
  envSetup();
  const clients = [{ name: 'Alice', email: 'alice@example.com', phone: '' }];
  const expired = ct.makeVerifyToken('alice@example.com', -1000);
  assert.equal(ct.resolveVerifyToken(clients, expired), null);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(ct.normalizeEmail('  A@B.CO '), 'a@b.co');
  assert.equal(ct.normalizeEmail(null), '');
  assert.equal(ct.normalizeEmail(undefined), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-token.test.js`
Expected: FAIL — `Cannot find module '../api/_checkin-token'`.

- [ ] **Step 3: Write `api/_checkin-token.js`**

```js
// A short-lived proof that a visitor matched an entry in checkin-clients.json.
//
// NOT a reuse of _booking-token.js: that helper is a stateless HMAC over
// (eventId, email) with no expiry field at all -- deliberately, since rotating
// the secret is its only revocation path -- and at verify time there is no
// eventId yet. A non-expiring credential minted from nothing but an email
// address is precisely what must not exist on this path, so this primitive
// signs an expiry INTO the HMAC and carries it in the clear beside the
// signature so it can be checked before any comparison happens.
const crypto = require('crypto');
const { sessionSecret } = require('./_admin-auth');

// Long enough to complete one booking, short enough that a token leaked into a
// log, a screenshot or a shared URL is useless very soon after.
const VERIFY_TOKEN_TTL_MS = 10 * 60 * 1000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// `expiryPart` is always the STRING form that appears in the token, never a
// Number. Signing and verifying therefore operate on byte-identical input with
// no number round-trip in between, which removes a whole class of
// canonicalisation bug ('1700000000000' vs '1.7e12' vs '01700000000000').
function signature(email, expiryPart) {
  const secret = sessionSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret)
    .update(`checkin-verify-v1|${normalizeEmail(email)}|${expiryPart}`)
    .digest('base64url');
}

// ttlMs is overridable so tests can mint an already-expired token (pass a
// negative value) without stubbing the clock.
function makeVerifyToken(email, ttlMs = VERIFY_TOKEN_TTL_MS) {
  const expiryPart = String(Date.now() + ttlMs);
  const sig = signature(email, expiryPart);
  if (!sig) return '';
  return `${sig}.${expiryPart}`;
}

function verifyVerifyToken(email, token) {
  if (typeof token !== 'string' || !token) return false;

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const sig = token.slice(0, dot);
  const expiryPart = token.slice(dot + 1);

  // Bounded digits only: rejects '1e15', '+1700000000000', ' 1700000000000',
  // and anything long enough to be an overflow probe.
  if (!/^\d{1,15}$/.test(expiryPart)) return false;

  // Expiry FIRST, before any HMAC work: an expired token is rejected on a
  // cheap integer comparison and never reaches the comparison path at all.
  if (!(Date.now() < Number(expiryPart))) return false;

  const expected = signature(email, expiryPart);
  if (!expected) return false;

  // Constant-time, with the length check first -- timingSafeEqual THROWS on a
  // length mismatch, which would turn a wrong-length token into a 500 instead
  // of a clean rejection.
  const a = Buffer.from(sig, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Recovers WHICH client a token was issued for. The email is inside the HMAC,
// not readable from the token, so the only way back to it is to test the token
// against each known client. The list is a hand-maintained mentorship roster
// (tens of entries), so this is a few dozen HMACs -- and it has a second,
// deliberate benefit: a client removed from the list between verifying and
// booking no longer resolves, so a stale token cannot book.
function resolveVerifyToken(clients, token) {
  if (typeof token !== 'string' || !token) return null;
  for (const c of (clients || [])) {
    if (c && c.email && verifyVerifyToken(c.email, token)) return c;
  }
  return null;
}

module.exports = {
  makeVerifyToken, verifyVerifyToken, resolveVerifyToken,
  normalizeEmail, VERIFY_TOKEN_TTL_MS,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/checkin-token.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_checkin-token.js test/checkin-token.test.js
git commit -m "feat: add expiring check-in verify-token primitive"
```

---

### Task 3: The client list module

**Files:**
- Create: `api/_checkin-clients.js`
- Test: `test/checkin-clients.test.js`

**Interfaces:**
- Consumes: `store.readJson` / `store.writeJson` / `store.CHECKIN_CLIENTS_BLOB` / `store.BLOB_NOT_CONFIGURED` from Task 1.
- Produces:
  - `loadClients() -> Promise<{ ok:true, clients: Client[], usedDefault:boolean } | { ok:false, reason:string, clients:[] }>`
  - `saveClients(clients) -> Promise<{ok:true} | {ok:false, reason:string}>` — writes `{ clients }`
  - `findClient(clients, { email, phone }) -> Client | null`
  - `upsertClient(clients, entry) -> Client[]` (new array; replaces in place by email)
  - `removeClient(clients, email) -> { clients: Client[], removed: boolean }`
  - `validateClient(entry) -> { ok: boolean, errors: string[] }`
  - `normalizeEmail(email) -> string`, `normalizePhone(phone) -> string`
  - `Client` is exactly `{ name: string, email: string (lowercased, non-empty), phone: string }`

- [ ] **Step 1: Write the failing test**

Create `test/checkin-clients.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-clients.test.js`
Expected: FAIL — `Cannot find module '../api/_checkin-clients'`.

- [ ] **Step 3: Write `api/_checkin-clients.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/checkin-clients.test.js`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_checkin-clients.js test/checkin-clients.test.js
git commit -m "feat: add check-in client list storage and matching helpers"
```

---

### Task 4: Admin client-list CRUD

**Files:**
- Create: `api/admin/checkin-clients.js`
- Test: `test/admin-checkin-clients.test.js`

**Interfaces:**
- Consumes: `auth.requireAdmin(req, res) -> boolean` from `api/_admin-auth.js`; `loadClients`, `saveClients`, `upsertClient`, `removeClient`, `validateClient`, `normalizeEmail` from Task 3; `store.BLOB_NOT_CONFIGURED` from Task 1.
- Produces the HTTP contract `admin.html` (Task 14) consumes:
  - `GET  /api/admin/checkin-clients` → `200 { ok:true, clients: Client[], storageMissing:boolean }`
  - `POST /api/admin/checkin-clients` with body `{ client: { name, email, phone } }` → `200 { ok:true, clients }` · `400 { ok:false, errors:string[] }` · `503/502 { ok:false, errors:[...] }`
  - `DELETE /api/admin/checkin-clients` with body `{ email }` → `200 { ok:true, clients }` · `400 { ok:false, errors }` · `404 { ok:false, errors:['That email is not on the list.'] }`
  - any other method → `405`

- [ ] **Step 1: Write the failing test**

Create `test/admin-checkin-clients.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');
const store = require('../api/_blob-store');
const cc = require('../api/_checkin-clients');
const handler = require('../api/admin/checkin-clients.js');

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
  process.env.ADMIN_PASSCODE = 'test-passcode';
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

function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }
function authedReq(method, body) {
  return { method, headers: { cookie: cookieValueOf(auth.issueSessionCookie()) }, body, query: {} };
}

const ALICE = { name: 'Alice', email: 'alice@example.com', phone: '5550100100' };
const BOB = { name: 'Bob', email: 'bob@example.com', phone: '' };

test('GET with no session -> 401, and loadClients is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true, clients: [] });
  await withStubs([{ obj: cc, key: 'loadClients', value: spy }], async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0, 'the client list must not be read before auth passes');
  });
});

test('POST with no session -> 401, and saveClients is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: spyStub({ ok: true, clients: [] }) },
    { obj: cc, key: 'saveClients', value: spy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { client: ALICE }, query: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0);
  });
});

test('DELETE with no session -> 401, and saveClients is NOT called', async () => {
  envSetup();
  const spy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: spyStub({ ok: true, clients: [ALICE] }) },
    { obj: cc, key: 'saveClients', value: spy },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'DELETE', headers: {}, body: { email: ALICE.email }, query: {} }, res);
    assert.equal(res._status, 401);
    assert.equal(spy.calls.length, 0);
  });
});

test('authenticated GET -> 200 with the client list', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.deepEqual(res._json.clients, [ALICE, BOB]);
    assert.equal(res._json.storageMissing, false);
  });
});

test('authenticated GET with BLOB_NOT_CONFIGURED -> 200, empty list, storageMissing:true', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    // Mirrors admin/availability.js: the manager must still render so Omar can
    // see what is missing rather than the panel failing opaquely.
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.deepEqual(res._json.clients, []);
    assert.equal(res._json.storageMissing, true);
  });
});

test('authenticated POST with a valid client -> 200 and saveClients called once with the appended entry', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: { name: 'Bob', email: 'BOB@Example.com', phone: ' 555-0199 ' } }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(saveSpy.calls.length, 1);
    const written = saveSpy.calls[0][0];
    assert.equal(written.length, 2);
    assert.deepEqual(written[1], { name: 'Bob', email: 'bob@example.com', phone: '555-0199' });
    // The response echoes the saved list so the page never needs a second GET.
    assert.deepEqual(res._json.clients, written);
  });
});

test('authenticated POST with an email already on the list REPLACES it instead of duplicating', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: { name: 'Alice Renamed', email: 'alice@example.com', phone: '5559999999' } }), res);
    assert.equal(res._status, 200);
    const written = saveSpy.calls[0][0];
    assert.equal(written.length, 2, 'the list must not grow');
    assert.equal(written[0].name, 'Alice Renamed');
    assert.equal(written[0].phone, '5559999999');
    assert.equal(written[1].email, 'bob@example.com');
  });
});

test('authenticated POST with no valid email -> 400 mentioning email, saveClients NOT called', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    for (const client of [
      { name: 'Ghost', phone: '5550100' },
      { name: 'Ghost', email: '', phone: '5550100' },
      { name: 'Ghost', email: '   ', phone: '5550100' },
      { name: 'Ghost', email: 'not-an-email', phone: '' },
    ]) {
      const res = makeRes();
      await handler(authedReq('POST', { client }), res);
      assert.equal(res._status, 400, `${JSON.stringify(client)} should be 400`);
      assert.equal(res._json.ok, false);
      assert.ok(Array.isArray(res._json.errors));
      assert.ok(res._json.errors.some(e => /email/i.test(e)),
        `expected an error mentioning email, got ${JSON.stringify(res._json.errors)}`);
    }
    assert.equal(saveSpy.calls.length, 0, 'a rejected entry must never reach the store');
  });
});

test('authenticated POST with a missing or non-object client -> 400', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: spyStub({ ok: true }) },
  ], async () => {
    for (const body of [{}, { client: null }, { client: 'alice' }]) {
      const res = makeRes();
      await handler(authedReq('POST', body), res);
      assert.equal(res._status, 400, `${JSON.stringify(body)} should be 400`);
    }
  });
});

test('authenticated POST with no phone is accepted -- phone is optional', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: { name: 'Solo', email: 'solo@example.com' } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(saveSpy.calls[0][0], [{ name: 'Solo', email: 'solo@example.com', phone: '' }]);
  });
});

test('authenticated POST when the write fails with BLOB_NOT_CONFIGURED -> 503 with a readable message', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: ALICE }), res);
    assert.equal(res._status, 503);
    assert.equal(res._json.ok, false);
    assert.ok(res._json.errors.some(e => /Blob store/i.test(e)));
  });
});

test('authenticated POST when the write fails for another reason -> 502 carrying that reason', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [], usedDefault: true }) },
    { obj: cc, key: 'saveClients', value: async () => ({ ok: false, reason: 'blob put 500' }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: ALICE }), res);
    assert.equal(res._status, 502);
    assert.ok(res._json.errors.includes('blob put 500'));
  });
});

test('authenticated POST when the READ fails with BLOB_NOT_CONFIGURED -> 503 and no write', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { client: ALICE }), res);
    assert.equal(res._status, 503);
    // Writing a list built on a failed read would replace the whole roster with
    // this one entry -- a silent wipe of every other client.
    assert.equal(saveSpy.calls.length, 0, 'never write a list built on a failed read');
  });
});

test('authenticated DELETE removes the entry and returns the remaining list', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('DELETE', { email: 'ALICE@EXAMPLE.COM' }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(saveSpy.calls.length, 1);
    assert.deepEqual(saveSpy.calls[0][0], [BOB]);
    assert.deepEqual(res._json.clients, [BOB]);
  });
});

test('authenticated DELETE of an email not on the list -> 404 and no write', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('DELETE', { email: 'nobody@example.com' }), res);
    assert.equal(res._status, 404);
    assert.equal(res._json.ok, false);
    assert.equal(saveSpy.calls.length, 0, 'a no-op delete must not rewrite the document');
  });
});

test('authenticated DELETE with no email -> 400 and no write', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    for (const body of [{}, { email: '' }, { email: '   ' }, null]) {
      const res = makeRes();
      await handler(authedReq('DELETE', body), res);
      assert.equal(res._status, 400, `${JSON.stringify(body)} should be 400`);
    }
    assert.equal(saveSpy.calls.length, 0);
  });
});

// Some proxies and fetch implementations drop a body on DELETE, which would
// turn every remove into a 400. The query fallback is what keeps the admin
// page's remove button working regardless.
test('authenticated DELETE reads the email from the query string when the body is absent', async () => {
  envSetup();
  const saveSpy = spyStub({ ok: true });
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE, BOB], usedDefault: false }) },
    { obj: cc, key: 'saveClients', value: saveSpy },
  ], async () => {
    const res = makeRes();
    await handler({
      method: 'DELETE',
      headers: { cookie: cookieValueOf(auth.issueSessionCookie()) },
      body: undefined,
      query: { email: 'bob@example.com' },
    }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(saveSpy.calls[0][0], [ALICE]);
  });
});

test('an unsupported method (PUT) while authenticated -> 405', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('PUT', {}), res);
  assert.equal(res._status, 405);
});

test('every response carries Cache-Control: no-store', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ALICE], usedDefault: false }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('GET'), res);
    assert.equal(res._headers['Cache-Control'], 'no-store');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/admin-checkin-clients.test.js`
Expected: FAIL — `Cannot find module '../api/admin/checkin-clients.js'`.

- [ ] **Step 3: Write `api/admin/checkin-clients.js`**

```js
// List, add/replace, and remove entries in checkin-clients.json. Passcode-gated
// by the same session cookie as every other admin endpoint -- this list is the
// entire access control on who may book a check-in call.
const auth = require('../_admin-auth');
const store = require('../_blob-store');
const cc = require('../_checkin-clients');

const STORE_MISSING_MESSAGE = 'The Vercel Blob store does not exist yet, so the client list '
  + 'cannot be saved. Create it in the Vercel dashboard (Storage -> Create Database -> Blob) '
  + 'and redeploy.';

function readFailure(res, reason) {
  const missing = reason === store.BLOB_NOT_CONFIGURED;
  return res.status(missing ? 503 : 502).json({
    ok: false, errors: [missing ? STORE_MISSING_MESSAGE : reason],
  });
}

function writeFailure(res, reason) {
  const missing = reason === store.BLOB_NOT_CONFIGURED;
  return res.status(missing ? 503 : 502).json({
    ok: false, errors: [missing ? STORE_MISSING_MESSAGE : reason],
  });
}

module.exports = async function handler(req, res) {
  // The roster changes the moment Omar edits it, and a cached 401 or a cached
  // stale list is worse than no caching at all.
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const read = await cc.loadClients();
    if (!read.ok && read.reason === store.BLOB_NOT_CONFIGURED) {
      // Mirrors admin/availability.js: still a 200, so the manager renders and
      // says what is missing rather than failing opaquely.
      return res.status(200).json({ ok: true, clients: [], storageMissing: true });
    }
    if (!read.ok) return res.status(502).json({ ok: false, errors: [read.reason] });
    return res.status(200).json({ ok: true, clients: read.clients, storageMissing: false });
  }

  if (req.method === 'POST') {
    const incoming = (req.body && req.body.client) || null;
    // Validate BEFORE reading the list: a bad entry must not even cost a read.
    const check = cc.validateClient(incoming);
    if (!check.ok) return res.status(400).json({ ok: false, errors: check.errors });

    const read = await cc.loadClients();
    // A write built on a failed read would replace the whole roster with this
    // one entry -- a silent wipe of every other client.
    if (!read.ok) return readFailure(res, read.reason);

    const clients = cc.upsertClient(read.clients, incoming);
    const written = await cc.saveClients(clients);
    if (!written.ok) return writeFailure(res, written.reason);
    return res.status(200).json({ ok: true, clients });
  }

  if (req.method === 'DELETE') {
    // Body first, query second: some proxies and fetch implementations drop a
    // body on DELETE, which would otherwise 400 every remove.
    const email = (req.body && req.body.email) || (req.query && req.query.email) || '';
    if (!cc.normalizeEmail(email)) {
      return res.status(400).json({ ok: false, errors: ['email is required'] });
    }

    const read = await cc.loadClients();
    if (!read.ok) return readFailure(res, read.reason);

    const { clients, removed } = cc.removeClient(read.clients, email);
    if (!removed) {
      // Not an idempotent 200 on purpose: the admin page removes by clicking a
      // row it just rendered, so "not on the list" means the list changed
      // underneath and the operator should see that, not a false success.
      return res.status(404).json({ ok: false, errors: ['That email is not on the list.'] });
    }
    const written = await cc.saveClients(clients);
    if (!written.ok) return writeFailure(res, written.reason);
    return res.status(200).json({ ok: true, clients });
  }

  return res.status(405).end();
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/admin-checkin-clients.test.js`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add api/admin/checkin-clients.js test/admin-checkin-clients.test.js
git commit -m "feat: add passcode-gated check-in client list CRUD endpoint"
```

---

### Task 5: Check-in hours template loader and admin endpoint

**Files:**
- Create: `api/_load-checkin-template.js`
- Create: `api/admin/checkin-availability.js`
- Test: `test/admin-checkin-availability.test.js`

**Interfaces:**
- Consumes: `store.readJson` / `store.writeJson` / `store.CHECKIN_AVAILABILITY_BLOB` / `store.BLOB_NOT_CONFIGURED` (Task 1); `av.DEFAULT_TEMPLATE`, `av.normalizeTemplate`, `av.validateTemplate` from `api/_availability.js` (unchanged); `auth.requireAdmin`.
- Produces:
  - `loadCheckinTemplate() -> Promise<{ ok:true, template: Template, usedDefault:boolean } | { ok:false, reason:string, template: Template }>` — the same return shape as the existing `loadTemplate()`, so a reader can be pointed at either.
  - `Template` is exactly what `api/_availability.js` produces: `{ timezone, days: { mon..sun: { enabled, start, end } }, slotMinutes, bufferMinutes, minNoticeHours }`.
  - `GET /api/admin/checkin-availability` → `200 { ok:true, template, usedDefault, storageMissing }`
  - `POST /api/admin/checkin-availability` with body `{ template }` → `200 { ok:true, template }` · `400 { ok:false, errors }` · `503/502 { ok:false, errors }`

**Note on first-run defaults:** an unwritten check-in template falls back to the same `av.DEFAULT_TEMPLATE` as the applicant one. That is not a coupling — the two are separate documents whose settings diverge the moment either is saved — it is just what keeps `/check-in` functional on day one, exactly as `loadTemplate()` does for the applicant widget.

- [ ] **Step 1: Write the failing test**

Create `test/admin-checkin-availability.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');
const av = require('../api/_availability');
const store = require('../api/_blob-store');
const { loadCheckinTemplate } = require('../api/_load-checkin-template');
const handler = require('../api/admin/checkin-availability.js');

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
  process.env.ADMIN_PASSCODE = 'test-passcode';
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

function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }
function authedReq(method, body) {
  return { method, headers: { cookie: cookieValueOf(auth.issueSessionCookie()) }, body };
}

function cloneTemplate() {
  return JSON.parse(JSON.stringify(av.DEFAULT_TEMPLATE));
}

test('loadCheckinTemplate reads CHECKIN_AVAILABILITY_BLOB, never the applicant blob', async () => {
  envSetup();
  const readSpy = spyStub({ ok: true, data: null });
  await withStubs([{ obj: store, key: 'readJson', value: readSpy }], async () => {
    await loadCheckinTemplate();
    assert.equal(readSpy.calls.length, 1);
    assert.equal(readSpy.calls[0][0], 'checkin-availability-template.json');
    assert.equal(readSpy.calls[0][0], store.CHECKIN_AVAILABILITY_BLOB);
    assert.notEqual(readSpy.calls[0][0], store.AVAILABILITY_BLOB);
  });
});

test('loadCheckinTemplate falls back to the normalized default when never written', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: null }) },
  ], async () => {
    const r = await loadCheckinTemplate();
    assert.equal(r.ok, true);
    assert.equal(r.usedDefault, true);
    assert.deepEqual(r.template, av.normalizeTemplate(av.DEFAULT_TEMPLATE));
  });
});

test('loadCheckinTemplate normalizes a stored document and reports usedDefault:false', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: true, data: {
      timezone: 'Europe/Istanbul',
      days: { mon: { enabled: true, start: '9:00', end: '12:00' } },
      slotMinutes: 20, bufferMinutes: 5, minNoticeHours: 24,
    } }) },
  ], async () => {
    const r = await loadCheckinTemplate();
    assert.equal(r.ok, true);
    assert.equal(r.usedDefault, false);
    assert.equal(r.template.timezone, 'Europe/Istanbul');
    assert.equal(r.template.slotMinutes, 20);
    assert.equal(r.template.bufferMinutes, 5);
    assert.equal(r.template.days.mon.start, '09:00', 'normalizeTemplate zero-pads');
    // Days absent from the document come back disabled -- availability fails closed.
    assert.equal(r.template.days.tue.enabled, false);
    assert.deepEqual(Object.keys(r.template.days).sort(),
      ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
  });
});

test('loadCheckinTemplate still returns a usable default template on a read failure', async () => {
  await withStubs([
    { obj: store, key: 'readJson', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, data: null }) },
  ], async () => {
    const r = await loadCheckinTemplate();
    assert.equal(r.ok, false);
    assert.equal(r.reason, store.BLOB_NOT_CONFIGURED);
    assert.deepEqual(r.template, av.normalizeTemplate(av.DEFAULT_TEMPLATE));
  });
});

test('GET with no session -> 401', async () => {
  envSetup();
  const res = makeRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res._status, 401);
});

test('POST with no session -> 401, and writeJson is NOT called', async () => {
  envSetup();
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { template: cloneTemplate() } }, res);
    assert.equal(res._status, 401);
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated GET -> 200 with all seven day keys', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('GET'), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.deepEqual(Object.keys(res._json.template.days).sort(),
    ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
});

test('authenticated GET with BLOB_NOT_CONFIGURED -> 200 with storageMissing:true (not a 5xx)', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  store.__setClientForTests(emptyBlobClient());

  const res = makeRes();
  await handler(authedReq('GET'), res);
  assert.equal(res._status, 200);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.storageMissing, true);

  process.env.BLOB_READ_WRITE_TOKEN = 'test-token'; // restore for later tests
});

test('authenticated POST writes to CHECKIN_AVAILABILITY_BLOB, never the applicant blob', async () => {
  envSetup();
  const writeSpy = spyStub({ ok: true });
  await withStubs([{ obj: store, key: 'writeJson', value: writeSpy }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: cloneTemplate() }), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(writeSpy.calls.length, 1);
    assert.equal(writeSpy.calls[0][0], store.CHECKIN_AVAILABILITY_BLOB);
    assert.notEqual(writeSpy.calls[0][0], store.AVAILABILITY_BLOB,
      'saving check-in hours must never overwrite the new-applicant hours');
  });
});

test('authenticated POST saves an independent timezone and slot length', async () => {
  envSetup();
  const writeSpy = spyStub({ ok: true });
  const tpl = cloneTemplate();
  tpl.timezone = 'Europe/Istanbul';
  tpl.slotMinutes = 15;
  tpl.bufferMinutes = 0;
  tpl.minNoticeHours = 24;
  await withStubs([{ obj: store, key: 'writeJson', value: writeSpy }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: tpl }), res);
    assert.equal(res._status, 200);
    const saved = writeSpy.calls[0][1];
    assert.equal(saved.timezone, 'Europe/Istanbul');
    assert.equal(saved.slotMinutes, 15);
    assert.equal(saved.bufferMinutes, 0);
    assert.equal(res._json.template.slotMinutes, 15);
  });
});

test('authenticated POST with mon.end before mon.start -> 400 mentioning mon, writeJson NOT called', async () => {
  envSetup();
  const bad = cloneTemplate();
  bad.days.mon.enabled = true;
  bad.days.mon.start = '17:00';
  bad.days.mon.end = '09:00';
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: bad }), res);
    assert.equal(res._status, 400);
    assert.equal(res._json.ok, false);
    assert.ok(res._json.errors.some(e => e.includes('mon')));
    // Validate BEFORE normalize: normalizing alone would silently rewrite the
    // mistake into hours Omar never chose.
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated POST with an invalid timezone or slot length -> 400', async () => {
  envSetup();
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const badTz = cloneTemplate(); badTz.timezone = 'Not/AZone';
    const badSlot = cloneTemplate(); badSlot.slotMinutes = 7;
    for (const tpl of [badTz, badSlot]) {
      const res = makeRes();
      await handler(authedReq('POST', { template: tpl }), res);
      assert.equal(res._status, 400);
    }
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated POST with no template at all -> 400', async () => {
  envSetup();
  await withStubs([{ obj: store, key: 'writeJson', value: spyStub({ ok: true }) }], async () => {
    const res = makeRes();
    await handler(authedReq('POST', {}), res);
    assert.equal(res._status, 400);
    assert.equal(store.writeJson.calls.length, 0);
  });
});

test('authenticated POST when the write fails with BLOB_NOT_CONFIGURED -> 503', async () => {
  envSetup();
  await withStubs([
    { obj: store, key: 'writeJson', value: spyStub({ ok: false, reason: store.BLOB_NOT_CONFIGURED }) },
  ], async () => {
    const res = makeRes();
    await handler(authedReq('POST', { template: cloneTemplate() }), res);
    assert.equal(res._status, 503);
    assert.equal(res._json.ok, false);
  });
});

test('an unsupported method (DELETE) while authenticated -> 405', async () => {
  envSetup();
  const res = makeRes();
  await handler(authedReq('DELETE'), res);
  assert.equal(res._status, 405);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/admin-checkin-availability.test.js`
Expected: FAIL — `Cannot find module '../api/_load-checkin-template'`.

- [ ] **Step 3: Write `api/_load-checkin-template.js`**

```js
// The check-in audience's hours. Structurally identical to _load-template.js
// but bound to a DIFFERENT blob: check-in slot length, buffer, minimum notice
// and timezone are set independently of the new-applicant hours, because
// check-ins are very likely shorter and more frequent and there is no reason to
// couple the two.
//
// Returns the same {ok, template, usedDefault|reason} shape as loadTemplate(),
// so any reader can be pointed at either loader without reshaping its result.
const store = require('./_blob-store');
const av = require('./_availability');

// A missing blob is not an error: it is a deployment that has never saved
// check-in hours. Serving the normalized default keeps /check-in functional on
// day one, exactly as loadTemplate() does for the applicant widget. That the
// two share a FIRST-RUN default is incidental -- they diverge the moment either
// is saved.
async function loadCheckinTemplate() {
  const read = await store.readJson(store.CHECKIN_AVAILABILITY_BLOB);
  if (!read.ok) {
    return {
      ok: false, reason: read.reason,
      template: av.normalizeTemplate(av.DEFAULT_TEMPLATE),
    };
  }
  return {
    ok: true,
    template: av.normalizeTemplate(read.data || av.DEFAULT_TEMPLATE),
    usedDefault: !read.data,
  };
}

module.exports = { loadCheckinTemplate };
```

- [ ] **Step 4: Write `api/admin/checkin-availability.js`**

```js
// Read/write the CHECK-IN weekly template. Passcode-gated behind the same
// session cookie as every other admin endpoint -- one login covers both tabs of
// admin.html. Deliberately a separate handler from admin/availability.js rather
// than one endpoint taking an audience parameter: an off-by-one in that
// parameter would silently overwrite the wrong audience's hours.
const auth = require('../_admin-auth');
const av = require('../_availability');
const store = require('../_blob-store');
const { loadCheckinTemplate } = require('../_load-checkin-template');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const tplRes = await loadCheckinTemplate();
    if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
      // Still return the defaults so the form renders and Omar can see the
      // shape of what he will be editing once storage exists.
      return res.status(200).json({ ok: true, template: tplRes.template,
        usedDefault: true, storageMissing: true });
    }
    return res.status(200).json({ ok: true, template: tplRes.template,
      usedDefault: !!tplRes.usedDefault, storageMissing: false });
  }

  if (req.method === 'POST') {
    const incoming = (req.body && req.body.template) || null;
    // Validate BEFORE normalizing: normalizing alone would silently rewrite a
    // mistake (an end time before its start) into something Omar did not choose.
    const check = av.validateTemplate(incoming);
    if (!check.ok) {
      return res.status(400).json({ ok: false, errors: check.errors });
    }
    const template = av.normalizeTemplate(incoming);
    const written = await store.writeJson(store.CHECKIN_AVAILABILITY_BLOB, template);
    if (!written.ok) {
      const missing = written.reason === store.BLOB_NOT_CONFIGURED;
      return res.status(missing ? 503 : 502).json({
        ok: false,
        errors: [missing
          ? 'The Vercel Blob store does not exist yet, so check-in hours cannot be saved. Create it in the Vercel dashboard (Storage -> Create Database -> Blob) and redeploy.'
          : written.reason],
      });
    }
    return res.status(200).json({ ok: true, template });
  }

  return res.status(405).end();
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/admin-checkin-availability.test.js`
Expected: PASS (16 tests).

- [ ] **Step 6: Commit**

```bash
git add api/_load-checkin-template.js api/admin/checkin-availability.js test/admin-checkin-availability.test.js
git commit -m "feat: add check-in hours template loader and admin endpoint"
```

---

### Task 6: The verification endpoint

**Files:**
- Create: `api/checkin-verify.js`
- Test: `test/checkin-verify.test.js`

**Interfaces:**
- Consumes: `loadClients`, `findClient`, `normalizeEmail`, `normalizePhone` from Task 3; `makeVerifyToken` from Task 2; `store.BLOB_NOT_CONFIGURED` from Task 1.
- Produces the HTTP contract `check-in.html` (Task 15) consumes:
  - `POST /api/checkin-verify` with body `{ email?, phone? }`
  - match → `200 { ok:true, name: string, verifyToken: string }`
  - no match → `200 { ok:false }` — **exactly that, nothing more**
  - neither field supplied → `400 { ok:false, error:'BAD_REQUEST', message:'Enter an email or a phone number.' }`
  - storage missing → `503 { ok:false, error:'BLOB_NOT_CONFIGURED', message:'Check-in booking is not set up yet.' }`
  - non-POST → `405`

**On the response shape:** a match and a non-match both return HTTP **200**. Using 401/403 for a non-match would make the status line itself an oracle — the spec's "no distinction shown between 'not on the list' and any other failure" has to hold at the transport level too, not just in the copy. The *client* renders the generic failure message; the server never sends a reason.

**The response deliberately does not include the matched email.** The page never needs it: `calendar-checkin-book.js` recovers the client from the token itself (`resolveVerifyToken`). Keeping the email server-side means a visitor who verified by phone never receives another person's — or even their own — address back over the wire.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-verify.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const cc = require('../api/_checkin-clients');
const ct = require('../api/_checkin-token');
const handler = require('../api/checkin-verify');

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

const ROSTER = [
  { name: 'Alice Client', email: 'alice@example.com', phone: '+1 (555) 010-0100' },
  { name: 'Bob Client', email: 'bob@example.com', phone: '' },
];

function withRoster(clients, fn) {
  return withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients, usedDefault: false }) },
  ], fn);
}

test('a listed email verifies: 200 {ok:true, name, verifyToken} and the token verifies for that email', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.name, 'Alice Client');
    assert.equal(typeof res._json.verifyToken, 'string');
    assert.ok(res._json.verifyToken.length > 0);
    assert.equal(ct.verifyVerifyToken('alice@example.com', res._json.verifyToken), true);
  });
});

test('a listed email verifies regardless of case and surrounding whitespace', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: '  ALICE@Example.COM  ' } }, res);
    assert.equal(res._json.ok, true);
    assert.equal(ct.verifyVerifyToken('alice@example.com', res._json.verifyToken), true);
  });
});

// The whole reason phone is a second channel: the token must still be scoped to
// the record's EMAIL, because email is the only way the confirmation reaches them.
test('a listed phone verifies, and the token is scoped to the record EMAIL not the phone', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { phone: '15550100100' } }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.name, 'Alice Client');
    assert.equal(ct.verifyVerifyToken('alice@example.com', res._json.verifyToken), true,
      'the token must be signed for the matched record email, not the submitted phone');
  });
});

test('a phone typed with formatting still verifies (digits-only comparison)', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (const phone of ['+1 (555) 010-0100', '1-555-010-0100', '1.555.010.0100']) {
      const res = makeRes();
      await handler({ method: 'POST', body: { phone } }, res);
      assert.equal(res._json.ok, true, `${phone} should verify`);
    }
  });
});

test('the response NEVER carries the matched email', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { phone: '15550100100' } }, res);
    assert.deepEqual(Object.keys(res._json).sort(), ['name', 'ok', 'verifyToken'],
      'only ok, name and verifyToken may be returned');
    assert.equal(JSON.stringify(res._json).includes('alice@example.com'), false,
      'the client email must not travel to the browser');
  });
});

test('an unlisted email returns 200 {ok:false} with NOTHING else', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'stranger@example.com' } }, res);

    // 200, not 401/403: the status line must not be an oracle either.
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: false },
      'a non-match must leak no reason, no name, and no token');
  });
});

test('an unlisted phone returns the SAME 200 {ok:false} as an unlisted email', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const byEmail = makeRes();
    await handler({ method: 'POST', body: { email: 'stranger@example.com' } }, byEmail);
    const byPhone = makeRes();
    await handler({ method: 'POST', body: { phone: '5559999999' } }, byPhone);

    assert.equal(byEmail._status, byPhone._status);
    assert.deepEqual(byEmail._json, byPhone._json,
      'the two failure modes must be indistinguishable');
  });
});

test('a blank phone does not match a client stored with no phone', async () => {
  envSetup();
  // BOB has phone ''. Submitting an empty phone must not hand back his record.
  await withRoster(ROSTER, async () => {
    for (const phone of ['', '   ', '---']) {
      const res = makeRes();
      await handler({ method: 'POST', body: { phone } }, res);
      assert.equal(res._status, 400, `${JSON.stringify(phone)} carries no identifier at all`);
    }
  });
});

test('an empty roster verifies nobody', async () => {
  envSetup();
  await withRoster([], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: false });
  });
});

test('a body with neither email nor phone -> 400 BAD_REQUEST', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    for (const body of [{}, { email: '', phone: '' }, { email: '  ' }, null, undefined]) {
      const res = makeRes();
      await handler({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `${JSON.stringify(body)} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
});

test('BLOB_NOT_CONFIGURED -> 503, and no token is minted', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
    assert.equal(res._json.verifyToken, undefined);
  });
});

test('any other read failure -> 502, and no token is minted', async () => {
  envSetup();
  await withStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: 'blob get 500', clients: [] }) },
  ], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.ok, false);
    assert.equal(res._json.verifyToken, undefined);
  });
});

test('every response carries Cache-Control: no-store', async () => {
  envSetup();
  await withRoster(ROSTER, async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'alice@example.com' } }, res);
    assert.equal(res._headers['Cache-Control'], 'no-store');
  });
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await handler({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});

test('a verified client whose name is blank still verifies, with an empty name', async () => {
  envSetup();
  await withRoster([{ name: '', email: 'nameless@example.com', phone: '' }], async () => {
    const res = makeRes();
    await handler({ method: 'POST', body: { email: 'nameless@example.com' } }, res);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.name, '');
    assert.equal(ct.verifyVerifyToken('nameless@example.com', res._json.verifyToken), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-verify.test.js`
Expected: FAIL — `Cannot find module '../api/checkin-verify'`.

- [ ] **Step 3: Write `api/checkin-verify.js`**

```js
// POST /api/checkin-verify
// { email?, phone? } -> { ok:true, name, verifyToken } | { ok:false }
//
// The light self-serve gate on /check-in: no account system, no password, just
// "are you on the manually-maintained client list". The token it hands back is
// what api/calendar-checkin-book.js requires, so verification is enforced at
// the API boundary rather than only in the page's UI -- without it, anyone
// could skip this step and POST straight to the booking endpoint.
const cc = require('./_checkin-clients');
const ct = require('./_checkin-token');
const store = require('./_blob-store');

module.exports = async function handler(req, res) {
  // A cached verification response would be a cached credential.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const email = cc.normalizeEmail(body.email);
  const phone = cc.normalizePhone(body.phone);

  // Not about the roster, so this cannot leak anything about it: the request
  // simply carried no identifier to look up.
  if (!email && !phone) {
    return res.status(400).json({ ok: false, error: 'BAD_REQUEST',
      message: 'Enter an email or a phone number.' });
  }

  const read = await cc.loadClients();
  if (!read.ok) {
    if (read.reason === store.BLOB_NOT_CONFIGURED) {
      return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
        message: 'Check-in booking is not set up yet.' });
    }
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not check that right now.' });
  }

  const client = cc.findClient(read.clients, { email, phone });
  if (!client) {
    // 200, not 401/403, and nothing but {ok:false}. The page shows one generic
    // message; the status line and the body must not distinguish "not on the
    // list" from anything else.
    return res.status(200).json({ ok: false });
  }

  // Always scoped to the record's EMAIL, even when the visitor typed a phone:
  // email is guaranteed present, is the record key, and is the only channel the
  // confirmation can reach them on. The email itself is deliberately NOT
  // returned -- calendar-checkin-book.js recovers it from the token.
  return res.status(200).json({
    ok: true,
    name: client.name,
    verifyToken: ct.makeVerifyToken(client.email),
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/checkin-verify.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add api/checkin-verify.js test/checkin-verify.test.js
git commit -m "feat: add check-in client verification endpoint"
```

---

### Task 7: Check-in availability endpoint

**Files:**
- Create: `api/calendar-checkin-availability.js`
- Test: `test/calendar-checkin-availability.test.js`

**Interfaces:**
- Consumes: `loadCheckinTemplate` (Task 5); `tz.parseYmd`, `tz.zonedWallTimeToUtc` from `api/_timezone.js`; `av.computeSlotsForRange` from `api/_availability.js`; `gcal.freeBusy`, `gcal.NOT_CONNECTED` from `api/_google-calendar.js`; `store.BLOB_NOT_CONFIGURED`.
- Produces the HTTP contract `check-in.html` consumes:
  - `GET /api/calendar-checkin-availability?date=YYYY-MM-DD[&days=N]` (N clamped to 1..31)
  - `200 { ok:true, timezone: string, slotMinutes: number, days: { 'YYYY-MM-DD': [{ start: ISO, end: ISO }] } }`
  - `400 { ok:false, error:'BAD_DATE', message }` · `503 BLOB_NOT_CONFIGURED` · `503 CALENDAR_NOT_CONNECTED` · `502 UPSTREAM` · `405`

**Why it queries the same calendar:** free/busy comes from the one shared Google Calendar, so an applicant's booked slot correctly disappears from the check-in grid and vice versa. Only the *template* differs.

**No verify token required here.** Availability is not sensitive — it is the same information the applicant widget already serves publicly — and requiring one would mean the page could not render a grid before a token round-trip. The token gate is on `calendar-checkin-book.js`, where it matters.

- [ ] **Step 1: Write the failing test**

Create `test/calendar-checkin-availability.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/calendar-checkin-availability.test.js`
Expected: FAIL — `Cannot find module '../api/calendar-checkin-availability'`.

- [ ] **Step 3: Write `api/calendar-checkin-availability.js`**

```js
// GET /api/calendar-checkin-availability?date=YYYY-MM-DD[&days=N]
//
// Mirrors calendar-availability.js exactly, reading the CHECK-IN template
// instead of the applicant one. Free/busy still comes from the single shared
// Google Calendar, which is the point: an applicant's booked slot correctly
// disappears from this grid, and a check-in booking disappears from theirs.
//
// No verify token is required here. Availability is not sensitive -- it is the
// same class of information the applicant widget already serves publicly -- and
// gating it would mean the page could not draw a grid before a token round
// trip. The token gate lives on calendar-checkin-book.js, where it matters.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const { loadCheckinTemplate } = require('./_load-checkin-template');

const MAX_DAYS = 31;

module.exports = async function handler(req, res) {
  // Set once, up front, so every branch -- including 405 and every error
  // response -- carries it. A cached error is worse than a cached success: a
  // stale CALENDAR_NOT_CONNECTED would keep telling clients booking is
  // unavailable long after it was connected.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const dateRaw = (req.query && req.query.date) || '';
  const ymd = tz.parseYmd(String(dateRaw));
  if (!ymd) {
    return res.status(400).json({ ok: false, error: 'BAD_DATE',
      message: 'date must be YYYY-MM-DD' });
  }
  let days = parseInt((req.query && req.query.days) || '1', 10);
  if (!Number.isFinite(days) || days < 1) days = 1;
  if (days > MAX_DAYS) days = MAX_DAYS;

  const tplRes = await loadCheckinTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
    return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
      message: 'Booking storage is not set up yet.' });
  }
  const template = tplRes.template;

  // One free/busy call for the whole range, padded by a day on each side so an
  // event starting before the range but running into it still blocks.
  const rangeStart = tz.zonedWallTimeToUtc(ymd.y, ymd.mo, ymd.d, 0, 0, template.timezone);
  const rangeEnd = rangeStart + (days + 1) * 86400000;
  const busyRes = await gcal.freeBusy(
    new Date(rangeStart - 86400000).toISOString(), new Date(rangeEnd).toISOString());

  if (!busyRes.ok) {
    const notConnected = busyRes.reason === gcal.NOT_CONNECTED;
    return res.status(notConnected ? 503 : 502).json({
      ok: false,
      error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: notConnected
        ? 'The calendar has not been connected yet.'
        : 'Could not read the calendar right now.',
    });
  }

  const byDate = av.computeSlotsForRange({
    template, startYmd: ymd, days, busy: busyRes.busy, nowMs: Date.now(),
  });

  const out = {};
  for (const [date, slots] of Object.entries(byDate)) {
    out[date] = slots.map(s => ({
      start: new Date(s.startMs).toISOString(),
      end: new Date(s.endMs).toISOString(),
    }));
  }

  return res.status(200).json({
    ok: true,
    timezone: template.timezone,
    slotMinutes: template.slotMinutes,
    days: out,
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/calendar-checkin-availability.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add api/calendar-checkin-availability.js test/calendar-checkin-availability.test.js
git commit -m "feat: add check-in availability endpoint"
```

---

### Task 8: Check-in Slack senders

**Files:**
- Create: `api/_checkin-slack.js`
- Test: `test/checkin-slack.test.js`

**Interfaces:**
- Consumes: `postToSlack(channelId, message) -> Promise<{ts:string|null}>`, `getPermalink(channelId, messageTs) -> Promise<string|null>`, `CHANNEL_CHECKIN_BOOKED`, `CHANNEL_CHECKIN_RESCHEDULED`, `CHANNEL_CHECKIN_CANCELLED` from `api/_slack.js` (Task 1); `formatWhen(startMs, timeZone, lang) -> string` from `api/_email.js`.
- Produces:
  - `postCheckinBookingCreated(b) -> Promise<{ts:string|null}>`
  - `postCheckinBookingChanged(b, kind, originalTs) -> Promise<{ts:string|null}>` where `kind` is `'rescheduled' | 'cancelled'`
  - `b` is the **Booking** object every check-in endpoint builds and every check-in sender receives — one shape, used by Tasks 8, 9, 10, 11, 12 and 13:

```js
// The Booking object. Every field is always present; the string fields are
// always strings (never null/undefined) so no sender needs a fallback.
{
  eventId: string,          // Google Calendar event id
  name: string,             // the client's name from checkin-clients.json
  email: string,            // the client's email from checkin-clients.json (lowercased)
  phone: string,            // '' when the record has no phone
  startMs: number,          // epoch ms
  endMs: number,            // epoch ms
  visitorTimeZone: string,  // IANA zone the client is in
  templateTimeZone: string, // IANA zone from the CHECK-IN template (Omar's zone)
  manageToken: string,      // makeBookingToken(eventId, email); '' on cancel
  meetLink: string,         // '' when the calendar refused conferencing
  lang: string,             // 'en' | 'ar'
}
```

**Note on the signature:** the spec writes `postCheckinBookingChanged(b, kind)`, but also says cross-channel context uses "the same `getPermalink` approach already shipped for the applicant channels" — which needs the original message's `ts`. The third parameter is therefore required, exactly as `postBookingChanged(b, kind, originalTs)` in `api/_booking-slack.js` already has it. `originalTs` may be `null`, in which case the permalink line is simply omitted.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-slack.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const slack = require('../api/_slack');
const cs = require('../api/_checkin-slack');

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

// _checkin-slack.js reaches _slack through the namespace (slack.postToSlack),
// so stubbing those exports takes effect without any require-cache work. It
// DOES destructure formatWhen, though, so the fresh-require dance is kept: it
// makes the suite correct whichever of the two a future edit changes.
const csPath = require.resolve('../api/_checkin-slack');
function freshCs() {
  delete require.cache[csPath];
  return require(csPath);
}

const START_MS = Date.UTC(2026, 10, 12, 15, 0, 0); // 2026-11-12 15:00Z

function booking(overrides = {}) {
  return {
    eventId: 'evt-checkin-1',
    name: 'Alice Client',
    email: 'alice@example.com',
    phone: '5550100100',
    startMs: START_MS,
    endMs: START_MS + 15 * 60000,
    visitorTimeZone: 'Europe/Istanbul',
    templateTimeZone: 'America/Toronto',
    manageToken: 'tok',
    meetLink: 'https://meet.example/checkin',
    lang: 'en',
    ...overrides,
  };
}

function textOf(message) {
  return (message.blocks || [])
    .map(b => (b.text && b.text.text) || (b.elements || []).map(e => e.text).join(' ') || '')
    .join('\n');
}

test('postCheckinBookingCreated posts to CHANNEL_CHECKIN_BOOKED and returns its ts', async () => {
  const postSpy = spyStub({ ts: 'ts-created' });
  await withStubs([{ obj: slack, key: 'postToSlack', value: postSpy }], async () => {
    const mod = freshCs();
    const r = await mod.postCheckinBookingCreated(booking());
    assert.deepEqual(r, { ts: 'ts-created' });
    assert.equal(postSpy.calls.length, 1);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_CHECKIN_BOOKED);
    assert.notEqual(postSpy.calls[0][0], slack.CHANNEL_NEW_CALLS_BOOKED,
      'a check-in must never land in the applicant booking channel');
  });
  delete require.cache[csPath];
});

test('the created message carries the name, email, phone, both zones and the Meet link', async () => {
  const postSpy = spyStub({ ts: 'ts-created' });
  await withStubs([{ obj: slack, key: 'postToSlack', value: postSpy }], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingCreated(booking());
    const text = textOf(postSpy.calls[0][1]);
    assert.match(text, /Alice Client/);
    assert.match(text, /alice@example\.com/);
    assert.match(text, /5550100100/);
    assert.match(text, /America\/Toronto/, "Omar's own zone must appear -- it is the one he acts on");
    assert.match(text, /Europe\/Istanbul/);
    assert.match(text, /https:\/\/meet\.example\/checkin/);
    // Named as a check-in, so #8 is never mistaken for #4 at a glance.
    assert.match(text, /check-?in/i);
  });
  delete require.cache[csPath];
});

test('a booking with no phone and no Meet link still posts cleanly', async () => {
  const postSpy = spyStub({ ts: null });
  await withStubs([{ obj: slack, key: 'postToSlack', value: postSpy }], async () => {
    const mod = freshCs();
    const r = await mod.postCheckinBookingCreated(booking({ phone: '', meetLink: '' }));
    assert.deepEqual(r, { ts: null });
    const text = textOf(postSpy.calls[0][1]);
    assert.match(text, /—/, 'an absent phone renders as an em dash, not "undefined"');
    assert.equal(/undefined/.test(text), false);
    assert.equal(/\*Meet:\*/.test(text), false, 'no Meet line when there is no link');
  });
  delete require.cache[csPath];
});

test("postCheckinBookingChanged('rescheduled') posts to CHANNEL_CHECKIN_RESCHEDULED", async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: async () => null },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'rescheduled', null);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_CHECKIN_RESCHEDULED);
    assert.match(textOf(postSpy.calls[0][1]), /rescheduled/i);
  });
  delete require.cache[csPath];
});

test("postCheckinBookingChanged('cancelled') posts to CHANNEL_CHECKIN_CANCELLED", async () => {
  const postSpy = spyStub({ ts: 'ts-cancel' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: async () => null },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'cancelled', null);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_CHECKIN_CANCELLED);
    assert.match(textOf(postSpy.calls[0][1]), /cancelled/i);
  });
  delete require.cache[csPath];
});

// Slack cannot thread across channels, so the link back to #8 is a permalink.
test('an originalTs is resolved to a permalink against CHANNEL_CHECKIN_BOOKED and linked', async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  const permaSpy = spyStub('https://slack.example/archives/C1/p123');
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: permaSpy },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'rescheduled', 'ts-original');
    assert.equal(permaSpy.calls.length, 1);
    assert.equal(permaSpy.calls[0][0], slack.CHANNEL_CHECKIN_BOOKED,
      'the original check-in message lives in #8, not #4');
    assert.equal(permaSpy.calls[0][1], 'ts-original');
    assert.match(textOf(postSpy.calls[0][1]), /https:\/\/slack\.example\/archives\/C1\/p123/);
  });
  delete require.cache[csPath];
});

test('no originalTs means getPermalink is never called and no link line appears', async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  const permaSpy = spyStub('https://should-not-be-used.example');
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: permaSpy },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'cancelled', null);
    assert.equal(permaSpy.calls.length, 0);
    assert.equal(/should-not-be-used/.test(textOf(postSpy.calls[0][1])), false);
  });
  delete require.cache[csPath];
});

test('a permalink lookup that returns null still posts the message', async () => {
  const postSpy = spyStub({ ts: 'ts-resched' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'getPermalink', value: async () => null },
  ], async () => {
    const mod = freshCs();
    await mod.postCheckinBookingChanged(booking(), 'rescheduled', 'ts-original');
    assert.equal(postSpy.calls.length, 1, 'a missing permalink must not cost the notification');
  });
  delete require.cache[csPath];
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-slack.test.js`
Expected: FAIL — `Cannot find module '../api/_checkin-slack'`.

- [ ] **Step 3: Write `api/_checkin-slack.js`**

```js
// Check-in bookings get their own three channels (#8/#9/#10), structurally
// mirroring the applicant set (#4/#5/#6). A separate file rather than an
// audience parameter on _booking-slack.js: the two audiences' message copy is
// expected to diverge, and a channel-picking parameter is one typo away from
// posting a client's check-in into the new-applicant channel.
//
// Backend FAILURES from the check-in endpoints do NOT come here -- they call
// the shared postSystemAlert (#7-system-alerts), which is infra-level and
// audience-agnostic.
const slack = require('./_slack');
const { formatWhen } = require('./_email');

function footer() {
  return `Sent by <https://3amaktrades.com|3AMAK Bot> · ${new Date().toUTCString()}`;
}

function whenLine(b) {
  const visitor = formatWhen(b.startMs, b.visitorTimeZone, 'en');
  const omar = formatWhen(b.startMs, b.templateTimeZone, 'en');
  // Both zones, because Omar's own wall-clock time is the one he acts on.
  return `*When:* ${omar} (${b.templateTimeZone})\n*Their time:* ${visitor} (${b.visitorTimeZone})`;
}

async function postCheckinBookingCreated(b) {
  return slack.postToSlack(slack.CHANNEL_CHECKIN_BOOKED, {
    username: '3AMAK Bot',
    icon_emoji: ':repeat:',
    blocks: [
      { type: 'header',
        text: { type: 'plain_text', text: '🔄 Check-in booked', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text:
          `*Client:* ${b.name}\n*Email:* ${b.email}\n*Phone:* ${b.phone || '—'}\n${whenLine(b)}`
          + (b.meetLink ? `\n*Meet:* ${b.meetLink}` : '') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

// `kind` is 'rescheduled' or 'cancelled'. Each posts to its own channel
// (#9/#10), separate from where the original booking lives (#8) -- Slack
// cannot thread across channels, so `originalTs` (the event's stored slackTs)
// is resolved to a permalink back to the original message instead. When
// originalTs is null the link line is simply omitted.
async function postCheckinBookingChanged(b, kind, originalTs) {
  const icon = kind === 'cancelled' ? '❌' : '🔁';
  const channel = kind === 'cancelled'
    ? slack.CHANNEL_CHECKIN_CANCELLED
    : slack.CHANNEL_CHECKIN_RESCHEDULED;
  const permalink = originalTs
    ? await slack.getPermalink(slack.CHANNEL_CHECKIN_BOOKED, originalTs)
    : null;
  const text = `${icon} *Check-in ${kind}* — ${b.name} (${b.email})\n${whenLine(b)}`
    + (permalink ? `\n<${permalink}|Original check-in booking>` : '');
  return slack.postToSlack(channel, {
    username: '3AMAK Bot',
    icon_emoji: ':repeat:',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

module.exports = { postCheckinBookingCreated, postCheckinBookingChanged };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/checkin-slack.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_checkin-slack.js test/checkin-slack.test.js
git commit -m "feat: add check-in Slack senders for the three new channels"
```

---

### Task 9: Check-in email senders (placeholder copy)

**Files:**
- Create: `api/_checkin-email.js`
- Test: `test/checkin-email.test.js`

**Interfaces:**
- Consumes: `send({to, subject, html}) -> Promise<{ok:boolean, reason?:string}>` and `formatWhen(startMs, timeZone, lang) -> string` from `api/_email.js` (Task 1 exported `send`); `escapeHtml`, `safeUrl` from `api/_html.js`; `baseUrl()` from `api/_site-url.js`.
- Produces, each taking the **Booking** object defined in Task 8 and each resolving to `{ok:boolean, reason?:string}` — **never throwing**:
  - `sendCheckinConfirmation(b)`
  - `sendCheckinRescheduleNotice(b)`
  - `sendCheckinCancellationNotice(b)`
  - `sendCheckinReminder(b)`

**ALL COPY IN THIS FILE IS PLACEHOLDER.** Only the sending mechanism and the trigger points are complete. Final wording is a separate collaborative pass with the user, exactly as for `api/_email.js`. Every subject and body carries the `// PLACEHOLDER COPY — collaborative design pass pending` comment and the `[PLACEHOLDER]` marker, and the shell ends with the `PLACEHOLDER EMAIL — final copy pending.` line.

**These emails advertise no reschedule/cancel links**, matching the applicant precedent: the endpoints exist and are tested, but nothing reads a `booking` query param yet, so a link would drop the client on a page that cannot act on it. `manageToken` is still minted and still valid, so wiring it up later needs no change here.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-email.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const baseEmail = require('../api/_email');
const ce = require('../api/_checkin-email');

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

// _checkin-email.js destructures `send` from _email at require-time, so the
// module must be re-required AFTER the stub is installed.
const cePath = require.resolve('../api/_checkin-email');
function freshCe() {
  delete require.cache[cePath];
  return require(cePath);
}

const START_MS = Date.UTC(2026, 10, 12, 15, 0, 0);

function booking(overrides = {}) {
  return {
    eventId: 'evt-checkin-1',
    name: 'Alice Client',
    email: 'alice@example.com',
    phone: '5550100100',
    startMs: START_MS,
    endMs: START_MS + 15 * 60000,
    visitorTimeZone: 'Europe/Istanbul',
    templateTimeZone: 'America/Toronto',
    manageToken: 'tok',
    meetLink: 'https://meet.example/checkin',
    lang: 'en',
    ...overrides,
  };
}

const SENDERS = [
  'sendCheckinConfirmation',
  'sendCheckinRescheduleNotice',
  'sendCheckinCancellationNotice',
  'sendCheckinReminder',
];

test('all four senders are exported', () => {
  for (const name of SENDERS) {
    assert.equal(typeof ce[name], 'function', `${name} must be exported`);
  }
});

test('each sender addresses the client email and passes a subject and html through send', async () => {
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      const r = await mod[name](booking());
      assert.equal(r.ok, true, `${name} should resolve ok`);
      assert.equal(sendSpy.calls.length, 1, `${name} should call send exactly once`);
      const arg = sendSpy.calls[0][0];
      assert.equal(arg.to, 'alice@example.com');
      assert.equal(typeof arg.subject, 'string');
      assert.ok(arg.subject.length > 0);
      assert.equal(typeof arg.html, 'string');
      assert.ok(arg.html.length > 0);
    });
    delete require.cache[cePath];
  }
});

test('every subject and body is marked [PLACEHOLDER], and the shell carries the footer', async () => {
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      const { subject, html } = sendSpy.calls[0][0];
      assert.match(subject, /\[PLACEHOLDER\]/, `${name} subject must be marked placeholder`);
      assert.match(html, /\[PLACEHOLDER\]/, `${name} body must be marked placeholder`);
      assert.match(html, /PLACEHOLDER EMAIL — final copy pending\./,
        `${name} must use the shared placeholder shell`);
    });
    delete require.cache[cePath];
  }
});

// The convention markers are what stop this copy being mistaken for finished
// text in a later pass, so they are asserted against the file itself.
test('the source file carries the PLACEHOLDER banner and a per-sender marker comment', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_checkin-email.js'), 'utf8');
  assert.match(src, /ALL COPY IN THIS FILE IS PLACEHOLDER/);
  const markers = src.match(/PLACEHOLDER COPY — collaborative design pass pending/g) || [];
  assert.ok(markers.length >= 8,
    `expected a marker above every subject and body (>=8), found ${markers.length}`);
});

test('the booking time is rendered in the CLIENT timezone, the one load-bearing value', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinConfirmation(booking());
    const { html } = sendSpy.calls[0][0];
    const expected = baseEmail.formatWhen(START_MS, 'Europe/Istanbul', 'en');
    assert.ok(expected.length > 0, 'formatWhen must produce something to look for');
    assert.ok(html.includes(expected),
      `expected the Istanbul rendering "${expected}" in the body`);
    assert.match(html, /Europe\/Istanbul/);
  });
  delete require.cache[cePath];
});

test('the Meet link is linked when present and omitted entirely when absent', async () => {
  for (const name of ['sendCheckinConfirmation', 'sendCheckinRescheduleNotice', 'sendCheckinReminder']) {
    const withLink = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: withLink }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      assert.match(withLink.calls[0][0].html, /href="https:\/\/meet\.example\/checkin"/,
        `${name} should link the Meet URL`);
    });
    delete require.cache[cePath];

    const withoutLink = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: withoutLink }], async () => {
      const mod = freshCe();
      await mod[name](booking({ meetLink: '' }));
      assert.equal(/Join link/.test(withoutLink.calls[0][0].html), false,
        `${name} must omit the join line when there is no link`);
    });
    delete require.cache[cePath];
  }
});

// safeUrl exists precisely so escaping alone cannot let a javascript: URL into
// an href rendered inside a mail client.
test('a javascript: Meet link is refused rather than escaped into an href', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinConfirmation(booking({ meetLink: 'javascript:alert(1)' }));
    const { html } = sendSpy.calls[0][0];
    assert.equal(/javascript:/i.test(html), false);
    assert.equal(/Join link/.test(html), false);
  });
  delete require.cache[cePath];
});

test('a name containing HTML is escaped', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinConfirmation(booking({ name: '<script>alert(1)</script>' }));
    const { html } = sendSpy.calls[0][0];
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;script&gt;/);
  });
  delete require.cache[cePath];
});

test('a send failure is returned, never thrown', async () => {
  for (const name of SENDERS) {
    await withStubs([
      { obj: baseEmail, key: 'send', value: async () => ({ ok: false, reason: 'resend 422' }) },
    ], async () => {
      const mod = freshCe();
      const r = await mod[name](booking());
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'resend 422');
    });
    delete require.cache[cePath];
  }
});

// The formatter must never be able to cost a booking that is already on the
// calendar, so a non-finite instant and a nonsense zone both have to survive.
test('a non-finite startMs and an invalid timezone still produce a sent email', async () => {
  for (const b of [booking({ startMs: NaN }), booking({ visitorTimeZone: 'Not/AZone' })]) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      const r = await mod.sendCheckinConfirmation(b);
      assert.equal(r.ok, true);
      assert.equal(sendSpy.calls.length, 1);
    });
    delete require.cache[cePath];
  }
});

test('the four subjects are distinct, so an inbox thread is not ambiguous', async () => {
  const subjects = [];
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      subjects.push(sendSpy.calls[0][0].subject);
    });
    delete require.cache[cePath];
  }
  assert.equal(new Set(subjects).size, 4, `subjects must differ: ${JSON.stringify(subjects)}`);
});

// A check-in email landing in a client's inbox must be unmistakable from an
// applicant one. Asserting the subjects NAME the audience is the check that
// survives a later copy pass, whereas comparing against _email.js's literal
// strings would not (its `send` is a module-local call, so stubbing the export
// does not intercept it anyway).
test('every check-in subject names it as a check-in', async () => {
  for (const name of SENDERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod[name](booking());
      assert.match(sendSpy.calls[0][0].subject, /check-?in/i,
        `${name} subject must name it as a check-in`);
    });
    delete require.cache[cePath];
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-email.test.js`
Expected: FAIL — `Cannot find module '../api/_checkin-email'`.

- [ ] **Step 3: Write `api/_checkin-email.js`**

```js
// Transactional email for the CHECK-IN audience.
//
// ############################################################################
// # ALL COPY IN THIS FILE IS PLACEHOLDER. Do not treat it as finished text.   #
// # Final wording and layout are a separate, collaborative design pass with   #
// # the user. Only the SENDING MECHANISM and TRIGGER POINTS are complete.     #
// ############################################################################
//
// The Resend POST (`send`) and the timezone formatter (`formatWhen`) are reused
// from api/_email.js rather than reimplemented: those are transport-layer
// plumbing, not audience-facing copy, so sharing them does not compromise the
// "fully separate lifecycle" decision -- and it means an env-var or retry fix
// never has to be made twice.
//
// NOTE: these emails deliberately advertise no reschedule/cancel links, exactly
// as the applicant ones do. The endpoints exist and are tested, but nothing
// reads a `booking` query param yet, so a link would drop the client on a page
// that cannot act on it. `manageToken` is still minted and still valid, so the
// flow can be wired up later without reworking anything here.
const { send, formatWhen } = require('./_email');
const { escapeHtml, safeUrl } = require('./_html');
const { baseUrl } = require('./_site-url');

// A shared placeholder shell so the real design pass has one obvious place to
// land, instead of four diverging ad-hoc layouts.
function shell(bodyHtml) {
  // PLACEHOLDER COPY — collaborative design pass pending
  return `<div style="font-family:system-ui,sans-serif;background:#050505;color:#F2EEE4;padding:24px">
    <p style="color:#D4AF37;font-weight:700">3AMAK TRADES</p>
    ${bodyHtml}
    <p style="color:#8B887F;font-size:12px">PLACEHOLDER EMAIL — final copy pending.</p>
  </div>`;
}

// The booking time in the CLIENT's own zone -- the one genuinely load-bearing
// value in these otherwise-placeholder bodies.
function whenHtml(b) {
  return `<strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
     (${escapeHtml(b.visitorTimeZone)})`;
}

// safeUrl, not escapeHtml: escaping alone would not stop a `javascript:` URL,
// and these links are rendered inside mail clients.
function joinHtml(b) {
  const href = safeUrl(b.meetLink);
  if (!href) return '';
  // PLACEHOLDER COPY — collaborative design pass pending
  return `<p>[PLACEHOLDER] Join link: <a href="${href}">${escapeHtml(b.meetLink)}</a></p>`;
}

async function sendCheckinConfirmation(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call is booked';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your check-in call is confirmed for ${whenHtml(b)}.</p>
    ${joinHtml(b)}`);
  return send({ to: b.email, subject, html });
}

async function sendCheckinRescheduleNotice(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call was moved';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your check-in call is now ${whenHtml(b)}.</p>
    ${joinHtml(b)}`);
  return send({ to: b.email, subject, html });
}

async function sendCheckinCancellationNotice(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call was cancelled';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your check-in call on
       ${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} is cancelled.</p>
    <p>[PLACEHOLDER] <a href="${escapeHtml(baseUrl())}/check-in">Book another check-in</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendCheckinReminder(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call is coming up';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Reminder: your check-in call is ${whenHtml(b)}.</p>
    ${joinHtml(b)}`);
  return send({ to: b.email, subject, html });
}

module.exports = {
  sendCheckinConfirmation, sendCheckinRescheduleNotice,
  sendCheckinCancellationNotice, sendCheckinReminder,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/checkin-email.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add api/_checkin-email.js test/checkin-email.test.js
git commit -m "feat: add check-in email senders with placeholder copy"
```

---

### Task 10: The check-in booking endpoint

**Files:**
- Create: `api/calendar-checkin-book.js`
- Test: `test/calendar-checkin-book.test.js`

**Interfaces:**
- Consumes: `loadClients` (Task 3); `resolveVerifyToken`, `makeVerifyToken` (Task 2); `loadCheckinTemplate` (Task 5); `AUDIENCE_CHECKIN` (Task 1); `postCheckinBookingCreated` (Task 8); `sendCheckinConfirmation` (Task 9); `guard.EVENT_MARKER`, `guard.overlapping`, `guard.shouldRollBack` from the **unchanged** `api/_booking-guard.js`; `makeBookingToken` from the **unchanged** `api/_booking-token.js`; `av.slotExists`; `gcal.freeBusy / insertEvent / listEvents / deleteEvent / patchEvent / meetLinkFor / NOT_CONNECTED`; `postSystemAlert`.
- Produces the HTTP contract `check-in.html` consumes:
  - `POST /api/calendar-checkin-book` with body `{ verifyToken, start (ISO), visitorTimeZone?, lang? }`
  - `200 { ok:true, eventId, manageToken, start: ISO, end: ISO, meetLink }`
  - `400 { ok:false, error:'BAD_REQUEST', message }` — bad/missing `start`
  - `403 { ok:false, error:'NOT_VERIFIED', message:'Your verification has expired. Please verify again.' }` — missing, expired, forged, or no-longer-listed token
  - `409 { ok:false, error:'SLOT_TAKEN', message }` · `503 BLOB_NOT_CONFIGURED` · `503 CALENDAR_NOT_CONNECTED` · `502 UPSTREAM` · `405`
- Produces on the calendar — `extendedProperties.private` with **exactly these seven keys**, which Tasks 11, 12 and 13 read back:

```js
{
  bookingSource: '3amak-booking', // guard.EVENT_MARKER -- the SHARED marker
  audience: 'checkin',            // AUDIENCE_CHECKIN -- what distinguishes the two
  visitorEmail: string,           // from the resolved client record, NOT the request body
  visitorName: string,
  visitorPhone: string,
  visitorTimeZone: string,
  lang: string,
}
```

**Why `visitorEmail` comes from the token, not the body:** the request body carries no email at all. The handler loads the client list and calls `resolveVerifyToken(clients, body.verifyToken)`, which returns the record the token was signed for. That record's email is what gets written and emailed — so it always matches a verified client even when the visitor originally typed a phone, and a caller cannot substitute an arbitrary address.

**No honeypot field.** `api/calendar-book.js` has one because it is open to the world. This endpoint requires an unforgeable 10-minute token that only `checkin-verify` can mint, which is a strictly stronger gate, and `check-in.html` renders no honeypot input — so a honeypot check here would be dead code nothing can exercise.

**The double-booking guard is used exactly as-is.** Both audiences write the same `EVENT_MARKER`, which is what lets a check-in booking and an applicant booking race each other and still resolve (one survives via the id tie-break, or both yield to a genuine foreign event). `api/_booking-guard.js` is not touched.

- [ ] **Step 1: Write the failing test**

Create `test/calendar-checkin-book.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const cc = require('../api/_checkin-clients');
const ct = require('../api/_checkin-token');
const cslack = require('../api/_checkin-slack');
const cemail = require('../api/_checkin-email');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const loadMod = require('../api/_load-checkin-template');
const av = require('../api/_availability');

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

const handlerPath = require.resolve('../api/calendar-checkin-book');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

// The check-in template used throughout: 15-minute slots, no buffer, mon-fri
// 09:00-10:00 America/Toronto, 24h notice. Deliberately DIFFERENT from the
// applicant default (30 minutes, 09:00-17:00), so a handler wired to the wrong
// loader produces a wrong endMs and fails loudly.
const CHECKIN_TEMPLATE = av.normalizeTemplate({
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
});

// A weekday 60+ days out at 09:00 America/Toronto: inside the window, on the
// 15-minute grid, well clear of the 24h notice rule and any DST boundary.
function validSlotStartMs() {
  const base = new Date(Date.now() + 60 * 86400000);
  let y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  while (true) {
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) break; // Mon-Fri
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return tz.zonedWallTimeToUtc(y, mo, d, 9, 0, 'America/Toronto');
}

const ROSTER = [
  { name: 'Alice Client', email: 'alice@example.com', phone: '5550100100' },
  { name: 'Bob Client', email: 'bob@example.com', phone: '' },
];

// An event as listEvents returns it for a booking THIS system created. Both
// audiences write the SAME bookingSource marker -- that is what makes the id
// tie-break legitimate between them. `audience` is carried too, so a fixture
// can stand in for either side of a cross-audience race.
function listedOurs(id, isoStart, isoEnd, audience) {
  const priv = { bookingSource: guard.EVENT_MARKER };
  if (audience) priv.audience = audience;
  return {
    id,
    start: { dateTime: isoStart },
    end: { dateTime: isoEnd },
    status: 'confirmed',
    extendedProperties: { private: priv },
  };
}

function goodBody(startMs, overrides = {}) {
  return {
    verifyToken: ct.makeVerifyToken('alice@example.com'),
    start: new Date(startMs).toISOString(),
    visitorTimeZone: 'Europe/Istanbul',
    lang: 'en',
    ...overrides,
  };
}

// The stub set every happy-path test needs. `extra` appends or overrides.
function baseStubs(extra = []) {
  return [
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: ROSTER, usedDefault: false }) },
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => ({ ts: null }) },
    { obj: cemail, key: 'sendCheckinConfirmation', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

test('happy path: 200 with eventId, a valid manageToken, start, end and meetLink', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000; // the CHECK-IN slot length, not 30
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-checkin-happy', hangoutLink: 'https://meet.example/ci' } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-checkin-happy', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, 'evt-checkin-happy');
    assert.equal(res._json.start, isoStart);
    assert.equal(res._json.end, isoEnd, 'endMs must come from the CHECK-IN slotMinutes (15)');
    assert.equal(res._json.meetLink, 'https://meet.example/ci');
    // The manage token is minted for the TOKEN's email, which is the roster's.
    assert.equal(bt.verifyBookingToken('evt-checkin-happy', 'alice@example.com', res._json.manageToken), true);
    assert.equal(deleteSpy.calls.length, 0, 'a clean booking must never roll itself back');
  });
  delete require.cache[handlerPath];
});

// The WRITE side of extendedProperties.private, asserted key by key. Every
// reader test hand-builds its own event object, so without this the suite stays
// green while a renamed key silently 403s every manage link, stops every
// reminder, and -- for `audience` specifically -- routes check-ins into the
// applicant templates.
test('the insert payload carries the shared marker AND audience:checkin, with exactly seven private keys', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-props' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-props', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);

    assert.equal(insertSpy.calls.length, 1);
    const payload = insertSpy.calls[0][0];
    assert.ok(payload.extendedProperties && payload.extendedProperties.private,
      'the insert payload must carry extendedProperties.private');
    const priv = payload.extendedProperties.private;
    assert.equal(priv.bookingSource, '3amak-booking');
    assert.equal(priv.bookingSource, guard.EVENT_MARKER,
      'the marker must be the SHARED constant so the guard sees both audiences');
    assert.equal(priv.audience, 'checkin');
    assert.equal(priv.visitorEmail, 'alice@example.com');
    assert.equal(priv.visitorName, 'Alice Client');
    assert.equal(priv.visitorPhone, '5550100100');
    assert.equal(priv.visitorTimeZone, 'Europe/Istanbul');
    assert.equal(priv.lang, 'en');
    assert.deepEqual(Object.keys(priv).sort(),
      ['audience', 'bookingSource', 'lang', 'visitorEmail', 'visitorName', 'visitorPhone', 'visitorTimeZone']);

    // The event's own times must be the requested slot, in UTC.
    assert.equal(payload.start.dateTime, isoStart);
    assert.equal(payload.end.dateTime, isoEnd);
    assert.equal(payload.start.timeZone, 'UTC');
  });
  delete require.cache[handlerPath];
});

// The whole reason the token exists: without server-side enforcement anyone
// could skip the verification UI and POST straight here.
test('a missing, forged, or expired verifyToken -> 403 NOT_VERIFIED and insertEvent is never called', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  const bad = [
    goodBody(startMs, { verifyToken: undefined }),
    goodBody(startMs, { verifyToken: '' }),
    goodBody(startMs, { verifyToken: 'not-a-token' }),
    goodBody(startMs, { verifyToken: `${'x'.repeat(43)}.${Date.now() + 600000}` }),
    goodBody(startMs, { verifyToken: ct.makeVerifyToken('alice@example.com', -1000) }),
  ];

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    for (const body of bad) {
      const res = makeRes();
      await h({ method: 'POST', body }, res);
      assert.equal(res._status, 403, `${JSON.stringify(body.verifyToken)} should be 403`);
      assert.equal(res._json.error, 'NOT_VERIFIED');
    }
    assert.equal(insertSpy.calls.length, 0, 'an unverified caller must never reach the calendar');
  });
  delete require.cache[handlerPath];
});

test('a token for someone no longer on the roster -> 403 NOT_VERIFIED', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs(baseStubs([
    // Alice verified, then Omar removed her before she confirmed.
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [ROSTER[1]], usedDefault: false }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'NOT_VERIFIED');
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// An arbitrary email in the body must be ignored outright -- not merely
// rejected -- since the token alone decides whose booking this is.
test('an email in the request body is ignored: the booking uses the TOKEN owner', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const insertSpy = spyStub({ ok: true, event: { id: 'evt-token-wins' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-token-wins', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs, {
      email: 'attacker@example.com',
      name: 'Attacker',
      phone: '5559999999',
      verifyToken: ct.makeVerifyToken('bob@example.com'),
    }) }, res);

    assert.equal(res._status, 200);
    const priv = insertSpy.calls[0][0].extendedProperties.private;
    assert.equal(priv.visitorEmail, 'bob@example.com');
    assert.equal(priv.visitorName, 'Bob Client');
    assert.equal(priv.visitorPhone, '');
    assert.equal(JSON.stringify(priv).includes('attacker@example.com'), false);
    assert.equal(JSON.stringify(priv).includes('Attacker'), false);
  });
  delete require.cache[handlerPath];
});

test('the confirmation email and Slack post are addressed to the token owner', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const slackSpy = spyStub({ ts: 'ts-1' });
  const emailSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-notify', hangoutLink: 'https://meet.example/n' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-notify', isoStart, isoEnd, 'checkin')] }) },
    { obj: cslack, key: 'postCheckinBookingCreated', value: slackSpy },
    { obj: cemail, key: 'sendCheckinConfirmation', value: emailSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);

    assert.equal(slackSpy.calls.length, 1);
    assert.equal(emailSpy.calls.length, 1);
    // Both receive the SAME Booking object shape.
    for (const b of [slackSpy.calls[0][0], emailSpy.calls[0][0]]) {
      assert.equal(b.eventId, 'evt-notify');
      assert.equal(b.name, 'Alice Client');
      assert.equal(b.email, 'alice@example.com');
      assert.equal(b.phone, '5550100100');
      assert.equal(b.startMs, startMs);
      assert.equal(b.endMs, endMs);
      assert.equal(b.visitorTimeZone, 'Europe/Istanbul');
      assert.equal(b.templateTimeZone, 'America/Toronto');
      assert.equal(b.meetLink, 'https://meet.example/n');
      assert.equal(b.lang, 'en');
      assert.equal(typeof b.manageToken, 'string');
      assert.ok(b.manageToken.length > 0);
    }
  });
  delete require.cache[handlerPath];
});

// The applicant senders must never fire for a check-in, or a mentorship client
// gets the new-applicant copy and the booking lands in #4.
test('the APPLICANT Slack and email senders are never called', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const appSlack = spyStub({ ts: null });
  const appEmail = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-sep' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-sep', isoStart, isoEnd, 'checkin')] }) },
    { obj: bslack, key: 'postBookingCreated', value: appSlack },
    { obj: email, key: 'sendBookingConfirmation', value: appEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(appSlack.calls.length, 0);
    assert.equal(appEmail.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a Slack ts is stored back onto the event so a later change can link to it', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-ts' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-ts', isoStart, isoEnd, 'checkin')] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => ({ ts: 'slack-ts-8' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 1);
    assert.equal(patchSpy.calls[0][0], 'evt-ts');
    assert.equal(patchSpy.calls[0][1].extendedProperties.private.slackTs, 'slack-ts-8');
  });
  delete require.cache[handlerPath];
});

test('no Slack ts means no patch call at all', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-nots' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-nots', isoStart, isoEnd, 'checkin')] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => ({ ts: null }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// The shared-marker property, exercised across audiences: an APPLICANT booking
// racing this one carries the same marker, so the id tie-break is legitimate
// and exactly one of the two survives.
test('an applicant booking racing this check-in resolves by the id tie-break: ours loses and is deleted', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'zzz-ours'; // 'aaa-applicant' sorts first -> ours loses
  const insertSpy = spyStub({ ok: true, event: { id: ourEventId } });
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          // No `audience` -- an applicant booking. Same marker, so its side runs
          // the same guard and will withdraw if it loses.
          listedOurs('aaa-applicant', isoStart, isoEnd, null),
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(deleteSpy.calls.length, 1, 'our event must actually be withdrawn');
    assert.equal(deleteSpy.calls[0][0], ourEventId);
  });
  delete require.cache[handlerPath];
});

test('the inverse: ours wins the cross-audience tie-break and is kept', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'aaa-ours';
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: ourEventId } }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
          listedOurs('zzz-applicant', isoStart, isoEnd, null),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.eventId, ourEventId);
    assert.equal(deleteSpy.calls.length, 0, 'the winner must not roll itself back');
  });
  delete require.cache[handlerPath];
});

test('a genuinely FOREIGN overlapping event rolls us back even when our id sorts first', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'aaa-ours'; // sorts FIRST, and must still yield
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: ourEventId } }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
          // Omar booked this on his phone: no marker, no guard on its side, so
          // nobody withdraws there and winning the tie-break would leave a real
          // double-booking standing while the client is told "confirmed".
          { id: 'zzz-omars-own', start: { dateTime: isoStart }, end: { dateTime: isoEnd }, status: 'confirmed' },
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 409);
    assert.equal(deleteSpy.calls.length, 1);
    assert.equal(deleteSpy.calls[0][0], ourEventId);
  });
  delete require.cache[handlerPath];
});

// The counterpart of the declined-invite fix already shipped for the applicant
// flow: freeBusy ignores an invite Omar declined, events.list still returns it.
// Without the guard's skip, the slot would be permanently unbookable here too.
test('a slot holding an invite Omar DECLINED still books', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  const ourEventId = 'zzz-ours'; // sorts LAST, so a surviving clash would roll us back
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: ourEventId } }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs(ourEventId, isoStart, isoEnd, 'checkin'),
          {
            id: 'aaa-declined-invite',
            start: { dateTime: isoStart },
            end: { dateTime: isoEnd },
            status: 'confirmed',
            attendees: [
              { email: 'organizer@example.com', organizer: true, responseStatus: 'accepted' },
              { email: 'omar@example.com', self: true, responseStatus: 'declined' },
            ],
          },
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200, 'a declined invite must not block the booking');
    assert.equal(deleteSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a failing listEvents keeps the booking (fail-open) but logs and alerts that the guard was skipped', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const logged = [];
  const realError = console.error;
  const alertSpy = spyStub(undefined);

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-unguarded' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'upstream 500 from Google' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs) }, res);
      assert.equal(res._status, 200, 'fail-open is deliberate and must not change');
      assert.equal(res._json.eventId, 'evt-unguarded');
    } finally {
      console.error = realError;
    }
    const line = logged.find(l => /guard/i.test(l));
    assert.ok(line, `expected a logged line about the skipped guard, got: ${JSON.stringify(logged)}`);
    assert.match(line, /evt-unguarded/);
    assert.match(line, /upstream 500 from Google/);
  });
  delete require.cache[handlerPath];
});

test('a slot that fails the pre-insert re-verify -> 409 without ever calling insertEvent', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({
        ok: true, busy: [{ start: startMs - 3600000, end: endMs + 3600000 }] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// The check-in template's window is 09:00-10:00, so 11:00 is outside it even
// though it would be a perfectly valid APPLICANT slot (09:00-17:00). This is
// what proves the handler reads the check-in template.
test('a time valid for applicant hours but outside CHECK-IN hours -> 409', async () => {
  envSetup();
  const nine = validSlotStartMs();
  const eleven = nine + 2 * 3600 * 1000;
  const insertSpy = spyStub({ ok: true, event: { id: 'should-never-exist' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(eleven) }, res);
    assert.equal(res._status, 409);
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a malformed or missing start -> 400 BAD_REQUEST', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: spyStub({ ok: true, event: { id: 'x' } }) },
  ]), async () => {
    const h = freshHandler();
    for (const start of ['not-a-date', '', undefined]) {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs, { start }) }, res);
      assert.equal(res._status, 400, `${JSON.stringify(start)} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
  delete require.cache[handlerPath];
});

test('an invalid visitorTimeZone falls back to UTC rather than failing', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();
  const insertSpy = spyStub({ ok: true, event: { id: 'evt-tz' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: insertSpy },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-tz', isoStart, isoEnd, 'checkin')] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs, { visitorTimeZone: 'Not/AZone' }) }, res);
    assert.equal(res._status, 200);
    assert.equal(insertSpy.calls[0][0].extendedProperties.private.visitorTimeZone, 'UTC');
  });
  delete require.cache[handlerPath];
});

test('lang is normalized to en unless it is exactly "ar"', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  for (const [given, expected] of [['ar', 'ar'], ['en', 'en'], ['fr', 'en'], [undefined, 'en']]) {
    const insertSpy = spyStub({ ok: true, event: { id: 'evt-lang' } });
    await withStubs(baseStubs([
      { obj: gcal, key: 'insertEvent', value: insertSpy },
      { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
      { obj: gcal, key: 'listEvents', value: async () => ({
          ok: true, events: [listedOurs('evt-lang', isoStart, isoEnd, 'checkin')] }) },
    ]), async () => {
      const h = freshHandler();
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs, { lang: given }) }, res);
      assert.equal(res._status, 200);
      assert.equal(insertSpy.calls[0][0].extendedProperties.private.lang, expected);
    });
    delete require.cache[handlerPath];
  }
});

test('BLOB_NOT_CONFIGURED on the client-list read -> 503 and no token work at all', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const insertSpy = spyStub({ ok: true, event: { id: 'x' } });
  await withStubs(baseStubs([
    { obj: cc, key: 'loadClients', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, clients: [] }) },
    { obj: gcal, key: 'insertEvent', value: insertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
    assert.equal(insertSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('BLOB_NOT_CONFIGURED on the template read -> 503', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, template: CHECKIN_TEMPLATE }) },
    { obj: gcal, key: 'insertEvent', value: spyStub({ ok: true, event: { id: 'x' } }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
  });
  delete require.cache[handlerPath];
});

test('CALENDAR_NOT_CONNECTED -> 503; another freeBusy failure -> 502; a failed insert -> 502', async () => {
  envSetup();
  const startMs = validSlotStartMs();

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
  delete require.cache[handlerPath];

  await withStubs(baseStubs([
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: false, reason: 'google 500' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
  delete require.cache[handlerPath];

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: false, reason: 'insert refused' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
  delete require.cache[handlerPath];
});

test('a throwing Slack stub and a throwing email stub still result in a 200, confirmed booking', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-survives' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-survives', isoStart, isoEnd, 'checkin')] }) },
    { obj: gcal, key: 'patchEvent', value: async () => { throw new Error('patch also down'); } },
    { obj: cslack, key: 'postCheckinBookingCreated', value: async () => { throw new Error('slack is down'); } },
    { obj: cemail, key: 'sendCheckinConfirmation', value: async () => { throw new Error('email is down'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, 'evt-survives');
  });
  delete require.cache[handlerPath];
});

test('a confirmation email that returns {ok:false} raises a system alert but keeps the 200', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  const endMs = startMs + 15 * 60 * 1000;
  const isoStart = new Date(startMs).toISOString();
  const isoEnd = new Date(endMs).toISOString();
  const alertSpy = spyStub(undefined);

  await withStubs(baseStubs([
    { obj: gcal, key: 'insertEvent', value: async () => ({ ok: true, event: { id: 'evt-mailfail' } }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs('evt-mailfail', isoStart, isoEnd, 'checkin')] }) },
    { obj: cemail, key: 'sendCheckinConfirmation', value: async () => ({ ok: false, reason: 'resend 422' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs) }, res);
    assert.equal(res._status, 200);
    assert.equal(alertSpy.calls.length, 1, 'a silently undelivered confirmation must be visible');
    assert.match(String(alertSpy.calls[0][0]), /evt-mailfail/);
    assert.match(String(alertSpy.calls[0][0]), /resend 422/);
  });
  delete require.cache[handlerPath];
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await require('../api/calendar-checkin-book')({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/calendar-checkin-book.test.js`
Expected: FAIL — `Cannot find module '../api/calendar-checkin-book'`.

- [ ] **Step 3: Write `api/calendar-checkin-book.js`**

```js
// POST /api/calendar-checkin-book
// { verifyToken, start (ISO), visitorTimeZone, lang }
//
// Mirrors calendar-book.js -- same pre-insert free/busy re-verify, same
// post-insert overlap guard, same manage-token minting -- with three
// differences:
//
//  1. A valid, unexpired verifyToken is REQUIRED. Verification is enforced
//     here, at the API boundary, not only in the page's UI: without this,
//     anyone could skip /check-in's verify step and POST straight here with an
//     arbitrary email.
//  2. The booking's identity (email, name, phone) comes from the client record
//     the TOKEN resolves to, never from the request body -- so it always
//     matches a verified client even when the visitor typed a phone, and a
//     caller cannot substitute an address.
//  3. The event is tagged audience:'checkin', which is what calendar-reminders
//     and the check-in reschedule/cancel handlers branch on.
//
// There is deliberately NO honeypot field. calendar-book.js has one because it
// is open to the world; an unforgeable 10-minute token is a strictly stronger
// gate, and check-in.html renders no honeypot input, so a check here would be
// dead code nothing can exercise.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const guard = require('./_booking-guard');
const cc = require('./_checkin-clients');
const ct = require('./_checkin-token');
const cslack = require('./_checkin-slack');
const cemail = require('./_checkin-email');
const { AUDIENCE_CHECKIN } = require('./_checkin-audience');
const { postSystemAlert } = require('./_slack');
const { makeBookingToken } = require('./_booking-token');
const { loadCheckinTemplate } = require('./_load-checkin-template');

function badRequest(res, message) {
  return res.status(400).json({ ok: false, error: 'BAD_REQUEST', message });
}

function storageMissing(res) {
  return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
    message: 'Booking storage is not set up yet.' });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  const startMs = Date.parse(String(body.start || ''));
  if (!Number.isFinite(startMs)) return badRequest(res, 'start must be an ISO timestamp');

  const lang = body.lang === 'ar' ? 'ar' : 'en';
  const visitorTimeZone = tz.isValidTimeZone(body.visitorTimeZone)
    ? body.visitorTimeZone : 'UTC';

  // The roster is loaded first because it is BOTH the token's keyspace and the
  // re-check that this client is still a client.
  const clientsRes = await cc.loadClients();
  if (!clientsRes.ok) {
    if (clientsRes.reason === store.BLOB_NOT_CONFIGURED) return storageMissing(res);
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not check that right now.' });
  }

  // Missing, malformed, expired, forged, or issued to someone since removed
  // from the roster -- all one indistinguishable 403.
  const client = ct.resolveVerifyToken(clientsRes.clients, body.verifyToken);
  if (!client) {
    return res.status(403).json({ ok: false, error: 'NOT_VERIFIED',
      message: 'Your verification has expired. Please verify again.' });
  }
  const addr = client.email;
  const name = client.name;
  const phone = client.phone;

  const tplRes = await loadCheckinTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) return storageMissing(res);
  const template = tplRes.template;
  const endMs = startMs + template.slotMinutes * 60 * 1000;

  // Re-verify against live free/busy: the grid the client is looking at may be
  // minutes stale, and it is the SAME calendar the applicant flow writes to.
  const busyRes = await gcal.freeBusy(
    new Date(startMs - 86400000).toISOString(),
    new Date(endMs + 86400000).toISOString());
  if (!busyRes.ok) {
    const notConnected = busyRes.reason === gcal.NOT_CONNECTED;
    return res.status(notConnected ? 503 : 502).json({
      ok: false,
      error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: notConnected ? 'The calendar is not connected yet.'
                            : 'Could not reach the calendar.',
    });
  }
  if (!av.slotExists({ template, startMs, busy: busyRes.busy, nowMs: Date.now() })) {
    return res.status(409).json({ ok: false, error: 'SLOT_TAKEN',
      message: 'That time is no longer available.' });
  }

  const inserted = await gcal.insertEvent({
    summary: `Check-in — ${name}`,
    description: `Check-in booked from 3amaktrades.com/check-in\nName: ${name}\nEmail: ${addr}\nPhone: ${phone || '—'}\nTheir timezone: ${visitorTimeZone}`,
    start: { dateTime: new Date(startMs).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endMs).toISOString(), timeZone: 'UTC' },
    extendedProperties: {
      private: {
        // The SHARED marker, identical to calendar-book.js. This is what lets a
        // check-in and an applicant booking race each other and still resolve
        // correctly, without _booking-guard.js knowing either audience exists.
        bookingSource: guard.EVENT_MARKER,
        // The one field that distinguishes the two. The applicant flow does not
        // set it; its absence means "applicant".
        audience: AUDIENCE_CHECKIN,
        visitorEmail: addr,
        visitorName: name,
        visitorPhone: phone,
        visitorTimeZone,
        lang,
      },
    },
    conferenceData: { createRequest: { requestId: `amak-ci-${Date.now()}` } },
  });
  if (!inserted.ok) {
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not create the event.' });
  }
  const eventId = inserted.event.id;

  // ---- The double-booking guard (shared, unmodified) ----------------------
  const after = await gcal.listEvents({
    timeMinIso: new Date(startMs - 1000).toISOString(),
    timeMaxIso: new Date(endMs + 1000).toISOString(),
  });
  if (after.ok) {
    const clash = guard.overlapping(after.events, startMs, endMs);
    if (guard.shouldRollBack(eventId, clash)) {
      await gcal.deleteEvent(eventId);
      return res.status(409).json({ ok: false, error: 'SLOT_TAKEN',
        message: 'Someone booked that time a moment before you.' });
    }
  } else {
    // Fail OPEN, exactly as calendar-book.js does: the event already exists,
    // and failing now would tell the client "not booked" about a booking that
    // is on the calendar. But this is the ONLY double-booking protection there
    // is, so a skipped check must never be silent.
    console.error('double-booking guard SKIPPED for check-in event', eventId,
      '-- listEvents failed:', after.reason);
    await postSystemAlert(`*Double-booking guard skipped* for CHECK-IN event \`${eventId}\` -- `
      + `listEvents failed: ${after.reason}. The booking still stands; verify manually there's no clash.`);
  }
  // -------------------------------------------------------------------------

  const meetLink = gcal.meetLinkFor(inserted.event);
  const token = makeBookingToken(eventId, addr);
  const booking = {
    eventId, name, email: addr, phone, startMs, endMs,
    visitorTimeZone, templateTimeZone: template.timezone,
    manageToken: token, meetLink, lang,
  };

  // Slack and email must never cost a confirmed booking, so both are
  // best-effort and their failures are logged and alerted, never returned.
  let slackTs = null;
  try {
    const posted = await cslack.postCheckinBookingCreated(booking);
    slackTs = (posted && posted.ts) || null;
  } catch (e) { console.error('check-in booking slack failed:', e.message); }

  if (slackTs) {
    // Stored so a later reschedule/cancel can link back to this message
    // (posted to a different channel, so a permalink -- not a real thread).
    try {
      await gcal.patchEvent(eventId, {
        extendedProperties: { private: { slackTs } },
      });
    } catch (e) { console.error('check-in slackTs patch failed:', e.message); }
  }

  try {
    const sent = await cemail.sendCheckinConfirmation(booking);
    if (!sent.ok) {
      console.error('check-in confirmation email failed:', sent.reason);
      await postSystemAlert(`*Check-in confirmation email failed* for \`${eventId}\` (${addr}): ${sent.reason}`);
    }
  } catch (e) {
    console.error('check-in confirmation email threw:', e.message);
    await postSystemAlert(`*Check-in confirmation email threw* for \`${eventId}\` (${addr}): ${e.message}`);
  }

  return res.status(200).json({
    ok: true, eventId, manageToken: token,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    meetLink,
  });
};
```

Note the `patchEvent` call is wrapped in its own try/catch — unlike `calendar-book.js`, where a throwing `patchEvent` would propagate. The existing applicant test `'a throwing Slack stub and a throwing email stub still result in a 200'` only passes there because its Slack stub throws *before* the patch is reached; guarding it here makes the same guarantee unconditional.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/calendar-checkin-book.test.js`
Expected: PASS (22 tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all green. In particular `test/calendar-book.test.js` and `test/booking-guard.test.js` must be untouched — this task added a second writer of `EVENT_MARKER` but changed neither the guard nor the applicant path.

- [ ] **Step 6: Commit**

```bash
git add api/calendar-checkin-book.js test/calendar-checkin-book.test.js
git commit -m "feat: add token-gated check-in booking endpoint"
```

---

### Task 11: Check-in reschedule endpoint

**Files:**
- Create: `api/calendar-checkin-reschedule.js`
- Test: `test/calendar-checkin-reschedule.test.js`

**Interfaces:**
- Consumes: `loadBooking({eventId, email, token}) -> {ok:true, event, meta} | {ok:false, status, error, message}` from the **unchanged** `api/_load-booking.js`; `isCheckinEvent(meta)` (Task 1); `loadCheckinTemplate` (Task 5); `postCheckinBookingChanged` (Task 8); `sendCheckinRescheduleNotice` (Task 9); `guard.overlapping`, `guard.shouldRollBack`; `makeBookingToken`; `av.slotExists`; `gcal.freeBusy / patchEvent / listEvents / meetLinkFor`; `postSystemAlert`.
- Produces:
  - `POST /api/calendar-checkin-reschedule` with body `{ eventId, email, token, start (ISO), visitorTimeZone? }`
  - `200 { ok:true, eventId, start: ISO, end: ISO }`
  - `400 BAD_REQUEST` · `403 FORBIDDEN` · `404 NOT_FOUND` · `409 SLOT_TAKEN` · `503 BLOB_NOT_CONFIGURED` · `503 CALENDAR_NOT_CONNECTED` · `502 UPSTREAM` · `405`

**Why `loadBooking` is reused unchanged:** it already does the three checks this path needs — token HMAC over `(eventId, email)`, the event exists, `bookingSource === EVENT_MARKER`, and `meta.visitorEmail` matches the supplied email. Check-in events carry the same shared marker, so it works as-is.

**The audience check is defense in depth.** `manageToken` does not encode which audience an event belongs to (it is just an HMAC over `eventId+email`, deliberately unchanged from the applicant version). So after `loadBooking` succeeds, this handler **explicitly** rejects any event whose `meta.audience !== 'checkin'` with a 403 — a check-in manage link must never be able to act on an applicant booking, even if some future bug caused an `eventId`/email pair to be reused or guessed across audiences. The 403 message is identical to `loadBooking`'s own ("That booking is not managed here.") so the two failure modes are indistinguishable from outside.

- [ ] **Step 1: Write the failing test**

Create `test/calendar-checkin-reschedule.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const cslack = require('../api/_checkin-slack');
const cemail = require('../api/_checkin-email');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const loadMod = require('../api/_load-checkin-template');
const av = require('../api/_availability');

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

const handlerPath = require.resolve('../api/calendar-checkin-reschedule');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

// 15-minute slots, mon-fri 09:00-12:00 America/Toronto, no buffer, 24h notice.
// A three-hour window so a "four hours later" move has somewhere to land.
const CHECKIN_TEMPLATE = av.normalizeTemplate({
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '12:00' },
    tue: { enabled: true, start: '09:00', end: '12:00' },
    wed: { enabled: true, start: '09:00', end: '12:00' },
    thu: { enabled: true, start: '09:00', end: '12:00' },
    fri: { enabled: true, start: '09:00', end: '12:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 15,
  bufferMinutes: 0,
  minNoticeHours: 24,
});

function validSlotStartMs() {
  const base = new Date(Date.now() + 60 * 86400000);
  let y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
  while (true) {
    const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) break; // Mon-Fri
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return tz.zonedWallTimeToUtc(y, mo, d, 9, 0, 'America/Toronto');
}

const EVENT_ID = 'evt-checkin-reschedule-1';
const EMAIL = 'alice@example.com';

// A check-in event as getEvent returns it: the SHARED marker plus audience.
function checkinEvent({ startMs, endMs, extra = {}, overrides = {} }) {
  return {
    id: EVENT_ID,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs).toISOString() },
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        audience: 'checkin',
        visitorEmail: EMAIL,
        visitorName: 'Alice Client',
        visitorPhone: '5550100100',
        visitorTimeZone: 'Europe/Istanbul',
        lang: 'en',
        slackTs: 'slack-ts-original',
        ...extra,
      },
    },
    ...overrides,
  };
}

// The SAME event with no audience tag at all: an APPLICANT booking. A check-in
// manage link must never be able to act on it.
function applicantEvent({ startMs, endMs }) {
  const e = checkinEvent({ startMs, endMs });
  delete e.extendedProperties.private.audience;
  return e;
}

function listedOurs(id, isoStart, isoEnd) {
  return {
    id,
    start: { dateTime: isoStart },
    end: { dateTime: isoEnd },
    status: 'confirmed',
    extendedProperties: { private: { bookingSource: guard.EVENT_MARKER } },
  };
}

function goodBody(newStartMs, overrides = {}) {
  return {
    eventId: EVENT_ID,
    email: EMAIL,
    token: bt.makeBookingToken(EVENT_ID, EMAIL),
    start: new Date(newStartMs).toISOString(),
    visitorTimeZone: 'Europe/Istanbul',
    ...overrides,
  };
}

function baseStubs(extra = []) {
  return [
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [] }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => ({ ts: null }) },
    { obj: cemail, key: 'sendCheckinRescheduleNotice', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

test('happy path: 200, and patchEvent is called with the NEW start/end at the CHECK-IN slot length', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000; // 11:00, still inside 09:00-12:00
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: { hangoutLink: 'https://meet.example/moved' } });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, isoNewStart, isoNewEnd)] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.eventId, EVENT_ID);
    assert.equal(res._json.start, isoNewStart);
    assert.equal(res._json.end, isoNewEnd, 'endMs must use the CHECK-IN slotMinutes (15)');

    assert.equal(patchSpy.calls.length, 1);
    const [, payload] = patchSpy.calls[0];
    assert.equal(payload.start.dateTime, isoNewStart);
    assert.equal(payload.end.dateTime, isoNewEnd);
  });
  delete require.cache[handlerPath];
});

// THE defense-in-depth check. manageToken is an HMAC over eventId+email only --
// it encodes no audience -- so a token that is genuinely valid for an APPLICANT
// booking must still be refused here.
test('an APPLICANT event (no audience tag) -> 403 FORBIDDEN, and patchEvent is never called', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: applicantEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    // The token here is genuinely valid for this eventId+email pair.
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(patchSpy.calls.length, 0,
      'a check-in link must never move an applicant booking');
  });
  delete require.cache[handlerPath];
});

test('an event tagged with some OTHER audience value -> 403 FORBIDDEN', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: checkinEvent({ startMs: oldStart, endMs: oldEnd, extra: { audience: 'something-else' } }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 403);
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

// The self-blocking regression, re-proved on this path: the event being moved is
// itself on the calendar, so its own busy interval must be filtered out before
// checking the new slot.
test('reschedule does not block on its own current busy interval', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldEnd; // back-to-back
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    // ONLY the booking's own interval is reported busy.
    { obj: gcal, key: 'freeBusy', value: async () => ({ ok: true, busy: [{ start: oldStart, end: oldEnd }] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, isoNewStart, isoNewEnd)] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200, `expected 200, got ${res._status} (${JSON.stringify(res._json)})`);
  });
  delete require.cache[handlerPath];
});

test('reminderSent is cleared on a successful reschedule so a moved call is reminded again', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, new Date(newStart).toISOString(), new Date(newEnd).toISOString())] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200);
    assert.equal(patchSpy.calls.length, 1);
    const [, payload] = patchSpy.calls[0];
    assert.ok(payload.extendedProperties && payload.extendedProperties.private);
    assert.equal(payload.extendedProperties.private.reminderSent, '');
  });
  delete require.cache[handlerPath];
});

test('lost race: 409, and patchEvent is called a second time restoring the ORIGINAL start/end', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const isoOldStart = new Date(oldStart).toISOString();
  const isoOldEnd = new Date(oldEnd).toISOString();
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    // 'aaa-other' sorts first -> ours loses. Both carry the marker, so this
    // exercises the id tie-break rather than the foreign-clash shortcut.
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);

    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 2, 'the move must be undone');
    const [, restore] = patchSpy.calls[1];
    assert.equal(restore.start.dateTime, isoOldStart);
    assert.equal(restore.end.dateTime, isoOldEnd);
    assert.equal(restore.extendedProperties.private.reminderSent, '');
  });
  delete require.cache[handlerPath];
});

// A rolled-back move must not re-arm a reminder that was already sent, or the
// client gets a second reminder for a time the call was never moved to.
test('lost race: the rollback restores an already-sent reminderSent flag', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: checkinEvent({ startMs: oldStart, endMs: oldEnd, extra: { reminderSent: '1' } }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ] }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 409);
    assert.equal(patchSpy.calls.length, 2);
    assert.equal(patchSpy.calls[0][1].extendedProperties.private.reminderSent, '');
    assert.equal(patchSpy.calls[1][1].extendedProperties.private.reminderSent, '1');
  });
  delete require.cache[handlerPath];
});

// Omar converted the booking to an all-day event, so start.dateTime is absent
// and Date.parse yields NaN. new Date(NaN).toISOString() THROWS, which would
// 500 the request AND leave the event parked at the clashing new time.
test('lost race on an all-day event: a clean 409 without throwing, and no restoring patch', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const isoNewStart = new Date(newStart).toISOString();
  const isoNewEnd = new Date(newEnd).toISOString();

  const allDay = checkinEvent({ startMs: oldStart, endMs: oldEnd });
  allDay.start = { date: '2026-12-01' };
  allDay.end = { date: '2026-12-02' };

  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: allDay }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true,
        events: [
          listedOurs('aaa-other', isoNewStart, isoNewEnd),
          listedOurs(EVENT_ID, isoNewStart, isoNewEnd),
        ] }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: spyStub(undefined) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await assert.doesNotReject(() => h({ method: 'POST', body: goodBody(newStart) }, res));
    assert.equal(res._status, 409, 'must be a clean 409, not an unhandled RangeError');
    assert.equal(patchSpy.calls.length, 1,
      'only the move patch may run -- there is no valid original time to restore');
  });
  delete require.cache[handlerPath];
});

test('a failing listEvents keeps the move (fail-open) and alerts that the guard was skipped', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const alertSpy = spyStub(undefined);
  const logged = [];
  const realError = console.error;

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'google 500' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ]), async () => {
    const h = freshHandler();
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    try {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(newStart) }, res);
      assert.equal(res._status, 200, 'fail-open is deliberate');
    } finally {
      console.error = realError;
    }
    assert.ok(logged.some(l => /guard/i.test(l)));
    assert.equal(alertSpy.calls.length, 1);
    assert.match(String(alertSpy.calls[0][0]), new RegExp(EVENT_ID));
  });
  delete require.cache[handlerPath];
});

test('the CHECK-IN Slack and email senders are called, and the applicant ones never are', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;

  const ciSlack = spyStub({ ts: null });
  const ciEmail = spyStub({ ok: true });
  const appSlack = spyStub({ ts: null });
  const appEmail = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: { hangoutLink: 'https://meet.example/m' } }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, new Date(newStart).toISOString(), new Date(newEnd).toISOString())] }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: ciSlack },
    { obj: cemail, key: 'sendCheckinRescheduleNotice', value: ciEmail },
    { obj: bslack, key: 'postBookingChanged', value: appSlack },
    { obj: email, key: 'sendRescheduleNotice', value: appEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200);

    assert.equal(ciSlack.calls.length, 1);
    assert.equal(ciSlack.calls[0][1], 'rescheduled');
    assert.equal(ciSlack.calls[0][2], 'slack-ts-original', 'the original #8 message ts must be passed through');
    assert.equal(ciEmail.calls.length, 1);
    assert.equal(appSlack.calls.length, 0);
    assert.equal(appEmail.calls.length, 0);

    // The Booking object handed to both senders.
    const b = ciEmail.calls[0][0];
    assert.equal(b.eventId, EVENT_ID);
    assert.equal(b.name, 'Alice Client');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '5550100100');
    assert.equal(b.startMs, newStart);
    assert.equal(b.endMs, newEnd);
    assert.equal(b.visitorTimeZone, 'Europe/Istanbul');
    assert.equal(b.templateTimeZone, 'America/Toronto');
    assert.equal(b.meetLink, 'https://meet.example/m');
    assert.equal(b.lang, 'en');
    assert.equal(bt.verifyBookingToken(EVENT_ID, EMAIL, b.manageToken), true);
  });
  delete require.cache[handlerPath];
});

test('a wrong manage token -> 403 FORBIDDEN (loadBooking passthrough)', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs, endMs: startMs + 900000 }) }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs + 2 * 3600 * 1000, { token: 'wrong-token' }) }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
  });
  delete require.cache[handlerPath];
});

test('a missing eventId/email/token -> 400 BAD_REQUEST (loadBooking passthrough)', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs, endMs: startMs + 900000 }) }) },
  ]), async () => {
    const h = freshHandler();
    for (const missing of ['eventId', 'email', 'token']) {
      const body = goodBody(startMs + 2 * 3600 * 1000);
      delete body[missing];
      const res = makeRes();
      await h({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `missing ${missing} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
  delete require.cache[handlerPath];
});

test('an event that no longer exists -> 404 NOT_FOUND (loadBooking passthrough)', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: 'not found' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(startMs + 2 * 3600 * 1000) }, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'NOT_FOUND');
  });
  delete require.cache[handlerPath];
});

test('a malformed start -> 400 BAD_REQUEST', async () => {
  envSetup();
  const startMs = validSlotStartMs();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs, endMs: startMs + 900000 }) }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true, event: {} }) },
  ]), async () => {
    const h = freshHandler();
    for (const start of ['not-a-date', '']) {
      const res = makeRes();
      await h({ method: 'POST', body: goodBody(startMs, { start }) }, res);
      assert.equal(res._status, 400);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
  });
  delete require.cache[handlerPath];
});

test('a slot that fails the re-verify -> 409 without calling patchEvent', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'freeBusy', value: async () => ({
        ok: true, busy: [{ start: newStart - 3600000, end: newEnd + 3600000 }] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.error, 'SLOT_TAKEN');
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a failed patchEvent -> 502 UPSTREAM', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: false, reason: 'patch refused' }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(oldStart + 2 * 3600 * 1000) }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
  });
  delete require.cache[handlerPath];
});

test('BLOB_NOT_CONFIGURED -> 503 without calling patchEvent', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const patchSpy = spyStub({ ok: true, event: {} });
  await withStubs(baseStubs([
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: false, reason: store.BLOB_NOT_CONFIGURED, template: CHECKIN_TEMPLATE }) },
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(oldStart + 2 * 3600 * 1000) }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'BLOB_NOT_CONFIGURED');
    assert.equal(patchSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('a throwing Slack stub and a throwing email stub still result in a 200', async () => {
  envSetup();
  const oldStart = validSlotStartMs();
  const oldEnd = oldStart + 15 * 60 * 1000;
  const newStart = oldStart + 2 * 3600 * 1000;
  const newEnd = newStart + 15 * 60 * 1000;

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent({ startMs: oldStart, endMs: oldEnd }) }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: gcal, key: 'listEvents', value: async () => ({
        ok: true, events: [listedOurs(EVENT_ID, new Date(newStart).toISOString(), new Date(newEnd).toISOString())] }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => { throw new Error('slack is down'); } },
    { obj: cemail, key: 'sendCheckinRescheduleNotice', value: async () => { throw new Error('email is down'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody(newStart) }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
  });
  delete require.cache[handlerPath];
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await require('../api/calendar-checkin-reschedule')({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/calendar-checkin-reschedule.test.js`
Expected: FAIL — `Cannot find module '../api/calendar-checkin-reschedule'`.

- [ ] **Step 3: Write `api/calendar-checkin-reschedule.js`**

```js
// POST /api/calendar-checkin-reschedule
// { eventId, email, token, start (ISO), visitorTimeZone? }
//
// Mirrors calendar-reschedule.js exactly -- same own-interval filter, same
// rollback discipline, same reminderSent re-arm/restore handling -- reading the
// CHECK-IN template and calling the CHECK-IN senders.
//
// There is no self-serve UI linking here yet (matching the applicant
// precedent): the endpoint is built and tested, and a client who needs to move
// a call contacts Omar directly for now.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const guard = require('./_booking-guard');
const cslack = require('./_checkin-slack');
const cemail = require('./_checkin-email');
const { isCheckinEvent } = require('./_checkin-audience');
const { postSystemAlert } = require('./_slack');
const { makeBookingToken } = require('./_booking-token');
const { loadCheckinTemplate } = require('./_load-checkin-template');
const { loadBooking } = require('./_load-booking');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  // Unchanged and shared: proves the token is a valid HMAC over eventId+email,
  // that the event exists, that it carries the shared bookingSource marker, and
  // that meta.visitorEmail matches the supplied email.
  const loaded = await loadBooking(body);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ ok: false, error: loaded.error,
      message: loaded.message });
  }
  const { event, meta } = loaded;

  // DEFENSE IN DEPTH. manageToken is an HMAC over eventId+email only -- it
  // encodes no audience -- so nothing in loadBooking stops a token that is
  // genuinely valid for an APPLICANT booking from arriving here. A check-in
  // manage link must never be able to act on an applicant booking, even if some
  // future bug caused an eventId/email pair to be reused or guessed across
  // audiences. The message is identical to loadBooking's own, so the two
  // rejections are indistinguishable from outside.
  if (!isCheckinEvent(meta)) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN',
      message: 'That booking is not managed here.' });
  }

  const startMs = Date.parse(String(body.start || ''));
  if (!Number.isFinite(startMs)) {
    return res.status(400).json({ ok: false, error: 'BAD_REQUEST',
      message: 'start must be an ISO timestamp' });
  }

  const tplRes = await loadCheckinTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
    return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
      message: 'Booking storage is not set up yet.' });
  }
  const template = tplRes.template;
  const endMs = startMs + template.slotMinutes * 60 * 1000;

  const busyRes = await gcal.freeBusy(
    new Date(startMs - 86400000).toISOString(),
    new Date(endMs + 86400000).toISOString());
  if (!busyRes.ok) {
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not reach the calendar.' });
  }
  // The booking being moved is itself on the calendar, so it would otherwise
  // block its own new slot when the two windows overlap.
  const oldStart = Date.parse(event.start && event.start.dateTime);
  const oldEnd = Date.parse(event.end && event.end.dateTime);
  const busy = busyRes.busy.filter(b => !(b.start === oldStart && b.end === oldEnd));

  if (!av.slotExists({ template, startMs, busy, nowMs: Date.now() })) {
    return res.status(409).json({ ok: false, error: 'SLOT_TAKEN',
      message: 'That time is no longer available.' });
  }

  // Captured BEFORE the move clears it: if the move is rolled back below, a
  // booking that had already been reminded must not be re-armed and reminded a
  // second time.
  const originalReminderSent = meta.reminderSent || '';

  const patched = await gcal.patchEvent(event.id, {
    start: { dateTime: new Date(startMs).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endMs).toISOString(), timeZone: 'UTC' },
    // A moved call needs its reminder again.
    extendedProperties: { private: { reminderSent: '' } },
  });
  if (!patched.ok) {
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not move the booking.' });
  }

  // Same non-atomic window as booking: re-check and undo if we lost the race.
  const after = await gcal.listEvents({
    timeMinIso: new Date(startMs - 1000).toISOString(),
    timeMaxIso: new Date(endMs + 1000).toISOString(),
  });
  if (after.ok) {
    const clash = guard.overlapping(after.events, startMs, endMs);
    if (guard.shouldRollBack(event.id, clash)) {
      if (Number.isFinite(oldStart) && Number.isFinite(oldEnd)) {
        await gcal.patchEvent(event.id, {
          start: { dateTime: new Date(oldStart).toISOString(), timeZone: 'UTC' },
          end: { dateTime: new Date(oldEnd).toISOString(), timeZone: 'UTC' },
          // Undo the reminder re-arm too, or a booking that was already reminded
          // gets reminded twice after a lost race.
          extendedProperties: { private: { reminderSent: originalReminderSent } },
        });
      } else {
        // The booking had no dateTime to begin with -- it was converted to an
        // all-day event in Google Calendar. There is no original time to
        // restore, and new Date(NaN).toISOString() would throw a RangeError,
        // 500ing this request AND leaving the event parked at the clashing new
        // time. Yield the 409 and make the un-restorable state loud instead.
        console.error('check-in reschedule rollback could NOT restore the original time for event',
          event.id, '-- start/end carried no dateTime (all-day or malformed);',
          'the event is left at the new time and needs manual attention');
        await postSystemAlert(`:warning: *Check-in reschedule rollback FAILED* for event \`${event.id}\` -- `
          + `could not restore the original time (no valid start/end dateTime). The event is left `
          + `at the new, clashing time. Needs manual attention.`);
      }
      return res.status(409).json({ ok: false, error: 'SLOT_TAKEN',
        message: 'Someone took that time a moment before you.' });
    }
  } else {
    // Fail open, as in calendar-checkin-book.js: the move already happened. But
    // this is the only double-booking protection on this path, so log and alert.
    console.error('double-booking guard SKIPPED for check-in event', event.id,
      '-- listEvents failed:', after.reason);
    await postSystemAlert(`*Double-booking guard skipped* on CHECK-IN reschedule for event \`${event.id}\` -- `
      + `listEvents failed: ${after.reason}. Verify manually there's no clash.`);
  }

  const visitorTimeZone = tz.isValidTimeZone(body.visitorTimeZone)
    ? body.visitorTimeZone
    : (tz.isValidTimeZone(meta.visitorTimeZone) ? meta.visitorTimeZone : 'UTC');

  const booking = {
    eventId: event.id, name: meta.visitorName || '—', email: meta.visitorEmail,
    phone: meta.visitorPhone || '', startMs, endMs,
    visitorTimeZone, templateTimeZone: template.timezone,
    manageToken: makeBookingToken(event.id, meta.visitorEmail),
    meetLink: gcal.meetLinkFor(patched.event), lang: meta.lang || 'en',
  };

  try { await cslack.postCheckinBookingChanged(booking, 'rescheduled', meta.slackTs || null); }
  catch (e) { console.error('check-in reschedule slack failed:', e.message); }
  try {
    const sent = await cemail.sendCheckinRescheduleNotice(booking);
    if (!sent.ok) {
      console.error('check-in reschedule email failed:', sent.reason);
      await postSystemAlert(`*Check-in reschedule email failed* for \`${event.id}\` (${meta.visitorEmail}): ${sent.reason}`);
    }
  } catch (e) {
    console.error('check-in reschedule email threw:', e.message);
    await postSystemAlert(`*Check-in reschedule email threw* for \`${event.id}\` (${meta.visitorEmail}): ${e.message}`);
  }

  return res.status(200).json({ ok: true, eventId: event.id,
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/calendar-checkin-reschedule.test.js`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add api/calendar-checkin-reschedule.js test/calendar-checkin-reschedule.test.js
git commit -m "feat: add check-in reschedule endpoint with audience guard"
```

---

### Task 12: Check-in cancel endpoint

**Files:**
- Create: `api/calendar-checkin-cancel.js`
- Test: `test/calendar-checkin-cancel.test.js`

**Interfaces:**
- Consumes: `loadBooking` (unchanged `api/_load-booking.js`); `isCheckinEvent` (Task 1); `loadCheckinTemplate` (Task 5); `postCheckinBookingChanged` (Task 8); `sendCheckinCancellationNotice` (Task 9); `gcal.deleteEvent`; `postSystemAlert`.
- Produces:
  - `POST /api/calendar-checkin-cancel` with body `{ eventId, email, token }`
  - `200 { ok:true }`
  - `400 BAD_REQUEST` · `403 FORBIDDEN` · `404 NOT_FOUND` · `503 CALENDAR_NOT_CONNECTED` · `502 UPSTREAM` · `405`

**The audience check must run before `deleteEvent`.** A 403 that arrives after the event is already gone is not a rejection.

- [ ] **Step 1: Write the failing test**

Create `test/calendar-checkin-cancel.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const cslack = require('../api/_checkin-slack');
const cemail = require('../api/_checkin-email');
const bslack = require('../api/_booking-slack');
const email = require('../api/_email');
const bt = require('../api/_booking-token');
const loadMod = require('../api/_load-checkin-template');
const av = require('../api/_availability');

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

const handlerPath = require.resolve('../api/calendar-checkin-cancel');
function freshHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

const CHECKIN_TEMPLATE = av.normalizeTemplate({
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '12:00' },
    tue: { enabled: true, start: '09:00', end: '12:00' },
    wed: { enabled: true, start: '09:00', end: '12:00' },
    thu: { enabled: true, start: '09:00', end: '12:00' },
    fri: { enabled: true, start: '09:00', end: '12:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 15, bufferMinutes: 0, minNoticeHours: 24,
});

const EVENT_ID = 'evt-checkin-cancel-1';
const EMAIL = 'alice@example.com';
const START_MS = Date.UTC(2026, 10, 12, 14, 0, 0);
const END_MS = START_MS + 15 * 60 * 1000;

function checkinEvent(overrides = {}) {
  return {
    id: EVENT_ID,
    start: { dateTime: new Date(START_MS).toISOString() },
    end: { dateTime: new Date(END_MS).toISOString() },
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        audience: 'checkin',
        visitorEmail: EMAIL,
        visitorName: 'Alice Client',
        visitorPhone: '5550100100',
        visitorTimeZone: 'Europe/Istanbul',
        lang: 'en',
        slackTs: 'slack-ts-original',
        ...(overrides.privateExtra || {}),
      },
    },
    ...(overrides.event || {}),
  };
}

function applicantEvent() {
  const e = checkinEvent();
  delete e.extendedProperties.private.audience;
  return e;
}

function goodBody(overrides = {}) {
  return {
    eventId: EVENT_ID,
    email: EMAIL,
    token: bt.makeBookingToken(EVENT_ID, EMAIL),
    ...overrides,
  };
}

function baseStubs(extra = []) {
  return [
    { obj: loadMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: CHECKIN_TEMPLATE, usedDefault: false }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => ({ ts: null }) },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: async () => ({ ok: true }) },
    ...extra,
  ];
}

test('happy path: 200 {ok:true} and deleteEvent is called with the event id', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
    assert.equal(deleteSpy.calls.length, 1);
    assert.equal(deleteSpy.calls[0][0], EVENT_ID);
  });
  delete require.cache[handlerPath];
});

// The audience check has to run BEFORE the delete: a 403 that arrives after the
// event is already gone is not a rejection.
test('an APPLICANT event -> 403 FORBIDDEN and deleteEvent is NEVER called', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: applicantEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.error, 'FORBIDDEN');
    assert.equal(deleteSpy.calls.length, 0,
      'a check-in link must never cancel an applicant booking');
  });
  delete require.cache[handlerPath];
});

test('an event tagged with some OTHER audience -> 403 and no delete', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true,
        event: checkinEvent({ privateExtra: { audience: 'something-else' } }) }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 403);
    assert.equal(deleteSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];
});

test('the CHECK-IN Slack and email senders are called with the cancelled Booking; applicant ones never are', async () => {
  envSetup();
  const ciSlack = spyStub({ ts: null });
  const ciEmail = spyStub({ ok: true });
  const appSlack = spyStub({ ts: null });
  const appEmail = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: ciSlack },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: ciEmail },
    { obj: bslack, key: 'postBookingChanged', value: appSlack },
    { obj: email, key: 'sendCancellationNotice', value: appEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);

    assert.equal(ciSlack.calls.length, 1);
    assert.equal(ciSlack.calls[0][1], 'cancelled');
    assert.equal(ciSlack.calls[0][2], 'slack-ts-original');
    assert.equal(ciEmail.calls.length, 1);
    assert.equal(appSlack.calls.length, 0);
    assert.equal(appEmail.calls.length, 0);

    const b = ciEmail.calls[0][0];
    assert.equal(b.eventId, EVENT_ID);
    assert.equal(b.name, 'Alice Client');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '5550100100');
    assert.equal(b.startMs, START_MS);
    assert.equal(b.endMs, END_MS);
    assert.equal(b.visitorTimeZone, 'Europe/Istanbul');
    assert.equal(b.templateTimeZone, 'America/Toronto');
    assert.equal(b.lang, 'en');
    // Nothing to manage after a cancellation.
    assert.equal(b.manageToken, '');
    assert.equal(b.meetLink, '');
  });
  delete require.cache[handlerPath];
});

test('a wrong token -> 403, a missing field -> 400, a vanished event -> 404 (loadBooking passthrough)', async () => {
  envSetup();
  const deleteSpy = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();

    const wrong = makeRes();
    await h({ method: 'POST', body: goodBody({ token: 'wrong-token' }) }, wrong);
    assert.equal(wrong._status, 403);
    assert.equal(wrong._json.error, 'FORBIDDEN');

    for (const missing of ['eventId', 'email', 'token']) {
      const body = goodBody();
      delete body[missing];
      const res = makeRes();
      await h({ method: 'POST', body }, res);
      assert.equal(res._status, 400, `missing ${missing} should be 400`);
      assert.equal(res._json.error, 'BAD_REQUEST');
    }
    assert.equal(deleteSpy.calls.length, 0);
  });
  delete require.cache[handlerPath];

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: 'not found' }) },
    { obj: gcal, key: 'deleteEvent', value: spyStub({ ok: true }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.error, 'NOT_FOUND');
  });
  delete require.cache[handlerPath];
});

test('an email whose case differs from the stored one still cancels', async () => {
  envSetup();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    // makeBookingToken normalizes the email, so an upper-case address produces
    // the same token and loadBooking's own comparison is normalized too.
    await h({ method: 'POST', body: {
      eventId: EVENT_ID,
      email: 'ALICE@EXAMPLE.COM',
      token: bt.makeBookingToken(EVENT_ID, 'ALICE@EXAMPLE.COM'),
    } }, res);
    assert.equal(res._status, 200);
  });
  delete require.cache[handlerPath];
});

test('a failed deleteEvent -> 502 UPSTREAM, and no cancellation notice is sent', async () => {
  envSetup();
  const ciEmail = spyStub({ ok: true });
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: false, reason: 'delete refused' }) },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: ciEmail },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.error, 'UPSTREAM');
    assert.equal(ciEmail.calls.length, 0,
      'never tell a client their call is cancelled when it is still on the calendar');
  });
  delete require.cache[handlerPath];
});

test('CALENDAR_NOT_CONNECTED -> 503 (loadBooking passthrough)', async () => {
  envSetup();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: false, reason: gcal.NOT_CONNECTED }) },
    { obj: gcal, key: 'deleteEvent', value: spyStub({ ok: true }) },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 503);
    assert.equal(res._json.error, 'CALENDAR_NOT_CONNECTED');
  });
  delete require.cache[handlerPath];
});

// The slot is already freed, which is what the client asked for, so notification
// failures must not turn a successful cancellation into an error.
test('a throwing Slack stub and a throwing email stub still result in a 200', async () => {
  envSetup();
  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: checkinEvent() }) },
    { obj: gcal, key: 'deleteEvent', value: async () => ({ ok: true }) },
    { obj: cslack, key: 'postCheckinBookingChanged', value: async () => { throw new Error('slack is down'); } },
    { obj: cemail, key: 'sendCheckinCancellationNotice', value: async () => { throw new Error('email is down'); } },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await h({ method: 'POST', body: goodBody() }, res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json, { ok: true });
  });
  delete require.cache[handlerPath];
});

test('an all-day event still cancels without throwing', async () => {
  envSetup();
  const allDay = checkinEvent();
  allDay.start = { date: '2026-12-01' };
  allDay.end = { date: '2026-12-02' };
  const deleteSpy = spyStub({ ok: true });

  await withStubs(baseStubs([
    { obj: gcal, key: 'getEvent', value: async () => ({ ok: true, event: allDay }) },
    { obj: gcal, key: 'deleteEvent', value: deleteSpy },
  ]), async () => {
    const h = freshHandler();
    const res = makeRes();
    await assert.doesNotReject(() => h({ method: 'POST', body: goodBody() }, res));
    assert.equal(res._status, 200);
    assert.equal(deleteSpy.calls.length, 1);
  });
  delete require.cache[handlerPath];
});

test('non-POST requests return 405', async () => {
  envSetup();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = makeRes();
    await require('../api/calendar-checkin-cancel')({ method, body: {} }, res);
    assert.equal(res._status, 405);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/calendar-checkin-cancel.test.js`
Expected: FAIL — `Cannot find module '../api/calendar-checkin-cancel'`.

- [ ] **Step 3: Write `api/calendar-checkin-cancel.js`**

```js
// POST /api/calendar-checkin-cancel
// { eventId, email, token }
//
// Mirrors calendar-cancel.js, calling the CHECK-IN senders. As with the
// reschedule endpoint, nothing links here yet -- it is built and tested, and a
// client who needs to cancel contacts Omar directly for now.
const gcal = require('./_google-calendar');
const cslack = require('./_checkin-slack');
const cemail = require('./_checkin-email');
const { isCheckinEvent } = require('./_checkin-audience');
const { postSystemAlert } = require('./_slack');
const { loadCheckinTemplate } = require('./_load-checkin-template');
const { loadBooking } = require('./_load-booking');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const loaded = await loadBooking(req.body || {});
  if (!loaded.ok) {
    return res.status(loaded.status).json({ ok: false, error: loaded.error,
      message: loaded.message });
  }
  const { event, meta } = loaded;

  // DEFENSE IN DEPTH, and it MUST come before the delete: a 403 that arrives
  // after the event is already gone is not a rejection. manageToken encodes no
  // audience, so nothing upstream stops an applicant booking's token arriving
  // here. Same message as loadBooking's own, so the two are indistinguishable
  // from outside.
  if (!isCheckinEvent(meta)) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN',
      message: 'That booking is not managed here.' });
  }

  // Read off the event BEFORE deleting it -- afterwards there is nothing to read.
  const startMs = Date.parse(event.start && event.start.dateTime) || Date.now();
  const endMs = Date.parse(event.end && event.end.dateTime) || startMs;

  const deleted = await gcal.deleteEvent(event.id);
  if (!deleted.ok) {
    // No notification on this path: never tell a client their call is cancelled
    // while it is still on the calendar.
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not cancel the booking.' });
  }

  const tplRes = await loadCheckinTemplate();
  const booking = {
    eventId: event.id, name: meta.visitorName || '—', email: meta.visitorEmail,
    phone: meta.visitorPhone || '', startMs, endMs,
    visitorTimeZone: meta.visitorTimeZone || 'UTC',
    templateTimeZone: tplRes.template.timezone,
    // Nothing left to manage, and no call left to join.
    manageToken: '', meetLink: '', lang: meta.lang || 'en',
  };

  // Best-effort: the slot is already freed, which is what the client asked for.
  try { await cslack.postCheckinBookingChanged(booking, 'cancelled', meta.slackTs || null); }
  catch (e) { console.error('check-in cancel slack failed:', e.message); }
  try {
    const sent = await cemail.sendCheckinCancellationNotice(booking);
    if (!sent.ok) {
      console.error('check-in cancellation email failed:', sent.reason);
      await postSystemAlert(`*Check-in cancellation email failed* for \`${event.id}\` (${meta.visitorEmail}): ${sent.reason}`);
    }
  } catch (e) {
    console.error('check-in cancellation email threw:', e.message);
    await postSystemAlert(`*Check-in cancellation email threw* for \`${event.id}\` (${meta.visitorEmail}): ${e.message}`);
  }

  return res.status(200).json({ ok: true });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/calendar-checkin-cancel.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add api/calendar-checkin-cancel.js test/calendar-checkin-cancel.test.js
git commit -m "feat: add check-in cancel endpoint with audience guard"
```

---

### Task 13: Branch the reminders cron on audience

**Files:**
- Modify: `api/calendar-reminders.js` — the require block at `:8-14`, and the per-event body of the loop at `:85-131`
- Test: extend `test/calendar-reminders.test.js` (append new tests; change no existing ones)

**Interfaces:**
- Consumes: `isCheckinEvent(meta)` (Task 1); `sendCheckinReminder(b)` (Task 9); `loadCheckinTemplate` (Task 5).
- Produces: no new exports. `handler.leadHours`, `handler.reminderWindow`, `handler.wouldRemind` stay exactly as they are — `test/reminder-delivery-guarantee.test.js` proves the delivery invariant against them and must keep passing untouched.

**Why one cron, not two.** Vercel's Hobby plan caps the number and frequency of cron jobs, and this project already spends its one daily slot on `/api/calendar-reminders`. The existing loop already walks every event carrying the shared `bookingSource` marker — which now includes check-ins — so branching inside it is both the only option and the correct one. Everything the delivery guarantee rests on (the `min(minNoticeHours, REMINDER_LEAD_HOURS) >= cronPeriodHours` invariant, "flag after send, never before", per-item isolation) applies identically to both audiences because it is the same loop.

**Both templates are loaded up front**, once per run, rather than lazily inside the loop. That is one extra blob read per day; making it conditional would add a branch to the one function whose failure mode is a silently missed reminder.

- [ ] **Step 1: Write the failing tests**

Append to `test/calendar-reminders.test.js`. First add these requires at the top of the file, next to the existing ones:

```js
const cemail = require('../api/_checkin-email');
const loadCheckinMod = require('../api/_load-checkin-template');
```

Then append these tests to the end of the file:

```js
// ---- audience branching -------------------------------------------------
// calendar-reminders.js is ONE cron job serving both audiences (Vercel Hobby
// caps cron count/frequency, and this project already spends its single daily
// slot here). The loop already walks every event carrying the shared
// bookingSource marker, so the only thing that must be right is which sender
// each event gets.

function makeCheckinEvent({ id, startMs, endMs, visitorEmail = EMAIL, reminderSent }) {
  // The existing makeEvent already merges `extra` into extendedProperties.private,
  // so the only difference from an applicant fixture is the audience tag.
  return makeEvent({ id, startMs, endMs, visitorEmail, reminderSent,
    extra: { audience: 'checkin' } });
}

test('a checkin-tagged event goes to sendCheckinReminder, never to the applicant sendReminder', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 1);
    assert.equal(ciSpy.calls.length, 1, 'the check-in sender must be used');
    assert.equal(appSpy.calls.length, 0, 'the applicant sender must NOT be used');
  });
});

test('an untagged (applicant) event still goes to the applicant sendReminder', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(appSpy.calls.length, 1);
    assert.equal(ciSpy.calls.length, 0);
  });
});

test('a mixed batch routes each event to its own sender in ONE run', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app-1', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci-1', startMs: futureMs(3) }),
        makeEvent({ id: 'evt-app-2', startMs: futureMs(4) }),
        makeCheckinEvent({ id: 'evt-ci-2', startMs: futureMs(5) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.considered, 4);
    assert.equal(res._json.sent, 4);
    assert.deepEqual(appSpy.calls.map(c => c[0].eventId).sort(), ['evt-app-1', 'evt-app-2']);
    assert.deepEqual(ciSpy.calls.map(c => c[0].eventId).sort(), ['evt-ci-1', 'evt-ci-2']);
  });
});

// A check-in booked against a DIFFERENT timezone than the applicant hours must
// be described to Omar in the check-in template's zone, not the applicant one.
test('a check-in reminder carries the CHECK-IN template timezone; an applicant one carries the applicant zone', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  const checkinTpl = av.normalizeTemplate({
    timezone: 'Europe/Istanbul',
    days: av.DEFAULT_TEMPLATE.days,
    slotMinutes: 15, bufferMinutes: 0, minNoticeHours: 24,
  });
  await withStubs([
    { obj: loadCheckinMod, key: 'loadCheckinTemplate', value: async () => ({ ok: true, template: checkinTpl, usedDefault: false }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(ciSpy.calls[0][0].templateTimeZone, 'Europe/Istanbul');
    assert.equal(appSpy.calls[0][0].templateTimeZone, 'America/Toronto');
  });
});

test('a check-in reminder receives the full Booking shape the check-in senders expect', async () => {
  envSetup();
  const ciSpy = spyStub({ ok: true });
  const startMs = futureMs(2);
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-shape', startMs, endMs: startMs + 15 * 60000 }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    const b = ciSpy.calls[0][0];
    assert.equal(b.eventId, 'evt-shape');
    assert.equal(b.name, 'Jane Doe');
    assert.equal(b.email, EMAIL);
    assert.equal(b.phone, '555-0100');
    assert.equal(b.startMs, startMs);
    assert.equal(b.endMs, startMs + 15 * 60000);
    assert.equal(b.visitorTimeZone, 'America/Toronto');
    assert.equal(typeof b.templateTimeZone, 'string');
    assert.equal(typeof b.manageToken, 'string');
    assert.ok(b.manageToken.length > 0);
    assert.equal(b.meetLink, 'https://meet.example/abc');
    assert.equal(b.lang, 'en');
  });
});

test('an already-reminded check-in event is skipped, exactly like an applicant one', async () => {
  envSetup();
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-done', startMs: futureMs(2), reminderSent: '1' }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.sent, 0);
    assert.equal(res._json.skipped, 1);
    assert.equal(ciSpy.calls.length, 0);
  });
});

test('a successful check-in reminder sets reminderSent AFTER the send, never before', async () => {
  envSetup();
  const order = [];
  const patchSpy = async (...args) => { order.push('patch'); return { ok: true, event: {} }; };
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-flag', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: async () => { order.push('send'); return { ok: true }; } },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.sent, 1);
    assert.deepEqual(order, ['send', 'patch'],
      'a duplicate reminder is a far smaller failure than a call the client forgets');
  });
});

test('a failing check-in reminder leaves the flag unset and raises a system alert', async () => {
  envSetup();
  const patchSpy = spyStub({ ok: true, event: {} });
  const alertSpy = spyStub(undefined);
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-mailfail', startMs: futureMs(2) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: async () => ({ ok: false, reason: 'resend 422' }) },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: alertSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.sent, 0);
    assert.equal(res._json.skipped, 1);
    assert.equal(patchSpy.calls.length, 0, 'the flag must stay unset so a later run can retry');
    assert.equal(alertSpy.calls.length, 1);
    assert.match(String(alertSpy.calls[0][0]), /evt-mailfail/);
  });
});

// Per-item isolation: one throwing check-in must not sink the applicant events
// in the same batch.
test('a throwing check-in sender does not prevent the other events in the batch from being reminded', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-boom', startMs: futureMs(2) }),
        makeEvent({ id: 'evt-fine', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: async () => { throw new Error('boom'); } },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: require('../api/_slack'), key: 'postSystemAlert', value: async () => {} },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 1);
    assert.equal(res._json.skipped, 1);
    assert.equal(appSpy.calls.length, 1, 'the applicant event must still be reminded');
  });
});

test('a check-in event with no visitorEmail is skipped without sending', async () => {
  envSetup();
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeCheckinEvent({ id: 'evt-noemail', startMs: futureMs(2), visitorEmail: null }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._json.skipped, 1);
    assert.equal(ciSpy.calls.length, 0);
  });
});

// A failed check-in template read must not stop applicant reminders, and must
// not stop check-in reminders either -- loadCheckinTemplate always returns a
// usable default template alongside its !ok.
test('a failing check-in template read still reminds both audiences', async () => {
  envSetup();
  const appSpy = spyStub({ ok: true });
  const ciSpy = spyStub({ ok: true });
  await withStubs([
    { obj: loadCheckinMod, key: 'loadCheckinTemplate', value: async () => ({
        ok: false, reason: 'blob get 500', template: av.normalizeTemplate(av.DEFAULT_TEMPLATE) }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [
        makeEvent({ id: 'evt-app', startMs: futureMs(2) }),
        makeCheckinEvent({ id: 'evt-ci', startMs: futureMs(3) }),
      ] }) },
    { obj: gcal, key: 'patchEvent', value: async () => ({ ok: true, event: {} }) },
    { obj: email, key: 'sendReminder', value: appSpy },
    { obj: cemail, key: 'sendCheckinReminder', value: ciSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.sent, 2);
    assert.equal(ciSpy.calls[0][0].templateTimeZone, 'America/Toronto');
  });
});
```

The new tests reference `av`, so add this require alongside the others at the top of `test/calendar-reminders.test.js` if it is not already there:

```js
const av = require('../api/_availability');
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --test test/calendar-reminders.test.js`
Expected: the pre-existing tests PASS; the new audience tests FAIL — the check-in sender is never called because the loop still calls `email.sendReminder` for every event.

- [ ] **Step 3: Add the three requires**

In `api/calendar-reminders.js`, add to the require block (after the existing `const email = require('./_email');` on line 10):

```js
const cemail = require('./_checkin-email');
const { isCheckinEvent } = require('./_checkin-audience');
const { loadCheckinTemplate } = require('./_load-checkin-template');
```

- [ ] **Step 4: Load both templates up front**

Replace the single template load (currently `const tplRes = await loadTemplate();` at line 82) with:

```js
  // BOTH templates, once per run. The two audiences may sit in different
  // timezones, and the reminder has to describe the call in the right one.
  // Making the second read conditional on the batch containing a check-in would
  // add a branch to the one function whose failure mode is a silently missed
  // reminder -- one extra blob read a day is the cheaper trade.
  //
  // Neither loader can fail destructively: both return a usable normalized
  // template alongside a !ok, so a blob hiccup degrades the displayed timezone
  // rather than dropping the reminder.
  const tplRes = await loadTemplate();
  const checkinTplRes = await loadCheckinTemplate();
```

- [ ] **Step 5: Branch inside the loop**

In the `for (const event of listed.events)` body, replace the `try { const result = await email.sendReminder({...}); ... }` block with the version below. Everything outside the two marked lines is unchanged — the skip conditions, the flag-after-send ordering, the alerts and the per-item isolation all stay exactly as they are.

```js
    // The ONE audience decision in this loop. `audience` is absent on every
    // applicant booking (calendar-book.js never writes it), so the default is
    // the applicant sender and no existing behaviour changes.
    const isCheckin = isCheckinEvent(meta);
    const sendReminderFor = isCheckin ? cemail.sendCheckinReminder : email.sendReminder;
    const templateTimeZone = isCheckin
      ? checkinTplRes.template.timezone
      : tplRes.template.timezone;

    try {
      const result = await sendReminderFor({
        eventId: event.id,
        name: meta.visitorName || '—',
        email: meta.visitorEmail,
        phone: meta.visitorPhone || '',
        startMs,
        endMs: Date.parse(event.end && event.end.dateTime) || startMs,
        visitorTimeZone: meta.visitorTimeZone || 'UTC',
        templateTimeZone,
        manageToken: makeBookingToken(event.id, meta.visitorEmail),
        meetLink: gcal.meetLinkFor(event),
        lang: meta.lang || 'en',
      });

      if (result.ok) {
        await gcal.patchEvent(event.id, {
          extendedProperties: { private: { reminderSent: '1' } },
        });
        sent++;
      } else {
        // Leave the flag unset so the next run retries -- though with the
        // current cron/window settings there's exactly one eligible tick per
        // booking, so in practice this recipient gets no reminder at all.
        // That's exactly why this alert matters: it's the only signal anyone
        // gets that it happened.
        console.error('reminder failed for', event.id, result.reason);
        await postSystemAlert(`*Reminder send failed* for \`${event.id}\` (${meta.visitorEmail || 'unknown'})`
          + `${isCheckin ? ' [check-in]' : ''}: ${result.reason}. `
          + `With the current settings this booking likely gets no reminder at all.`);
        skipped++;
      }
    } catch (e) {
      // Per-item isolation: one bad event must not sink the whole batch, and it
      // must NOT be marked reminded -- the next run should retry it.
      console.error('reminder threw for', event.id, e.message);
      await postSystemAlert(`*Reminder send threw* for \`${event.id}\` (${meta.visitorEmail || 'unknown'})`
        + `${isCheckin ? ' [check-in]' : ''}: ${e.message}. `
        + `With the current settings this booking likely gets no reminder at all.`);
      skipped++;
    }
```

- [ ] **Step 6: Run the reminders tests to verify they pass**

Run: `node --test test/calendar-reminders.test.js`
Expected: PASS — every pre-existing test plus the 11 new audience tests.

- [ ] **Step 7: Run the delivery-guarantee test explicitly**

Run: `node --test test/reminder-delivery-guarantee.test.js`
Expected: PASS, unchanged. It proves the `min(minNoticeHours, REMINDER_LEAD_HOURS) >= cronPeriodHours` invariant against the real `leadHours` / `reminderWindow` / `wouldRemind` exports. This task must not have touched them; a failure here means the window arithmetic was altered.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add api/calendar-reminders.js test/calendar-reminders.test.js
git commit -m "feat: branch the reminders cron on event audience"
```

---

### Task 14: Admin tab bar, check-in hours form, and client manager

**Files:**
- Modify: `admin.html` — `<style>` block (add tab-bar and table rules), the `#app` markup (`:222-293`), and the inline `<script>` (`:295-567`)
- Test: `test/admin-page-structure.test.js`

**Interfaces:**
- Consumes: `GET/POST /api/admin/checkin-availability` (Task 5) and `GET/POST/DELETE /api/admin/checkin-clients` (Task 4). No new server code.
- Produces: no JS module exports (`admin.html` is a static page with no bundler). The contract later work relies on is the set of element ids listed in the test below.

**Layout decision.** Readiness and Connect Calendar stay **above** the tab bar. They are audience-agnostic infrastructure — one Blob store, one OAuth connection, one Resend key — and putting them inside the "New Applicants" tab would wrongly imply they are scoped to that audience. The tab bar sits directly below them and switches between two panels:

- **New Applicants** (first, default) → the existing `#availabilityPanel`, its markup and its ids unchanged.
- **Check-Ins** → two stacked sections, matching the spec: the check-in hours form (a mirror of the applicant one) and the client-list manager.

**Id-prefix scheme.** Every field in the hours form is addressed by `prefix + baseId`. The applicant prefix is the empty string, so **every existing id stays exactly as it is** — no churn in the working form — and the check-in prefix is `chk-`. The build/populate/collect helpers all take that prefix.

- [ ] **Step 1: Write the failing test**

Create `test/admin-page-structure.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function idsIn(source) {
  const out = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

// The one failure mode of a two-form page built by duplicating a one-form page:
// a copied id, which makes document.getElementById silently return the wrong
// field and one form quietly edit the other's values.
test('no id appears twice in admin.html', () => {
  const ids = idsIn(html);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('the existing applicant ids are all still present and unrenamed', () => {
  const required = [
    'gate', 'gateForm', 'passcodeInput', 'gateError', 'app',
    'readinessPanel', 'blobConfigured', 'calendarConnected', 'resendConfigured',
    'redirectUri', 'blockersList',
    'connectPanel', 'connectSuccess', 'connectState', 'connectBtn',
    'availabilityPanel', 'storageMissingNote', 'availabilityForm',
    'daysRows', 'slotMinutes', 'bufferMinutes', 'minNoticeHours',
    'timezoneInput', 'tzList', 'tzNow', 'formErrors', 'formSuccess',
  ];
  const ids = new Set(idsIn(html));
  for (const id of required) {
    assert.ok(ids.has(id), `existing id "${id}" went missing`);
  }
});

test('the tab bar and both panels exist', () => {
  const ids = new Set(idsIn(html));
  for (const id of ['tabBar', 'tabApplicants', 'tabCheckins', 'panelApplicants', 'panelCheckins']) {
    assert.ok(ids.has(id), `missing tab element "${id}"`);
  }
  // The applicant panel must WRAP the existing availability panel, not replace it.
  const wrapStart = html.indexOf('id="panelApplicants"');
  const availAt = html.indexOf('id="availabilityPanel"');
  const checkinsAt = html.indexOf('id="panelCheckins"');
  assert.ok(wrapStart !== -1 && availAt > wrapStart,
    'the existing availability panel must live inside panelApplicants');
  assert.ok(checkinsAt > availAt, 'panelCheckins must come after the applicant panel');
});

test('Readiness and Connect Calendar sit ABOVE the tab bar, not inside a tab', () => {
  const readiness = html.indexOf('id="readinessPanel"');
  const connect = html.indexOf('id="connectPanel"');
  const tabBar = html.indexOf('id="tabBar"');
  assert.ok(readiness !== -1 && connect !== -1 && tabBar !== -1);
  assert.ok(readiness < tabBar, 'readinessPanel must precede the tab bar');
  assert.ok(connect < tabBar, 'connectPanel must precede the tab bar');
});

test('the check-in hours form mirrors the applicant one with a chk- prefix on every field', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'chk-availabilityPanel', 'chk-storageMissingNote', 'chk-availabilityForm',
    'chk-daysRows', 'chk-slotMinutes', 'chk-bufferMinutes', 'chk-minNoticeHours',
    'chk-timezoneInput', 'chk-tzList', 'chk-tzNow', 'chk-formErrors', 'chk-formSuccess',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing check-in hours id "${id}"`);
  }
});

test('the client manager has a table body, an add form, and its message slots', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'clientsPanel', 'clientsTableBody', 'clientsEmpty', 'clientsStorageMissingNote',
    'clientAddForm', 'clientName', 'clientEmail', 'clientPhone',
    'clientErrors', 'clientSuccess',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing client-manager id "${id}"`);
  }
});

// Email is the record key and the only channel notices go through, so the add
// form must not let it be submitted empty.
test('the client email input is required and typed as an email; name and phone are not required', () => {
  const emailInput = html.match(/<input[^>]*id="clientEmail"[^>]*>/);
  assert.ok(emailInput, 'clientEmail input not found');
  assert.match(emailInput[0], /\brequired\b/);
  assert.match(emailInput[0], /type="email"/);

  for (const id of ['clientName', 'clientPhone']) {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(input, `${id} input not found`);
    assert.equal(/\brequired\b/.test(input[0]), false, `${id} must NOT be required`);
  }
});

test('the page talks to all four admin endpoints and to no visitor-facing one', () => {
  for (const url of [
    '/api/admin/status', '/api/admin/login',
    '/api/admin/availability', '/api/admin/checkin-availability',
    '/api/admin/checkin-clients',
  ]) {
    assert.ok(html.includes(url), `admin.html must call ${url}`);
  }
  // The admin page must never drive the visitor endpoints.
  for (const url of ['/api/calendar-checkin-book', '/api/checkin-verify', '/api/calendar-book']) {
    assert.equal(html.includes(url), false, `admin.html must not call ${url}`);
  }
});

test('the DELETE call sends the email in a JSON body', () => {
  // The endpoint accepts a query fallback, but the page uses the body -- the
  // documented path -- so assert that is what ships.
  assert.match(html, /method:\s*'DELETE'/);
  const idx = html.indexOf("method: 'DELETE'");
  const window = html.slice(idx, idx + 400);
  assert.match(window, /JSON\.stringify\(\{\s*email/);
});

test('the tab bar is keyboard-reachable: both tabs are real buttons with aria state', () => {
  for (const id of ['tabApplicants', 'tabCheckins']) {
    const el = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(el, `${id} must be a <button>, not a div`);
    assert.match(el[0], /aria-selected=/, `${id} must carry aria-selected`);
  }
  assert.match(html, /role="tablist"/);
});

// The new rules must reuse the site's tokens rather than inventing colours.
test('the new CSS uses the existing custom properties and introduces no new colour literals', () => {
  for (const token of ['--void', '--band-2', '--gold', '--gold-lo', '--bone', '--dim', '--ink', '--slab']) {
    assert.ok(html.includes(token), `${token} must still be defined/used`);
  }

  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const from = styleBlock.indexOf('/* ══ tab bar ══ */');
  assert.ok(from !== -1, 'expected the tab-bar CSS section');
  const to = styleBlock.indexOf('[hidden]', from);
  assert.ok(to > from, 'the new CSS must sit before the [hidden] rule');
  const newCss = styleBlock.slice(from, to);

  assert.ok(/\.tab-bar\s*\{/.test(newCss) && /\.clients-table\s*\{/.test(newCss),
    'expected tab-bar and clients-table rules in the new section');

  // #241D08 is the hairline colour admin.html already uses for .day-row and
  // ul.plain-list separators. There is no token for it, so reusing that exact
  // literal is correct; anything ELSE hard-coded is a new colour being invented.
  const ALLOWED_LITERALS = new Set(['#241D08']);
  const literals = newCss.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  const unexpected = literals.filter(l => !ALLOWED_LITERALS.has(l.toUpperCase()));
  assert.deepEqual(unexpected, [],
    `new CSS must use var(--token); found raw colours: ${unexpected.join(', ')}`);

  // Logical properties only -- admin.html is dir="ltr" today, but the codebase
  // rule is logical everywhere, and this section is the newest code in it.
  const physical = newCss.match(/\b(margin|padding|border)-(left|right)\s*:/g) || [];
  assert.deepEqual(physical, [], `physical side properties in new CSS: ${physical.join(', ')}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/admin-page-structure.test.js`
Expected: FAIL — the tab-bar, check-in hours, and client-manager ids do not exist yet. (The "no duplicate ids" and "existing ids present" tests should already pass.)

- [ ] **Step 3: Add the new CSS**

In `admin.html`, insert these rules into the `<style>` block immediately before the final `[hidden]{display:none !important;}` rule:

```css
    /* ══ tab bar ══ */
    .tab-bar{
      display:flex; gap:0; margin-block-end:28px;
      border-block-end:1px solid var(--gold-lo);
    }
    .tab-btn{
      background:transparent; color:var(--dim);
      padding:12px 22px; font-size:15px;
      border-block-end:2px solid transparent;
      margin-block-end:-1px;
    }
    .tab-btn:hover{color:var(--bone);}
    .tab-btn[aria-selected="true"]{
      color:var(--gold); border-block-end-color:var(--gold);
    }
    .tab-btn:focus-visible{outline:2px solid var(--gold);outline-offset:-2px;}

    /* ══ client list ══ */
    .clients-table{
      width:100%; border-collapse:collapse; margin-block-end:24px; font-size:14px;
    }
    .clients-table th{
      text-align:start; font-size:11px; font-weight:600; letter-spacing:.08em;
      text-transform:uppercase; color:var(--dim);
      padding-block:8px; border-block-end:1px solid var(--gold-lo);
    }
    .clients-table td{
      padding-block:11px; border-block-end:1px solid #241D08;
      color:var(--bone); word-break:break-word;
    }
    .clients-table tr:last-child td{border-block-end:none;}
    .clients-table td.client-actions{text-align:end; white-space:nowrap;}
    .client-remove{
      background:transparent; color:var(--dim);
      font-size:12px; letter-spacing:.06em; padding:4px 0;
    }
    .client-remove:hover{color:var(--gold);}
    .client-remove:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
    #clientsEmpty{color:var(--dim);font-size:14px;margin:0 0 24px;}
    .clients-add-row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;}
    .clients-add-row .field{flex:1 1 180px;margin-block-end:0;}
```

- [ ] **Step 4: Restructure the `#app` markup**

Replace the whole `<div id="app" hidden> … </div>` block (currently lines 222–293) with:

```html
  <div id="app" hidden>
    <div class="wrap">
      <header class="page-head">
        <h1>Booking Admin</h1>
        <p>Connect the calendar and set the hours that can be booked.</p>
      </header>

      <!--
        Readiness and Connect Calendar deliberately sit ABOVE the tab bar: there
        is one Blob store, one OAuth connection and one Resend key for the whole
        system, so scoping them inside an audience tab would misrepresent them.
      -->
      <section class="panel" id="readinessPanel">
        <h2>Readiness</h2>
        <dl class="status-grid">
          <dt>Blob storage configured</dt><dd id="blobConfigured">—</dd>
          <dt>Calendar connected</dt><dd id="calendarConnected">—</dd>
          <dt>Email (Resend) configured</dt><dd id="resendConfigured">—</dd>
          <dt>OAuth redirect URI</dt><dd id="redirectUri" class="redirect-uri">—</dd>
        </dl>
        <ul class="plain-list" id="blockersList"></ul>
      </section>

      <section class="panel" id="connectPanel">
        <h2>Connect Calendar</h2>
        <div id="connectSuccess" class="note-success" hidden>
          Google Calendar connected successfully.
        </div>
        <p id="connectState" style="color:var(--dim);font-size:14px;margin-block-end:16px;">—</p>
        <a id="connectBtn" class="btn-primary" href="/api/calendar-oauth-start">Connect Google Calendar</a>
      </section>

      <div class="tab-bar" id="tabBar" role="tablist" aria-label="Booking audience">
        <button type="button" class="tab-btn" id="tabApplicants" role="tab"
                aria-selected="true" aria-controls="panelApplicants">New Applicants</button>
        <button type="button" class="tab-btn" id="tabCheckins" role="tab"
                aria-selected="false" aria-controls="panelCheckins">Check-Ins</button>
      </div>

      <div id="panelApplicants" role="tabpanel" aria-labelledby="tabApplicants">
        <section class="panel" id="availabilityPanel">
          <h2>Weekly Availability</h2>
          <div id="storageMissingNote" class="note-error" hidden>
            The Vercel Blob store does not exist yet, so this form shows the default
            hours only -- saving will fail until the store is created (Storage → Create
            Database → Blob) and the deployment is redeployed.
          </div>

          <form id="availabilityForm">
            <div id="daysRows"></div>

            <div class="field-row" style="margin-block-start:24px;">
              <div class="field">
                <label for="slotMinutes">Slot length</label>
                <select class="input" id="slotMinutes"></select>
              </div>
              <div class="field">
                <label for="bufferMinutes">Buffer (minutes)</label>
                <input class="input" type="number" id="bufferMinutes" min="0" max="240" step="1" />
              </div>
              <div class="field">
                <label for="minNoticeHours">Minimum notice (hours)</label>
                <input class="input" type="number" id="minNoticeHours" min="0" max="720" step="1" />
              </div>
            </div>

            <div class="tz-row">
              <div class="field">
                <label for="timezoneInput">Time zone</label>
                <input class="input" type="text" id="timezoneInput" list="tzList" placeholder="America/Toronto" autocomplete="off" />
                <datalist id="tzList"></datalist>
              </div>
              <span id="tzNow"></span>
            </div>

            <ul class="error-list" id="formErrors" hidden></ul>
            <div class="note-success" id="formSuccess" hidden>Saved.</div>

            <div class="form-actions">
              <button type="submit" class="btn-primary">Save Hours</button>
            </div>
          </form>
        </section>
      </div>

      <div id="panelCheckins" role="tabpanel" aria-labelledby="tabCheckins" hidden>
        <section class="panel" id="chk-availabilityPanel">
          <h2>Check-In Availability</h2>
          <p style="color:var(--dim);font-size:13px;margin:0 0 18px;">
            Set separately from the new-applicant hours above -- slot length, buffer,
            minimum notice and time zone are all independent.
          </p>
          <div id="chk-storageMissingNote" class="note-error" hidden>
            The Vercel Blob store does not exist yet, so this form shows the default
            hours only -- saving will fail until the store is created (Storage → Create
            Database → Blob) and the deployment is redeployed.
          </div>

          <form id="chk-availabilityForm">
            <div id="chk-daysRows"></div>

            <div class="field-row" style="margin-block-start:24px;">
              <div class="field">
                <label for="chk-slotMinutes">Slot length</label>
                <select class="input" id="chk-slotMinutes"></select>
              </div>
              <div class="field">
                <label for="chk-bufferMinutes">Buffer (minutes)</label>
                <input class="input" type="number" id="chk-bufferMinutes" min="0" max="240" step="1" />
              </div>
              <div class="field">
                <label for="chk-minNoticeHours">Minimum notice (hours)</label>
                <input class="input" type="number" id="chk-minNoticeHours" min="0" max="720" step="1" />
              </div>
            </div>

            <div class="tz-row">
              <div class="field">
                <label for="chk-timezoneInput">Time zone</label>
                <input class="input" type="text" id="chk-timezoneInput" list="chk-tzList" placeholder="America/Toronto" autocomplete="off" />
                <datalist id="chk-tzList"></datalist>
              </div>
              <span id="chk-tzNow"></span>
            </div>

            <ul class="error-list" id="chk-formErrors" hidden></ul>
            <div class="note-success" id="chk-formSuccess" hidden>Saved.</div>

            <div class="form-actions">
              <button type="submit" class="btn-primary">Save Check-In Hours</button>
            </div>
          </form>
        </section>

        <section class="panel" id="clientsPanel">
          <h2>Check-In Clients</h2>
          <p style="color:var(--dim);font-size:13px;margin:0 0 18px;">
            Only people on this list can book a check-in call. Email is required --
            it is the only channel confirmations and cancellations go through.
            Phone is optional, and just gives them a second way to identify
            themselves. Adding an email that is already listed updates that entry.
          </p>
          <div id="clientsStorageMissingNote" class="note-error" hidden>
            The Vercel Blob store does not exist yet, so the client list cannot be
            saved. Create it (Storage → Create Database → Blob) and redeploy.
          </div>

          <table class="clients-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Phone</th><th></th></tr>
            </thead>
            <tbody id="clientsTableBody"></tbody>
          </table>
          <p id="clientsEmpty" hidden>No clients yet. Add the first one below.</p>

          <form id="clientAddForm">
            <div class="clients-add-row">
              <div class="field">
                <label for="clientName">Name</label>
                <input class="input" type="text" id="clientName" autocomplete="off" />
              </div>
              <div class="field">
                <label for="clientEmail">Email (required)</label>
                <input class="input" type="email" id="clientEmail" autocomplete="off" required />
              </div>
              <div class="field">
                <label for="clientPhone">Phone (optional)</label>
                <input class="input" type="tel" id="clientPhone" autocomplete="off" />
              </div>
            </div>

            <ul class="error-list" id="clientErrors" hidden></ul>
            <div class="note-success" id="clientSuccess" hidden>Saved.</div>

            <div class="form-actions">
              <button type="submit" class="btn-primary">Add Client</button>
            </div>
          </form>
        </section>
      </div>
    </div>
  </div>
```

- [ ] **Step 5: Parameterize the existing form helpers by id prefix**

In the inline `<script>`, replace the five functions `buildDayRows`, `buildSlotOptions`, `buildTimezoneList`, `updateTzNow`, `populateForm`, `collectTemplate` with these prefixed versions. The applicant prefix is `''`, so every existing id resolves exactly as before.

```js
    // Every field is addressed as prefix + baseId. The applicant prefix is the
    // empty string, so its ids are unchanged; the check-in prefix is 'chk-'.
    const PREFIX_APPLICANTS = '';
    const PREFIX_CHECKINS = 'chk-';

    function buildDayRows(prefix) {
      const wrap = $(`${prefix}daysRows`);
      wrap.innerHTML = '';
      for (const key of DAY_KEYS) {
        const row = document.createElement('div');
        row.className = 'day-row';
        row.dataset.day = key;
        row.innerHTML = `
          <label class="day-toggle">
            <input type="checkbox" id="${prefix}day-${key}-enabled" />
            <span>${DAY_LABELS[key]}</span>
          </label>
          <input class="input hhmm" type="text" id="${prefix}day-${key}-start" placeholder="09:00" maxlength="5" inputmode="numeric" />
          <span class="day-to">to</span>
          <input class="input hhmm" type="text" id="${prefix}day-${key}-end" placeholder="17:00" maxlength="5" inputmode="numeric" />
        `;
        wrap.appendChild(row);
      }
    }

    function buildSlotOptions(prefix) {
      const sel = $(`${prefix}slotMinutes`);
      sel.innerHTML = '';
      for (const m of SLOT_MINUTE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = String(m);
        opt.textContent = `${m} minutes`;
        sel.appendChild(opt);
      }
    }

    function buildTimezoneList(prefix) {
      const list = $(`${prefix}tzList`);
      list.innerHTML = '';
      let zones = null;
      try {
        if (typeof Intl.supportedValuesOf === 'function') {
          zones = Intl.supportedValuesOf('timeZone');
        }
      } catch (e) {
        zones = null;
      }
      if (!Array.isArray(zones) || zones.length === 0) zones = FALLBACK_TIMEZONES;
      for (const z of zones) {
        const opt = document.createElement('option');
        opt.value = z;
        list.appendChild(opt);
      }
    }

    // Recomputed whenever the field changes, so picking the wrong zone is
    // obvious immediately instead of silently shifting every future booking.
    function updateTzNow(prefix) {
      const tzValue = $(`${prefix}timezoneInput`).value.trim();
      const out = $(`${prefix}tzNow`);
      if (!tzValue) { out.textContent = ''; out.classList.remove('error-text'); return; }
      try {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tzValue, weekday: 'short',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
        });
        out.textContent = `Local time there: ${fmt.format(new Date())}`;
        out.classList.remove('error-text');
      } catch (e) {
        out.textContent = 'Unrecognized time zone -- check spelling.';
        out.classList.add('error-text');
      }
    }

    function populateForm(prefix, template) {
      const days = template.days || {};
      for (const key of DAY_KEYS) {
        const d = days[key] || { enabled: false, start: '09:00', end: '17:00' };
        $(`${prefix}day-${key}-enabled`).checked = d.enabled === true;
        $(`${prefix}day-${key}-start`).value = d.start || '09:00';
        $(`${prefix}day-${key}-end`).value = d.end || '17:00';
      }
      $(`${prefix}slotMinutes`).value = String(template.slotMinutes);
      $(`${prefix}bufferMinutes`).value = template.bufferMinutes;
      $(`${prefix}minNoticeHours`).value = template.minNoticeHours;
      $(`${prefix}timezoneInput`).value = template.timezone || '';
      updateTzNow(prefix);
    }

    function collectTemplate(prefix) {
      const days = {};
      for (const key of DAY_KEYS) {
        days[key] = {
          enabled: $(`${prefix}day-${key}-enabled`).checked,
          start: $(`${prefix}day-${key}-start`).value.trim(),
          end: $(`${prefix}day-${key}-end`).value.trim(),
        };
      }
      return {
        timezone: $(`${prefix}timezoneInput`).value.trim(),
        days,
        slotMinutes: Number($(`${prefix}slotMinutes`).value),
        bufferMinutes: Number($(`${prefix}bufferMinutes`).value),
        minNoticeHours: Number($(`${prefix}minNoticeHours`).value),
      };
    }
```

- [ ] **Step 6: Replace the availability load/submit wiring with the shared, prefixed version**

Replace the existing `loadAvailability()` function and the `$('availabilityForm').addEventListener(...)` block with:

```js
    // One loader and one submit handler for BOTH hours forms. A second copy is
    // how the two would drift -- and a drifted copy on an admin page is how
    // hours get saved to the wrong audience.
    async function loadAvailabilityInto(prefix, endpoint, noteId) {
      let res;
      try {
        res = await fetch(endpoint);
      } catch (e) {
        return;
      }
      if (res.status === 401) { showGate(); return; }
      const data = await res.json().catch(() => ({}));
      if (data && data.template) {
        populateForm(prefix, data.template);
        $(noteId).hidden = !data.storageMissing;
      }
    }

    function wireAvailabilityForm(prefix, endpoint, noteId) {
      const errorsEl = $(`${prefix}formErrors`);
      const successEl = $(`${prefix}formSuccess`);
      $(`${prefix}availabilityForm`).addEventListener('submit', async (e) => {
        e.preventDefault();
        errorsEl.hidden = true;
        errorsEl.innerHTML = '';
        successEl.hidden = true;

        const template = collectTemplate(prefix);
        let res, data;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template }),
          });
          data = await res.json().catch(() => ({}));
        } catch (err) {
          errorsEl.innerHTML = '<li>Network error -- try again.</li>';
          errorsEl.hidden = false;
          return;
        }

        if (res.status === 401) { showGate(); return; }

        if (res.status === 200 && data.ok) {
          successEl.hidden = false;
          populateForm(prefix, data.template);
          $(noteId).hidden = true;
          return;
        }

        const errs = Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors
          : [`Save failed (status ${res.status})`];
        for (const msg of errs) {
          const li = document.createElement('li');
          li.textContent = msg;
          errorsEl.appendChild(li);
        }
        errorsEl.hidden = false;
      });
    }
```

- [ ] **Step 7: Add the tab switcher and the client manager**

Insert these functions into the `<script>`, before `init()`:

```js
    // ── tabs ────────────────────────────────────────────────────────────────
    function selectTab(which) {
      const applicants = which === 'applicants';
      $('tabApplicants').setAttribute('aria-selected', applicants ? 'true' : 'false');
      $('tabCheckins').setAttribute('aria-selected', applicants ? 'false' : 'true');
      $('panelApplicants').hidden = !applicants;
      $('panelCheckins').hidden = applicants;
    }

    // ── client manager ──────────────────────────────────────────────────────
    function renderClients(clients) {
      const body = $('clientsTableBody');
      body.innerHTML = '';
      const list = Array.isArray(clients) ? clients : [];
      $('clientsEmpty').hidden = list.length > 0;

      for (const c of list) {
        const tr = document.createElement('tr');

        // textContent, never innerHTML: a client's own name is data, and this
        // page renders it straight back.
        const nameTd = document.createElement('td');
        nameTd.textContent = c.name || '—';
        const emailTd = document.createElement('td');
        emailTd.textContent = c.email;
        const phoneTd = document.createElement('td');
        phoneTd.textContent = c.phone || '—';

        const actionsTd = document.createElement('td');
        actionsTd.className = 'client-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'client-remove';
        btn.textContent = 'Remove';
        // The email is the record key, so it is what the DELETE carries.
        btn.dataset.email = c.email;
        actionsTd.appendChild(btn);

        tr.append(nameTd, emailTd, phoneTd, actionsTd);
        body.appendChild(tr);
      }
    }

    function showClientErrors(messages) {
      const el = $('clientErrors');
      el.innerHTML = '';
      for (const msg of messages) {
        const li = document.createElement('li');
        li.textContent = msg;
        el.appendChild(li);
      }
      el.hidden = false;
    }

    async function loadClients() {
      let res;
      try {
        res = await fetch('/api/admin/checkin-clients');
      } catch (e) {
        return;
      }
      if (res.status === 401) { showGate(); return; }
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        renderClients(data.clients);
        $('clientsStorageMissingNote').hidden = !data.storageMissing;
      }
    }

    function wireClientManager() {
      $('clientAddForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        $('clientErrors').hidden = true;
        $('clientSuccess').hidden = true;

        const client = {
          name: $('clientName').value.trim(),
          email: $('clientEmail').value.trim(),
          phone: $('clientPhone').value.trim(),
        };
        // The server validates too -- this is only so the obvious case does not
        // need a round trip.
        if (!client.email) {
          showClientErrors(['Email is required.']);
          return;
        }

        let res, data;
        try {
          res = await fetch('/api/admin/checkin-clients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client }),
          });
          data = await res.json().catch(() => ({}));
        } catch (err) {
          showClientErrors(['Network error -- try again.']);
          return;
        }

        if (res.status === 401) { showGate(); return; }

        if (res.status === 200 && data.ok) {
          renderClients(data.clients);
          $('clientsStorageMissingNote').hidden = true;
          $('clientSuccess').hidden = false;
          $('clientName').value = '';
          $('clientEmail').value = '';
          $('clientPhone').value = '';
          return;
        }
        showClientErrors(Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors
          : [`Save failed (status ${res.status})`]);
      });

      // Delegated, because the rows are re-rendered after every change and a
      // per-row listener would be re-attached (and leak) each time.
      $('clientsTableBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('.client-remove');
        if (!btn) return;
        const email = btn.dataset.email;
        if (!email) return;
        if (!window.confirm(`Remove ${email} from the check-in client list?`)) return;

        $('clientErrors').hidden = true;
        $('clientSuccess').hidden = true;
        btn.disabled = true;

        let res, data;
        try {
          res = await fetch('/api/admin/checkin-clients', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          data = await res.json().catch(() => ({}));
        } catch (err) {
          btn.disabled = false;
          showClientErrors(['Network error -- try again.']);
          return;
        }

        if (res.status === 401) { showGate(); return; }

        if (res.status === 200 && data.ok) {
          renderClients(data.clients);
          return;
        }
        btn.disabled = false;
        showClientErrors(Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors
          : [`Remove failed (status ${res.status})`]);
      });
    }
```

- [ ] **Step 8: Rewrite `init()` and the gate handler's post-login load**

Replace `init()` with:

```js
    async function loadAllPanels() {
      await loadAvailabilityInto(PREFIX_APPLICANTS, '/api/admin/availability', 'storageMissingNote');
      await loadAvailabilityInto(PREFIX_CHECKINS, '/api/admin/checkin-availability', 'chk-storageMissingNote');
      await loadClients();
    }

    async function init() {
      for (const prefix of [PREFIX_APPLICANTS, PREFIX_CHECKINS]) {
        buildDayRows(prefix);
        buildSlotOptions(prefix);
        buildTimezoneList(prefix);
      }

      if (new URLSearchParams(location.search).get('connected') === '1') {
        $('connectSuccess').hidden = false;
      }

      selectTab('applicants');
      $('tabApplicants').addEventListener('click', () => selectTab('applicants'));
      $('tabCheckins').addEventListener('click', () => selectTab('checkins'));

      wireAvailabilityForm(PREFIX_APPLICANTS, '/api/admin/availability', 'storageMissingNote');
      wireAvailabilityForm(PREFIX_CHECKINS, '/api/admin/checkin-availability', 'chk-storageMissingNote');
      wireClientManager();

      const authed = await loadStatus();
      if (authed) await loadAllPanels();

      for (const prefix of [PREFIX_APPLICANTS, PREFIX_CHECKINS]) {
        $(`${prefix}timezoneInput`).addEventListener('input', () => updateTzNow(prefix));
        $(`${prefix}timezoneInput`).addEventListener('change', () => updateTzNow(prefix));
      }
    }
```

Then in the `$('gateForm')` submit handler, replace the two lines

```js
          const authed = await loadStatus();
          if (authed) await loadAvailability();
```

with

```js
          const authed = await loadStatus();
          if (authed) await loadAllPanels();
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `node --test test/admin-page-structure.test.js`
Expected: PASS (11 tests).

- [ ] **Step 10: Verify in a browser**

Run: `npx vercel dev` (or the project's usual local server), open `http://localhost:3000/admin`, log in with `ADMIN_PASSCODE`, and check each of these:

1. Readiness and Connect Calendar render above the tab bar.
2. **New Applicants** is selected on load and shows the existing hours form, populated from `/api/admin/availability`.
3. Clicking **Check-Ins** swaps to the check-in hours form plus the client list; clicking back restores the applicant tab. Both tabs are reachable by Tab + Enter.
4. Saving applicant hours still works and does not change the check-in form's values; saving check-in hours does not change the applicant form's values. (Reload and confirm each form comes back with its own saved values — this is the real test that the two blobs are separate.)
5. Adding a client with an email appends a row; adding the same email again updates that row rather than adding a second; submitting with an empty email is refused; Remove asks for confirmation then drops the row.
6. Setting the check-in time zone to something different from the applicant one shows the right "Local time there" under each field independently.

- [ ] **Step 11: Run the whole suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add admin.html test/admin-page-structure.test.js
git commit -m "feat: add admin tab bar, check-in hours form, and client manager"
```

---

### Task 15: The standalone `/check-in` page

**Files:**
- Create: `check-in.html`
- Test: `test/checkin-page-structure.test.js`

**Interfaces:**
- Consumes: `POST /api/checkin-verify` (Task 6), `GET /api/calendar-checkin-availability?date=&days=` (Task 7), `POST /api/calendar-checkin-book` (Task 10).
- Produces: nothing other code imports. `vercel.json` already sets `cleanUrls: true`, so `check-in.html` is served at `/check-in` with **no routing change**.

**Independently written, on purpose.** This page shares no code with `booking-widget.js`. The spec makes that an explicit decision: the two pickers are expected to diverge in look and behaviour, and a shared widget is what would make that divergence expensive. The tokens, fonts and zero-radius flat system are reused **by name** so the page still looks like the rest of the site.

**Scope: English-only, `dir="ltr"`.** `index.html` is bilingual and RTL-first; `admin.html` is already English-only for the same reason this page is — the audience is a known, small group reached by a direct link, and the site's rule is no language mixing, which a half-translated page would break. Every rule is nonetheless written with logical properties (`margin-block-end`, `border-inline-start`, `text-align:start`), so adding Arabic later is a `dir` flip plus a copy table, not a rewrite. The booking POST sends `lang: 'en'`.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-page-structure.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'check-in.html'), 'utf8');

function idsIn(source) {
  const out = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

test('no id appears twice', () => {
  const ids = idsIn(html);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('all three steps and their key elements exist', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'stepVerify', 'verifyForm', 'verifyEmail', 'verifyPhone', 'verifyError', 'verifySubmit',
    'stepPick', 'greeting', 'dayStrip', 'dayPrev', 'dayNext', 'slots',
    'pickerLoading', 'pickerError', 'noSlots', 'tzNote',
    'confirmBar', 'confirmSummary', 'confirmBtn',
    'stepDone', 'doneWhen', 'doneMeet',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing element "${id}"`);
  }
});

test('the page calls exactly the three check-in endpoints and no applicant one', () => {
  for (const url of ['/api/checkin-verify', '/api/calendar-checkin-availability', '/api/calendar-checkin-book']) {
    assert.ok(html.includes(url), `check-in.html must call ${url}`);
  }
  for (const url of ['/api/calendar-book', '/api/calendar-availability', '/api/admin/']) {
    assert.equal(html.includes(url), false, `check-in.html must not call ${url}`);
  }
  // No shared widget code, per the explicit decision in the spec.
  assert.equal(html.includes('booking-widget.js'), false);
  assert.equal(html.includes('BookingWidget'), false);
});

// The generic message is a decision, not a placeholder: it must not hint at
// whether the identifier was unknown or something else failed.
test('the failed-verification copy is the exact generic message from the spec', () => {
  assert.ok(html.includes("We couldn't verify that email or phone. If you're a current client, contact Omar directly."),
    'the generic verification-failure message must appear verbatim');
});

test('the page reuses the site CSS tokens by name and defines them with the site values', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const pairs = {
    '--void': '#050505',
    '--band': '#101010',
    '--band-2': '#181817',
    '--gold': '#D4AF37',
    '--gold-lo': '#7A6218',
    '--bone': '#F2EEE4',
    '--dim': '#8B887F',
    '--ink': '#0A0802',
    '--slab': '#1C1C1A',
  };
  for (const [token, value] of Object.entries(pairs)) {
    assert.match(styleBlock, new RegExp(`${token}\\s*:\\s*${value}`, 'i'),
      `${token} must be defined as ${value}, matching index.html`);
  }
});

test('the flat zero-radius system is kept: no border-radius anywhere', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const radii = styleBlock.match(/border-radius\s*:\s*([^;]+);/g) || [];
  for (const rule of radii) {
    assert.match(rule, /:\s*0\s*;/, `non-zero radius breaks the site's flat system: ${rule}`);
  }
});

// The site is RTL-aware, so a page written with physical properties would be
// the one thing blocking a later Arabic pass.
test('layout uses logical properties, not physical margin/padding sides', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const physical = styleBlock.match(/\b(margin|padding|border)-(left|right)\s*:/g) || [];
  assert.deepEqual(physical, [], `physical side properties found: ${physical.join(', ')}`);
  assert.equal(/text-align\s*:\s*(left|right)/.test(styleBlock), false,
    'use text-align:start/end, not left/right');
});

test('the fonts are the site fonts, loaded from Google Fonts', () => {
  assert.match(html, /fonts\.googleapis\.com/);
  assert.match(html, /Big\+Shoulders\+Display/);
  assert.match(html, /family=Inter|&Inter/);
});

test('a 409 on confirm is handled as an expected race: cleared selection and a re-fetch', () => {
  assert.match(html, /409/, 'the confirm handler must branch on 409');
  assert.match(html, /SLOT_TAKEN/);
});

test('an expired verification (403 NOT_VERIFIED) sends the visitor back to the verify step', () => {
  assert.match(html, /NOT_VERIFIED/);
});

test('the verify token is held in a JS variable, never written to storage', () => {
  assert.equal(/localStorage/.test(html), false, 'a verify token must not be persisted');
  assert.equal(/sessionStorage/.test(html), false);
  assert.equal(/document\.cookie/.test(html), false);
});

test('the booking POST sends the verifyToken, the start instant, the visitor zone and lang', () => {
  const idx = html.indexOf('/api/calendar-checkin-book');
  assert.ok(idx !== -1);
  const window = html.slice(idx, idx + 600);
  for (const field of ['verifyToken', 'start', 'visitorTimeZone', 'lang']) {
    assert.ok(window.includes(field), `the book POST body must carry ${field}`);
  }
  // Identity is never sent -- the server takes it from the token.
  assert.equal(/body:\s*JSON\.stringify\(\{[^}]*\bemail\b/.test(window), false,
    'the page must not send an email with the booking -- the token decides who it is');
});

test('the page is marked noindex: a direct client link is not a public page', () => {
  assert.match(html, /<meta\s+name="robots"\s+content="noindex/i);
});

test('slot times are only ever FORMATTED from the absolute ISO instants the server sends', () => {
  // No manual offset arithmetic on instants: the server sends absolute ISO and
  // Intl does the zone work, which is the site-wide rule.
  assert.match(html, /Intl\.DateTimeFormat/);
  assert.equal(/getTimezoneOffset/.test(html), false,
    'manual offset math on a slot instant is exactly the bug this rule prevents');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/checkin-page-structure.test.js`
Expected: FAIL — `ENOENT: no such file or directory, open '.../check-in.html'`.

- [ ] **Step 3: Write `check-in.html`**

```html
<!DOCTYPE html>
<!--
  /check-in -- the standalone check-in booking page for EXISTING mentorship
  clients. Reached by a direct link Omar sends, gated by a light self-serve
  verification step against a manually-maintained client list. No account
  system, no password.

  Deliberately independent of booking-widget.js: the applicant widget and this
  picker are expected to diverge in look and behaviour, and a shared widget is
  what would make that divergence expensive. The site's CSS tokens, fonts and
  flat zero-radius system are reused BY NAME so it still looks like the rest of
  the site.

  English-only and dir="ltr", like admin.html: the audience is a known, small
  group reached by a direct link, and the site's rule is no language mixing --
  which a half-translated page would break. Every rule below uses LOGICAL
  properties, so adding Arabic later is a dir flip plus a copy table.
-->
<html lang="en" dir="ltr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- A direct client link is not a public page. -->
  <meta name="robots" content="noindex, nofollow">
  <title>3AMAK Trades — Book a Check-In</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">

  <style>
    *{box-sizing:border-box;}

    /* The same tokens, with the same values, as index.html's :root. Copied
       rather than imported because this page loads no shared stylesheet -- keep
       them in sync by hand if the palette ever moves. */
    :root{
      --void:#050505;
      --band:#101010;
      --band-2:#181817;
      --gold:#D4AF37;
      --gold-lo:#7A6218;
      --bone:#F2EEE4;
      --dim:#8B887F;
      --ink:#0A0802;
      --slab:#1C1C1A;
    }

    html,body{margin:0;padding:0;background:var(--void);}
    body{
      font-family:'Inter',system-ui,sans-serif;
      color:var(--bone);
      min-height:100vh;
    }

    h1,h2{
      font-family:'Big Shoulders Display',sans-serif;
      font-weight:800; text-transform:uppercase; letter-spacing:.02em;
      margin:0 0 .6em; color:var(--bone);
    }

    .wrap{max-width:620px;margin:0 auto;padding:clamp(28px,6vw,64px) 20px 80px;}

    header.page-head{
      padding-block-end:22px; border-block-end:1px solid var(--gold-lo);
      margin-block-end:32px;
    }
    header.page-head h1{font-size:clamp(24px,4vw,34px);margin:0;}
    header.page-head p{color:var(--dim);font-size:14px;margin:.6em 0 0;line-height:1.6;}

    section.panel{
      background:var(--band-2);
      padding:clamp(18px,3vw,28px);
      margin-block-end:24px;
      border:0; border-radius:0;
    }

    label{
      display:block; font-size:11px; font-weight:600; letter-spacing:.08em;
      text-transform:uppercase; color:var(--dim); margin-block-end:6px;
    }
    .field{margin-block-end:22px;}
    .input{
      width:100%; background:transparent; color:var(--bone);
      font-family:inherit; font-size:16px; font-weight:600;
      border:0; border-block-end:1px solid var(--gold-lo); border-radius:0;
      padding:10px 2px 11px; outline:none;
      transition:border-color .15s ease; appearance:none;
    }
    .input:focus{border-block-end-color:var(--gold);}
    .input::placeholder{color:var(--dim);}

    .or-line{
      color:var(--dim); font-size:12px; letter-spacing:.1em;
      text-transform:uppercase; text-align:center;
      margin-block:-8px 18px;
    }

    button{
      font-family:'Big Shoulders Display',sans-serif; font-weight:800;
      text-transform:uppercase; letter-spacing:.05em;
      border:none; border-radius:0; cursor:pointer;
    }
    .btn-primary{
      background:var(--gold); color:var(--ink);
      padding:13px 28px; font-size:16px;
    }
    .btn-primary:hover:not(:disabled){background:var(--bone);}
    .btn-primary:disabled{opacity:.45;cursor:not-allowed;}
    .btn-primary:focus-visible{outline:2px solid var(--bone);outline-offset:2px;}

    .note-error{
      color:var(--gold); font-size:13px; line-height:1.6;
      margin-block-end:18px; padding:11px 13px; background:var(--slab);
      border-inline-start:2px solid var(--gold);
    }
    .note-dim{color:var(--dim);font-size:13px;line-height:1.6;margin:0;}

    /* ══ day strip ══ */
    .day-row{display:flex;align-items:center;gap:6px;margin-block-end:22px;}
    .day-strip{
      display:flex; gap:6px; overflow-x:auto; scroll-behavior:smooth;
      flex:1 1 auto; padding-block-end:4px;
    }
    .day-strip::-webkit-scrollbar{height:4px;}
    .day{
      flex:0 0 auto; min-width:58px; padding:9px 10px;
      background:var(--band); color:var(--bone);
      border:1px solid transparent; border-radius:0;
      text-align:center; cursor:pointer;
    }
    .day-weekday{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);}
    .day-num{font-size:18px;font-weight:700;margin-block-start:2px;}
    .day.is-selected{background:var(--gold);color:var(--ink);}
    .day.is-selected .day-weekday{color:var(--ink);}
    .day:hover:not(.is-selected):not(:disabled){background:#221F14;}
    .day:disabled{opacity:.35;cursor:not-allowed;}
    .day:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}

    .arrow-btn{
      flex:0 0 auto; width:32px; height:44px;
      background:transparent; color:var(--bone);
      border:1px solid var(--gold-lo); border-radius:0;
      font-size:15px; line-height:1;
    }
    .arrow-btn:disabled{opacity:.3;cursor:not-allowed;}
    .arrow-btn:hover:not(:disabled){border-color:var(--gold);}
    .arrow-btn:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}

    /* ══ slots ══ */
    .slots{display:flex;flex-wrap:wrap;gap:8px;margin-block-end:22px;}
    .slot{
      background:var(--band); color:var(--bone);
      border:1px solid var(--gold-lo); border-radius:0;
      padding:10px 15px; font-family:'Inter',system-ui,sans-serif;
      font-size:15px; font-weight:600; text-transform:none; letter-spacing:0;
    }
    .slot:hover{border-color:var(--gold);}
    .slot.is-selected{background:var(--gold);border-color:var(--gold);color:var(--ink);}
    .slot:focus-visible{outline:2px solid var(--gold);outline-offset:2px;}
    .slot-time{unicode-bidi:isolate;}

    #tzNote{color:var(--dim);font-size:12px;margin:0 0 22px;}
    #confirmSummary{font-size:15px;line-height:1.7;margin:0 0 18px;}
    #confirmSummary strong{color:var(--gold);}

    #doneWhen{font-size:16px;line-height:1.7;margin:0 0 14px;}
    #doneWhen strong{color:var(--gold);}
    #doneMeet a{color:var(--gold);word-break:break-all;}

    [hidden]{display:none !important;}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="page-head">
      <h1>Book a Check-In</h1>
      <p>For current mentorship clients. Confirm who you are, then pick a time.</p>
    </header>

    <!-- STEP 1 ── verify -->
    <section class="panel" id="stepVerify">
      <h2>Who are you?</h2>
      <p class="note-dim" style="margin-block-end:22px;">
        Enter the email or phone number Omar has on file for you.
      </p>
      <div class="note-error" id="verifyError" hidden></div>
      <form id="verifyForm" novalidate>
        <div class="field">
          <label for="verifyEmail">Email</label>
          <input class="input" type="email" id="verifyEmail" autocomplete="email"
                 inputmode="email" placeholder="you@example.com" />
        </div>
        <p class="or-line">or</p>
        <div class="field">
          <label for="verifyPhone">Phone</label>
          <input class="input" type="tel" id="verifyPhone" autocomplete="tel"
                 inputmode="tel" placeholder="+1 555 010 0100" />
        </div>
        <button type="submit" class="btn-primary" id="verifySubmit">Continue</button>
      </form>
    </section>

    <!-- STEP 2 ── pick -->
    <section class="panel" id="stepPick" hidden>
      <h2 id="greeting">Pick a time</h2>
      <div class="note-error" id="pickerError" hidden></div>

      <div class="day-row">
        <button type="button" class="arrow-btn" id="dayPrev" aria-label="Earlier days">‹</button>
        <div class="day-strip" id="dayStrip"></div>
        <button type="button" class="arrow-btn" id="dayNext" aria-label="Later days">›</button>
      </div>

      <p class="note-dim" id="pickerLoading" hidden>Loading times…</p>
      <p class="note-dim" id="noSlots" hidden>No openings on this day. Try another.</p>
      <div class="slots" id="slots"></div>
      <p id="tzNote"></p>

      <div id="confirmBar" hidden>
        <p id="confirmSummary"></p>
        <button type="button" class="btn-primary" id="confirmBtn">Confirm Check-In</button>
      </div>
    </section>

    <!-- STEP 3 ── done -->
    <section class="panel" id="stepDone" hidden>
      <h2>You're booked</h2>
      <p id="doneWhen"></p>
      <p id="doneMeet" hidden></p>
      <p class="note-dim">
        A confirmation email is on its way. Need to change it? Message Omar directly.
      </p>
    </section>
  </div>

  <script>
    'use strict';

    // How many days of availability to fetch in one request. The endpoint clamps
    // at 31; 14 keeps the payload small while covering a fortnight.
    var RANGE_DAYS = 14;

    // The verify token lives ONLY here, in a closure variable. Never
    // localStorage, sessionStorage or a cookie: it is a 10-minute credential,
    // and persisting it would outlive the tab that earned it for no benefit.
    var state = {
      verifyToken: '',
      name: '',
      timezone: '',      // the CHECK-IN template's zone, from the availability response
      slotMinutes: 0,
      days: {},          // { 'YYYY-MM-DD': [{start, end}] }
      dayKeys: [],
      selectedDay: '',
      selectedStart: '', // the absolute ISO instant of the chosen slot
      submitting: false,
    };

    // The visitor's own zone, used both for display and for what gets stored on
    // the booking. Falls back to UTC on an engine that cannot report it.
    var visitorTz = (function () {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      catch (e) { return 'UTC'; }
    })();

    function $(id) { return document.getElementById(id); }
    function show(id) { $(id).hidden = false; }
    function hide(id) { $(id).hidden = true; }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    // 'YYYY-MM-DD' for the visitor's own local date. Used only to know which
    // date to ask for first -- never to interpret a slot instant.
    function localDateKey(d) {
      d = d || new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    // A day-chip label for a CALENDAR DATE, not an instant: the probe is pinned
    // to UTC noon and formatted with timeZone:'UTC' so the label always matches
    // the key regardless of the visitor's system zone.
    function dayLabel(dateKey) {
      var bits = String(dateKey).split('-');
      var probe = new Date(Date.UTC(+bits[0], +bits[1] - 1, +bits[2], 12, 0, 0));
      return {
        weekday: new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(probe),
        dayNum: new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'UTC' }).format(probe),
      };
    }

    // The server sends absolute ISO instants precisely so the client only ever
    // FORMATS -- never does offset arithmetic of its own.
    function formatTime(iso, zone) {
      try {
        return new Intl.DateTimeFormat('en-GB', {
          timeZone: zone, hour: '2-digit', minute: '2-digit',
        }).format(new Date(iso));
      } catch (e) {
        return new Intl.DateTimeFormat('en-GB', {
          timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
        }).format(new Date(iso));
      }
    }

    function formatFull(iso, zone) {
      try {
        return new Intl.DateTimeFormat('en-GB', {
          timeZone: zone, dateStyle: 'full', timeStyle: 'short',
        }).format(new Date(iso));
      } catch (e) {
        return new Date(iso).toISOString();
      }
    }

    // ── step 1: verify ──────────────────────────────────────────────────────
    // ONE generic message for every failure. Deliberate: it must not hint at
    // whether the identifier was unknown, malformed, or something else broke.
    var GENERIC_FAIL = "We couldn't verify that email or phone. If you're a current client, contact Omar directly.";

    function showVerifyError(message) {
      $('verifyError').textContent = message;
      show('verifyError');
    }

    $('verifyForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      hide('verifyError');

      var email = $('verifyEmail').value.trim();
      var phone = $('verifyPhone').value.trim();
      if (!email && !phone) {
        showVerifyError('Enter an email or a phone number.');
        return;
      }

      $('verifySubmit').disabled = true;
      var res, data;
      try {
        res = await fetch('/api/checkin-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, phone: phone }),
        });
        data = await res.json().catch(function () { return {}; });
      } catch (err) {
        $('verifySubmit').disabled = false;
        showVerifyError('Network error -- try again.');
        return;
      }
      $('verifySubmit').disabled = false;

      if (res.status === 503) {
        showVerifyError('Check-in booking is not set up yet. Message Omar directly.');
        return;
      }
      // Every other non-success, including the deliberate 200 {ok:false},
      // collapses to the one generic message.
      if (!data || data.ok !== true || !data.verifyToken) {
        showVerifyError(GENERIC_FAIL);
        return;
      }

      state.verifyToken = data.verifyToken;
      state.name = data.name || '';
      $('greeting').textContent = state.name
        ? 'Pick a time, ' + state.name
        : 'Pick a time';

      hide('stepVerify');
      show('stepPick');
      await loadAvailability(localDateKey());
    });

    // ── step 2: pick ────────────────────────────────────────────────────────
    function renderDayStrip() {
      var strip = $('dayStrip');
      strip.innerHTML = '';
      state.dayKeys.forEach(function (key) {
        var slots = state.days[key] || [];
        var parts = dayLabel(key);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day' + (key === state.selectedDay ? ' is-selected' : '');
        btn.disabled = slots.length === 0;
        btn.dataset.day = key;
        btn.setAttribute('aria-pressed', key === state.selectedDay ? 'true' : 'false');

        var wd = document.createElement('div');
        wd.className = 'day-weekday';
        wd.textContent = parts.weekday;
        var num = document.createElement('div');
        num.className = 'day-num';
        num.textContent = parts.dayNum;
        btn.append(wd, num);
        strip.appendChild(btn);
      });
    }

    function renderSlots() {
      var wrap = $('slots');
      wrap.innerHTML = '';
      var slots = state.days[state.selectedDay] || [];
      $('noSlots').hidden = slots.length > 0;

      slots.forEach(function (s) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'slot' + (s.start === state.selectedStart ? ' is-selected' : '');
        btn.dataset.start = s.start;
        btn.setAttribute('aria-pressed', s.start === state.selectedStart ? 'true' : 'false');
        var span = document.createElement('span');
        span.className = 'slot-time';
        span.textContent = formatTime(s.start, visitorTz);
        btn.appendChild(span);
        wrap.appendChild(btn);
      });

      $('tzNote').textContent = 'Times shown in your time zone (' + visitorTz + ').';
      renderConfirmBar();
    }

    function renderConfirmBar() {
      if (!state.selectedStart) { hide('confirmBar'); return; }
      $('confirmSummary').innerHTML = '';
      var line = document.createElement('span');
      line.textContent = 'Check-in on ';
      var when = document.createElement('strong');
      when.textContent = formatFull(state.selectedStart, visitorTz);
      var tail = document.createElement('span');
      tail.textContent = ' (' + visitorTz + ')'
        + (state.slotMinutes ? ' · ' + state.slotMinutes + ' minutes' : '');
      $('confirmSummary').append(line, when, tail);
      show('confirmBar');
    }

    // The first day that actually has openings -- today's hours may already
    // have passed, so the answer is not necessarily today. 'YYYY-MM-DD' sorts
    // correctly as a plain string.
    function firstDayWithOpenings() {
      for (var i = 0; i < state.dayKeys.length; i++) {
        var slots = state.days[state.dayKeys[i]];
        if (slots && slots.length > 0) return state.dayKeys[i];
      }
      return '';
    }

    async function loadAvailability(fromDateKey) {
      hide('pickerError');
      hide('noSlots');
      show('pickerLoading');
      $('slots').innerHTML = '';

      var res, data;
      try {
        res = await fetch('/api/calendar-checkin-availability?date='
          + encodeURIComponent(fromDateKey) + '&days=' + RANGE_DAYS);
        data = await res.json().catch(function () { return {}; });
      } catch (err) {
        hide('pickerLoading');
        $('pickerError').textContent = 'Could not load times -- try again.';
        show('pickerError');
        return;
      }
      hide('pickerLoading');

      if (!data || data.ok !== true) {
        $('pickerError').textContent = res.status === 503
          ? 'Booking is temporarily unavailable. Message Omar directly.'
          : 'Could not load times -- try again.';
        show('pickerError');
        return;
      }

      state.timezone = data.timezone || '';
      state.slotMinutes = Number(data.slotMinutes) || 0;
      state.days = data.days || {};
      state.dayKeys = Object.keys(state.days).sort();
      state.rangeStart = fromDateKey;

      // Keep the current selection if it survived the refetch; otherwise land on
      // the first day that has anything.
      if (!state.days[state.selectedDay] || state.days[state.selectedDay].length === 0) {
        state.selectedDay = firstDayWithOpenings() || state.dayKeys[0] || '';
        state.selectedStart = '';
      }
      if (state.selectedStart) {
        var still = (state.days[state.selectedDay] || []).some(function (s) {
          return s.start === state.selectedStart;
        });
        if (!still) state.selectedStart = '';
      }

      renderDayStrip();
      renderSlots();
      updateArrows();

      if (state.dayKeys.length > 0 && !firstDayWithOpenings()) {
        $('pickerError').textContent = 'No openings in the next ' + RANGE_DAYS
          + ' days. Try the arrow for later dates, or message Omar.';
        show('pickerError');
      }
    }

    function shiftDays(delta) {
      var base = state.rangeStart ? state.rangeStart.split('-') : null;
      var from = base
        ? new Date(Date.UTC(+base[0], +base[1] - 1, +base[2]))
        : new Date();
      from.setUTCDate(from.getUTCDate() + delta * RANGE_DAYS);
      var today = localDateKey();
      var key = from.getUTCFullYear() + '-' + pad2(from.getUTCMonth() + 1) + '-' + pad2(from.getUTCDate());
      // Never page back before today: there is nothing bookable there.
      if (key < today) key = today;
      state.selectedDay = '';
      state.selectedStart = '';
      loadAvailability(key);
    }

    function updateArrows() {
      $('dayPrev').disabled = !state.rangeStart || state.rangeStart <= localDateKey();
    }

    $('dayStrip').addEventListener('click', function (e) {
      var btn = e.target.closest('.day');
      if (!btn || btn.disabled) return;
      state.selectedDay = btn.dataset.day;
      state.selectedStart = '';
      renderDayStrip();
      renderSlots();
    });

    $('slots').addEventListener('click', function (e) {
      var btn = e.target.closest('.slot');
      if (!btn) return;
      state.selectedStart = btn.dataset.start;
      renderSlots();
    });

    $('dayPrev').addEventListener('click', function () { shiftDays(-1); });
    $('dayNext').addEventListener('click', function () { shiftDays(1); });

    // ── step 3: confirm ─────────────────────────────────────────────────────
    // Nothing is collected here: the name came back from checkin-verify, and the
    // EMAIL is never in the browser at all -- the server takes it from the
    // token. So the body carries only the token, the instant, and display info.
    $('confirmBtn').addEventListener('click', async function () {
      if (!state.selectedStart || state.submitting) return;
      state.submitting = true;
      $('confirmBtn').disabled = true;
      hide('pickerError');

      var res, data;
      try {
        res = await fetch('/api/calendar-checkin-book', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            verifyToken: state.verifyToken,
            start: state.selectedStart,
            visitorTimeZone: visitorTz,
            lang: 'en',
          }),
        });
        data = await res.json().catch(function () { return {}; });
      } catch (err) {
        state.submitting = false;
        $('confirmBtn').disabled = false;
        $('pickerError').textContent = 'Network error -- try again.';
        show('pickerError');
        return;
      }

      state.submitting = false;
      $('confirmBtn').disabled = false;

      // An expected race, not an error: somebody took the slot between the grid
      // loading and this click. Clear the selection, say so plainly, re-fetch.
      if (res.status === 409 || (data && data.error === 'SLOT_TAKEN')) {
        state.selectedStart = '';
        hide('confirmBar');
        $('pickerError').textContent = 'That time was just taken. Here are the current openings.';
        show('pickerError');
        await loadAvailability(state.rangeStart || localDateKey());
        return;
      }

      // The 10-minute token ran out (or the roster changed). Back to step 1 --
      // there is nothing the picker can do about it.
      if (res.status === 403 || (data && data.error === 'NOT_VERIFIED')) {
        state.verifyToken = '';
        state.selectedStart = '';
        hide('stepPick');
        show('stepVerify');
        showVerifyError('That took a while, so we need to check who you are again.');
        return;
      }

      if (!data || data.ok !== true) {
        $('pickerError').textContent = res.status === 503
          ? 'Booking is temporarily unavailable. Message Omar directly.'
          : 'Could not book that time -- try again.';
        show('pickerError');
        return;
      }

      // Booked. The token has done its job; drop it.
      state.verifyToken = '';

      $('doneWhen').innerHTML = '';
      var lead = document.createElement('span');
      lead.textContent = 'Your check-in is confirmed for ';
      var when = document.createElement('strong');
      when.textContent = formatFull(data.start, visitorTz);
      var tail = document.createElement('span');
      tail.textContent = ' (' + visitorTz + ').';
      $('doneWhen').append(lead, when, tail);

      if (data.meetLink && /^https?:\/\//i.test(data.meetLink)) {
        $('doneMeet').innerHTML = '';
        var label = document.createElement('span');
        label.textContent = 'Join link: ';
        var a = document.createElement('a');
        a.href = data.meetLink;
        a.textContent = data.meetLink;
        a.rel = 'noopener noreferrer';
        $('doneMeet').append(label, a);
        show('doneMeet');
      }

      hide('stepPick');
      show('stepDone');
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/checkin-page-structure.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Verify in a browser**

Run: `npx vercel dev`, then:

1. Add yourself as a client from `/admin` → Check-Ins → Add Client (email required).
2. Open `http://localhost:3000/check-in` (no trailing `.html` — `cleanUrls` handles it).
3. Submit an email that is **not** on the list → the exact generic message appears, with no hint of why.
4. Submit the listed email → the greeting shows your name and the day strip renders. Days with no openings are disabled.
5. Pick a slot → the confirm bar summarises it in your own zone. Confirm → the "You're booked" panel shows the time and the Meet link, and the event appears on the calendar tagged `audience: checkin` (check the event's private extended properties, or just confirm `#8-checkin-booked` received a post).
6. Load the page, wait past 10 minutes without confirming, then confirm → you are returned to the verify step with the "took a while" message.
7. Open the page in two tabs, book the same slot in both → the second gets "That time was just taken" and a refreshed grid, not an error.
8. Narrow the window to 360px: the day strip scrolls horizontally and nothing overflows the page.
9. Tab through the whole flow with the keyboard: every day chip, slot and button is reachable and shows a visible gold focus ring.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add check-in.html test/checkin-page-structure.test.js
git commit -m "feat: add standalone /check-in booking page"
```

---

## Self-Review

Run this yourself after the last task, before handing off.

**1. Spec coverage** — every requirement in `docs/superpowers/specs/2026-09-29-checkin-booking-design.md` mapped to a task:

| Spec requirement | Task |
| --- | --- |
| `checkin-availability-template.json` blob, same shape as the applicant template, independent document | 1 (constant), 5 (loader + admin write) |
| Timezone separately admin-editable on the check-in template | 5 |
| `checkin-clients.json` blob, `{ clients: [{name,email,phone}] }` | 1 (constant), 3 (module) |
| Email required on every entry; email is the record key | 3 (`validateClient`), 4 (POST 400), 14 (`required` input) |
| Phone optional, second way to verify | 3, 4, 6, 14 |
| Case-insensitive email match, digits-only phone match | 3 (`findClient`, `normalizePhone`) |
| No new OAuth blob; one calendar, one connection | Global Constraints; nothing in any task adds one |
| Shared `EVENT_MARKER`, `_booking-guard.js` untouched | Global Constraints; 10 (writes the shared marker, cross-audience race tests) |
| `extendedProperties.private.audience = 'checkin'`; applicant absence means applicant | 1 (constant), 10 (write), 11/12/13 (read) |
| `POST /api/checkin-verify` → `{ok:true,name,verifyToken}` / `{ok:false}` | 6 |
| New `makeVerifyToken`/`verifyVerifyToken` in `api/_checkin-token.js`, NOT a `manageToken` reuse | 2 |
| `checkin-verify-v1\|<email>\|<expiryEpochMs>` HMAC on `sessionSecret()` | 2 |
| `<base64url signature>.<expiryEpochMs>`, expiry checked before the HMAC, constant-time compare | 2 |
| Token always scoped to the record's email, even when a phone was typed | 2, 6 (test asserts it) |
| 10-minute expiry | 2 (`VERIFY_TOKEN_TTL_MS`) |
| Generic failure, no distinction between causes | 6 (200 for both, `{ok:false}` only), 15 (verbatim copy) |
| `GET /api/calendar-checkin-availability`, same free/busy against the same calendar | 7 |
| `POST /api/calendar-checkin-book`: re-verify, guard, manage token, `verifyToken` required, 403 otherwise | 10 |
| `visitorEmail` from the token, not the body | 10 (`resolveVerifyToken`, and the "email in the body is ignored" test) |
| `POST /api/calendar-checkin-reschedule` / `-cancel`, same rollback and `reminderSent` discipline | 11, 12 |
| Audience-mismatch 403 defense in depth on both | 11, 12 |
| `GET/POST /api/admin/checkin-availability`, same passcode gate, validate-before-normalize | 5 |
| `GET/POST/DELETE /api/admin/checkin-clients`; POST validates email; add-existing replaces; DELETE by email | 4 |
| Reminders stays ONE cron, branching on `meta.audience` | 13 |
| Delivery guarantee unchanged for both audiences | 13 (Step 7 runs `reminder-delivery-guarantee.test.js` unchanged) |
| `api/_checkin-slack.js` mirroring `_booking-slack.js`, three new channel constants | 1, 8 |
| `getPermalink` for cross-channel context | 8 |
| Backend failures reuse `postSystemAlert` / `#7` | 10, 11, 12, 13 (no new alert channel anywhere) |
| `api/_checkin-email.js` with the four senders, placeholder copy, `send`/`formatWhen` reused from `_email.js` | 1 (export), 9 |
| `check-in.html`: standalone, no `booking-widget.js`, Bullion identity, same tokens/fonts/zero-radius/logical properties | 15 |
| Verify → picker → confirm; confirm collects nothing further | 15 |
| 409 handled as an expected race | 15 |
| `admin.html` tab bar: New Applicants (default) + Check-Ins with hours form and client manager, one passcode session | 14 |
| No manage-booking UI or link for check-in clients | 9 (no links in the emails), 15 (no manage page) |
| Out of scope: CRM sync, login system, final copy, second calendar, applicant-flow changes | Global Constraints; no task adds any |

No spec requirement is unmapped.

**2. Placeholder scan** — the only occurrences of the word "placeholder" in this plan are (a) the `PASTE_REAL_ID` markers in Task 1 Step 5, which the task's PREREQUISITE resolves with a concrete command and whose test fails on anything not Slack-shaped, and (b) the deliberate, spec-mandated `[PLACEHOLDER]` email copy in Task 9. There is no "TBD", no "implement later", no "add appropriate error handling", no "write tests for the above", and no "similar to Task N" — every test step contains complete runnable code, and every implementation step contains the complete file or the exact replacement block.

**3. Type and signature consistency** — checked across tasks:

- `store.CHECKIN_AVAILABILITY_BLOB` / `store.CHECKIN_CLIENTS_BLOB` (Task 1) — consumed with those exact names in 3, 5.
- `AUDIENCE_CHECKIN` / `isCheckinEvent(meta)` (Task 1) — consumed in 10, 11, 12, 13. `isCheckinEvent` always takes `extendedProperties.private`, never an event.
- `makeVerifyToken(email, ttlMs?)`, `verifyVerifyToken(email, token)`, `resolveVerifyToken(clients, token)`, `VERIFY_TOKEN_TTL_MS` (Task 2) — consumed in 6 (`makeVerifyToken`) and 10 (`resolveVerifyToken`). Named identically everywhere.
- `loadClients()` returns `{ok, clients, usedDefault|reason}` (Task 3) — consumed in 4, 6, 10 with those exact fields.
- `Client` is `{name, email, phone}` with all three always strings (Task 3) — matches what 4 returns over HTTP, what 6 reads `.name` from, and what 10 reads `.email`/`.name`/`.phone` from.
- `loadCheckinTemplate()` returns `{ok, template, usedDefault|reason}` (Task 5) — same shape as the existing `loadTemplate()`, consumed in 7, 10, 11, 12, 13.
- The **Booking** object (defined once, in Task 8) is the single shape produced by 10, 11, 12 and 13 and consumed by 8 and 9. Eleven fields, all always present: `eventId, name, email, phone, startMs, endMs, visitorTimeZone, templateTimeZone, manageToken, meetLink, lang`. Verified field-by-field against every sender and every builder.
- `postCheckinBookingCreated(b)` and `postCheckinBookingChanged(b, kind, originalTs)` (Task 8) — called with exactly those arities in 10, 11, 12.
- `sendCheckinConfirmation` / `sendCheckinRescheduleNotice` / `sendCheckinCancellationNotice` / `sendCheckinReminder` (Task 9) — called in 10, 11, 12, 13 respectively, spelled identically.
- `send({to, subject, html})` from `_email.js` (Task 1) — consumed only in 9.
- `loadBooking(body)` returning `{ok, event, meta}` / `{ok:false, status, error, message}` — unchanged, consumed in 11, 12.
- Id prefixes in Task 14 (`''` and `'chk-'`) — every helper takes `prefix` first; `populateForm(prefix, template)` and `collectTemplate(prefix)` have prefix-first signatures consistently, and `loadAvailabilityInto(prefix, endpoint, noteId)` / `wireAvailabilityForm(prefix, endpoint, noteId)` match their call sites in `init()`.

One naming decision worth flagging to a reviewer: `api/_checkin-clients.js` exports `loadClients`, and `admin.html` (Task 14) also defines a browser-side `loadClients()`. They are in different runtimes and never in the same scope, so this is not a collision — but do not "fix" one by renaming the other without updating its call sites.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-29-checkin-booking.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute tasks in one session with checkpoints for review. **REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

Which approach?
