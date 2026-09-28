# Calendar Booking System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor who already applied on the `1k-3k` / `3k+` budget tier book a call on Omar's Google Calendar directly from the Apply form's confirmation screen, with no DM round-trip.

**Architecture:** Vercel serverless functions under `api/` (CommonJS, same convention as the existing `api/submit.js`), all persistent state in two private Vercel Blob JSON documents, and one dependency-free vanilla-JS widget (`booking-widget.js`) mounted into the existing `#formConfirm` screen. Slot availability is computed on request from a weekly template plus live Google free/busy data — never pre-generated. The calendar itself is the record: no bookings database, and per-booking metadata (Slack thread ts, reminder-sent flag, visitor email) rides along in each event's `extendedProperties.private`.

**Tech Stack:** Node 24 (Vercel runtime), CommonJS, `@vercel/blob@^2.8.0`, `node-fetch@^2.7.0` (already present), Google Calendar REST v3 (raw `fetch`, no googleapis SDK), Resend REST API, `node:test` + `node:assert/strict` for tests (zero new test dependencies), `node:crypto` for HMAC.

**Spec:** `docs/superpowers/specs/2026-09-24-calendar-booking-design.md` (committed on the `internal-docs` branch; read with `git show internal-docs:docs/superpowers/specs/2026-09-24-calendar-booking-design.md`).

## Global Constraints

These apply to **every** task. Do not restate them as done; just never violate them.

- **Do not write final email copy.** Every subject/body string must carry the exact comment `// PLACEHOLDER COPY — collaborative design pass pending`. Final wording is a separate interactive step with the user.
- **Tier 1 only.** No client list, no packages, no client-facing login, no multi-staff/multi-calendar scheduling. Do not build any of it "just in case."
- **The OAuth redirect path is locked** to `/api/calendar-oauth-callback` (registered in Google Cloud). The file must be `api/calendar-oauth-callback.js`. Do not rename it.
- **Do not recreate credentials.** `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` already exist as Vercel env vars (Production + Preview). Reference them as `process.env.X` only.
- **Do not touch `main`, do not push, do not open a PR.** All work stays on the local worktree branch.
- **Visual system is fixed (Bullion).** Use only these tokens: `--void:#050505`, `--band:#101010`, `--band-2:#181817`, `--gold:#D4AF37`, `--gold-lo:#7A6218`, `--bone:#F2EEE4`, `--dim:#8B887F`, `--ink:#0A0802`, `--slab:#1C1C1A`. Headings `'Big Shoulders Display','Changa',sans-serif` with a `[dir="rtl"]` override to `'Changa'` + `text-transform:none`. **`border-radius: 0` everywhere** — zero exceptions. Use logical CSS properties (`border-block-end`, `padding-inline`, `margin-inline-start`) never physical `left`/`right`. No new visual language.
- **Bilingual, no mixing.** Any new visible string needs a key in **both** the `ar` and `en` blocks of the `t` object in `index.html`. Arabic is Levantine, informal — match the register of `confirm_wa_label: "بتفضل تتواصل معنا وين؟ واتساب أو إنستغرام"`. Never ship an English string that renders in Arabic mode.
- **RTL is the default** (`dir="rtl"`, `lang="ar"`). Everything must work in both directions. Never write horizontal-scroll or offset math that assumes LTR — this codebase has already shipped a real bug where exactly that silently scrolled into empty space (see the `driftLoop` comment in `index.html`).
- **Vercel routing:** any file in `api/` whose name does **not** start with `_` becomes a public HTTP route. All shared helpers MUST be `_`-prefixed.
- **Commit style:** `feat:` / `fix:` / `docs:` / `content:` / `style:` prefix, lowercase, and the message explains *why*, not just *what*. See `git log`.
- **Never commit `node_modules/`.**

## Environment variables

Already provisioned (do not recreate): `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Auto-provided by Vercel once the Blob store exists: `BLOB_READ_WRITE_TOKEN`.

**New, NOT yet provisioned — the user must set these. Every task that reads one must fail closed with a clear, readable error, never a 500 stack trace:**

| Var | Required? | Default / fallback |
| --- | --- | --- |
| `ADMIN_PASSCODE` | **Yes** — admin gate is unusable without it | none; fail closed |
| `ADMIN_SESSION_SECRET` | No | derived via HMAC from `GOOGLE_CLIENT_SECRET` |
| `GOOGLE_CALENDAR_ID` | No | `'primary'` |
| `RESEND_FROM` | No | `'onboarding@resend.dev'` (Resend shared sender) |
| `PUBLIC_BASE_URL` | **Yes** — OAuth cannot complete without it | `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`, then `https://3amaktrades.com` |
| `CRON_SECRET` | No | if unset, the reminder endpoint refuses to run |

**`PUBLIC_BASE_URL` must byte-match the origin of the redirect URI registered on the Google Cloud OAuth client** (i.e. `<PUBLIC_BASE_URL>/api/calendar-oauth-callback` must equal the registered URI exactly, trailing slash included). Google compares the redirect URI as a literal string and rejects anything else with `Error 400: redirect_uri_mismatch`.

`VERCEL_URL` **cannot** be relied on for this: it is always set on Vercel but is the *per-deployment* hostname, unique to every single deploy, so it can never match one registered URI. `VERCEL_PROJECT_PRODUCTION_URL` (the stable production domain) is preferred over it, but only an explicit `PUBLIC_BASE_URL` is guaranteed to match what was registered. The same value builds the links inside every transactional email, so a wrong value also sends deployment-hash hosts to visitors. Resolved in exactly one place: `api/_site-url.js`.

---

## File Structure

**Shared helpers (all `_`-prefixed so Vercel does not route them):**

| File | Responsibility |
| --- | --- |
| `api/_blob-store.js` | Read/write the two JSON docs. Private access, CDN-cache-bypassing reads, graceful "not configured" state. |
| `api/_timezone.js` | Pure IANA-timezone math: wall-clock ↔ UTC, DST-gap detection. No I/O. |
| `api/_availability.js` | Pure slot computation from template + busy intervals + now. No I/O. |
| `api/_google-calendar.js` | OAuth token exchange/refresh (cached keyed on refresh-token value) + Calendar REST calls. |
| `api/_admin-auth.js` | Passcode check + HMAC-signed session cookie. |
| `api/_booking-token.js` | Stateless HMAC token authorising a visitor to reschedule/cancel their own booking. |
| `api/_email.js` | Resend sending. Four transactional emails, all PLACEHOLDER copy. |
| `api/_booking-slack.js` | Booking notifications, built on the existing `api/_slack.js`. |
| `api/_site-url.js` | The single `baseUrl()`. One copy only: it builds both the OAuth redirect URI and every emailed link, so a divergent copy breaks one of the two. |

**Endpoints:**

| File | Route |
| --- | --- |
| `api/calendar-oauth-start.js` | `GET /api/calendar-oauth-start` |
| `api/calendar-oauth-callback.js` | `GET /api/calendar-oauth-callback` (**path locked**) |
| `api/calendar-availability.js` | `GET /api/calendar-availability` |
| `api/calendar-book.js` | `POST /api/calendar-book` |
| `api/calendar-reschedule.js` | `POST /api/calendar-reschedule` |
| `api/calendar-cancel.js` | `POST /api/calendar-cancel` |
| `api/calendar-reminders.js` | `GET /api/calendar-reminders` (cron) |
| `api/admin/login.js` | `POST /api/admin/login` |
| `api/admin/status.js` | `GET /api/admin/status` |
| `api/admin/availability.js` | `GET` + `POST /api/admin/availability` |

**Frontend / config:**

| File | Responsibility |
| --- | --- |
| `booking-widget.js` | Self-contained zero-dependency widget, `BookingWidget.mount(container, options)`. |
| `admin.html` | Connect-calendar + weekly-availability admin page. |
| `index.html` | **Modify**: confirm-screen markup, widget CSS, `t` strings, `submitForm()` wiring. |
| `vercel.json` | **Modify**: add the reminder cron. |
| `package.json` | **Modify**: add `@vercel/blob`, add `"test": "node --test"`. |
| `.gitignore` | **Create**: ignore `node_modules/`. |

**Tests** (`node --test` auto-discovers `test/**/*.test.js`):
`test/timezone.test.js`, `test/availability.test.js`, `test/blob-store.test.js`, `test/admin-auth.test.js`, `test/booking-token.test.js`, `test/booking-guard.test.js`

---

## Verified technical facts

These were confirmed by running code in this worktree. Do not re-litigate or "improve" them.

1. **Node 24.15 with full ICU.** `Intl.supportedValuesOf('timeZone')` returns 418 zones. Zone-aware formatting works.
2. **The wall-clock→UTC algorithm in Task 2 is verified correct**: 0 mismatches across 1460 wall-clock times in `America/Toronto`, `Europe/Istanbul`, `Asia/Riyadh`, `Australia/Lord_Howe` (30-min DST), `Asia/Kathmandu` (+05:45). Two passes over the offset lookup are **required** — one pass is wrong at DST boundaries.
3. **Spring-forward gap is silent.** `2026-03-08 02:30` in `America/Toronto` does not exist; the algorithm returns the instant that formats back as `01:30`. A slot generator that does not verify the round-trip will silently emit a wrong-time slot. Task 2 provides `wallTimeExistsInZone` for exactly this; Task 3 must use it.
4. **Fall-back ambiguity resolves to the earlier (DST) occurrence.** `2026-11-01 01:30` → `05:30Z`. Acceptable and intentional.
5. **`@vercel/blob@2.8.0`** exports `put`, `get`, `head`, `list`, `del`, `BlobNotFoundError`. `put`'s `cacheControlMaxAge` **cannot go below 60 seconds** (defaults to one month) — so CDN-cached reads of a mutable document are a real staleness hazard.
6. **The fix for (5):** `get(pathname, { access: 'private', useCache: false })` bypasses the CDN and reads origin storage. It resolves to `null` (does not throw) when the blob does not exist.
7. **`access: 'private'` is supported on `put`.** It is mandatory here — a public `oauth-refresh-token.json` would expose a Google refresh token at a guessable URL.
8. **Reading a blob body:** `await new Response(result.stream).text()` — verified working.
9. **With no Blob store configured**, `get` throws `BlobError: "Vercel Blob: No blob credentials found…"`. Task 1 converts this into a clean `{ ok: false, reason: 'BLOB_NOT_CONFIGURED' }` so the whole system degrades readably instead of 500ing. **This is the expected state right now — the Blob store does not exist yet.**
10. **Test command is bare `node --test`.** On Windows, `node --test test/` fails with `MODULE_NOT_FOUND` (it tries to resolve `test` as a module). Always use bare `node --test`.
11. **`postToSlack(channelId, message)` in `api/_slack.js` returns `{ ts }` and spreads `...message` into the `chat.postMessage` body** — so passing `thread_ts` threads a reply. Threading IS supported. Requires `SLACK_BOT_TOKEN`; the webhook fallback returns `ts: null` and cannot thread.
12. **`budgetCode` values** are exactly `'<500'`, `'500-1k'`, `'1k-3k'`, `'3k+'`, set from `answers.q6` in `submitForm()` (`index.html`). Note the deliberate off-by-one: step 6 holds budget but its translation keys are `q7_a`…`q7_d`.

---

## Rulings on points the spec left open

Implement these as written. Each is recorded in the final report.

- **R1 — `bufferMinutes` pads busy intervals, it does not widen the slot grid.** The grid advances by `slotMinutes`; a candidate slot is rejected if it comes within `bufferMinutes` of any busy interval. This is the standard Calendly semantic and it also gives back-to-back protection for free, because a new booking becomes a busy interval. *Cost if wrong:* slots sit closer together than Omar wants; one-line change.
- **R2 — Visitor reschedule/cancel is authorised by a stateless HMAC token** over `eventId|email`, handed back by `/api/calendar-book` and embedded in email links. *Why:* the spec allows no bookings database, so authorisation cannot be a stored session. *Cost if wrong:* nothing; token is opaque and revocable by rotating the secret.
- **R3 — Per-booking metadata lives in the event's `extendedProperties.private`** (`bookingSource`, `visitorEmail`, `visitorTimeZone`, `slackTs`, `reminderSent`). *Why:* keeps "the calendar is the record" literally true and avoids a third blob. *Cost if wrong:* none material.
- **R4 — Booking notifications go to `CHANNEL_WARM_LEADS`**, threading reschedule/cancel onto the original message via the stored `slackTs`. *Why:* a booked call is warmer than a raw application, and that is where `wa-click.js` already sends warm signals. *Cost if wrong:* one constant.
- **R5 — Double-booking rollback uses a deterministic tie-break.** If the post-insert overlap check finds more than one event, the event with the lexicographically smallest `id` wins and every other booking rolls itself back. *Why:* the spec's plain "roll back if more than one exists" makes both sides of a true simultaneous race cancel, leaving nobody booked. *Cost if wrong:* none; strictly safer.
  - **R5 refined (final review):** the tie-break is only sound when BOTH racers run this guard, which is true only when two of *our own* bookings collide. If any overlapping event lacks our `bookingSource` marker — Omar booked on his phone, another Google client wrote, or `freeBusy` lagged a just-created event — nobody withdraws on the other side, so winning the tie-break would leave a genuine double-booking standing while the visitor is told "confirmed". Any foreign overlap therefore yields **unconditionally**; the id tie-break applies only among our own events.
- **R6 — `/api/calendar-availability` accepts an optional `days=N`** (1–31, default 1) returning a map of date → slots. *Why:* the widget must "auto-select the first day with real openings" and draw a day strip; per-day requests would be N round trips and N free/busy queries. The single-`date` contract from the spec still works unchanged. *Cost if wrong:* none; additive.
- **R7 — A Google Meet link is requested for each booking, with automatic fallback.** If the insert is rejected for conference reasons, retry once without `conferenceData`. *Why:* "book a call" needs somewhere to meet, and the confirmation email needs a join link. *Cost if wrong:* drop the `createRequest` block; bookings still work.
- **R8 — Reminder de-duplication is a flag on the event** (`reminderSent: '1'`), driven by a Vercel Cron. *Why:* no bookings table to track sends. **Note:** Vercel's Hobby plan permits only once-per-day crons; the plan ships `0 * * * *` (hourly) and the final report flags that it may need relaxing depending on plan.
- **R9 — Ambiguous fall-back wall times resolve to the earlier occurrence**, and non-existent spring-forward wall times are dropped from availability entirely.

---

## Task list

1. Scaffolding, `.gitignore`, `@vercel/blob`, blob-store layer
2. `api/_timezone.js` — timezone math
3. `api/_availability.js` — slot computation
4. `api/_google-calendar.js` — OAuth + Calendar REST client
5. Admin gate + OAuth connect flow
6. `api/calendar-availability.js`
7. Booking side-effect helpers (token, email, Slack)
8. `api/calendar-book.js` + double-booking guard
9. `api/calendar-reschedule.js` + `api/calendar-cancel.js`
10. Admin availability API + `admin.html`
11. `booking-widget.js`
12. `index.html` integration
13. Reminder cron

---

### Task 1: Scaffolding, `.gitignore`, and the blob-store layer

**Files:**
- Create: `.gitignore`
- Modify: `package.json`
- Create: `api/_blob-store.js`
- Test: `test/blob-store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BLOB_NOT_CONFIGURED` = `'BLOB_NOT_CONFIGURED'`
  - `AVAILABILITY_BLOB` = `'availability-template.json'`, `OAUTH_BLOB` = `'oauth-refresh-token.json'`
  - `async readJson(pathname) -> { ok: boolean, reason?: string, data: object|null }` — `data: null` means "blob does not exist yet"
  - `async writeJson(pathname, data) -> { ok: boolean, reason?: string }`
  - `isConfigured() -> boolean`
  - `__setClientForTests(client)` where `client` is `{ get, put }`

- [ ] **Step 1: Create `.gitignore`** — `node_modules/` is currently untracked with no ignore file, so `git add .` would commit 35 packages.

```
node_modules/
.vercel
.env
.env.local
.DS_Store
```

- [ ] **Step 2: Add the dependency and test script to `package.json`**

```json
{
  "name": "3amaktrades-landing",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@vercel/blob": "^2.8.0",
    "node-fetch": "^2.7.0"
  }
}
```

Then run `npm install`.

- [ ] **Step 3: Write the failing test** — `test/blob-store.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');

function fakeClient({ body = null, throwOnGet = null } = {}) {
  const calls = { get: [], put: [] };
  return {
    calls,
    get: async (pathname, options) => {
      calls.get.push({ pathname, options });
      if (throwOnGet) throw throwOnGet;
      if (body === null) return null;
      return { stream: new Response(body).body, blob: {}, headers: new Headers() };
    },
    put: async (pathname, content, options) => {
      calls.put.push({ pathname, content, options });
      return { pathname };
    },
  };
}

test('readJson returns data:null when the blob does not exist', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  store.__setClientForTests(fakeClient({ body: null }));
  const res = await store.readJson('availability-template.json');
  assert.equal(res.ok, true);
  assert.equal(res.data, null);
});

test('readJson parses JSON and always bypasses the CDN cache', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const c = fakeClient({ body: JSON.stringify({ timezone: 'America/Toronto' }) });
  store.__setClientForTests(c);
  const res = await store.readJson('availability-template.json');
  assert.equal(res.ok, true);
  assert.equal(res.data.timezone, 'America/Toronto');
  // A stale read here would serve an old refresh token or old hours.
  assert.equal(c.calls.get[0].options.useCache, false);
  assert.equal(c.calls.get[0].options.access, 'private');
});

test('writeJson writes privately, overwritably, with a stable pathname', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const c = fakeClient();
  store.__setClientForTests(c);
  const res = await store.writeJson('availability-template.json', { a: 1 });
  assert.equal(res.ok, true);
  const put = c.calls.put[0];
  assert.equal(put.options.access, 'private');       // public == credential leak
  assert.equal(put.options.allowOverwrite, true);
  assert.equal(put.options.addRandomSuffix, false);  // else we can never read it back
  assert.equal(put.options.contentType, 'application/json');
  assert.deepEqual(JSON.parse(put.content), { a: 1 });
});

test('reports BLOB_NOT_CONFIGURED instead of throwing when there is no store', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  store.__setClientForTests(fakeClient());
  const read = await store.readJson('availability-template.json');
  assert.equal(read.ok, false);
  assert.equal(read.reason, store.BLOB_NOT_CONFIGURED);
  const write = await store.writeJson('availability-template.json', {});
  assert.equal(write.ok, false);
  assert.equal(write.reason, store.BLOB_NOT_CONFIGURED);
});

test('a throwing client surfaces as ok:false, never an exception', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  store.__setClientForTests(fakeClient({ throwOnGet: new Error('network down') }));
  const res = await store.readJson('availability-template.json');
  assert.equal(res.ok, false);
  assert.match(res.reason, /network down/);
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_blob-store'`

- [ ] **Step 5: Implement `api/_blob-store.js`**

```js
// The two JSON documents holding every piece of persistent state for the
// booking system. Both are PRIVATE: oauth-refresh-token.json holds a Google
// refresh token, which at a public blob URL would be a credential leak.
//
// Reads always pass useCache:false. Vercel Blob's cacheControlMaxAge cannot be
// set below 60s (and defaults to a month), so a CDN-cached read of a mutable
// document can serve hours-old availability, or a refresh token Omar has
// already replaced. useCache:false reads origin storage instead.
const vercelBlob = require('@vercel/blob');

const BLOB_NOT_CONFIGURED = 'BLOB_NOT_CONFIGURED';
const AVAILABILITY_BLOB = 'availability-template.json';
const OAUTH_BLOB = 'oauth-refresh-token.json';

let client = { get: vercelBlob.get, put: vercelBlob.put };

// Tests inject a fake so the suite never needs a real Blob store.
function __setClientForTests(c) { client = c; }

// The Blob store does not exist on this project yet (the user creates it from
// the Vercel dashboard). Detect that up front so callers can return a readable
// "storage not set up" message instead of a 500 from deep inside the SDK.
function isConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN
    || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));
}

async function readJson(pathname) {
  if (!isConfigured()) return { ok: false, reason: BLOB_NOT_CONFIGURED, data: null };
  try {
    const result = await client.get(pathname, { access: 'private', useCache: false });
    if (!result) return { ok: true, data: null }; // not written yet -- normal first run
    const text = await new Response(result.stream).text();
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, reason: e.message || String(e), data: null };
  }
}

async function writeJson(pathname, data) {
  if (!isConfigured()) return { ok: false, reason: BLOB_NOT_CONFIGURED };
  try {
    await client.put(pathname, JSON.stringify(data, null, 2), {
      access: 'private',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false, // a random suffix changes the pathname every write
      cacheControlMaxAge: 60, // the SDK's floor; reads bypass the cache anyway
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

module.exports = {
  readJson, writeJson, isConfigured, __setClientForTests,
  BLOB_NOT_CONFIGURED, AVAILABILITY_BLOB, OAUTH_BLOB,
};
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json package-lock.json api/_blob-store.js test/blob-store.test.js
git commit -m "feat: add Vercel Blob storage layer for booking state

Both documents are private: oauth-refresh-token.json holds a Google refresh
token that would be readable at a guessable URL if the blob were public. Reads
pass useCache:false because Blob's cacheControlMaxAge floor is 60s and defaults
to a month, so a cached read can serve a refresh token Omar already replaced.

A missing store is reported as BLOB_NOT_CONFIGURED rather than thrown, so the
system degrades to a readable message until the store is created."
```

---

### Task 2: `api/_timezone.js` — timezone math

The highest-risk correctness area in the build. Pure functions, no I/O, no dependencies.

**Files:**
- Create: `api/_timezone.js`
- Test: `test/timezone.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `zoneOffsetMs(utcMs, timeZone) -> number` — ms to add to UTC to get zone wall time
  - `zonedWallTimeToUtc(y, mo, d, h, mi, timeZone) -> number` (epoch ms; **`mo` is 1-based**)
  - `wallTimeExistsInZone(y, mo, d, h, mi, timeZone) -> boolean`
  - `zoneDateParts(utcMs, timeZone) -> { year, month, day, hour, minute }` (`month` 1-based)
  - `parseYmd('YYYY-MM-DD') -> { y, mo, d } | null`
  - `formatYmd(y, mo, d) -> 'YYYY-MM-DD'`
  - `weekdayKeyFromYmd(y, mo, d) -> 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun'`
  - `parseHm('HH:MM') -> { h, mi } | null`
  - `isValidTimeZone(tz) -> boolean`
  - `WEEKDAY_KEYS` = `['sun','mon','tue','wed','thu','fri','sat']`

- [ ] **Step 1: Write the failing test** — `test/timezone.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../api/_timezone');

function inZone(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(ms);
}

test('converts wall time to UTC across a DST boundary', () => {
  // Toronto is EST (-5) in January, EDT (-4) in July.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 1, 15, 9, 0, 'America/Toronto')).toISOString(),
    '2026-01-15T14:00:00.000Z');
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 7, 15, 9, 0, 'America/Toronto')).toISOString(),
    '2026-07-15T13:00:00.000Z');
});

test('Istanbul has no DST, so summer and winter share an offset', () => {
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 1, 15, 9, 0, 'Europe/Istanbul')).toISOString(),
    '2026-01-15T06:00:00.000Z');
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 7, 15, 9, 0, 'Europe/Istanbul')).toISOString(),
    '2026-07-15T06:00:00.000Z');
});

test('round-trips wall times in zones with odd offsets and odd DST', () => {
  // Kathmandu is +05:45; Lord Howe shifts by only 30 minutes.
  for (const zone of ['America/Toronto', 'Europe/Istanbul', 'Asia/Riyadh',
                      'Australia/Lord_Howe', 'Asia/Kathmandu']) {
    for (let day = 0; day < 365; day++) {
      const base = new Date(Date.UTC(2026, 0, 1 + day));
      const y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1, d = base.getUTCDate();
      for (const h of [0, 9, 13, 23]) {
        if (!tz.wallTimeExistsInZone(y, mo, d, h, 30, zone)) continue;
        const ms = tz.zonedWallTimeToUtc(y, mo, d, h, 30, zone);
        const want = `${String(h).padStart(2, '0')}:30`;
        assert.ok(inZone(ms, zone).endsWith(want),
          `${zone} ${y}-${mo}-${d} ${want} -> ${inZone(ms, zone)}`);
      }
    }
  }
});

test('flags the spring-forward gap, where a wall time does not exist', () => {
  // Toronto jumps 02:00 -> 03:00 on 2026-03-08. 02:30 never happens.
  assert.equal(tz.wallTimeExistsInZone(2026, 3, 8, 1, 30, 'America/Toronto'), true);
  assert.equal(tz.wallTimeExistsInZone(2026, 3, 8, 2, 30, 'America/Toronto'), false);
  assert.equal(tz.wallTimeExistsInZone(2026, 3, 8, 3, 30, 'America/Toronto'), true);
});

test('resolves an ambiguous fall-back wall time to the earlier occurrence', () => {
  // 01:30 happens twice on 2026-11-01. 05:30Z is the first (EDT) one.
  assert.equal(
    new Date(tz.zonedWallTimeToUtc(2026, 11, 1, 1, 30, 'America/Toronto')).toISOString(),
    '2026-11-01T05:30:00.000Z');
});

test('reads back the wall-clock parts of an instant in a zone', () => {
  assert.deepEqual(
    tz.zoneDateParts(Date.UTC(2026, 6, 15, 13, 0), 'America/Toronto'),
    { year: 2026, month: 7, day: 15, hour: 9, minute: 0 });
});

test('maps a calendar date to a weekday key', () => {
  assert.equal(tz.weekdayKeyFromYmd(2026, 9, 25), 'fri');
  assert.equal(tz.weekdayKeyFromYmd(2026, 9, 27), 'sun');
  assert.equal(tz.weekdayKeyFromYmd(2026, 9, 28), 'mon');
});

test('parses and formats dates and times, rejecting malformed input', () => {
  assert.deepEqual(tz.parseYmd('2026-09-25'), { y: 2026, mo: 9, d: 25 });
  assert.equal(tz.parseYmd('25-09-2026'), null);
  assert.equal(tz.parseYmd('2026-13-01'), null);
  assert.equal(tz.parseYmd('2026-02-31'), null);
  assert.equal(tz.parseYmd('not a date'), null);
  assert.equal(tz.formatYmd(2026, 9, 5), '2026-09-05');
  assert.deepEqual(tz.parseHm('09:30'), { h: 9, mi: 30 });
  assert.deepEqual(tz.parseHm('9:30'), { h: 9, mi: 30 });
  assert.equal(tz.parseHm('24:00'), null);
  assert.equal(tz.parseHm('garbage'), null);
});

test('validates IANA zone names', () => {
  assert.equal(tz.isValidTimeZone('America/Toronto'), true);
  assert.equal(tz.isValidTimeZone('Europe/Istanbul'), true);
  assert.equal(tz.isValidTimeZone('Mars/Olympus'), false);
  assert.equal(tz.isValidTimeZone(''), false);
  assert.equal(tz.isValidTimeZone(null), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_timezone'`

- [ ] **Step 3: Implement `api/_timezone.js`**

```js
// Timezone math with no date library. Node on Vercel ships full ICU, so
// Intl.DateTimeFormat with an explicit timeZone is the source of truth for
// offsets -- including future DST rules.
//
// Verified: 0 mismatches across 1460 wall-clock times in America/Toronto,
// Europe/Istanbul, Asia/Riyadh, Australia/Lord_Howe (30-minute DST) and
// Asia/Kathmandu (+05:45).

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// How far the zone's wall clock sits from UTC at a given instant. Formats the
// instant in the zone, then re-reads those wall-clock fields as if they were
// UTC; the difference is the offset.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const part of dtf.formatToParts(utcMs)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  // hour12:false yields "24" for midnight in some ICU versions.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                           +hour, +parts.minute, +parts.second);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

// The UTC instant at which the zone's wall clock reads the given local time.
// TWO passes are required, not one: the first offset lookup happens at the
// wrong instant, which is off by an hour (or 30 minutes) right at a DST
// boundary. The second pass re-reads the offset at the corrected instant.
function zonedWallTimeToUtc(y, mo, d, h, mi, timeZone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}

function zoneDateParts(utcMs, timeZone) {
  const parts = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  for (const part of dtf.formatToParts(utcMs)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +hour, minute: +parts.minute,
  };
}

// On a spring-forward day an hour of wall time does not exist. Converting 02:30
// on such a day yields an instant that reads back as 01:30 -- so without this
// check a slot generator silently offers a time that never happens.
function wallTimeExistsInZone(y, mo, d, h, mi, timeZone) {
  const back = zoneDateParts(zonedWallTimeToUtc(y, mo, d, h, mi, timeZone), timeZone);
  return back.year === y && back.month === mo && back.day === d
    && back.hour === h && back.minute === mi;
}

function parseYmd(s) {
  const m = typeof s === 'string' && s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Reject 2026-02-31 and friends by round-tripping through Date.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, mo, d };
}

function formatYmd(y, mo, d) {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// A calendar date's weekday does not depend on a timezone, so this needs none.
function weekdayKeyFromYmd(y, mo, d) {
  return WEEKDAY_KEYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

function parseHm(s) {
  const m = typeof s === 'string' && s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  zoneOffsetMs, zonedWallTimeToUtc, zoneDateParts, wallTimeExistsInZone,
  parseYmd, formatYmd, weekdayKeyFromYmd, parseHm, isValidTimeZone, WEEKDAY_KEYS,
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS. The round-trip test alone exercises ~7000 conversions.

- [ ] **Step 5: Commit**

```bash
git add api/_timezone.js test/timezone.test.js
git commit -m "feat: add timezone math for admin-editable booking hours

Omar splits time between Canada and Turkey, so the availability template's
timezone is data rather than a constant -- which means every slot boundary
needs real IANA conversion instead of a fixed offset.

zonedWallTimeToUtc deliberately runs two offset lookups: one pass is wrong by
an hour at a DST boundary. wallTimeExistsInZone exists because the
spring-forward gap is otherwise silent -- 02:30 on a jump day converts to an
instant that reads back as 01:30, which would offer visitors a slot at a time
that never occurs."
```

---

### Task 3: `api/_availability.js` — slot computation

Pure, no I/O. This is where R1 (buffer semantics) and R9 (DST handling) live.

**Files:**
- Create: `api/_availability.js`
- Test: `test/availability.test.js`

**Interfaces:**
- Consumes: `api/_timezone.js` (Task 2).
- Produces:
  - `DEFAULT_TEMPLATE` — the object written on first run:
    ```js
    { timezone: 'America/Toronto',
      days: { mon:{enabled:true,start:'09:00',end:'17:00'}, /* tue..fri same */
              sat:{enabled:false,start:'09:00',end:'17:00'}, sun:{...false} },
      slotMinutes: 30, bufferMinutes: 15, minNoticeHours: 12 }
    ```
  - `normalizeTemplate(raw) -> template` — fills defaults, clamps, drops junk. Never throws.
  - `validateTemplate(raw) -> { ok: boolean, errors: string[] }`
  - `computeSlotsForDay({ template, ymd, busy, nowMs }) -> [{ startMs, endMs }]`
  - `computeSlotsForRange({ template, startYmd, days, busy, nowMs }) -> { 'YYYY-MM-DD': [{startMs,endMs}], ... }`
  - `slotExists({ template, startMs, busy, nowMs }) -> boolean` — used by booking to re-verify a requested slot

  `busy` is `[{ start: epochMs, end: epochMs }]`. `ymd` is `{ y, mo, d }`.

- [ ] **Step 1: Write the failing test** — `test/availability.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const av = require('../api/_availability');
const tz = require('../api/_timezone');

const TPL = {
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '11:00' },
    tue: { enabled: true, start: '09:00', end: '11:00' },
    wed: { enabled: true, start: '09:00', end: '11:00' },
    thu: { enabled: true, start: '09:00', end: '11:00' },
    fri: { enabled: true, start: '09:00', end: '11:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 30, bufferMinutes: 0, minNoticeHours: 0,
};

// 2026-09-28 is a Monday.
const MON = { y: 2026, mo: 9, d: 28 };
const at = (h, mi) => tz.zonedWallTimeToUtc(2026, 9, 28, h, mi, 'America/Toronto');

test('generates a slot grid inside the day window', () => {
  const slots = av.computeSlotsForDay({ template: TPL, ymd: MON, busy: [], nowMs: 0 });
  assert.equal(slots.length, 4); // 09:00 09:30 10:00 10:30
  assert.equal(slots[0].startMs, at(9, 0));
  assert.equal(slots[0].endMs, at(9, 30));
  assert.equal(slots[3].startMs, at(10, 30));
  // Never runs past the end of the window.
  assert.equal(slots[3].endMs, at(11, 0));
});

test('returns nothing for a disabled day', () => {
  const sat = { y: 2026, mo: 10, d: 3 }; // Saturday
  assert.deepEqual(av.computeSlotsForDay({ template: TPL, ymd: sat, busy: [], nowMs: 0 }), []);
});

test('drops slots that overlap a busy interval', () => {
  const busy = [{ start: at(9, 30), end: at(10, 0) }];
  const slots = av.computeSlotsForDay({ template: TPL, ymd: MON, busy, nowMs: 0 });
  assert.deepEqual(slots.map(s => s.startMs), [at(9, 0), at(10, 0), at(10, 30)]);
});

test('an event partially covering a slot still removes the whole slot', () => {
  const busy = [{ start: at(9, 10), end: at(9, 20) }];
  const slots = av.computeSlotsForDay({ template: TPL, ymd: MON, busy, nowMs: 0 });
  assert.equal(slots.some(s => s.startMs === at(9, 0)), false);
});

test('bufferMinutes pads busy intervals rather than widening the grid (R1)', () => {
  const template = { ...TPL, bufferMinutes: 15 };
  const busy = [{ start: at(10, 0), end: at(10, 30) }];
  const slots = av.computeSlotsForDay({ template, ymd: MON, busy, nowMs: 0 });
  // 09:30-10:00 now falls inside the 15-minute pad before the event, and
  // 10:30-11:00 inside the pad after it. The grid itself stays on :00/:30.
  assert.deepEqual(slots.map(s => s.startMs), [at(9, 0)]);
});

test('honours minNoticeHours', () => {
  const template = { ...TPL, minNoticeHours: 2 };
  const nowMs = at(8, 0); // 08:00 local, so 09:00 and 09:30 are inside 2h notice
  const slots = av.computeSlotsForDay({ template, ymd: MON, busy: [], nowMs });
  assert.deepEqual(slots.map(s => s.startMs), [at(10, 0), at(10, 30)]);
});

test('skips wall times lost to the spring-forward gap (R9)', () => {
  // Toronto jumps 02:00 -> 03:00 on 2026-03-08 (a Sunday).
  const template = {
    ...TPL,
    days: { ...TPL.days, sun: { enabled: true, start: '01:00', end: '04:00' } },
  };
  const slots = av.computeSlotsForDay({
    template, ymd: { y: 2026, mo: 3, d: 8 }, busy: [], nowMs: 0,
  });
  // Every emitted slot must read back at the wall time it claims.
  for (const s of slots) {
    const p = tz.zoneDateParts(s.startMs, 'America/Toronto');
    assert.equal(p.day, 8);
    assert.ok(p.hour !== 2, `emitted a 02:xx slot that does not exist: ${p.hour}`);
  }
  assert.ok(slots.length > 0);
});

test('slot boundaries follow the template timezone, not the server', () => {
  const istanbul = { ...TPL, timezone: 'Europe/Istanbul' };
  const slots = av.computeSlotsForDay({ template: istanbul, ymd: MON, busy: [], nowMs: 0 });
  assert.equal(
    new Date(slots[0].startMs).toISOString(), '2026-09-28T06:00:00.000Z'); // 09:00 +03
});

test('computeSlotsForRange keys results by date and spans days', () => {
  const out = av.computeSlotsForRange({
    template: TPL, startYmd: { y: 2026, mo: 10, d: 2 }, days: 3, busy: [], nowMs: 0,
  });
  assert.deepEqual(Object.keys(out), ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(out['2026-10-02'].length, 4); // Friday
  assert.equal(out['2026-10-03'].length, 0); // Saturday, disabled
  assert.equal(out['2026-10-04'].length, 0); // Sunday, disabled
});

test('slotExists agrees with the generated grid', () => {
  assert.equal(av.slotExists({ template: TPL, startMs: at(9, 30), busy: [], nowMs: 0 }), true);
  assert.equal(av.slotExists({ template: TPL, startMs: at(9, 7),  busy: [], nowMs: 0 }), false);
  assert.equal(av.slotExists({ template: TPL, startMs: at(12, 0), busy: [], nowMs: 0 }), false);
  assert.equal(av.slotExists({
    template: TPL, startMs: at(9, 30),
    busy: [{ start: at(9, 30), end: at(10, 0) }], nowMs: 0,
  }), false);
});

test('normalizeTemplate repairs junk without throwing', () => {
  const n = av.normalizeTemplate({
    timezone: 'Mars/Olympus',                       // invalid -> default
    days: { mon: { enabled: true, start: '9:00', end: 'nonsense' } },
    slotMinutes: 7,                                 // not allowed -> default
    bufferMinutes: -5,                              // clamped
    minNoticeHours: 9999,                           // clamped
  });
  assert.equal(n.timezone, 'America/Toronto');
  assert.equal(n.days.mon.end, '17:00');
  assert.equal(n.slotMinutes, 30);
  assert.equal(n.bufferMinutes, 0);
  assert.ok(n.minNoticeHours <= 720);
  for (const k of tz.WEEKDAY_KEYS) assert.ok(n.days[k], `missing day ${k}`);
  assert.doesNotThrow(() => av.normalizeTemplate(null));
  assert.doesNotThrow(() => av.normalizeTemplate('garbage'));
});

test('validateTemplate rejects an end at or before its start', () => {
  const bad = { ...TPL, days: { ...TPL.days, mon: { enabled: true, start: '17:00', end: '09:00' } } };
  const res = av.validateTemplate(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(e => /mon/.test(e)));
  assert.equal(av.validateTemplate(TPL).ok, true);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_availability'`

- [ ] **Step 3: Implement `api/_availability.js`**

```js
// Pure slot computation: weekly template + live busy intervals + "now" in,
// bookable slots out. No I/O, no clock reads -- nowMs is always passed in, which
// is what makes every rule here testable.
//
// Slots are computed per request and never stored. The only persistent state is
// the template itself.
const tz = require('./_timezone');

const ALLOWED_SLOT_MINUTES = [15, 20, 30, 45, 60, 90, 120];

const DEFAULT_DAY = { enabled: false, start: '09:00', end: '17:00' };

const DEFAULT_TEMPLATE = {
  timezone: 'America/Toronto',
  days: {
    mon: { enabled: true, start: '09:00', end: '17:00' },
    tue: { enabled: true, start: '09:00', end: '17:00' },
    wed: { enabled: true, start: '09:00', end: '17:00' },
    thu: { enabled: true, start: '09:00', end: '17:00' },
    fri: { enabled: true, start: '09:00', end: '17:00' },
    sat: { enabled: false, start: '09:00', end: '17:00' },
    sun: { enabled: false, start: '09:00', end: '17:00' },
  },
  slotMinutes: 30,
  bufferMinutes: 15,
  minNoticeHours: 12,
};

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

// Accepts whatever is in the blob (possibly hand-edited, possibly an older
// shape) and returns something every downstream function can rely on.
function normalizeTemplate(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const days = {};
  for (const key of tz.WEEKDAY_KEYS) {
    const d = (src.days && typeof src.days === 'object' && src.days[key]) || {};
    const start = tz.parseHm(d.start) ? d.start : DEFAULT_TEMPLATE.days[key].start;
    const end = tz.parseHm(d.end) ? d.end : DEFAULT_TEMPLATE.days[key].end;
    days[key] = {
      enabled: d.enabled === true,
      start: start.length === 4 ? `0${start}` : start, // '9:00' -> '09:00'
      end: end.length === 4 ? `0${end}` : end,
    };
  }
  const slotMinutes = ALLOWED_SLOT_MINUTES.includes(Number(src.slotMinutes))
    ? Number(src.slotMinutes) : DEFAULT_TEMPLATE.slotMinutes;
  return {
    timezone: tz.isValidTimeZone(src.timezone) ? src.timezone : DEFAULT_TEMPLATE.timezone,
    days,
    slotMinutes,
    bufferMinutes: clamp(src.bufferMinutes, 0, 240, DEFAULT_TEMPLATE.bufferMinutes),
    minNoticeHours: clamp(src.minNoticeHours, 0, 720, DEFAULT_TEMPLATE.minNoticeHours),
  };
}

// Used by the admin POST to reject a bad save with a readable message, rather
// than silently normalizing Omar's hours into something he did not ask for.
function validateTemplate(raw) {
  const errors = [];
  const src = (raw && typeof raw === 'object') ? raw : {};
  if (!tz.isValidTimeZone(src.timezone)) errors.push('timezone is not a valid IANA zone name');
  if (!ALLOWED_SLOT_MINUTES.includes(Number(src.slotMinutes))) {
    errors.push(`slotMinutes must be one of ${ALLOWED_SLOT_MINUTES.join(', ')}`);
  }
  for (const key of tz.WEEKDAY_KEYS) {
    const d = (src.days && src.days[key]) || null;
    if (!d) { errors.push(`${key} is missing`); continue; }
    const s = tz.parseHm(d.start), e = tz.parseHm(d.end);
    if (!s) { errors.push(`${key} start time is not HH:MM`); continue; }
    if (!e) { errors.push(`${key} end time is not HH:MM`); continue; }
    if (d.enabled && (e.h * 60 + e.mi) <= (s.h * 60 + s.mi)) {
      errors.push(`${key} end time must be after its start time`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// R1: bufferMinutes pads each busy interval instead of widening the slot grid.
// This is the standard "buffer around my events" semantic, and because a new
// booking becomes a busy interval it also gives back-to-back protection free.
function overlapsBusy(startMs, endMs, busy, bufferMs) {
  for (const b of busy) {
    if (startMs < b.end + bufferMs && endMs > b.start - bufferMs) return true;
  }
  return false;
}

function computeSlotsForDay({ template, ymd, busy = [], nowMs }) {
  const tpl = normalizeTemplate(template);
  const day = tpl.days[tz.weekdayKeyFromYmd(ymd.y, ymd.mo, ymd.d)];
  if (!day || !day.enabled) return [];

  const start = tz.parseHm(day.start), end = tz.parseHm(day.end);
  if (!start || !end) return [];

  const slotMs = tpl.slotMinutes * 60 * 1000;
  const bufferMs = tpl.bufferMinutes * 60 * 1000;
  const earliest = nowMs + tpl.minNoticeHours * 60 * 60 * 1000;

  // The window's edges are wall times in the template's zone, so they move with
  // DST rather than being a fixed number of ms from midnight.
  const windowEnd = tz.zonedWallTimeToUtc(ymd.y, ymd.mo, ymd.d, end.h, end.mi, tpl.timezone);

  const slots = [];
  const startMinutes = start.h * 60 + start.mi;
  const endMinutes = end.h * 60 + end.mi;
  for (let m = startMinutes; m + tpl.slotMinutes <= endMinutes; m += tpl.slotMinutes) {
    const h = Math.floor(m / 60), mi = m % 60;
    // R9: on a spring-forward day this wall time may not exist at all. Emitting
    // it anyway would offer a slot at a time that never happens.
    if (!tz.wallTimeExistsInZone(ymd.y, ymd.mo, ymd.d, h, mi, tpl.timezone)) continue;
    const startMs = tz.zonedWallTimeToUtc(ymd.y, ymd.mo, ymd.d, h, mi, tpl.timezone);
    const endMs = startMs + slotMs;
    if (endMs > windowEnd) continue;         // DST can shorten the real window
    if (startMs < earliest) continue;        // minimum notice
    if (overlapsBusy(startMs, endMs, busy, bufferMs)) continue;
    slots.push({ startMs, endMs });
  }
  return slots.sort((a, b) => a.startMs - b.startMs);
}

function computeSlotsForRange({ template, startYmd, days, busy = [], nowMs }) {
  const out = {};
  const base = Date.UTC(startYmd.y, startYmd.mo - 1, startYmd.d);
  for (let i = 0; i < days; i++) {
    const cur = new Date(base + i * 86400000);
    const ymd = {
      y: cur.getUTCFullYear(), mo: cur.getUTCMonth() + 1, d: cur.getUTCDate(),
    };
    out[tz.formatYmd(ymd.y, ymd.mo, ymd.d)] =
      computeSlotsForDay({ template, ymd, busy, nowMs });
  }
  return out;
}

// Re-verifies a requested start before booking. Derives the calendar date from
// the instant in the TEMPLATE's zone, so a visitor in another zone whose local
// date differs still lands on the right day's rules.
function slotExists({ template, startMs, busy = [], nowMs }) {
  const tpl = normalizeTemplate(template);
  const p = tz.zoneDateParts(startMs, tpl.timezone);
  const slots = computeSlotsForDay({
    template: tpl, ymd: { y: p.year, mo: p.month, d: p.day }, busy, nowMs,
  });
  return slots.some(s => s.startMs === startMs);
}

module.exports = {
  DEFAULT_TEMPLATE, DEFAULT_DAY, ALLOWED_SLOT_MINUTES,
  normalizeTemplate, validateTemplate,
  computeSlotsForDay, computeSlotsForRange, slotExists,
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS, all availability tests plus the earlier suites.

- [ ] **Step 5: Commit**

```bash
git add api/_availability.js test/availability.test.js
git commit -m "feat: compute bookable slots from the weekly template

Slots are derived per request from the template plus live busy intervals and
never stored, so editing hours or the timezone takes effect immediately with no
regeneration step.

bufferMinutes pads busy intervals rather than widening the slot grid: that keeps
the visible grid on clean :00/:30 boundaries and, because each new booking
becomes a busy interval, gives back-to-back protection without a second rule.

Slots whose wall time is lost to a spring-forward jump are dropped rather than
silently shifted into the previous hour."
```

---

### Task 4: `api/_google-calendar.js` — OAuth + Calendar REST client

Raw `fetch` against Google's REST API. No `googleapis` SDK — it is a large dependency for six calls.

**Files:**
- Create: `api/_google-calendar.js`
- Test: `test/google-calendar.test.js`

**Interfaces:**
- Consumes: `api/_blob-store.js` (Task 1).
- Produces:
  - `consentUrl(state) -> string`
  - `redirectUri() -> string` — **must** produce `https://3amaktrades.com/api/calendar-oauth-callback` in production
  - `async exchangeCodeForTokens(code) -> { ok, refreshToken?, reason? }`
  - `async saveRefreshToken(refreshToken) -> { ok, reason? }`
  - `async isConnected() -> boolean`
  - `async getAccessToken() -> { ok, accessToken?, reason? }`
  - `async freeBusy(timeMinIso, timeMaxIso) -> { ok, busy?: [{start,end}], reason? }` (ms numbers)
  - `async listEvents({ timeMinIso, timeMaxIso, privateExtendedProperty }) -> { ok, events?, reason? }`
  - `async getEvent(eventId) -> { ok, event?, reason? }`
  - `async insertEvent(event) -> { ok, event?, reason? }`
  - `async patchEvent(eventId, patch) -> { ok, event?, reason? }`
  - `async deleteEvent(eventId) -> { ok, reason? }`
  - `calendarId() -> string`
  - `__resetTokenCacheForTests()`, `__setFetchForTests(fn)`
  - `NOT_CONNECTED` = `'CALENDAR_NOT_CONNECTED'`

- [ ] **Step 1: Write the failing test** — `test/google-calendar.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gcal = require('../api/_google-calendar');
const store = require('../api/_blob-store');

function envSetup() {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.PUBLIC_BASE_URL = 'https://3amaktrades.com';
  gcal.__resetTokenCacheForTests();
}

function memoryBlob(initial = {}) {
  const docs = { ...initial };
  return {
    get: async (pathname) => docs[pathname] === undefined
      ? null
      : { stream: new Response(docs[pathname]).body, blob: {}, headers: new Headers() },
    put: async (pathname, content) => { docs[pathname] = content; return { pathname }; },
    __docs: docs,
  };
}

test('the redirect URI matches the value registered in Google Cloud', () => {
  envSetup();
  // Renaming this path silently breaks OAuth -- Google rejects unregistered URIs.
  assert.equal(gcal.redirectUri(), 'https://3amaktrades.com/api/calendar-oauth-callback');
});

test('the consent URL requests offline access and forces a refresh token', () => {
  envSetup();
  const u = new URL(gcal.consentUrl('state123'));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  // Without prompt=consent, reconnecting returns no refresh token.
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar');
  assert.equal(u.searchParams.get('state'), 'state123');
  assert.equal(u.searchParams.get('response_type'), 'code');
});

test('reports NOT_CONNECTED when no refresh token has been stored', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob());
  const res = await gcal.getAccessToken();
  assert.equal(res.ok, false);
  assert.equal(res.reason, gcal.NOT_CONNECTED);
  assert.equal(await gcal.isConnected(), false);
});

test('caches the access token, then re-fetches when the refresh token changes', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  let calls = 0;
  gcal.__setFetchForTests(async () => {
    calls++;
    return { ok: true, status: 200,
      json: async () => ({ access_token: `at-${calls}`, expires_in: 3600 }) };
  });

  const a = await gcal.getAccessToken();
  const b = await gcal.getAccessToken();
  assert.equal(a.accessToken, 'at-1');
  assert.equal(b.accessToken, 'at-1', 'second call should hit the cache');
  assert.equal(calls, 1);

  // Omar reconnects with a different Google account: the cached token belongs to
  // the old one and must not be served. Keying the cache on the refresh token's
  // own value (not just an expiry) is what catches this.
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-2' }),
  }));
  const c = await gcal.getAccessToken();
  assert.equal(c.accessToken, 'at-2');
  assert.equal(calls, 2);
});

test('freeBusy converts Google timestamps to epoch ms', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  gcal.__setFetchForTests(async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({
      calendars: { primary: { busy: [
        { start: '2026-09-28T13:00:00Z', end: '2026-09-28T14:00:00Z' },
      ] } },
    }) };
  });
  const res = await gcal.freeBusy('2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z');
  assert.equal(res.ok, true);
  assert.deepEqual(res.busy, [{
    start: Date.parse('2026-09-28T13:00:00Z'),
    end: Date.parse('2026-09-28T14:00:00Z'),
  }]);
});

test('insertEvent retries without conferencing if Meet creation is rejected (R7)', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  const bodies = [];
  gcal.__setFetchForTests(async (url, opts) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return { ok: false, status: 400,
        text: async () => 'Invalid conference type value',
        json: async () => ({ error: { message: 'Invalid conference type value' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'evt-1' }) };
  });
  const res = await gcal.insertEvent({
    summary: 'Call', start: { dateTime: '2026-09-28T13:00:00Z' },
    end: { dateTime: '2026-09-28T13:30:00Z' },
    conferenceData: { createRequest: { requestId: 'r1' } },
  });
  assert.equal(res.ok, true);
  assert.equal(res.event.id, 'evt-1');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].conferenceData, 'first attempt should ask for Meet');
  assert.equal(bodies[1].conferenceData, undefined, 'retry should drop conferenceData');
});

test('a Google error surfaces as ok:false rather than throwing', async () => {
  envSetup();
  store.__setClientForTests(memoryBlob({
    'oauth-refresh-token.json': JSON.stringify({ refreshToken: 'rt-1' }),
  }));
  gcal.__setFetchForTests(async () => ({
    ok: false, status: 401, text: async () => 'invalid_grant',
    json: async () => ({ error: 'invalid_grant' }),
  }));
  const res = await gcal.getAccessToken();
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid_grant/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_google-calendar'`

- [ ] **Step 3: Implement `api/_google-calendar.js`**

```js
// Google Calendar via raw REST. The googleapis SDK is a very large dependency
// for the six calls this system makes.
//
// Every function returns {ok, ...} and never throws: a Google outage must show
// the visitor "couldn't load times" rather than a 500 stack trace.
const nodeFetch = require('node-fetch');
const store = require('./_blob-store');

const NOT_CONNECTED = 'CALENDAR_NOT_CONNECTED';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

let doFetch = (...args) => nodeFetch(...args);
function __setFetchForTests(fn) { doFetch = fn; }

// Cached access token. Keyed on the refresh token's own VALUE, not merely an
// expiry: if Omar reconnects (or switches Google accounts) the stored refresh
// token changes, and an expiry-only cache would keep serving a token minted for
// the previous account until it timed out.
let tokenCache = { refreshToken: null, accessToken: null, expiresAtMs: 0 };
function __resetTokenCacheForTests() {
  tokenCache = { refreshToken: null, accessToken: null, expiresAtMs: 0 };
}

function calendarId() { return process.env.GOOGLE_CALENDAR_ID || 'primary'; }

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://3amaktrades.com';
}

// LOCKED to the URI registered on the Google Cloud OAuth client. Renaming the
// endpoint file without updating Google Cloud breaks the consent round-trip.
function redirectUri() { return `${baseUrl()}/api/calendar-oauth-callback`; }

function consentUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',   // without this, a reconnect returns no refresh token
    include_granted_scopes: 'true',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function readErr(res) {
  try { return (await res.text()).slice(0, 300); }
  catch (e) { return `HTTP ${res.status}`; }
}

async function exchangeCodeForTokens(code) {
  try {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) return { ok: false, reason: await readErr(res) };
    const data = await res.json();
    if (!data.refresh_token) {
      return { ok: false, reason: 'Google returned no refresh_token (re-consent required)' };
    }
    return { ok: true, refreshToken: data.refresh_token };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function saveRefreshToken(refreshToken) {
  const res = await store.writeJson(store.OAUTH_BLOB, {
    refreshToken, savedAt: new Date().toISOString(),
  });
  __resetTokenCacheForTests(); // a new token invalidates anything cached
  return res;
}

async function loadRefreshToken() {
  const read = await store.readJson(store.OAUTH_BLOB);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.data || !read.data.refreshToken) return { ok: false, reason: NOT_CONNECTED };
  return { ok: true, refreshToken: read.data.refreshToken };
}

async function isConnected() {
  const r = await loadRefreshToken();
  return r.ok;
}

async function getAccessToken() {
  const rt = await loadRefreshToken();
  if (!rt.ok) return { ok: false, reason: rt.reason };

  const fresh = tokenCache.accessToken
    && tokenCache.refreshToken === rt.refreshToken
    && Date.now() < tokenCache.expiresAtMs - 60_000; // 60s safety margin
  if (fresh) return { ok: true, accessToken: tokenCache.accessToken };

  try {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: rt.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) return { ok: false, reason: await readErr(res) };
    const data = await res.json();
    if (!data.access_token) return { ok: false, reason: 'no access_token in response' };
    tokenCache = {
      refreshToken: rt.refreshToken,
      accessToken: data.access_token,
      expiresAtMs: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return { ok: true, accessToken: data.access_token };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function authed(path, { method = 'GET', body = null, query = null } = {}) {
  const tok = await getAccessToken();
  if (!tok.ok) return { ok: false, reason: tok.reason };
  const url = new URL(`${CAL_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
  }
  try {
    const res = await doFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${tok.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return { ok: false, reason: await readErr(res), status: res.status };
    if (res.status === 204) return { ok: true, data: null };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function freeBusy(timeMinIso, timeMaxIso) {
  const res = await authed('/freeBusy', {
    method: 'POST',
    body: { timeMin: timeMinIso, timeMax: timeMaxIso, timeZone: 'UTC',
            items: [{ id: calendarId() }] },
  });
  if (!res.ok) return res;
  const cal = res.data && res.data.calendars && res.data.calendars[calendarId()];
  const raw = (cal && cal.busy) || [];
  return {
    ok: true,
    busy: raw.map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
            .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end)),
  };
}

async function listEvents({ timeMinIso, timeMaxIso, privateExtendedProperty = null }) {
  const res = await authed(`/calendars/${encodeURIComponent(calendarId())}/events`, {
    query: {
      timeMin: timeMinIso, timeMax: timeMaxIso,
      singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false',
      maxResults: 250,
      privateExtendedProperty: privateExtendedProperty || undefined,
    },
  });
  if (!res.ok) return res;
  return { ok: true, events: (res.data && res.data.items) || [] };
}

// R7: ask for a Google Meet link, but never let conferencing failure cost a
// booking -- some calendars reject conference creation outright.
async function insertEvent(event) {
  const path = `/calendars/${encodeURIComponent(calendarId())}/events`;
  const first = await authed(path, {
    method: 'POST', body: event,
    query: { conferenceDataVersion: event.conferenceData ? 1 : 0, sendUpdates: 'none' },
  });
  if (first.ok) return { ok: true, event: first.data };
  if (event.conferenceData && /conference/i.test(first.reason || '')) {
    const { conferenceData, ...withoutConference } = event;
    const retry = await authed(path, {
      method: 'POST', body: withoutConference,
      query: { conferenceDataVersion: 0, sendUpdates: 'none' },
    });
    if (retry.ok) return { ok: true, event: retry.data };
    return { ok: false, reason: retry.reason };
  }
  return { ok: false, reason: first.reason };
}

async function getEvent(eventId) {
  const res = await authed(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`);
  if (!res.ok) return res;
  return { ok: true, event: res.data };
}

async function patchEvent(eventId, patch) {
  const res = await authed(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: patch, query: { sendUpdates: 'none' } });
  if (!res.ok) return res;
  return { ok: true, event: res.data };
}

async function deleteEvent(eventId) {
  const res = await authed(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', query: { sendUpdates: 'none' } });
  // A 410/404 means it is already gone, which is the state we wanted.
  if (!res.ok && !/410|404/.test(String(res.status))) return res;
  return { ok: true };
}

module.exports = {
  NOT_CONNECTED, SCOPE, consentUrl, redirectUri, calendarId, baseUrl,
  exchangeCodeForTokens, saveRefreshToken, isConnected, getAccessToken,
  freeBusy, listEvents, getEvent, insertEvent, patchEvent, deleteEvent,
  __resetTokenCacheForTests, __setFetchForTests,
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_google-calendar.js test/google-calendar.test.js
git commit -m "feat: add Google Calendar REST client with account-aware token cache

Uses raw fetch rather than the googleapis SDK, which is a very large dependency
for six calls.

The access-token cache is keyed on the refresh token's own value, not just an
expiry: when Omar reconnects or switches Google accounts the stored refresh
token changes, and an expiry-only cache would keep serving a token minted for
the previous account until it aged out.

Meet-link creation falls back to a plain insert if the calendar rejects
conferencing, so a conferencing quirk can never cost a booking. Every function
returns {ok,...} instead of throwing so a Google outage degrades to a readable
message."
```

---

### Task 5: Admin gate + OAuth connect flow

**Files:**
- Create: `api/_admin-auth.js`, `api/admin/login.js`, `api/admin/status.js`, `api/calendar-oauth-start.js`, `api/calendar-oauth-callback.js`
- Test: `test/admin-auth.test.js`

**Interfaces:**
- Consumes: `api/_google-calendar.js`, `api/_blob-store.js`.
- Produces:
  - `sessionSecret() -> string|null`
  - `checkPasscode(candidate) -> boolean` (timing-safe; false when `ADMIN_PASSCODE` unset)
  - `issueSessionCookie() -> string` (full `Set-Cookie` value)
  - `clearSessionCookie() -> string`
  - `verifySession(req) -> boolean`
  - `requireAdmin(req, res) -> boolean` — writes `401 {error:'unauthorized'}` and returns `false` when not authorised
  - `signState() -> string` / `verifyState(state) -> boolean` — CSRF protection on the OAuth round-trip
  - `SESSION_COOKIE` = `'amak_admin'`

- [ ] **Step 1: Write the failing test** — `test/admin-auth.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../api/_admin-auth');

function reqWithCookie(cookie) { return { headers: cookie ? { cookie } : {} }; }
function cookieValueOf(setCookie) { return setCookie.split(';')[0]; }

test('fails closed when ADMIN_PASSCODE is not configured', () => {
  delete process.env.ADMIN_PASSCODE;
  assert.equal(auth.checkPasscode('anything'), false);
  assert.equal(auth.checkPasscode(''), false);
});

test('accepts only the exact passcode', () => {
  process.env.ADMIN_PASSCODE = 'correct-horse';
  assert.equal(auth.checkPasscode('correct-horse'), true);
  assert.equal(auth.checkPasscode('wrong'), false);
  assert.equal(auth.checkPasscode('correct-horse '), false);
  assert.equal(auth.checkPasscode(undefined), false);
  assert.equal(auth.checkPasscode(null), false);
});

test('a session cookie round-trips and is hardened', () => {
  process.env.ADMIN_PASSCODE = 'correct-horse';
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const setCookie = auth.issueSessionCookie();
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.equal(auth.verifySession(reqWithCookie(cookieValueOf(setCookie))), true);
});

test('rejects a tampered or forged cookie', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const good = cookieValueOf(auth.issueSessionCookie());
  assert.equal(auth.verifySession(reqWithCookie(good)), true);
  assert.equal(auth.verifySession(reqWithCookie(`${good}tampered`)), false);
  assert.equal(auth.verifySession(reqWithCookie('amak_admin=garbage.signature')), false);
  assert.equal(auth.verifySession(reqWithCookie('amak_admin=')), false);
  assert.equal(auth.verifySession(reqWithCookie('')), false);
  assert.equal(auth.verifySession({ headers: {} }), false);
});

test('a cookie signed with a different secret does not verify', () => {
  process.env.ADMIN_SESSION_SECRET = 'secret-a';
  const cookie = cookieValueOf(auth.issueSessionCookie());
  process.env.ADMIN_SESSION_SECRET = 'secret-b';
  assert.equal(auth.verifySession(reqWithCookie(cookie)), false);
});

test('an expired session is rejected', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const cookie = cookieValueOf(auth.issueSessionCookie(-1000)); // already expired
  assert.equal(auth.verifySession(reqWithCookie(cookie)), false);
});

test('falls back to a derived secret so only ADMIN_PASSCODE is strictly required', () => {
  delete process.env.ADMIN_SESSION_SECRET;
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  const cookie = cookieValueOf(auth.issueSessionCookie());
  assert.equal(auth.verifySession(reqWithCookie(cookie)), true);
});

test('OAuth state round-trips and rejects forgery', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const s = auth.signState();
  assert.equal(auth.verifyState(s), true);
  assert.equal(auth.verifyState(`${s}x`), false);
  assert.equal(auth.verifyState('nope'), false);
  assert.equal(auth.verifyState(''), false);
});

test('requireAdmin writes a 401 and returns false when unauthorised', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  let status = null, payload = null;
  const res = { status(c) { status = c; return this; }, json(p) { payload = p; return this; } };
  assert.equal(auth.requireAdmin({ headers: {} }, res), false);
  assert.equal(status, 401);
  assert.deepEqual(payload, { error: 'unauthorized' });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_admin-auth'`

- [ ] **Step 3: Implement `api/_admin-auth.js`**

```js
// Admin gate: one shared passcode plus an HMAC-signed session cookie. This
// manages one person's calendar, so a full user-account system would be
// scaffolding nobody needs.
const crypto = require('crypto');

const SESSION_COOKIE = 'amak_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ADMIN_SESSION_SECRET is optional: deriving it from GOOGLE_CLIENT_SECRET under a
// fixed label keeps the two keys separate while leaving ADMIN_PASSCODE as the
// only variable the user strictly has to set.
function sessionSecret() {
  if (process.env.ADMIN_SESSION_SECRET) return process.env.ADMIN_SESSION_SECRET;
  if (process.env.GOOGLE_CLIENT_SECRET) {
    return crypto.createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET)
      .update('amak-admin-session-v1').digest('hex');
  }
  return null;
}

function sign(value) {
  const secret = sessionSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

// Constant-time comparison so a wrong passcode leaks nothing through timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkPasscode(candidate) {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return false;                 // fail closed, never open
  if (typeof candidate !== 'string' || !candidate) return false;
  return safeEqual(candidate, expected);
}

function issueSessionCookie(ttlMs = SESSION_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs }), 'utf8')
    .toString('base64url');
  const sig = sign(payload);
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function verifySession(req) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const expected = sign(payload);
  if (!expected || !safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch (e) {
    return false;
  }
}

function requireAdmin(req, res) {
  if (verifySession(req)) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// Signed, short-lived state on the OAuth round-trip so the callback cannot be
// driven by a link someone else crafted.
function signState() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 10 * 60 * 1000, n: crypto.randomBytes(8).toString('hex'),
  }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyState(state) {
  if (typeof state !== 'string' || !state) return false;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot), sig = state.slice(dot + 1);
  const expected = sign(payload);
  if (!expected || !safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch (e) {
    return false;
  }
}

module.exports = {
  SESSION_COOKIE, sessionSecret, checkPasscode, issueSessionCookie,
  clearSessionCookie, verifySession, requireAdmin, signState, verifyState,
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Create `api/admin/login.js`**

```js
const auth = require('../_admin-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  if (!process.env.ADMIN_PASSCODE) {
    // Being explicit beats a generic 401: the user has to know the gate is
    // unconfigured rather than assume they typed the wrong passcode.
    return res.status(503).json({ error: 'ADMIN_PASSCODE is not set on this deployment' });
  }
  if (!auth.checkPasscode(body.passcode)) {
    return res.status(401).json({ error: 'wrong passcode' });
  }
  res.setHeader('Set-Cookie', auth.issueSessionCookie());
  return res.status(200).json({ ok: true });
};
```

- [ ] **Step 6: Create `api/admin/status.js`** — drives the admin page's readiness panel, and is how the user will confirm the Blob store came online.

```js
const auth = require('../_admin-auth');
const store = require('../_blob-store');
const gcal = require('../_google-calendar');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!auth.requireAdmin(req, res)) return;

  const blobConfigured = store.isConfigured();
  const calendarConnected = blobConfigured ? await gcal.isConnected() : false;

  return res.status(200).json({
    ok: true,
    blobConfigured,
    calendarConnected,
    calendarId: gcal.calendarId(),
    redirectUri: gcal.redirectUri(),
    resendConfigured: !!process.env.RESEND_API_KEY,
    // Surfaced so the admin page can say exactly what is still missing rather
    // than failing opaquely while the Blob store does not exist yet.
    blockers: [
      !blobConfigured && 'Vercel Blob store not created (Storage -> Create Database -> Blob)',
      blobConfigured && !calendarConnected && 'Google Calendar not connected yet',
      !process.env.RESEND_API_KEY && 'RESEND_API_KEY missing',
    ].filter(Boolean),
  });
};
```

- [ ] **Step 7: Create `api/calendar-oauth-start.js`**

> **Require paths differ by directory.** Files directly in `api/` use `./_helper`; files under `api/admin/` use `../_helper`. Check this per file — a wrong relative path is a runtime 500, not a build error.

```js
const auth = require('./_admin-auth');
const gcal = require('./_google-calendar');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  // Passcode-gated: an open consent-start endpoint lets anyone begin an OAuth
  // flow against our client id.
  if (!auth.verifySession(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google OAuth env vars missing' });
  }
  res.writeHead(302, { Location: gcal.consentUrl(auth.signState()) });
  return res.end();
};
```

- [ ] **Step 8: Create `api/calendar-oauth-callback.js`** — **the filename is locked**; Google rejects any redirect URI it does not have registered.

```js
// LOCKED PATH: /api/calendar-oauth-callback is registered on the Google Cloud
// OAuth client. Renaming this file breaks the consent round-trip until the
// Google Cloud console is updated to match.
const auth = require('./_admin-auth');
const gcal = require('./_google-calendar');

function page(title, body) {
  // Deliberately minimal: this is a redirect waypoint Omar sees for a moment,
  // not a designed surface.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{background:#050505;color:#F2EEE4;font-family:system-ui,sans-serif;padding:48px;}
a{color:#D4AF37;}code{color:#8B887F;}</style></head>
<body><h1 style="color:#D4AF37">${title}</h1>${body}
<p><a href="/admin.html">Back to the admin page</a></p></body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { code, state, error } = req.query || {};

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (error) return res.status(400).send(page('Connection cancelled', `<p><code>${error}</code></p>`));
  if (!code) return res.status(400).send(page('Missing code', '<p>Google returned no authorization code.</p>'));
  if (!auth.verifyState(state)) {
    return res.status(400).send(page('Expired or invalid link',
      '<p>Start the connection again from the admin page.</p>'));
  }

  const exchanged = await gcal.exchangeCodeForTokens(code);
  if (!exchanged.ok) {
    return res.status(502).send(page('Could not exchange the code',
      `<p><code>${exchanged.reason}</code></p>`));
  }

  const saved = await gcal.saveRefreshToken(exchanged.refreshToken);
  if (!saved.ok) {
    const hint = saved.reason === 'BLOB_NOT_CONFIGURED'
      ? '<p>The Vercel Blob store does not exist yet, so there is nowhere to save the token. Create it in the Vercel dashboard (Storage &rarr; Create Database &rarr; Blob), redeploy, then connect again.</p>'
      : `<p><code>${saved.reason}</code></p>`;
    return res.status(503).send(page('Calendar authorised, but not saved', hint));
  }

  res.writeHead(302, { Location: '/admin.html?connected=1' });
  return res.end();
};
```

- [ ] **Step 9: Run the full suite**

Run: `node --test`
Expected: PASS, all suites.

- [ ] **Step 10: Commit**

```bash
git add api/_admin-auth.js api/admin/login.js api/admin/status.js \
        api/calendar-oauth-start.js api/calendar-oauth-callback.js test/admin-auth.test.js
git commit -m "feat: add passcode admin gate and Google Calendar connect flow

One shared passcode plus an HMAC-signed session cookie: this manages a single
person's calendar, so a user-account system would be scaffolding nobody needs.
Passcode and signature comparisons are constant-time, and a missing
ADMIN_PASSCODE fails closed rather than open.

ADMIN_SESSION_SECRET is optional and derived from GOOGLE_CLIENT_SECRET under a
fixed label when absent, keeping ADMIN_PASSCODE the only variable that must be
set by hand.

The callback path is /api/calendar-oauth-callback because that exact URI is
registered on the Google Cloud client -- renaming the file breaks consent. It
reports the missing-Blob-store case explicitly, since that is the current state
and would otherwise look like an auth failure."
```

---

### Task 6: `api/calendar-availability.js` — the public slots endpoint

**Files:**
- Create: `api/calendar-availability.js`
- Create: `api/_load-template.js`

**Interfaces:**
- Consumes: `_blob-store`, `_availability`, `_google-calendar`, `_timezone`.
- Produces:
  - `api/_load-template.js`: `async loadTemplate() -> { ok, template, reason? }` — returns the normalized `DEFAULT_TEMPLATE` when the blob is absent, so a fresh deployment still serves sensible hours.
  - Response shape (R6): `{ ok: true, timezone, slotMinutes, days: { 'YYYY-MM-DD': [{ start: ISO, end: ISO }] } }`
  - Failure shape: `{ ok: false, error: 'CALENDAR_NOT_CONNECTED' | 'BLOB_NOT_CONFIGURED' | 'UPSTREAM' , message }`

- [ ] **Step 1: Create `api/_load-template.js`**

```js
const store = require('./_blob-store');
const av = require('./_availability');

// A missing blob is not an error: it is a deployment that has never saved hours.
// Serving the normalized default keeps the widget functional on day one.
async function loadTemplate() {
  const read = await store.readJson(store.AVAILABILITY_BLOB);
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

module.exports = { loadTemplate };
```

- [ ] **Step 2: Create `api/calendar-availability.js`**

```js
// GET /api/calendar-availability?date=YYYY-MM-DD[&days=N]
//
// Slots are computed per request from the template plus live free/busy data and
// never stored. `days` (R6) lets the widget draw its whole day strip and pick the
// first day with real openings in ONE round trip instead of N.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const { loadTemplate } = require('./_load-template');

const MAX_DAYS = 31;

module.exports = async function handler(req, res) {
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

  const tplRes = await loadTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
    return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
      message: 'Booking storage is not set up yet.' });
  }
  const template = tplRes.template;

  // Query free/busy across the whole range in one call, padded by a day on each
  // side so an event that starts before the range but runs into it still blocks.
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

  // Slots move with the calendar, so they must never be cached.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    timezone: template.timezone,
    slotMinutes: template.slotMinutes,
    days: out,
  });
};
```

- [ ] **Step 3: Verify by hand-running the handler**

Create a temporary script `probe.tmp.js` that stubs the module's dependencies and calls the handler with `{ query: { date: '2026-09-28', days: 3 } }`, asserting that `days` has 3 keys and the ISO strings parse. Confirm a `BLOB_NOT_CONFIGURED` env produces a 503 with that exact error code. Delete `probe.tmp.js` afterwards — it must not be committed.

Run: `node probe.tmp.js`
Expected: prints the three date keys and the 503 case, then exits 0.

- [ ] **Step 4: Run the suite to confirm nothing regressed**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/calendar-availability.js api/_load-template.js
git commit -m "feat: serve bookable slots computed per request

Adds an optional days=N parameter beyond the spec's single-date contract: the
widget has to auto-select the first day with real openings and draw a day strip,
which per-day requests would turn into N round trips and N free/busy queries.

The free/busy window is padded a day on each side so an event starting before
the range but running into it still blocks slots. Responses are no-store because
availability changes the moment anything lands on the calendar.

A missing availability blob serves normalized defaults rather than failing --
a fresh deployment should still offer sensible hours."
```

---

### Task 7: Booking side-effect helpers — token, email, Slack

**Files:**
- Create: `api/_booking-token.js`, `api/_email.js`, `api/_booking-slack.js`
- Test: `test/booking-token.test.js`

**Interfaces:**
- Consumes: `api/_slack.js` (existing), `api/_admin-auth.js` (for `sessionSecret`).
- Produces:
  - `_booking-token.js`: `makeBookingToken(eventId, email) -> string`, `verifyBookingToken(eventId, email, token) -> boolean`
  - `_email.js`: `async sendBookingConfirmation(b)`, `sendRescheduleNotice(b)`, `sendCancellationNotice(b)`, `sendReminder(b)` — each `-> { ok, reason? }`, each **never throws**
  - `_booking-slack.js`: `async postBookingCreated(b) -> { ts }`, `async postBookingChanged(b, kind, threadTs) -> { ts }`
  - Shared booking shape `b`: `{ eventId, name, email, phone, startMs, endMs, visitorTimeZone, templateTimeZone, manageToken, meetLink, lang }`

- [ ] **Step 1: Write the failing test** — `test/booking-token.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bt = require('../api/_booking-token');

test('a booking token round-trips for its own event and email', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', token), true);
});

test('a token does not transfer to another event or another person', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  assert.equal(bt.verifyBookingToken('evt-2', 'a@example.com', token), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'b@example.com', token), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', 'forged'), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', ''), false);
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', null), false);
});

test('email comparison is case- and whitespace-insensitive', () => {
  process.env.ADMIN_SESSION_SECRET = 'session-secret';
  const token = bt.makeBookingToken('evt-1', 'A@Example.com');
  assert.equal(bt.verifyBookingToken('evt-1', ' a@example.COM ', token), true);
});

test('rotating the secret invalidates every existing token', () => {
  process.env.ADMIN_SESSION_SECRET = 'secret-a';
  const token = bt.makeBookingToken('evt-1', 'a@example.com');
  process.env.ADMIN_SESSION_SECRET = 'secret-b';
  assert.equal(bt.verifyBookingToken('evt-1', 'a@example.com', token), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_booking-token'`

- [ ] **Step 3: Implement `api/_booking-token.js`**

```js
// R2: the spec allows no bookings database, so a visitor's right to reschedule
// or cancel cannot be a stored session. A stateless HMAC over eventId+email is
// the whole authorisation: it needs no storage, and rotating the secret revokes
// every outstanding link at once.
const crypto = require('crypto');
const { sessionSecret } = require('./_admin-auth');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function makeBookingToken(eventId, email) {
  const secret = sessionSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret)
    .update(`booking-v1|${eventId}|${normalizeEmail(email)}`)
    .digest('base64url');
}

function verifyBookingToken(eventId, email, token) {
  if (typeof token !== 'string' || !token) return false;
  const expected = makeBookingToken(eventId, email);
  if (!expected) return false;
  const a = Buffer.from(token, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { makeBookingToken, verifyBookingToken, normalizeEmail };
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Implement `api/_email.js`**

**Every subject and body below is placeholder text and MUST keep its marker comment.** Do not improve the wording — final copy is a separate collaborative pass with the user.

```js
// Transactional email via Resend's REST API (no SDK -- one endpoint).
//
// ############################################################################
// # ALL COPY IN THIS FILE IS PLACEHOLDER. Do not treat it as finished text.   #
// # Final wording and layout are a separate, collaborative design pass with   #
// # the user. Only the SENDING MECHANISM and TRIGGER POINTS are complete.     #
// ############################################################################
const nodeFetch = require('node-fetch');

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  // Resend's shared sender works before 3amaktrades.com is verified for sending.
  return process.env.RESEND_FROM || '3AMAK Trades <onboarding@resend.dev>';
}

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://3amaktrades.com';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Renders the booking time in the visitor's own zone -- the one thing in these
// emails that is genuinely load-bearing rather than placeholder.
function formatWhen(startMs, timeZone, lang) {
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en-GB', {
      timeZone, dateStyle: 'full', timeStyle: 'short',
    }).format(startMs);
  } catch (e) {
    return new Date(startMs).toISOString();
  }
}

function manageLinks(b) {
  const q = `eventId=${encodeURIComponent(b.eventId)}`
    + `&email=${encodeURIComponent(b.email)}`
    + `&token=${encodeURIComponent(b.manageToken || '')}`;
  return {
    reschedule: `${baseUrl()}/?booking=reschedule&${q}`,
    cancel: `${baseUrl()}/?booking=cancel&${q}`,
  };
}

async function send({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, reason: 'RESEND_API_KEY not set' };
  }
  if (!to) return { ok: false, reason: 'no recipient' };
  try {
    const res = await nodeFetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => `HTTP ${res.status}`);
      return { ok: false, reason: detail.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

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

async function sendBookingConfirmation(b) {
  const links = manageLinks(b);
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call is booked';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your call is confirmed for
       <strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
       (${escapeHtml(b.visitorTimeZone)}).</p>
    ${b.meetLink ? `<p>[PLACEHOLDER] Join link: <a href="${escapeHtml(b.meetLink)}">${escapeHtml(b.meetLink)}</a></p>` : ''}
    <p>[PLACEHOLDER] <a href="${escapeHtml(links.reschedule)}">Reschedule</a>
       &middot; <a href="${escapeHtml(links.cancel)}">Cancel</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendRescheduleNotice(b) {
  const links = manageLinks(b);
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call was moved';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your call is now
       <strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
       (${escapeHtml(b.visitorTimeZone)}).</p>
    ${b.meetLink ? `<p>[PLACEHOLDER] Join link: <a href="${escapeHtml(b.meetLink)}">${escapeHtml(b.meetLink)}</a></p>` : ''}
    <p>[PLACEHOLDER] <a href="${escapeHtml(links.reschedule)}">Reschedule again</a>
       &middot; <a href="${escapeHtml(links.cancel)}">Cancel</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendCancellationNotice(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call was cancelled';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your call on
       ${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} is cancelled.</p>
    <p>[PLACEHOLDER] <a href="${escapeHtml(baseUrl())}/#apply">Book another time</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendReminder(b) {
  const links = manageLinks(b);
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call is coming up';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Reminder: your call is
       <strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
       (${escapeHtml(b.visitorTimeZone)}).</p>
    ${b.meetLink ? `<p>[PLACEHOLDER] Join link: <a href="${escapeHtml(b.meetLink)}">${escapeHtml(b.meetLink)}</a></p>` : ''}
    <p>[PLACEHOLDER] <a href="${escapeHtml(links.cancel)}">Cancel</a></p>`);
  return send({ to: b.email, subject, html });
}

module.exports = {
  sendBookingConfirmation, sendRescheduleNotice, sendCancellationNotice,
  sendReminder, formatWhen, manageLinks, escapeHtml,
};
```

- [ ] **Step 6: Implement `api/_booking-slack.js`**

```js
// R4: bookings go to #3-warm-leads -- a booked call is warmer than a raw
// application, and that channel already receives warm signals from wa-click.js.
// Reuses postToSlack rather than adding a second notification path.
const { postToSlack, CHANNEL_WARM_LEADS } = require('./_slack');
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

async function postBookingCreated(b) {
  return postToSlack(CHANNEL_WARM_LEADS, {
    username: '3AMAK Bot',
    icon_emoji: ':calendar:',
    blocks: [
      { type: 'header',
        text: { type: 'plain_text', text: '📅 Call booked', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text:
          `*Name:* ${b.name}\n*Email:* ${b.email}\n*Phone:* ${b.phone || '—'}\n${whenLine(b)}`
          + (b.meetLink ? `\n*Meet:* ${b.meetLink}` : '') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

// `kind` is 'rescheduled' or 'cancelled'. threadTs comes from the event's stored
// slackTs, so a change lands under the original booking rather than as noise.
async function postBookingChanged(b, kind, threadTs) {
  const icon = kind === 'cancelled' ? '❌' : '🔁';
  const message = {
    username: '3AMAK Bot',
    icon_emoji: ':calendar:',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text:
          `${icon} *Call ${kind}* — ${b.name} (${b.email})\n${whenLine(b)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  };
  // Threading needs SLACK_BOT_TOKEN; the webhook fallback returns no ts, in
  // which case this posts as a normal top-level message.
  if (threadTs) message.thread_ts = threadTs;
  return postToSlack(CHANNEL_WARM_LEADS, message);
}

module.exports = { postBookingCreated, postBookingChanged };
```

- [ ] **Step 7: Run the suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/_booking-token.js api/_email.js api/_booking-slack.js test/booking-token.test.js
git commit -m "feat: add booking notification and manage-link plumbing

Reschedule/cancel authorisation is a stateless HMAC over eventId+email because
the design allows no bookings database -- there is no session to store, and
rotating the secret revokes every outstanding link at once. The token is scoped
so it cannot be replayed against another booking or another person.

Slack reuses the existing postToSlack pipeline and threads changes onto the
original booking message via a ts stored on the calendar event.

EMAIL COPY IS PLACEHOLDER ONLY, marked as such at every subject and body. The
sending mechanism and all four trigger points are complete; final wording is a
separate collaborative pass with the user."
```

---

### Task 8: `api/calendar-book.js` + the double-booking guard

The availability check and the insert are not atomic. The post-insert overlap re-check is the **only** thing preventing a real double-booking, so it gets its own tested module.

**Files:**
- Create: `api/_booking-guard.js`, `api/calendar-book.js`
- Test: `test/booking-guard.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `_booking-guard.js`:
    - `EVENT_MARKER` = `'3amak-booking'`
    - `overlapping(events, startMs, endMs) -> events[]` — busy, non-cancelled events intersecting the window
    - `shouldRollBack(ourEventId, overlappingEvents) -> boolean` (R5)
  - `api/calendar-book.js` response: `{ ok: true, eventId, manageToken, start, end, meetLink }`
    - `409 { ok:false, error:'SLOT_TAKEN' }` — the widget treats this as an expected race, not an error
    - `503 { ok:false, error:'CALENDAR_NOT_CONNECTED' | 'BLOB_NOT_CONFIGURED' }`

- [ ] **Step 1: Write the failing test** — `test/booking-guard.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../api/_booking-guard');

const S = '2026-09-28T13:00:00Z', E = '2026-09-28T13:30:00Z';
const startMs = Date.parse(S), endMs = Date.parse(E);

function evt(id, start, end, extra = {}) {
  return { id, start: { dateTime: start }, end: { dateTime: end }, status: 'confirmed', ...extra };
}

test('finds events intersecting the window', () => {
  const events = [
    evt('a', S, E),                                                   // exact
    evt('b', '2026-09-28T13:15:00Z', '2026-09-28T13:45:00Z'),         // partial
    evt('c', '2026-09-28T12:00:00Z', '2026-09-28T13:00:00Z'),         // ends exactly at start
    evt('d', '2026-09-28T13:30:00Z', '2026-09-28T14:00:00Z'),         // starts exactly at end
  ];
  const hit = guard.overlapping(events, startMs, endMs).map(e => e.id);
  // Touching at a boundary is not an overlap -- back-to-back slots must be legal.
  assert.deepEqual(hit, ['a', 'b']);
});

test('ignores cancelled and transparent events', () => {
  const events = [
    evt('cancelled', S, E, { status: 'cancelled' }),
    evt('free', S, E, { transparency: 'transparent' }),
    evt('real', S, E),
  ];
  assert.deepEqual(guard.overlapping(events, startMs, endMs).map(e => e.id), ['real']);
});

test('ignores all-day events, which carry date not dateTime', () => {
  const events = [
    { id: 'allday', start: { date: '2026-09-28' }, end: { date: '2026-09-29' }, status: 'confirmed' },
    evt('real', S, E),
  ];
  assert.deepEqual(guard.overlapping(events, startMs, endMs).map(e => e.id), ['real']);
});

test('does not roll back when ours is the only event in the window', () => {
  assert.equal(guard.shouldRollBack('evt-b', [evt('evt-b', S, E)]), false);
  assert.equal(guard.shouldRollBack('evt-b', []), false);
});

test('R5: on a race, the lexicographically smallest id wins and others roll back', () => {
  const both = [evt('evt-a', S, E), evt('evt-b', S, E)];
  // Deterministic tie-break: a plain "more than one exists, so roll back" rule
  // makes BOTH sides cancel and leaves nobody booked.
  assert.equal(guard.shouldRollBack('evt-b', both), true);
  assert.equal(guard.shouldRollBack('evt-a', both), false);
});

test('rolls back when someone else already held the slot', () => {
  const events = [evt('omar-existing', S, E), evt('zzz-ours', S, E)];
  assert.equal(guard.shouldRollBack('zzz-ours', events), true);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test`
Expected: FAIL — `Cannot find module '../api/_booking-guard'`

- [ ] **Step 3: Implement `api/_booking-guard.js`**

```js
// The availability check and the event insert are two separate API calls, so two
// visitors can both pass the check before either inserts. This module is the
// only thing standing between that race and a genuine double-booking.
const EVENT_MARKER = '3amak-booking';

function instant(side) {
  // All-day events expose `date` rather than `dateTime` and never block a slot.
  if (!side || !side.dateTime) return null;
  const ms = Date.parse(side.dateTime);
  return Number.isFinite(ms) ? ms : null;
}

function overlapping(events, startMs, endMs) {
  return (events || []).filter(e => {
    if (!e || e.status === 'cancelled') return false;
    if (e.transparency === 'transparent') return false; // marked "free", not busy
    const s = instant(e.start), en = instant(e.end);
    if (s === null || en === null) return false;
    // Strict inequality: an event ending exactly when the slot starts does not
    // overlap it, so back-to-back bookings stay legal.
    return s < endMs && en > startMs;
  });
}

// R5: the spec says "roll back if more than one now exists", but applied
// literally both sides of a simultaneous race would cancel and nobody would end
// up booked. A deterministic tie-break on event id means exactly one survives.
function shouldRollBack(ourEventId, overlappingEvents) {
  if (!overlappingEvents || overlappingEvents.length <= 1) return false;
  const winner = overlappingEvents
    .map(e => e.id)
    .filter(Boolean)
    .sort()[0];
  return winner !== ourEventId;
}

module.exports = { EVENT_MARKER, overlapping, shouldRollBack };
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node --test`
Expected: PASS, 6 tests.

- [ ] **Step 5: Implement `api/calendar-book.js`**

```js
// POST /api/calendar-book
// { name, email, phone, start (ISO), visitorTimeZone, lang }
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const guard = require('./_booking-guard');
const email = require('./_email');
const bslack = require('./_booking-slack');
const { makeBookingToken } = require('./_booking-token');
const { loadTemplate } = require('./_load-template');

function badRequest(res, message) {
  return res.status(400).json({ ok: false, error: 'BAD_REQUEST', message });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  // Honeypot, matching api/submit.js: real visitors never see this field.
  if (body.website) return res.status(200).json({ ok: true });

  const name = String(body.name || '').trim();
  const addr = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const lang = body.lang === 'ar' ? 'ar' : 'en';
  const startMs = Date.parse(String(body.start || ''));

  if (!name) return badRequest(res, 'name is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return badRequest(res, 'a valid email is required');
  if (!Number.isFinite(startMs)) return badRequest(res, 'start must be an ISO timestamp');

  const visitorTimeZone = tz.isValidTimeZone(body.visitorTimeZone)
    ? body.visitorTimeZone : 'UTC';

  const tplRes = await loadTemplate();
  if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
    return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
      message: 'Booking storage is not set up yet.' });
  }
  const template = tplRes.template;
  const endMs = startMs + template.slotMinutes * 60 * 1000;

  // Re-verify against live free/busy: the slot list the visitor is looking at
  // may be minutes stale.
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

  const manageToken = makeBookingToken('pending', addr); // re-derived once we have the real id

  const inserted = await gcal.insertEvent({
    summary: `Call — ${name}`,
    description: `Booked from 3amaktrades.com\nName: ${name}\nEmail: ${addr}\nPhone: ${phone || '—'}\nTheir timezone: ${visitorTimeZone}`,
    start: { dateTime: new Date(startMs).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endMs).toISOString(), timeZone: 'UTC' },
    extendedProperties: {
      // R3: the calendar is the record, so per-booking metadata rides with the
      // event instead of needing a third blob.
      private: {
        bookingSource: guard.EVENT_MARKER,
        visitorEmail: addr,
        visitorName: name,
        visitorPhone: phone,
        visitorTimeZone,
        lang,
      },
    },
    conferenceData: { createRequest: { requestId: `amak-${Date.now()}` } },
  });
  if (!inserted.ok) {
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not create the event.' });
  }
  const eventId = inserted.event.id;

  // ---- The double-booking guard -------------------------------------------
  // The check above and this insert are not atomic. Re-read the window now that
  // our event exists and see whether anyone else landed in it too.
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
  }
  // -------------------------------------------------------------------------

  const meetLink = (inserted.event.hangoutLink)
    || (inserted.event.conferenceData
        && inserted.event.conferenceData.entryPoints
        && (inserted.event.conferenceData.entryPoints
             .find(p => p.entryPointType === 'video') || {}).uri)
    || '';

  const token = makeBookingToken(eventId, addr);
  const booking = {
    eventId, name, email: addr, phone, startMs, endMs,
    visitorTimeZone, templateTimeZone: template.timezone,
    manageToken: token, meetLink, lang,
  };

  // Slack and email must never cost a confirmed booking, so both are best-effort
  // and their failures are logged rather than returned.
  let slackTs = null;
  try {
    const posted = await bslack.postBookingCreated(booking);
    slackTs = (posted && posted.ts) || null;
  } catch (e) { console.error('booking slack failed:', e.message); }

  if (slackTs) {
    // Stored so a later reschedule/cancel can thread onto this same message.
    await gcal.patchEvent(eventId, {
      extendedProperties: { private: { slackTs } },
    });
  }

  try {
    const sent = await email.sendBookingConfirmation(booking);
    if (!sent.ok) console.error('confirmation email failed:', sent.reason);
  } catch (e) { console.error('confirmation email threw:', e.message); }

  return res.status(200).json({
    ok: true, eventId, manageToken: token,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    meetLink,
  });
};
```

> **Note:** `extendedProperties.private` on a PATCH merges keys rather than replacing the map, so patching `slackTs` alone preserves the booking metadata written at insert.

- [ ] **Step 6: Run the suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/_booking-guard.js api/calendar-book.js test/booking-guard.test.js
git commit -m "feat: create calendar bookings with a double-booking guard

The availability check and the event insert are separate API calls, so two
visitors can both pass the check before either inserts. After inserting, the
window is re-read and a deterministic tie-break on event id decides who keeps
it -- the losing booking deletes itself and returns 409.

The tie-break is deliberate: the design's plain 'roll back if more than one
exists' rule, applied literally, makes both sides of a simultaneous race cancel
and leaves nobody booked.

Boundary-touching events do not count as overlaps, so back-to-back slots stay
bookable, and cancelled/transparent/all-day events are ignored. Slack and email
are best-effort: neither may cost an already-confirmed booking."
```

---

### Task 9: `api/calendar-reschedule.js` + `api/calendar-cancel.js`

Same overlap discipline as booking. Both require a valid booking token (R2).

**Files:**
- Create: `api/_load-booking.js`, `api/calendar-reschedule.js`, `api/calendar-cancel.js`

**Interfaces:**
- Produces:
  - `_load-booking.js`: `async loadBooking({ eventId, email, token }) -> { ok, status?, error?, message?, event?, meta? }` — verifies the token, fetches the event, confirms it is one of ours and that the email matches.
  - Reschedule response: `{ ok:true, eventId, start, end }`; `409 SLOT_TAKEN`; `403 FORBIDDEN`; `404 NOT_FOUND`
  - Cancel response: `{ ok:true }`

- [ ] **Step 1: Create `api/_load-booking.js`**

```js
// Shared front half of reschedule and cancel: prove the caller owns this
// booking, then hand back the event.
const gcal = require('./_google-calendar');
const guard = require('./_booking-guard');
const { verifyBookingToken, normalizeEmail } = require('./_booking-token');

async function loadBooking({ eventId, email, token }) {
  if (!eventId || !email || !token) {
    return { ok: false, status: 400, error: 'BAD_REQUEST',
      message: 'eventId, email and token are required' };
  }
  if (!verifyBookingToken(eventId, email, token)) {
    return { ok: false, status: 403, error: 'FORBIDDEN',
      message: 'That link is not valid for this booking.' };
  }

  const got = await gcal.getEvent(eventId);
  if (!got.ok) {
    if (got.reason === gcal.NOT_CONNECTED) {
      return { ok: false, status: 503, error: 'CALENDAR_NOT_CONNECTED',
        message: 'The calendar is unavailable.' };
    }
    return { ok: false, status: 404, error: 'NOT_FOUND',
      message: 'That booking no longer exists.' };
  }
  const event = got.event;
  const meta = (event.extendedProperties && event.extendedProperties.private) || {};

  if (meta.bookingSource !== guard.EVENT_MARKER) {
    // Never let a booking token touch an event this system did not create.
    return { ok: false, status: 403, error: 'FORBIDDEN',
      message: 'That booking is not managed here.' };
  }
  if (normalizeEmail(meta.visitorEmail) !== normalizeEmail(email)) {
    return { ok: false, status: 403, error: 'FORBIDDEN',
      message: 'That link is not valid for this booking.' };
  }
  return { ok: true, event, meta };
}

module.exports = { loadBooking };
```

- [ ] **Step 2: Create `api/calendar-reschedule.js`**

```js
// POST /api/calendar-reschedule
// { eventId, email, token, start (ISO), visitorTimeZone? }
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const guard = require('./_booking-guard');
const email = require('./_email');
const bslack = require('./_booking-slack');
const { makeBookingToken } = require('./_booking-token');
const { loadTemplate } = require('./_load-template');
const { loadBooking } = require('./_load-booking');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  const loaded = await loadBooking(body);
  if (!loaded.ok) {
    return res.status(loaded.status).json({ ok: false, error: loaded.error,
      message: loaded.message });
  }
  const { event, meta } = loaded;

  const startMs = Date.parse(String(body.start || ''));
  if (!Number.isFinite(startMs)) {
    return res.status(400).json({ ok: false, error: 'BAD_REQUEST',
      message: 'start must be an ISO timestamp' });
  }

  const tplRes = await loadTemplate();
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
      await gcal.patchEvent(event.id, {
        start: { dateTime: new Date(oldStart).toISOString(), timeZone: 'UTC' },
        end: { dateTime: new Date(oldEnd).toISOString(), timeZone: 'UTC' },
      });
      return res.status(409).json({ ok: false, error: 'SLOT_TAKEN',
        message: 'Someone took that time a moment before you.' });
    }
  }

  const visitorTimeZone = tz.isValidTimeZone(body.visitorTimeZone)
    ? body.visitorTimeZone
    : (tz.isValidTimeZone(meta.visitorTimeZone) ? meta.visitorTimeZone : 'UTC');

  const booking = {
    eventId: event.id, name: meta.visitorName || '—', email: meta.visitorEmail,
    phone: meta.visitorPhone || '', startMs, endMs,
    visitorTimeZone, templateTimeZone: template.timezone,
    manageToken: makeBookingToken(event.id, meta.visitorEmail),
    meetLink: patched.event.hangoutLink || '', lang: meta.lang || 'en',
  };

  try { await bslack.postBookingChanged(booking, 'rescheduled', meta.slackTs || null); }
  catch (e) { console.error('reschedule slack failed:', e.message); }
  try { await email.sendRescheduleNotice(booking); }
  catch (e) { console.error('reschedule email failed:', e.message); }

  return res.status(200).json({ ok: true, eventId: event.id,
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
};
```

- [ ] **Step 3: Create `api/calendar-cancel.js`**

```js
// POST /api/calendar-cancel
// { eventId, email, token }
const gcal = require('./_google-calendar');
const email = require('./_email');
const bslack = require('./_booking-slack');
const { loadTemplate } = require('./_load-template');
const { loadBooking } = require('./_load-booking');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const loaded = await loadBooking(req.body || {});
  if (!loaded.ok) {
    return res.status(loaded.status).json({ ok: false, error: loaded.error,
      message: loaded.message });
  }
  const { event, meta } = loaded;

  const startMs = Date.parse(event.start && event.start.dateTime) || Date.now();
  const endMs = Date.parse(event.end && event.end.dateTime) || startMs;

  const deleted = await gcal.deleteEvent(event.id);
  if (!deleted.ok) {
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not cancel the booking.' });
  }

  const tplRes = await loadTemplate();
  const booking = {
    eventId: event.id, name: meta.visitorName || '—', email: meta.visitorEmail,
    phone: meta.visitorPhone || '', startMs, endMs,
    visitorTimeZone: meta.visitorTimeZone || 'UTC',
    templateTimeZone: tplRes.template.timezone,
    manageToken: '', meetLink: '', lang: meta.lang || 'en',
  };

  // Best-effort: the slot is already freed, which is what the visitor asked for.
  try { await bslack.postBookingChanged(booking, 'cancelled', meta.slackTs || null); }
  catch (e) { console.error('cancel slack failed:', e.message); }
  try { await email.sendCancellationNotice(booking); }
  catch (e) { console.error('cancel email failed:', e.message); }

  return res.status(200).json({ ok: true });
};
```

- [ ] **Step 4: Run the suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_load-booking.js api/calendar-reschedule.js api/calendar-cancel.js
git commit -m "feat: let visitors reschedule and cancel their own booking

Both endpoints verify the HMAC booking token, then re-check that the event was
created by this system and that the email on it matches -- a token must never be
able to reach an event the booking system did not create.

Reschedule filters the booking's own busy interval out of the free/busy result,
or the event being moved would block its own new slot whenever the old and new
windows overlap. It applies the same post-write overlap check as booking and
restores the original time if it lost the race, and clears reminderSent so a
moved call is reminded again."
```

---

### Task 10: Admin availability API + `admin.html`

**Files:**
- Create: `api/admin/availability.js`, `admin.html`

**Interfaces:**
- Consumes: `_admin-auth`, `_availability`, `_blob-store`, `_load-template`, `_google-calendar`.
- Produces:
  - `GET /api/admin/availability` -> `{ ok, template, usedDefault }`
  - `POST /api/admin/availability` body `{ template }` -> `{ ok, template }` or `400 { ok:false, errors:[...] }`

- [ ] **Step 1: Create `api/admin/availability.js`**

```js
// Read/write the weekly template. Passcode-gated -- these hours decide when
// strangers can put things on Omar's calendar.
const auth = require('../_admin-auth');
const av = require('../_availability');
const store = require('../_blob-store');
const { loadTemplate } = require('../_load-template');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const tplRes = await loadTemplate();
    if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
      // Still return the defaults so the form renders and Omar can see the shape
      // of what he will be editing once storage exists.
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
    const written = await store.writeJson(store.AVAILABILITY_BLOB, template);
    if (!written.ok) {
      const missing = written.reason === store.BLOB_NOT_CONFIGURED;
      return res.status(missing ? 503 : 502).json({
        ok: false,
        errors: [missing
          ? 'The Vercel Blob store does not exist yet, so hours cannot be saved. Create it in the Vercel dashboard (Storage -> Create Database -> Blob) and redeploy.'
          : written.reason],
      });
    }
    return res.status(200).json({ ok: true, template });
  }

  return res.status(405).end();
};
```

- [ ] **Step 2: Create `admin.html`**

Requirements — an internal tool, so it stays plain, but it must still use the Bullion tokens and `border-radius: 0`. It is **English-only and `dir="ltr"`** (one operator, not a public bilingual surface); state this in a comment so it does not read as an oversight.

Sections:
1. **Passcode gate** — a single password field posting to `/api/admin/login`, revealing the rest on success. On load, call `/api/admin/status`; a 401 means show the gate.
2. **Readiness panel** — renders `blockers[]` from `/api/admin/status`. When `blobConfigured` is false, show the exact dashboard path. Also show `redirectUri` so it can be compared against Google Cloud.
3. **Connect calendar** — a button linking to `/api/calendar-oauth-start`, plus connected/not-connected state. Shows a success note when `?connected=1` is present.
4. **Weekly availability form** — seven rows (Mon–Sun), each an enabled checkbox plus two `HH:MM` text inputs; then `slotMinutes` (a select over `ALLOWED_SLOT_MINUTES`), `bufferMinutes`, `minNoticeHours`, and the **timezone** control.

Timezone control: a `<datalist>`-backed text input populated from `Intl.supportedValuesOf('timeZone')` (418 entries), falling back to a short hardcoded list (`America/Toronto`, `Europe/Istanbul`, `America/New_York`, `America/Vancouver`, `Europe/London`, `Asia/Riyadh`, `Asia/Dubai`, `UTC`) if `supportedValuesOf` is unavailable. A searchable combobox is explicitly enough per the spec.

Save posts the whole template; render `errors[]` inline on a 400. Show the saved timezone's current local time next to the field so Omar can sanity-check the zone he picked.

Use plain `fetch`, no framework. Use `HH:MM` text inputs, **not** `<input type=time>`: the spec's point about native controls being unstyleable applies here too, and consistency with the widget matters more than the native picker.

- [ ] **Step 3: Verify the gate actually gates**

Confirm by inspection and by running the suite that:
- `GET /api/admin/availability` without a cookie returns 401 (`requireAdmin` runs before any method branch).
- `POST` with `days.mon.end` earlier than `days.mon.start` returns 400 with an error naming `mon`.
- With no `ADMIN_PASSCODE`, `/api/admin/login` returns 503 with an explanatory message rather than a generic 401.

Run: `node --test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add api/admin/availability.js admin.html
git commit -m "feat: add admin page for connecting the calendar and setting hours

The template POST validates before normalizing: normalizing alone would quietly
rewrite a mistake like an end time before its start into something Omar never
chose, so a bad save is rejected with a message naming the day instead.

The timezone is a searchable datalist over the runtime's full IANA list because
Omar moves between Canada and Turkey and changes it himself. The page shows the
selected zone's current local time so a wrong pick is obvious immediately, and
surfaces the registered OAuth redirect URI for comparison against Google Cloud.

Hours are text HH:MM inputs rather than native time pickers, matching the
booking widget -- native controls cannot be styled to the Bullion system.

Deliberately English-only and LTR: this is a single-operator internal tool, not
a public bilingual surface."
```

---

### Task 11: `booking-widget.js`

One self-contained file, zero dependencies, mounted by the confirmation screen.

**Files:**
- Create: `booking-widget.js`

**Interfaces:**
- Consumes: `GET /api/calendar-availability`, `POST /api/calendar-book`.
- Produces `window.BookingWidget` with:
  ```js
  BookingWidget.mount(container, {
    lang: 'ar' | 'en',
    dir: 'rtl' | 'ltr',
    extraFields: { name, email, phone },   // already collected by the Apply form
    texts: { /* every string, keyed -- see the table below */ },
    rangeDays: 14,
    apiBase: '',
    mode: 'book',                          // reserved; only 'book' is implemented
    onBooked(result),                       // { eventId, start, end, meetLink, manageToken }
    onDuplicate(),
    onUnavailable(reason),                  // 'CALENDAR_NOT_CONNECTED' | 'BLOB_NOT_CONFIGURED' | 'UPSTREAM'
  }) -> { destroy() }
  ```

**Required `texts` keys** (the embedder owns all copy, so the widget never holds a second translation table): `loading`, `pick_day`, `pick_time`, `no_slots_day`, `no_slots_range`, `tz_label`, `your_details`, `name_label`, `email_label`, `phone_label`, `confirm_btn`, `confirming`, `slot_taken`, `generic_error`, `unavailable`, `booked_title`, `booked_body`, `today`, `weekday_short` (array of 7, **Sunday-first**), `month_short` (array of 12).

**Structural requirements:**

1. **Progressive reveal in this order:** day strip → time slots for the chosen day → contact fields → confirm button. A later section stays hidden until the previous one has a value.
2. **Auto-select the first day that actually has openings**, not today — today's hours may already have passed. Derive it from the single `days=N` range response.
3. **Contact fields are pre-filled from `extraFields` and never re-asked.** Render them as read-only summary text with a small "change" toggle that turns them into inputs, rather than three empty boxes the visitor already filled in.
4. **A 409 is an expected race, not an error:** clear the selected slot, show `texts.slot_taken`, and silently re-fetch that day's slots. Do not show an error dialog and do not clear the day selection.
5. **Scoped style injected once**, guarded by `document.getElementById('booking-widget-styles')`. All classes prefixed `bw-`. `border-radius: 0` everywhere; colours come from the page's existing CSS custom properties (`var(--gold)` etc.) so the widget inherits Bullion automatically rather than restating hex values.
6. **Custom day/time pickers built from scratch** — never `<input type=date>` or `<input type=time>`, which cannot be restyled.

**State/render discipline** (the spec calls this out explicitly, and it is where `innerHTML` re-rendering goes wrong):

```js
// Typed values live in state, NOT read back out of the DOM at render time --
// re-rendering via innerHTML destroys the inputs and would drop whatever the
// visitor was typing.
const state = {
  range: {},            // { 'YYYY-MM-DD': [{start,end}] }
  selectedDate: null,
  selectedStart: null,
  visitorTz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  fields: { name: '', email: '', phone: '' },
  editingFields: false,
  status: 'loading',    // loading | ready | confirming | booked | unavailable
  notice: '',
};

// Live input is mirrored into state on every keystroke, so the next render
// restores it.
container.addEventListener('input', (e) => {
  const key = e.target.getAttribute('data-bw-field');
  if (key) state.fields[key] = e.target.value;
});
```

**RTL handling — read this before writing the day strip.** This codebase has already shipped a real bug where horizontal-scroll math assumed LTR and silently ran into empty space. Under `dir="rtl"` browsers disagree about the sign and origin of `scrollLeft`, so **do not compute scroll offsets by hand.**

```js
// Save and restore scrollLeft verbatim across renders. Round-tripping the exact
// value the browser gave us is correct regardless of whether this browser
// reports RTL scrollLeft as positive, negative, or inverted -- we never do
// arithmetic on it, so there is no sign convention to get wrong.
const strip = container.querySelector('.bw-day-strip');
const savedScroll = strip ? strip.scrollLeft : 0;
// ...re-render...
const newStrip = container.querySelector('.bw-day-strip');
if (newStrip) newStrip.scrollLeft = savedScroll;

// To bring the selected day into view, let the browser do the direction math.
// scrollIntoView is direction-agnostic; a manual offsetLeft calculation is not.
const selected = container.querySelector('.bw-day.is-selected');
if (selected && shouldScrollToSelection) {
  selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
```

Additional RTL rules:
- Lay the strip out with flexbox and let `dir` drive visual order. Never `position: absolute` + `left`.
- Use logical properties throughout (`margin-inline-start`, `border-inline-end`, `padding-inline`).
- Any chevron/arrow must flip: mirror it with `[dir="rtl"] .bw-arrow { transform: scaleX(-1); }`, the pattern already used for `.form-btn-next span`.
- Times render LTR even in Arabic — wrap them in `dir="ltr"`, matching how `index.html` already handles `.bl-num` and the phone field.

**Time formatting:** format every slot with `Intl.DateTimeFormat(locale, { timeZone: state.visitorTz, hour: '2-digit', minute: '2-digit' })`, where `locale` is `'ar'`/`'en-GB'`. Never do manual offset arithmetic in the browser; the server sends absolute ISO instants precisely so the client only has to format them.

**Timezone dropdown:** a `<select>` seeded from `Intl.supportedValuesOf('timeZone')` (fallback to a short list plus the detected zone), defaulting to the detected zone and fully overridable — the same auto-detect-but-overridable pattern as the phone country-code picker. Changing it **re-renders the slot labels only**; it does not re-fetch, because slots are absolute instants and the change is purely presentational. (Re-fetching would be harmless but wasteful.)

**Fetch behaviour:**
- On mount, `GET {apiBase}/api/calendar-availability?date={today}&days={rangeDays}` once.
- Non-`ok` responses with `error` of `CALENDAR_NOT_CONNECTED` / `BLOB_NOT_CONFIGURED` / `UPSTREAM` set `status = 'unavailable'` and invoke `onUnavailable(error)`. The widget must render `texts.unavailable`, never a stack trace or a raw error code.
- On confirm, `POST {apiBase}/api/calendar-book` with `{ name, email, phone, start, visitorTimeZone, lang }`. On `200` call `onBooked(data)`; on `409` run the race path in (4); on anything else show `texts.generic_error` and re-enable the button.
- Guard against double-submit by checking `state.status === 'confirming'`.

- [ ] **Step 1: Write `booking-widget.js`** implementing every requirement above.

- [ ] **Step 2: Verify in a real browser, in BOTH directions**

Because the Blob store does not exist, `/api/calendar-availability` cannot return real slots yet. Create a temporary `widget-harness.tmp.html` that stubs `window.fetch` to return a canned range response (one day empty, the next with three slots), mounts the widget twice — once in an `dir="rtl"` container and once `dir="ltr"` — and exercises:

- the day strip scrolls and the selected day stays visible in **both** directions;
- the first day **with slots** is auto-selected, not the empty first day;
- typing in a contact field survives a re-render (change the timezone while a field is focused and confirm the text is still there);
- a stubbed 409 clears the slot, shows the taken message, keeps the day selected, and re-fetches;
- a stubbed `CALENDAR_NOT_CONNECTED` renders `texts.unavailable`.

Delete `widget-harness.tmp.html` before committing.

Expected: all five behaviours confirmed, no console errors, no horizontal page scrollbar in either direction.

- [ ] **Step 3: Commit**

```bash
git add booking-widget.js
git commit -m "feat: add self-contained booking widget

Zero dependencies and mounted via BookingWidget.mount so the confirmation screen
is just its first embedder. Reveals progressively -- day, then times, then
details -- and auto-selects the first day that actually has openings, since
today's hours may already have passed.

Day-strip scroll position is saved and restored verbatim and selection uses
scrollIntoView rather than offsetLeft arithmetic: browsers disagree on the sign
and origin of scrollLeft under RTL, and this codebase has already shipped one bug
from hand-rolled horizontal-scroll math that assumed LTR.

Typed values are mirrored into state on input rather than read from the DOM at
render time, so an innerHTML re-render cannot drop what the visitor is typing.
A 409 is treated as the expected slot race -- clear the slot, say so plainly,
refetch quietly -- not as an error. All copy is passed in by the embedder so
there is no second translation table to keep in sync."
```

---

### Task 12: `index.html` integration

**Files:**
- Modify: `index.html` — four separate edits, described below with exact anchors.

**Interfaces:**
- Consumes: `booking-widget.js` (Task 11), `POST /api/calendar-book`.
- Produces: nothing other tasks depend on.

**Anchors as they exist today** (line numbers will drift as you edit — match on text):
- Confirm-screen CSS ends at `.form-confirm .cta-btn-wa svg { fill: currentColor; }` (~line 822).
- Arabic confirm strings are at `confirm_discord_btn: "انضم لسيرفر الديسكورد",` (~line 1291); English at `confirm_discord_btn: "Join Discord",` (~line 1440).
- Confirm markup is `<div class="form-confirm" id="formConfirm">` (~line 2034), ending `</div>` after the Discord anchor (~line 2054).
- The tier logic is `const isLowBudget = payload.budgetCode === '<500';` (~line 2635).

- [ ] **Step 1: Add the CSS**, immediately after `.form-confirm .cta-btn-wa svg { fill: currentColor; }`

Requirements: a `#bookingWidgetHost` block (hidden by default, `margin-block-start` for separation) and a `.confirm-book-label` matching the existing `.confirm-wa-label` rhythm. Reuse `.cta-btn-wa` for the "Book a Call" button so it inherits the outlined gold treatment the confirm screen already defines — do **not** invent a new button class. Add a calendar-specific hover only if it differs from the existing rule. `border-radius: 0`, logical properties, both directions.

- [ ] **Step 2: Add translation keys to BOTH language blocks**

Arabic (Levantine, informal — match `confirm_wa_label`'s register), inserted after `confirm_discord_btn`:

```js
    confirm_book_label: "أو بتحب تحجز مكالمة مع عمر مباشرة؟",
    confirm_book_btn: "احجز مكالمة",
    book_loading: "عم نجيب الأوقات المتاحة...",
    book_pick_day: "اختار اليوم",
    book_pick_time: "اختار الوقت",
    book_no_slots_day: "ما في أوقات فاضية هذا اليوم.",
    book_no_slots_range: "ما في أوقات فاضية هالفترة. جرب راسلنا عالواتساب.",
    book_tz_label: "التوقيت تبعك",
    book_your_details: "معلوماتك",
    book_name_label: "الاسم",
    book_email_label: "الإيميل",
    book_phone_label: "الموبايل",
    book_confirm_btn: "ثبّت الحجز",
    book_confirming: "عم نثبّت الحجز...",
    book_slot_taken: "هذا الوقت انحجز قبل شوي. اختار وقت تاني.",
    book_generic_error: "صار خطأ. جرب مرة تانية.",
    book_unavailable: "الحجز مش متاح هلق. راسلنا عالواتساب وبنرتبلك موعد.",
    book_booked_title: "تم الحجز! 🎉",
    book_booked_body: "بعتنالك إيميل فيه كل التفاصيل.",
    book_today: "اليوم",
    book_change: "تغيير",
```

English, inserted after the English `confirm_discord_btn`:

```js
    confirm_book_label: "Or book a call with Omar directly?",
    confirm_book_btn: "Book a Call",
    book_loading: "Loading available times...",
    book_pick_day: "Pick a day",
    book_pick_time: "Pick a time",
    book_no_slots_day: "No times open on this day.",
    book_no_slots_range: "No times open in this period. Message us on WhatsApp instead.",
    book_tz_label: "Your timezone",
    book_your_details: "Your details",
    book_name_label: "Name",
    book_email_label: "Email",
    book_phone_label: "Phone",
    book_confirm_btn: "Confirm booking",
    book_confirming: "Confirming...",
    book_slot_taken: "That time was just taken. Pick another one.",
    book_generic_error: "Something went wrong. Please try again.",
    book_unavailable: "Booking isn't available right now. Message us on WhatsApp and we'll set a time.",
    book_booked_title: "You're booked! 🎉",
    book_booked_body: "We've emailed you all the details.",
    book_today: "Today",
    book_change: "Change",
```

Weekday/month short names come from `Intl.DateTimeFormat(locale, {weekday:'short'})` at runtime rather than 19 more translation keys per language — the browser already localises these correctly for both locales.

- [ ] **Step 3: Add the markup** inside `#formConfirm`, after the Discord anchor and before the closing `</div>`

```html
        <!-- Book a Call -- only rendered for the 1k-3k / 3k+ tiers, shown
             alongside the WhatsApp/Instagram row rather than replacing it. -->
        <p class="confirm-wa-label bl-mono bl-mono--gold" data-key="confirm_book_label"
           id="confirmBookLabel" style="display:none"></p>
        <button type="button" class="cta-btn-wa" id="bookCallBtn" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16"/><path d="M8 3v4M16 3v4M3 11h18"/>
          </svg>
          <span data-key="confirm_book_btn"></span>
        </button>
        <div id="bookingWidgetHost" style="display:none"></div>
```

The `<rect>` deliberately has no `rx` — zero border-radius applies to iconography too.

- [ ] **Step 4: Wire `submitForm()`**, replacing the tier block at `const isLowBudget = ...`

```js
    // <$500 leads skip the WhatsApp sales conversation entirely -- pushing
    // a paid-program pitch on someone who just said they can't afford it
    // either wastes the sales side's time or feels like a mismatch. Discord
    // (always shown, just above) gives them a free way to stay engaged.
    const isLowBudget = payload.budgetCode === '<500';
    document.getElementById('confirmWaLabel').style.display = isLowBudget ? 'none' : '';
    document.getElementById('confirmTalkRow').style.display = isLowBudget ? 'none' : '';

    // The $1k+ tiers can skip the DM round-trip and put a call straight on
    // Omar's calendar. Everyone else keeps the DM paths unchanged.
    const canBook = payload.budgetCode === '1k-3k' || payload.budgetCode === '3k+';
    const bookLabel = document.getElementById('confirmBookLabel');
    const bookBtn = document.getElementById('bookCallBtn');
    if (canBook) {
      bookLabel.style.display = '';
      bookBtn.style.display = '';
      // Loaded on demand: most visitors never reach this tier, so the widget
      // should not be part of the initial page weight.
      bookBtn.addEventListener('click', () => openBookingWidget(payload), { once: true });
    }
```

Then add, alongside `submitForm()`:

```js
  // Pulls in booking-widget.js the first time someone asks to book, then mounts
  // it with the details the Apply form already collected.
  let bookingWidgetLoading = false;
  function openBookingWidget(payload) {
    if (bookingWidgetLoading) return;
    bookingWidgetLoading = true;

    const host = document.getElementById('bookingWidgetHost');
    const btn = document.getElementById('bookCallBtn');
    host.style.display = '';
    btn.disabled = true;

    const mount = () => {
      btn.style.display = 'none';
      document.getElementById('confirmBookLabel').style.display = 'none';
      window.BookingWidget.mount(host, {
        lang,
        dir: lang === 'ar' ? 'rtl' : 'ltr',
        extraFields: {
          name: payload.name === '—' ? '' : payload.name,
          email: payload.email === '—' ? '' : payload.email,
          phone: payload.phone === '—' ? '' : payload.phone,
        },
        rangeDays: 14,
        texts: {
          loading: txt('book_loading'), pick_day: txt('book_pick_day'),
          pick_time: txt('book_pick_time'), no_slots_day: txt('book_no_slots_day'),
          no_slots_range: txt('book_no_slots_range'), tz_label: txt('book_tz_label'),
          your_details: txt('book_your_details'), name_label: txt('book_name_label'),
          email_label: txt('book_email_label'), phone_label: txt('book_phone_label'),
          confirm_btn: txt('book_confirm_btn'), confirming: txt('book_confirming'),
          slot_taken: txt('book_slot_taken'), generic_error: txt('book_generic_error'),
          unavailable: txt('book_unavailable'), booked_title: txt('book_booked_title'),
          booked_body: txt('book_booked_body'), today: txt('book_today'),
          change: txt('book_change'),
        },
        onBooked: () => {
          // The widget renders its own booked state; nothing more to do here.
        },
        onUnavailable: () => {
          // Booking is down or not connected. Put the DM paths back in front of
          // them rather than leaving a dead end.
          document.getElementById('confirmWaLabel').style.display = '';
          document.getElementById('confirmTalkRow').style.display = '';
        },
      });
    };

    if (window.BookingWidget) return mount();
    const s = document.createElement('script');
    s.src = '/booking-widget.js';
    s.onload = mount;
    s.onerror = () => {
      bookingWidgetLoading = false;
      btn.disabled = false;
      host.style.display = 'none';
    };
    document.head.appendChild(s);
  }
```

- [ ] **Step 5: Verify in a real browser, both languages**

1. Serve the site locally. Complete the Apply form choosing budget **C (`1k-3k`)**; confirm the Book a Call label and button appear *alongside* WhatsApp/Instagram, and Discord still shows.
2. Repeat with **D (`3k+`)** — same result.
3. Repeat with **B (`500-1k`)** — WhatsApp/Instagram/Discord only, **no** booking option.
4. Repeat with **A (`<500`)** — Discord only, unchanged from today.
5. Toggle to English mid-confirmation and confirm every new string switches (they carry `data-key`, so `render()` sweeps them).
6. Click Book a Call: the widget mounts, and with no Blob store it renders `book_unavailable` and restores the WhatsApp row. **This is the expected outcome until the store exists** — it is the graceful-degradation path, not a failure.
7. Confirm no horizontal page scrollbar in Arabic (RTL) or English.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: offer direct call booking to the \$1k+ tiers on the confirm screen

Sits alongside the existing WhatsApp/Instagram row rather than replacing it, and
only for 1k-3k/3k+: the lower tiers keep exactly the paths they have today.

booking-widget.js is fetched on click rather than at page load, because most
visitors never reach this tier and the widget should not be part of the initial
page weight for people who will never see it.

All widget copy is passed in from the existing t object so there is one
translation table, not two, and every new string carries data-key so the
language toggle sweeps it. If booking is unavailable the WhatsApp row is put
back, so a visitor never lands on a dead end."
```

---

### Task 13: Reminder cron

**Files:**
- Create: `api/calendar-reminders.js`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `_google-calendar`, `_email`, `_load-template`, `_booking-guard`.
- Produces: `GET /api/calendar-reminders` -> `{ ok, considered, sent, skipped }`

- [ ] **Step 1: Modify `vercel.json`**

```json
{
  "version": 2,
  "crons": [
    { "path": "/api/calendar-reminders", "schedule": "0 * * * *" }
  ]
}
```

> **Plan limitation to confirm:** Vercel's Hobby plan allows only once-per-day cron schedules (and at most two crons). If this project is on Hobby, the deploy will reject `0 * * * *` and the schedule must become something like `0 13 * * *`. Flag this rather than silently weakening the reminder.

- [ ] **Step 2: Create `api/calendar-reminders.js`**

```js
// GET /api/calendar-reminders -- invoked by Vercel Cron.
//
// R8: with no bookings table, "already reminded" is a flag on the event itself
// (extendedProperties.private.reminderSent). Setting it before sending would risk
// dropping a reminder; setting it after risks sending twice. We set it AFTER a
// successful send, because a duplicate reminder is a far smaller failure than a
// call the visitor forgets.
const gcal = require('./_google-calendar');
const guard = require('./_booking-guard');
const email = require('./_email');
const { loadTemplate } = require('./_load-template');

const LEAD_HOURS = Number(process.env.REMINDER_LEAD_HOURS) || 24;

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: without a secret this endpoint would let anyone trigger a mail
  // run against every upcoming booking.
  if (!secret) return false;
  const header = (req.headers && req.headers.authorization) || '';
  return header === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!authorized(req)) {
    return res.status(401).json({ ok: false,
      error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET not set' });
  }

  const now = Date.now();
  const windowEnd = now + LEAD_HOURS * 60 * 60 * 1000;

  // Only events this system created can be reminded -- Omar's own meetings are
  // none of our business.
  const listed = await gcal.listEvents({
    timeMinIso: new Date(now).toISOString(),
    timeMaxIso: new Date(windowEnd).toISOString(),
    privateExtendedProperty: `bookingSource=${guard.EVENT_MARKER}`,
  });
  if (!listed.ok) {
    const notConnected = listed.reason === gcal.NOT_CONNECTED;
    return res.status(notConnected ? 503 : 502).json({
      ok: false, error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: listed.reason,
    });
  }

  const tplRes = await loadTemplate();
  let sent = 0, skipped = 0;

  for (const event of listed.events) {
    const meta = (event.extendedProperties && event.extendedProperties.private) || {};
    if (meta.reminderSent === '1') { skipped++; continue; }
    if (!meta.visitorEmail) { skipped++; continue; }

    const startMs = Date.parse(event.start && event.start.dateTime);
    if (!Number.isFinite(startMs) || startMs < now) { skipped++; continue; }

    const result = await email.sendReminder({
      eventId: event.id,
      name: meta.visitorName || '—',
      email: meta.visitorEmail,
      phone: meta.visitorPhone || '',
      startMs,
      endMs: Date.parse(event.end && event.end.dateTime) || startMs,
      visitorTimeZone: meta.visitorTimeZone || 'UTC',
      templateTimeZone: tplRes.template.timezone,
      manageToken: require('./_booking-token').makeBookingToken(event.id, meta.visitorEmail),
      meetLink: event.hangoutLink || '',
      lang: meta.lang || 'en',
    });

    if (result.ok) {
      await gcal.patchEvent(event.id, {
        extendedProperties: { private: { reminderSent: '1' } },
      });
      sent++;
    } else {
      // Leave the flag unset so the next run retries.
      console.error('reminder failed for', event.id, result.reason);
      skipped++;
    }
  }

  return res.status(200).json({ ok: true, considered: listed.events.length, sent, skipped });
};
```

- [ ] **Step 3: Verify the guard and the flag logic**

Confirm by inspection:
- With `CRON_SECRET` unset, the endpoint returns 401 with `'CRON_SECRET not set'` — it never runs unguarded.
- With a wrong bearer token, 401.
- The `privateExtendedProperty` filter means Omar's personal events are never listed, let alone emailed.
- `reminderSent` is written only after `sendReminder` reports `ok`.

Run: `node --test`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add api/calendar-reminders.js vercel.json
git commit -m "feat: remind visitors before their booked call

There is no bookings table to record what has been sent, so 'already reminded'
is a flag on the calendar event itself, written only after Resend accepts the
send. Ordering it that way means a failure retries next run: a duplicate
reminder is a much smaller failure than a call the visitor forgets.

The event list is filtered to bookings this system created, so Omar's own
meetings are never read or emailed about. The endpoint refuses to run without
CRON_SECRET rather than letting anyone trigger a mail run.

Scheduled hourly; Vercel's Hobby plan only permits daily crons, so this may need
relaxing to a fixed daily time depending on the project's plan."
```

---

## Self-Review

Run through this before declaring the plan done.

**1. Spec coverage** — every spec section maps to a task:

| Spec requirement | Task |
| --- | --- |
| Single Google Calendar, OAuth already set up | 4, 5 |
| Fixed weekly template, **admin-editable timezone** | 3, 10 |
| Visitor timezone auto-detected but overridable | 11 |
| Email templates: mechanism + triggers, placeholder copy | 7, 8, 9, 13 |
| Slack through the existing `_slack.js` pipeline | 7 |
| Vercel Blob, two JSON docs | 1 |
| Bullion visual identity | 10, 11, 12 |
| Surfaces only for `1k-3k` / `3k+` | 12 |
| `GET /api/calendar-oauth-start` (passcode-gated) | 5 |
| `GET /api/calendar-oauth-callback` (locked path) | 5 |
| `GET /api/calendar-availability?date=` | 6 |
| `POST /api/calendar-book` + post-insert overlap rollback | 8 |
| `POST /api/calendar-reschedule` / `-cancel`, same discipline | 9 |
| `GET`/`POST /api/admin/availability`, passcode-gated | 10 |
| Admin gate: passcode + HMAC session cookie | 5 |
| Access tokens cached keyed on refresh-token **value** | 4 |
| Slots computed on request, never stored | 3, 6 |
| Widget: `mount()`, progressive reveal, `extraFields` | 11 |
| Auto-select first day with real openings | 11 |
| 409 treated as an expected race | 11, 8 |
| Preserve typed input + `scrollLeft` across re-renders | 11 |
| `onBooked`/`onDuplicate`/`onUnavailable` callbacks | 11 |
| Custom day/time pickers, not native inputs | 11, 10 |
| Reminder before the call | 13 |
| No Tier 2/3, no multi-calendar, no final copy | Global Constraints |

**2. Placeholder scan** — the only "PLACEHOLDER" strings are the email subjects/bodies in Task 7, which are *required* to be placeholders and are marked as such. No `TBD`, no "add error handling", no "similar to Task N".

**3. Type consistency** — verify while executing:
- `busy` is **always** `[{ start: ms, end: ms }]` (numbers, not ISO) from `freeBusy` through `computeSlotsForDay`.
- `ymd` is **always** `{ y, mo, d }` with `mo` **1-based**.
- `template.days` keys are the lowercase three-letter forms in `WEEKDAY_KEYS` (Sunday-first array, but referenced by name).
- The booking object `b` has the same field names in `_email.js`, `_booking-slack.js`, `calendar-book.js`, `calendar-reschedule.js`, `calendar-cancel.js`, `calendar-reminders.js`.
- `gcal.getEvent` is used by `_load-booking.js` (added in Task 4's exports).
- Require prefixes: `./_x` in `api/`, `../_x` in `api/admin/`.

## Known gaps at completion (carry into the final report)

1. **The Vercel Blob store does not exist.** Every persistence path is therefore untested against the real service. Expected behaviour until it is created: availability returns `503 BLOB_NOT_CONFIGURED`, the widget shows `book_unavailable`, and the OAuth callback explains that it authorised but could not save.
2. **Omar's one-time OAuth consent has not happened**, so no refresh token exists and no real calendar read/write has been exercised.
3. **`ADMIN_PASSCODE` is not set**, so the admin page and both OAuth endpoints will 401/503 until the user adds it.
4. **`CRON_SECRET` is not set**, so the reminder endpoint refuses to run.
5. **Email copy is placeholder** by explicit instruction — the collaborative pass is still owed.
6. **Cron frequency may violate the Hobby plan** (daily maximum); confirm the plan or relax the schedule.
7. **Resend sends from the shared `onboarding@resend.dev`** until `3amaktrades.com` is verified for sending.
8. **Reschedule and cancel are API-only — there is no visitor-facing UI yet.** `/api/calendar-reschedule` and `/api/calendar-cancel` are complete and tested, and `manageToken` is still minted and returned by `/api/calendar-book`, but nothing reads a `booking` query param on the front end (the widget's reschedule mode was deferred by the spec). The emails therefore no longer advertise reschedule/cancel links: shipping a link that silently lands a high-intent lead on the homepage is worse than not offering one. Wiring the flow later needs no change to the endpoints or the token.

