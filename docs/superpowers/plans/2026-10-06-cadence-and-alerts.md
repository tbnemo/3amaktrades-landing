# Booking Cadence + System Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single flat pre-call reminder with three cascading touches (~24h / ~2h / ~10min) scaled to each booking's actual notice, give active check-in clients a recurring Monday-reset weekly nudge to book, and give the owner a live daily heartbeat plus an on-demand snapshot in the existing `#7-system-alerts` channel so he can see all of it firing.

**Architecture:** Three layers on the existing `api/` serverless-function system. (1) The reminder's one-flag/one-window logic is extracted into a new pure module `api/_reminder-touches.js` that describes **three** independent touches, each with its own `extendedProperties.private` flag and its own owning cron path — the 24h touch keeps riding Vercel's once-daily cron unchanged, while the 2h and 10min touches ride a new bearer-secret-protected `?touch=fine` mode on the *same* endpoint, polled every ~5 minutes by an external cron service the user configures. (2) A new private Blob document `checkin-cadence-state.json` plus `api/_checkin-cadence.js` tracks per-week, per-client nudge state; the weekly pass runs inside the existing daily cron tick, scoped to `isAccessActive()` clients, branching booked→reassurance / not-booked→escalation tier by day. (3) `api/_cadence-slack.js` maintains one `chat.update`-refreshed heartbeat message per day in the existing alerts channel and builds the on-demand snapshot, both as single non-nested read-merge-writes against the same blob.

**Tech Stack:** Node.js CommonJS serverless functions on Vercel, `@vercel/blob` (private access, `useCache:false`), Google Calendar REST v3 via `node-fetch`, Resend REST for email, Slack `chat.postMessage` + `chat.update` via bot token, `node:test` + `node:assert/strict` for tests, zero-build static HTML/CSS/JS for `admin.html`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-cadence-and-alerts-design.md` (on the `internal-docs` branch; read with `git show internal-docs:docs/superpowers/specs/2026-10-06-cadence-and-alerts-design.md`)

## Global Constraints

- **THE DEPLOYMENT IS AT THE SERVERLESS-FUNCTION CAP. Do not create any new non-`_`-prefixed file under `api/`.** The Hobby plan allows 12 Serverless Functions and every non-`_` `.js` file under `api/` becomes one. The current count is exactly 12: `calendar-availability.js`, `calendar-book.js`, `calendar-cancel.js`, `calendar-checkin.js`, `calendar-oauth-callback.js`, `calendar-oauth-start.js`, `calendar-reminders.js`, `calendar-reschedule.js`, `submit.js`, `admin/auth.js`, `admin/availability.js`, `admin/checkin.js`. A thirteenth file fails the build (this already happened once at 19 — see the header comment in `api/calendar-checkin.js`). Every new endpoint in this plan is therefore a **mode on the existing `/api/calendar-reminders` function**, and every new module is `_`-prefixed.
- **Touch keys, verbatim:** `'24h'`, `'2h'`, `'10m'`. **Event flag names, verbatim:** `reminder24hSent`, `reminder2hSent`, `reminder10mSent`. The old single `reminderSent` flag is retired and must appear nowhere in `api/` or `test/` when this plan is done.
- **Flag values, verbatim:** `'1'` = this touch was sent. `'moot'` = this touch was deliberately skipped because its moment had already passed when the booking was made. `''` or absent = still pending. Every cron path skips a touch whose flag is **any non-empty string** — so `'moot'` and `'1'` both suppress, and only `''`/absent is eligible. Google `extendedProperties.private` values are always strings; never write a boolean or a number.
- **`needsImmediateReminder` is deleted, not redefined.** Its old meaning (`min(notice, lead) < CRON_PERIOD_HOURS`, a single yes/no for one reminder) has no correct generalization to three touches, and keeping the name with new semantics would silently change what four call sites and one proof file believe. Task 1 introduces `planTouches(startMs, nowMs)`; Task 7 replaces all four call sites and rewrites `test/reminder-delivery-guarantee.test.js` around the new invariant.
- **The 24h touch's mootness and the daily cron's listing window are two different numbers, deliberately.** Mootness is measured against a **fixed 24h** nominal moment (`startMs - 24h`); the daily cron keeps listing `[now, now + leadHours()]` exactly as `wouldRemind` does today (deployed `REMINDER_LEAD_HOURS=36`). Collapsing the two would make every booking with under 36h of notice lose its day-before reminder, which is a regression, not the spec.
- **Blob name, verbatim:** `checkin-cadence-state.json`, PRIVATE, read with `useCache:false`, via the existing `api/_blob-store.js` helpers. No retention/pruning policy — the spec explicitly leaves old weeks to accumulate.
- **Week boundaries are always Monday 00:00 through the following Monday 00:00, in the CHECK-IN template's own configured timezone** (`loadCheckinTemplate().template.timezone`), never UTC and never a raw `getDay()` on an epoch instant.
- **Escalation tier keys, verbatim:** `'neutral'`, `'direct'`, `'urgent'`, `'lastcall'`. **Day mapping, decided here (the spec left it to implementation):** Tue→`neutral`, Thu→`direct`, Sat→`urgent`, Sun→`lastcall`; Mon/Wed/Fri send no nudge. One tier per week maximum per client, never resent, and a lower tier already sent is never re-sent once a later one fires.
- **Nudge scope, verbatim from the spec:** only clients with an **active, non-paused package**. A paused client, an expired one, **and a `durationMonths === 0` ("No package") client** are all excluded from the nudge entirely — a "No package" client is an admin-chosen ongoing/indefinite arrangement with no weekly check-in obligation, so `isAccessActive()` alone is NOT the right filter (it returns `true` for them, because their computed `expiresAt` is `null`). The filter is `hasCheckinObligation()` from `api/_checkin-cadence.js`, which is `isAccessActive(c, nowMs) && Number(c.durationMonths) !== 0`.
- **No new Slack channel.** Everything posts to the existing `CHANNEL_SYSTEM_ALERTS` (`#7-system-alerts`, `C0C56PC8BPV`). The existing failure-only `postSystemAlert()` behaviour stays byte-for-byte unchanged.
- **NO QUEUE. Anywhere.** The spec calls out the nested-queue deadlock in advance: a serializing wrapper around the heartbeat update, called from inside another wrapper of the same queue, deadlocks forever on the slot the outer call holds. The heartbeat and the counters are a single idempotent read-merge-write (`_checkin-cadence.js`'s `mutate()`), and **`mutate()` must never be called from inside another `mutate()` callback**. Do not add a mutex, lock, or promise chain "to be safe" — a lost count on a simultaneous daily+fine tick is a cosmetic undercount in one Slack line, and the cure the spec warns about is strictly worse than the disease.
- **Email copy reuses the finished Minimal Ticket helpers only.** Every new template is built from `shell`, `headline`, `detailsBox`, `ctaButton`, `footerLine`, `joinRow` already exported by `api/_email.js`. No new visual pass, no new colours, no new inline style blocks, and **no change whatsoever** to the four existing applicant templates or the four existing check-in templates. `api/_email.js` templates are bilingual (`lang:'en'` and `lang:'ar'` both real copy); `api/_checkin-email.js` templates are English-only.
- **No placeholder copy.** `test/checkin-email.test.js` already asserts neither email source file contains the string `PLACEHOLDER`. Every template added by this plan ships final copy.
- **Out of scope, do not build:** a nudge-to-book sequence for applicants who never booked (applicants get pre-call reminders only); a skip/opt-out link on the check-in nudge; a per-event "Sent" Slack message stream; any change to the booking/reschedule/cancel flows themselves, their Slack channels, or the eight existing email templates.
- **Two secrets, both bearer, distinct:** the existing `CRON_SECRET` (Vercel's daily cron) and the new `REMINDER_FINE_CRON_SECRET` (the external ~5-minute cron). Compared with `safeEqual` from `api/_admin-auth.js`, the same constant-time comparison every other secret in this codebase uses. Neither secret is ever exposed to `admin.html`.
- **Test style:** `node:test` + `node:assert/strict`, CommonJS `require`, local `makeRes()` / `withStubs()` / `spyStub()` / `emptyBlobClient()` / `envSetup()` helpers copied into each test file (this repo duplicates them per file rather than sharing a helper module — follow that). Run with `npm test` (which is `node --test`).
- **Node runtime:** CommonJS only (`require` / `module.exports`). No TypeScript, no ESM, no build step.

---

## File Structure

**New API modules (all `_`-prefixed, so none costs a Serverless Function)**

| File | Responsibility |
| --- | --- |
| `api/_reminder-touches.js` | The three-touch table and ALL the window/mootness/reliability arithmetic. Pure, no I/O. This is the single place that knows what "~24h before" means, which cron owns it, and whether that cron can be trusted with a given booking. |
| `api/_checkin-cadence.js` | `checkin-cadence-state.json` load/save/`mutate`, the week- and day-entry accessors, and the pure weekday→tier mapping. |
| `api/_cadence-slack.js` | The daily `chat.update`-refreshed heartbeat message and the on-demand snapshot message. Builds Slack block payloads; reads cadence state; posts through `api/_slack.js`. |

**Modified files**

| File | Change |
| --- | --- |
| `api/_blob-store.js` | `+ CHECKIN_CADENCE_BLOB` constant and export. |
| `api/_timezone.js` | `+ weekdayKeyInZone`, `+ mondayYmdFor`, `+ weekWindow` — the Monday-anchored week boundary, genuinely new to this codebase. |
| `api/_slack.js` | `+ updateSlackMessage(channelId, ts, message)` — `chat.update`, with no webhook fallback (a webhook cannot edit a message). |
| `api/_email.js` | `+ sendStartingSoon(b)` — the bilingual 10-minute template. Existing four senders untouched. |
| `api/_checkin-email.js` | `+ sendCheckinStartingSoon(b)`, `+ sendCheckinAllSet(n)`, `+ sendCheckinNudge(n, tier)`. Existing four senders untouched. |
| `api/calendar-reminders.js` | The big one: per-touch loop instead of one send; the `?touch=fine` mode; the weekly nudge pass; the heartbeat refresh; the `{cadenceStatus:true}` snapshot mode. Re-exports the arithmetic from `_reminder-touches.js` so existing requires keep working. |
| `api/calendar-book.js:181-201` | `needsImmediateReminder` → `planTouches`: pre-stamp moot flags, send any immediate touch. |
| `api/calendar-reschedule.js:77-104, 169-188` | Clear/restore three flags instead of one; `planTouches` on the new start. |
| `api/calendar-checkin.js:409-428, 597-624, 683-700` | The same two changes on the check-in book and reschedule handlers. |
| `admin.html:630-633, 2231-2268, 2276-2310` | The existing "Send Due Reminders Now" button also replays the weekly nudge pass; a new "Check Cadence Status" button posts the snapshot. |
| `vercel.json` | **No change.** Still exactly one Vercel cron (`/api/calendar-reminders`, `0 0 * * *`). The 5-minute poller is external infrastructure, outside this file, and `test/reminder-delivery-guarantee.test.js` asserts that the Vercel cron list stays a single daily job. |

**New test files:** `test/reminder-touches.test.js`, `test/checkin-nudge-email.test.js`, `test/calendar-reminders-fine.test.js`, `test/checkin-cadence.test.js`, `test/checkin-nudge-pass.test.js`, `test/cadence-heartbeat.test.js`, `test/cadence-snapshot.test.js`.

**Modified test files:** `test/timezone.test.js`, `test/email.test.js`, `test/checkin-email.test.js`, `test/calendar-reminders.test.js`, `test/reminder-delivery-guarantee.test.js` (rewritten invariant), `test/calendar-book.test.js`, `test/calendar-reschedule.test.js`, `test/calendar-checkin-book.test.js`, `test/calendar-checkin-reschedule.test.js`, `test/admin-page-structure.test.js`.

**Task ordering rationale (not arbitrary):** Tasks 1–2 are pure arithmetic with no I/O and no consumers, testable in complete isolation. Tasks 3–4 are the email senders, and they land **before** every cron/handler task that calls them: this repo's tests stub collaborators with `withStubs`, which monkey-patches a property on an already-required module, and a stub for a function that does not exist yet silently patches `undefined` into place instead of failing loudly. Task 5 then changes the daily cron to read/write the new flags, Task 6 adds the fine path that owns the other two touches, and Task 7 changes the four booking handlers last — by then both cron paths exist, so the "a touch left to a cron really does get sent" half of the delivery proof can be asserted against real code rather than an intention. Task 8 is the cadence blob module, pure except for the two `_blob-store` calls, and lands before the pass (9), the heartbeat (10) and the snapshot (11) that all read it. Task 11 is last because it is the only task that needs both the cadence state (8) and the Slack message builders (10).

---

### Task 1: The three-touch arithmetic module

**Files:**
- Create: `api/_reminder-touches.js`
- Modify: `api/_blob-store.js:30-35` (constant block) and `api/_blob-store.js:78-83` (exports)
- Modify: `api/calendar-reminders.js:25-99` (delete the moved arithmetic) and `api/calendar-reminders.js:320-335` (re-export block)
- Test: `test/reminder-touches.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `store.CHECKIN_CADENCE_BLOB === 'checkin-cadence-state.json'` (string)
  - `require('./_reminder-touches')` →
    - `CRON_PERIOD_HOURS === 24` (number)
    - `FINE_CRON_PERIOD_MINUTES === 5` (number)
    - `PATH_DAILY === 'daily'`, `PATH_FINE === 'fine'` (strings)
    - `TOUCHES` — frozen array of `{ key, flag, offsetMs, path }` in cadence order `['24h','2h','10m']`
    - `TOUCH_KEYS` — `['24h','2h','10m']` (frozen string array)
    - `TOUCH_FLAGS` — `['reminder24hSent','reminder2hSent','reminder10mSent']` (frozen string array)
    - `touchByKey(key) -> {key,flag,offsetMs,path} | null`
    - `touchesForPath(path) -> Array<touch>`
    - `leadHours() -> number` (moved verbatim from `calendar-reminders.js`)
    - `reminderWindow(nowMs) -> {timeMinMs, timeMaxMs}` (moved verbatim)
    - `wouldRemind(startMs, nowMs) -> boolean` (moved verbatim)
    - `pathPeriodMs(path) -> number`
    - `touchDueAt(key, startMs, nowMs) -> boolean`
    - `touchStatusAt(key, startMs, nowMs) -> 'moot' | 'immediate' | 'cron'`
    - `planTouches(startMs, nowMs) -> { moot: string[], immediate: string[], cron: string[] }` (key arrays, each in `TOUCH_KEYS` order)
  - `require('./calendar-reminders')` keeps exporting `leadHours`, `reminderWindow`, `wouldRemind`, `CRON_PERIOD_HOURS` with identical behaviour (re-exported from the new module), and **no longer exports `needsImmediateReminder`**.

- [ ] **Step 1: Write the failing test**

Create `test/reminder-touches.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../api/_reminder-touches');
const store = require('../api/_blob-store');
const remind = require('../api/calendar-reminders');

const HOUR = 3600000;
const MINUTE = 60000;

function withLead(hours, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  process.env.REMINDER_LEAD_HOURS = String(hours);
  try { return fn(); } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
}

test('the cadence blob name is exported with its exact spec value and is unique', () => {
  assert.equal(store.CHECKIN_CADENCE_BLOB, 'checkin-cadence-state.json');
  const all = [
    store.AVAILABILITY_BLOB, store.OAUTH_BLOB, store.LOGIN_ATTEMPTS_BLOB,
    store.CHECKIN_AVAILABILITY_BLOB, store.CHECKIN_CLIENTS_BLOB,
    store.CHECKIN_VERIFY_ATTEMPTS_BLOB, store.APPLICANTS_BLOB,
    store.CHECKIN_CADENCE_BLOB,
  ];
  assert.equal(new Set(all).size, all.length, `blob names must be unique: ${all.join(', ')}`);
});

test('the three touches are declared in cadence order with the exact spec keys and flags', () => {
  assert.deepEqual(t.TOUCH_KEYS, ['24h', '2h', '10m']);
  assert.deepEqual(t.TOUCH_FLAGS, ['reminder24hSent', 'reminder2hSent', 'reminder10mSent']);
  assert.deepEqual(t.TOUCHES.map(x => x.offsetMs), [24 * HOUR, 2 * HOUR, 10 * MINUTE]);
  assert.deepEqual(t.TOUCHES.map(x => x.path), ['daily', 'fine', 'fine']);
  // The old single flag must be gone, not aliased alongside the new three.
  assert.ok(!t.TOUCH_FLAGS.includes('reminderSent'));
});

test('each cron path owns exactly the touches it is responsible for', () => {
  assert.deepEqual(t.touchesForPath(t.PATH_DAILY).map(x => x.key), ['24h']);
  assert.deepEqual(t.touchesForPath(t.PATH_FINE).map(x => x.key), ['2h', '10m']);
  assert.equal(t.pathPeriodMs(t.PATH_DAILY), 24 * HOUR);
  assert.equal(t.pathPeriodMs(t.PATH_FINE), 5 * MINUTE);
});

// The 24h touch's cron window is the EXISTING window, verbatim -- the one thing
// in this whole plan that must not move. wouldRemind is the definition.
test("touchDueAt('24h') is exactly wouldRemind, at both lead settings", () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  for (const lead of [36, 24]) {
    withLead(lead, () => {
      for (const h of [-1, 0, 0.5, 2, 12, 23.9, 24, 30, 36, 36.1, 48]) {
        const start = now + h * HOUR;
        assert.equal(t.touchDueAt('24h', start, now), t.wouldRemind(start, now),
          `lead=${lead} h=${h}`);
      }
    });
  }
});

// The fine touches are half-open [nominal, start): their moment has arrived and
// the call has not started. NOT the 24h touch's "anything in the next N hours"
// window -- that would fire the 2h copy at a call ten minutes away, one email
// after the other.
test('the fine touches fire from their nominal moment up to (not including) the start', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  assert.equal(t.touchDueAt('2h', now + 2 * HOUR + MINUTE, now), false, 'just before the 2h mark');
  assert.equal(t.touchDueAt('2h', now + 2 * HOUR, now), true, 'exactly at the 2h mark');
  assert.equal(t.touchDueAt('2h', now + MINUTE, now), true, 'still open 1 minute out');
  assert.equal(t.touchDueAt('2h', now, now), false, 'the call has started');
  assert.equal(t.touchDueAt('2h', now - MINUTE, now), false, 'the call is under way');

  assert.equal(t.touchDueAt('10m', now + 11 * MINUTE, now), false);
  assert.equal(t.touchDueAt('10m', now + 10 * MINUTE, now), true);
  assert.equal(t.touchDueAt('10m', now + MINUTE, now), true);
  assert.equal(t.touchDueAt('10m', now, now), false);
});

// The spec's two worked examples, which are the whole point of the feature.
test('SPEC EXAMPLE: a booking made 1 hour out skips the moot 24h and 2h touches and only gets the 10min one', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(36, () => {
    const plan = t.planTouches(now + 1 * HOUR, now);
    assert.deepEqual(plan.moot, ['24h', '2h']);
    assert.deepEqual(plan.immediate, []);
    assert.deepEqual(plan.cron, ['10m']);
  });
});

test('SPEC EXAMPLE: a booking made 5 minutes out gets none of the three', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(36, () => {
    const plan = t.planTouches(now + 5 * MINUTE, now);
    assert.deepEqual(plan.moot, ['24h', '2h', '10m']);
    assert.deepEqual(plan.immediate, []);
    assert.deepEqual(plan.cron, []);
  });
});

test('a booking with normal notice leaves all three touches to their crons', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(36, () => {
    const plan = t.planTouches(now + 3 * 24 * HOUR, now);
    assert.deepEqual(plan.moot, []);
    assert.deepEqual(plan.immediate, []);
    assert.deepEqual(plan.cron, ['24h', '2h', '10m']);
  });
});

// The regression this plan exists to avoid: with the DEPLOYED lead of 36h, a
// booking made 30 hours out must still get its day-before touch. Measuring
// mootness against leadHours() instead of a fixed 24h would silently drop it,
// and 30h notice is an extremely ordinary booking.
test('REGRESSION GUARD: at lead=36 a 30-hour-notice booking keeps its 24h touch', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(36, () => {
    const plan = t.planTouches(now + 30 * HOUR, now);
    assert.equal(plan.moot.includes('24h'), false,
      'mootness must be measured against a FIXED 24h nominal, not leadHours()');
    assert.deepEqual(plan.cron, ['24h', '2h', '10m']);
  });
});

// A lead below the cron period is the one configuration where the daily cron
// genuinely cannot be trusted, and the immediate-send escape valve still has to
// exist for it.
test('a lead shorter than the cron period forces the 24h touch to send immediately', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(12, () => {
    assert.equal(t.touchStatusAt('24h', now + 25 * HOUR, now), 'immediate');
    assert.equal(t.touchStatusAt('24h', now + 23 * HOUR, now), 'moot');
  });
});

test('non-finite inputs are moot, never immediate -- a NaN must not trigger a send', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  for (const key of t.TOUCH_KEYS) {
    assert.equal(t.touchStatusAt(key, NaN, now), 'moot');
    assert.equal(t.touchStatusAt(key, now + HOUR, NaN), 'moot');
    assert.equal(t.touchStatusAt(key, undefined, now), 'moot');
    assert.equal(t.touchDueAt(key, NaN, now), false);
  }
  assert.equal(t.touchStatusAt('nonsense', now + HOUR, now), 'moot');
  assert.equal(t.touchByKey('nonsense'), null);
});

test('a call already under way is moot for every touch', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const plan = t.planTouches(now - HOUR, now);
  assert.deepEqual(plan.moot, ['24h', '2h', '10m']);
  assert.deepEqual(plan.immediate, []);
  assert.deepEqual(plan.cron, []);
});

// SOUNDNESS. 'cron' is a PROMISE, not a hope: whenever planTouches leaves a
// touch to a cron, some tick of that cron must provably land inside the touch's
// own due window, for EVERY phase. Proved by brute force over phases rather than
// by restating the arithmetic.
test('SOUNDNESS: every touch left to a cron is really caught by it, at every phase', () => {
  const B = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(36, () => {
    let checked = 0;
    for (const noticeMin of [6, 9, 10, 11, 30, 119, 120, 121, 300, 1439, 1440, 1441, 4320]) {
      const S = B + noticeMin * MINUTE;
      const plan = t.planTouches(S, B);
      for (const key of plan.cron) {
        const touch = t.touchByKey(key);
        const periodMs = t.pathPeriodMs(touch.path);
        // 12 arbitrary phases of the owning cron, each a fraction of a period.
        for (let p = 0; p < 12; p++) {
          const phase = Math.floor((p / 12) * periodMs);
          let hit = false;
          for (let tick = B + phase; tick <= S + periodMs; tick += periodMs) {
            if (tick >= B && t.touchDueAt(key, S, tick)) { hit = true; break; }
          }
          assert.ok(hit, `touch ${key} left to the ${touch.path} cron is NEVER caught `
            + `(notice ${noticeMin}min, phase ${phase}ms) -- that is a silently missed email`);
          checked++;
        }
      }
    }
    assert.ok(checked > 100, `expected a real sweep, only checked ${checked} combinations`);
  });
});

// The reverse direction, so a predicate that marked everything 'immediate'
// cannot pass: a touch is only skipped as moot when its moment really has gone.
test('SOUNDNESS: a touch marked moot really has an unreachable moment', () => {
  const B = Date.UTC(2026, 9, 6, 12, 0, 0);
  withLead(36, () => {
    for (const noticeMin of [1, 5, 9, 30, 119, 1439]) {
      const S = B + noticeMin * MINUTE;
      for (const key of t.planTouches(S, B).moot) {
        const touch = t.touchByKey(key);
        assert.ok(S - touch.offsetMs < B,
          `${key} was called moot at ${noticeMin}min notice, but its nominal moment `
          + `${new Date(S - touch.offsetMs).toISOString()} is still in the future`);
      }
    }
  });
});

// The arithmetic moved OUT of calendar-reminders.js, but four handlers and two
// test files require it from there. Re-exports keep that contract.
test('calendar-reminders.js still re-exports the moved arithmetic', () => {
  assert.equal(remind.CRON_PERIOD_HOURS, 24);
  assert.equal(typeof remind.leadHours, 'function');
  assert.equal(typeof remind.reminderWindow, 'function');
  assert.equal(typeof remind.wouldRemind, 'function');
  withLead(36, () => assert.equal(remind.leadHours(), 36));
  withLead(24, () => assert.equal(remind.leadHours(), 24));
});

// Deleted, not redefined -- see Global Constraints. A leftover export is how a
// call site keeps compiling while meaning something different.
test('needsImmediateReminder is gone from both modules', () => {
  assert.equal(remind.needsImmediateReminder, undefined);
  assert.equal(t.needsImmediateReminder, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/reminder-touches.test.js`
Expected: FAIL — `Cannot find module '../api/_reminder-touches'`.

- [ ] **Step 3: Create `api/_reminder-touches.js`**

```js
// The three pre-call reminder touches, and all the arithmetic that decides when
// each one fires. Pure: no I/O, no Google, no email, no blob.
//
// This file used to be four functions at the top of calendar-reminders.js
// (leadHours/reminderWindow/wouldRemind/needsImmediateReminder) describing ONE
// reminder. The cadence is now three independent touches, and the two halves of
// the delivery guarantee -- "which cron owns this touch" and "can that cron be
// trusted with this booking" -- have to be answered the same way in five places
// (the two cron paths and the four booking/reschedule handlers). Keeping the
// answer in one pure module is what stops those five drifting apart.
//
// A note on vocabulary, because three words do a lot of work below:
//
//   NOMINAL MOMENT  the instant a touch is "supposed" to go out: startMs minus
//                   the touch's own offset. start-24h, start-2h, start-10min.
//   DUE WINDOW      the span of time during which a cron run WILL send the
//                   touch. For the fine touches this is [nominal, start) --
//                   their moment has come and the call has not begun. For the
//                   24h touch it is the EXISTING window, [now, now+lead] on the
//                   start, unchanged from the single-reminder era (see below).
//   MOOT            the nominal moment was already in the past when the booking
//                   was made. The touch is not late and not failed; there was
//                   never a moment at which it could have been sent. It must be
//                   stamped on the event so no cron sends it, and it must NOT be
//                   logged or alerted as a failure.

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

// How far apart two ticks of Vercel's own cron are. ONE source of truth for a
// number the delivery guarantee is measured against: the Hobby plan caps crons
// at once per day, so vercel.json schedules /api/calendar-reminders "0 0 * * *".
//
// This constant does NOT set the period -- vercel.json's schedule does. It is
// what the code BELIEVES the period to be, and a belief that runs behind reality
// is the dangerous case. test/reminder-delivery-guarantee.test.js parses the
// live schedule and asserts the two agree.
const CRON_PERIOD_HOURS = 24;

// How far apart two ticks of the EXTERNAL cron are (cron-job.org or equivalent,
// configured by the user, hitting /api/calendar-reminders?touch=fine).
//
// Five minutes, not ten or fifteen, and the reason is arithmetic rather than
// taste: the 10-minute touch's due window is itself only 10 minutes wide, and a
// window is guaranteed to contain a tick regardless of phase only once it is at
// least a full period long. A 15-minute poller would sail straight over the
// 10-minute touch for most bookings, silently.
//
// Same caveat as above: this is a BELIEF about infrastructure this repo cannot
// see. If the external job is ever reconfigured slower than this, touchStatusAt
// starts promising a delivery nothing performs -- so the setup instructions in
// the plan's Task 6 and this constant have to be changed together.
const FINE_CRON_PERIOD_MINUTES = 5;

const PATH_DAILY = 'daily';
const PATH_FINE = 'fine';

// `offsetMs` is the NOMINAL offset, and for the 24h touch it is deliberately a
// fixed 24 hours rather than leadHours(). Mootness is measured against it; the
// daily cron's listing window still uses leadHours() (deployed 36). Collapsing
// the two would make every booking with under 36h of notice lose its day-before
// reminder -- which is most bookings, and a plain regression.
const TOUCHES = Object.freeze([
  Object.freeze({ key: '24h', flag: 'reminder24hSent', offsetMs: 24 * HOUR_MS, path: PATH_DAILY }),
  Object.freeze({ key: '2h', flag: 'reminder2hSent', offsetMs: 2 * HOUR_MS, path: PATH_FINE }),
  Object.freeze({ key: '10m', flag: 'reminder10mSent', offsetMs: 10 * MINUTE_MS, path: PATH_FINE }),
]);

const TOUCH_KEYS = Object.freeze(TOUCHES.map(t => t.key));
const TOUCH_FLAGS = Object.freeze(TOUCHES.map(t => t.flag));

function touchByKey(key) {
  return TOUCHES.find(t => t.key === key) || null;
}

function touchesForPath(path) {
  return TOUCHES.filter(t => t.path === path);
}

function pathPeriodMs(path) {
  return path === PATH_FINE
    ? FINE_CRON_PERIOD_MINUTES * MINUTE_MS
    : CRON_PERIOD_HOURS * HOUR_MS;
}

// Read per call rather than captured at module load: a module-load constant is
// unreachable from a test that wants to vary it, which is exactly why the window
// behaviour went untested through two review rounds. Env vars are fixed for the
// life of a deployment, so reading per call costs nothing.
function leadHours() {
  const n = Number(process.env.REMINDER_LEAD_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

// The window handed to listEvents on the DAILY path: bookings starting between
// now and now+lead. Unchanged from the single-reminder era.
function reminderWindow(nowMs) {
  return { timeMinMs: nowMs, timeMaxMs: nowMs + leadHours() * HOUR_MS };
}

// Whether a DAILY run happening at nowMs would send the 24h touch for a booking
// starting at startMs. listEvents returns everything INTERSECTING the window, so
// a call already under way comes back too -- the lower bound is what drops it,
// because reminding someone about a call that has started is worse than
// useless. The upper bound re-states Google's own filter locally so the rule
// lives in one place.
function wouldRemind(startMs, nowMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return false;
  const { timeMinMs, timeMaxMs } = reminderWindow(nowMs);
  return startMs >= timeMinMs && startMs <= timeMaxMs;
}

// Would a run of this touch's OWN cron, happening at nowMs, send it?
//
// The 24h touch delegates to wouldRemind so the existing behaviour is not merely
// reimplemented-the-same, it is literally the same function.
//
// The fine touches use the half-open [nominal, start) instead. A [now, now+2h]
// style window would fire the 2h copy at a call ten minutes away -- immediately
// followed by the 10-minute copy -- which is two emails a reader cannot tell
// apart and the exact reason the cadence has distinct copy per touch.
function touchDueAt(key, startMs, nowMs) {
  const touch = touchByKey(key);
  if (!touch) return false;
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return false;
  if (touch.path === PATH_DAILY) return wouldRemind(startMs, nowMs);
  return startMs > nowMs && startMs - touch.offsetMs <= nowMs;
}

// At booking (or reschedule) time, what happens to this touch?
//
//   'moot'       its nominal moment is already behind us. Stamp the flag so no
//                cron sends it. Not a failure; do not alert.
//   'immediate'  its moment is still ahead, but the owning cron cannot be
//                RELIED ON to land inside the due window. Send it now and stamp
//                the flag, or the recipient gets nothing with no trace.
//   'cron'       its moment is ahead and a tick provably lands in the window.
//                Leave the flag clear and let the cron do it.
//
// The reliability test is the same one the single-reminder era used: the
// interval during which a run would send is at least a full cron period long,
// so it contains a tick for EVERY phase. Shorter than that, the booking might
// get lucky -- but "might" is not delivery, and the failure mode is a visitor
// who simply never hears from us again about a call they scheduled.
//
//   daily path: the interval is [max(B, S-lead), S], length min(notice, lead),
//               exactly as wouldRemind implements it.
//   fine path:  the interval is [nominal, start), length offsetMs, because
//               'moot' already established that nominal >= now.
function touchStatusAt(key, startMs, nowMs) {
  const touch = touchByKey(key);
  if (!touch) return 'moot';
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return 'moot';
  if (startMs - touch.offsetMs < nowMs) return 'moot';
  const intervalMs = touch.path === PATH_DAILY
    ? Math.min(startMs - nowMs, leadHours() * HOUR_MS)
    : touch.offsetMs;
  return intervalMs >= pathPeriodMs(touch.path) ? 'cron' : 'immediate';
}

// The one function the four booking/reschedule handlers call. Returns all three
// touches sorted into what the handler has to DO about each: stamp the moot
// ones, send the immediate ones, leave the rest alone.
//
// Replaces needsImmediateReminder, which answered this for a single reminder
// and has no correct generalization to three (a yes/no cannot say WHICH touch,
// and the moot case has no representation in it at all).
function planTouches(startMs, nowMs) {
  const out = { moot: [], immediate: [], cron: [] };
  for (const touch of TOUCHES) {
    out[touchStatusAt(touch.key, startMs, nowMs)].push(touch.key);
  }
  return out;
}

module.exports = {
  CRON_PERIOD_HOURS, FINE_CRON_PERIOD_MINUTES, PATH_DAILY, PATH_FINE,
  TOUCHES, TOUCH_KEYS, TOUCH_FLAGS,
  touchByKey, touchesForPath, pathPeriodMs,
  leadHours, reminderWindow, wouldRemind,
  touchDueAt, touchStatusAt, planTouches,
};
```

- [ ] **Step 4: Add the cadence blob constant**

In `api/_blob-store.js`, immediately after the `APPLICANTS_BLOB` declaration (line 35), add:

```js
// Per-week, per-client state for the check-in weekly nudge cycle, plus a small
// per-day section for the Slack heartbeat. Its own document rather than a field
// on checkin-clients.json: that one is read on the /check-in verification hot
// path, and a counter the cron rewrites every tick has no business being in it.
//
// Shape:
//   { weeks: { "<Monday YYYY-MM-DD>": { "<client email>": {
//         reassuranceSent: bool,
//         nudges: { neutral: bool, direct: bool, urgent: bool, lastcall: bool } } } },
//     days:  { "<YYYY-MM-DD>": {
//         heartbeatTs: string|null,
//         touches: { '24h': n, '2h': n, '10m': n },
//         nudges: { neutral: n, direct: n, urgent: n, lastcall: n, reassurance: n },
//         failures: n } } }
//
// No pruning: the spec deliberately leaves old weeks to accumulate and says to
// revisit only if the document size becomes a real concern.
const CHECKIN_CADENCE_BLOB = 'checkin-cadence-state.json';
```

Then replace the export block at the bottom of the file:

```js
module.exports = {
  readJson, writeJson, isConfigured, __setClientForTests,
  BLOB_NOT_CONFIGURED, AVAILABILITY_BLOB, OAUTH_BLOB, LOGIN_ATTEMPTS_BLOB,
  CHECKIN_AVAILABILITY_BLOB, CHECKIN_CLIENTS_BLOB, CHECKIN_VERIFY_ATTEMPTS_BLOB,
  APPLICANTS_BLOB, CHECKIN_CADENCE_BLOB,
};
```

- [ ] **Step 5: Delete the moved arithmetic from `api/calendar-reminders.js`**

Delete lines 25–99 of `api/calendar-reminders.js` — the whole block from the `// How far apart two cron ticks are.` comment through the closing brace of `needsImmediateReminder`. That removes `CRON_PERIOD_HOURS`, `leadHours`, `reminderWindow`, `wouldRemind` and `needsImmediateReminder` from this file.

In their place, add a single require beneath the existing requires (after `const cslack = require('./_checkin-slack');` on line 23):

```js
// Every piece of "when does a touch fire" arithmetic, in one pure module. The
// whole module object, not destructured, so a test's monkey-patch of one
// function is visible here at call time.
const touches = require('./_reminder-touches');
```

- [ ] **Step 6: Point the rest of the file at the new module**

Inside `handler`, replace `const listWindow = reminderWindow(now);` with:

```js
  const listWindow = touches.reminderWindow(now);
```

and replace `if (!wouldRemind(startMs, now)) { skipped++; continue; }` with:

```js
    if (!touches.touchDueAt('24h', startMs, now)) { skipped++; continue; }
```

(The `meta.reminderSent` check on the line above is left alone for now — Task 5 is what converts it to the three flags. This step is a pure move, and `touchDueAt('24h', ...)` is `wouldRemind` by construction, so the suite must stay green.)

Then replace the export block at the bottom of the file:

```js
module.exports = handler;
// The window/mootness arithmetic lives in api/_reminder-touches.js now, but the
// two proof files and four handlers require it from here. Re-exported rather
// than moved-and-left-dangling, so no call site had to change in the same
// commit that moved the code.
module.exports.CRON_PERIOD_HOURS = touches.CRON_PERIOD_HOURS;
module.exports.leadHours = touches.leadHours;
module.exports.reminderWindow = touches.reminderWindow;
module.exports.wouldRemind = touches.wouldRemind;
// NOT re-exported: needsImmediateReminder. It is deleted, not renamed -- its
// single-reminder meaning has no correct three-touch generalization, and an
// alias would let a call site keep compiling while meaning something else. Use
// touches.planTouches(startMs, nowMs) instead.
module.exports.planTouches = touches.planTouches;
// Temporary -- see bulkCancelAll's own comment. Exported so a test can
// exercise it directly.
module.exports.bulkCancelAll = bulkCancelAll;
```

- [ ] **Step 7: Run the new test to verify it passes**

Run: `node --test test/reminder-touches.test.js`
Expected: PASS, all tests.

- [ ] **Step 8: Run the two existing proof suites — they must still be green**

Run: `node --test test/calendar-reminders.test.js test/reminder-delivery-guarantee.test.js`
Expected: `test/calendar-reminders.test.js` PASSES unchanged. `test/reminder-delivery-guarantee.test.js` FAILS **only** on `remind.needsImmediateReminder is not a function`, in the tests that call it (it is rewritten in Task 7). Every other test in that file, including `cronPeriodHours()` and the `leadHours`/`wouldRemind` arithmetic, must pass. If anything else in either file fails, Step 5/6 moved more than it should have — fix that before continuing.

- [ ] **Step 9: Commit**

```bash
git add api/_reminder-touches.js api/_blob-store.js api/calendar-reminders.js test/reminder-touches.test.js
git commit -m "feat(reminders): extract three-touch arithmetic into _reminder-touches.js

Declares the 24h/2h/10m cadence, which cron path owns each touch, and the
moot/immediate/cron decision that replaces needsImmediateReminder. Adds the
checkin-cadence-state.json blob name. The 24h touch's due window is literally
wouldRemind, so the daily cron's behaviour is unchanged."
```

---

### Task 2: Monday-anchored week boundary helper

**Files:**
- Modify: `api/_timezone.js:83-86` (beside the existing `weekdayKeyFromYmd`) and `api/_timezone.js:106-109` (exports)
- Test: `test/timezone.test.js` (append)

**Interfaces:**
- Consumes: the existing `zoneDateParts`, `zonedWallTimeToUtc`, `parseYmd`, `formatYmd`, `weekdayKeyFromYmd`, `WEEKDAY_KEYS` from the same file.
- Produces:
  - `tz.weekdayKeyInZone(utcMs, timeZone) -> 'sun'|'mon'|'tue'|'wed'|'thu'|'fri'|'sat'`
  - `tz.mondayYmdFor(utcMs, timeZone) -> 'YYYY-MM-DD'` — the Monday of the Mon–Sun week containing that instant, as read in that zone
  - `tz.weekWindow(utcMs, timeZone) -> { mondayYmd: string, startMs: number, endMs: number }` — `startMs` is Monday 00:00 local, `endMs` is the FOLLOWING Monday 00:00 local; the window is half-open `[startMs, endMs)`

- [ ] **Step 1: Write the failing test**

Append to `test/timezone.test.js`:

```js
// ---------------------------------------------------------------------------
// Monday-anchored week boundaries. Genuinely new to this file: everything above
// is per-day slot math, and nothing here knew what a "week" was.
//
// Weeks are ALWAYS Monday-Sunday. The trap this helper exists to close is
// `new Date(ms).getDay()`, which is Sunday-first AND reads the SERVER's zone --
// two different bugs in one expression, and a cadence anchored on it would reset
// on the wrong day for half the world.
// ---------------------------------------------------------------------------

test('weekdayKeyInZone reads the weekday in the GIVEN zone, not the server zone', () => {
  // 2026-10-05T03:00Z is Monday 05 Oct in UTC and in Istanbul (+03), but still
  // Sunday 04 Oct at 23:00 in Toronto (-04).
  const ms = Date.parse('2026-10-05T03:00:00Z');
  assert.equal(tz.weekdayKeyInZone(ms, 'Europe/Istanbul'), 'mon');
  assert.equal(tz.weekdayKeyInZone(ms, 'America/Toronto'), 'sun');
});

test('mondayYmdFor anchors every day of a week on the same Monday', () => {
  // 2026-10-05 is a Monday. Walk Mon..Sun at local noon.
  const expected = '2026-10-05';
  for (let d = 5; d <= 11; d++) {
    const ms = tz.zonedWallTimeToUtc(2026, 10, d, 12, 0, 'America/Toronto');
    assert.equal(tz.mondayYmdFor(ms, 'America/Toronto'), expected,
      `2026-10-${d} should anchor on ${expected}`);
  }
  // And the next day rolls over to the next Monday, not before.
  const nextMon = tz.zonedWallTimeToUtc(2026, 10, 12, 12, 0, 'America/Toronto');
  assert.equal(tz.mondayYmdFor(nextMon, 'America/Toronto'), '2026-10-12');
});

// The getDay() bug, stated as an assertion: Sunday must anchor BACKWARD onto the
// Monday six days earlier, not forward onto the next one.
test('Sunday belongs to the week that STARTED six days earlier', () => {
  const sundayNoon = tz.zonedWallTimeToUtc(2026, 10, 11, 12, 0, 'America/Toronto');
  assert.equal(tz.weekdayKeyInZone(sundayNoon, 'America/Toronto'), 'sun');
  assert.equal(tz.mondayYmdFor(sundayNoon, 'America/Toronto'), '2026-10-05');
});

test('mondayYmdFor crosses month and year boundaries', () => {
  // 2026-11-01 is a Sunday -> anchors on Monday 2026-10-26.
  const nov1 = tz.zonedWallTimeToUtc(2026, 11, 1, 12, 0, 'America/Toronto');
  assert.equal(tz.mondayYmdFor(nov1, 'America/Toronto'), '2026-10-26');
  // 2027-01-01 is a Friday -> anchors on Monday 2026-12-28.
  const jan1 = tz.zonedWallTimeToUtc(2027, 1, 1, 12, 0, 'America/Toronto');
  assert.equal(tz.mondayYmdFor(jan1, 'America/Toronto'), '2026-12-28');
});

test('weekWindow is a half-open [Monday 00:00, next Monday 00:00) in the zone', () => {
  const wednesday = tz.zonedWallTimeToUtc(2026, 10, 7, 15, 0, 'America/Toronto');
  const w = tz.weekWindow(wednesday, 'America/Toronto');
  assert.equal(w.mondayYmd, '2026-10-05');
  assert.equal(new Date(w.startMs).toISOString(), '2026-10-05T04:00:00.000Z'); // EDT, -04
  assert.equal(new Date(w.endMs).toISOString(), '2026-10-12T04:00:00.000Z');
  assert.equal(w.endMs - w.startMs, 7 * 86400000);
  assert.ok(w.startMs <= wednesday && wednesday < w.endMs);
});

test('the window boundary is inclusive at the start and exclusive at the end', () => {
  const w = tz.weekWindow(tz.zonedWallTimeToUtc(2026, 10, 7, 15, 0, 'America/Toronto'),
    'America/Toronto');
  // The first instant of the week is IN it; the first instant of the next week
  // is not, and anchors on the next Monday instead.
  assert.equal(tz.mondayYmdFor(w.startMs, 'America/Toronto'), '2026-10-05');
  assert.equal(tz.mondayYmdFor(w.endMs, 'America/Toronto'), '2026-10-12');
});

// A DST transition inside the week shortens or lengthens it in wall-clock terms,
// and the window must still cover every instant in it -- no hour of the week may
// fall outside the window that is supposed to contain it.
test('a week containing a DST shift still covers every instant inside it', () => {
  // Toronto falls back on Sunday 2026-11-01.
  const zone = 'America/Toronto';
  const w = tz.weekWindow(tz.zonedWallTimeToUtc(2026, 10, 28, 12, 0, zone), zone);
  assert.equal(w.mondayYmd, '2026-10-26');
  assert.equal(w.endMs - w.startMs, 7 * 86400000 + 3600000, 'the fall-back week is 169h long');
  for (let d = 26; d <= 31; d++) {
    for (const h of [0, 1, 2, 3, 12, 23]) {
      const ms = tz.zonedWallTimeToUtc(2026, 10, d, h, 0, zone);
      assert.ok(ms >= w.startMs && ms < w.endMs, `2026-10-${d} ${h}:00 fell outside its own week`);
    }
  }
  for (const h of [0, 1, 2, 3, 12, 23]) {
    const ms = tz.zonedWallTimeToUtc(2026, 11, 1, h, 0, zone);
    assert.ok(ms >= w.startMs && ms < w.endMs, `2026-11-01 ${h}:00 fell outside its own week`);
  }
});

test('weeks tile without gap or overlap across a year, in several zones', () => {
  for (const zone of ['America/Toronto', 'Europe/Istanbul', 'Asia/Kathmandu', 'Australia/Lord_Howe']) {
    let cursor = tz.weekWindow(Date.UTC(2026, 0, 7, 12, 0, 0), zone);
    for (let i = 0; i < 52; i++) {
      const next = tz.weekWindow(cursor.endMs, zone);
      assert.equal(next.startMs, cursor.endMs,
        `${zone}: week ${i + 1} does not start where week ${i} ended`);
      assert.notEqual(next.mondayYmd, cursor.mondayYmd, `${zone}: the Monday did not advance`);
      assert.equal(tz.weekdayKeyInZone(next.startMs, zone), 'mon',
        `${zone}: a week boundary landed on a non-Monday`);
      cursor = next;
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/timezone.test.js`
Expected: FAIL — `tz.weekdayKeyInZone is not a function`.

- [ ] **Step 3: Add the three helpers**

In `api/_timezone.js`, immediately after `weekdayKeyFromYmd` (line 86), add:

```js
// The weekday of an INSTANT, as read in a particular zone. Two instants one hour
// apart can be different weekdays in one zone and the same in another, so the
// zone is not optional here the way it is for weekdayKeyFromYmd above.
function weekdayKeyInZone(utcMs, timeZone) {
  const p = zoneDateParts(utcMs, timeZone);
  return weekdayKeyFromYmd(p.year, p.month, p.day);
}

// The Monday that opens the Mon-Sun week containing this instant, in this zone,
// as "YYYY-MM-DD". This string is the key the cadence state is filed under, so
// it has to be stable for every instant in the week and change exactly once a
// week, at local midnight on Monday.
//
// Why not `new Date(ms).getDay()`: that is Sunday-first AND reads the SERVER's
// timezone. Both are wrong here. The zone-local calendar date is resolved first
// (zoneDateParts), and only then is a weekday taken from it -- via a UTC Date
// built from those Y/M/D numbers, where getUTCDay() is pure calendar arithmetic
// on a plain date and carries no zone of its own. That is the same trick
// weekdayKeyFromYmd already uses.
function mondayYmdFor(utcMs, timeZone) {
  const p = zoneDateParts(utcMs, timeZone);
  // getUTCDay(): 0=Sunday .. 6=Saturday. (dow + 6) % 7 maps Monday->0 and
  // Sunday->6, which is the number of days to step BACK to reach Monday. The
  // Sunday case is the one that matters: a Sunday belongs to the week that began
  // six days ago, never to the one starting tomorrow.
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const backDays = (dow + 6) % 7;
  // Date.UTC normalizes a negative or oversized day-of-month, so this crosses
  // month and year boundaries without any special casing.
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - backDays));
  return formatYmd(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

// The half-open instant range [Monday 00:00 local, next Monday 00:00 local) for
// the week containing utcMs, plus the Monday key itself.
//
// Both edges go through zonedWallTimeToUtc, so a week containing a DST
// transition is a real 167 or 169 hours long rather than a nominal 168 -- which
// is what makes "is this booking inside this week" correct for every instant in
// it, including the shifted hour.
//
// Edge case, deliberately not special-cased: in the rare zone where a
// spring-forward lands exactly at 00:00 on a Monday, local midnight does not
// exist and zonedWallTimeToUtc returns the instant the clock jumps to. The
// boundary moves by an hour and the weeks still tile without gap or overlap,
// which is all any caller needs.
function weekWindow(utcMs, timeZone) {
  const mondayYmd = mondayYmdFor(utcMs, timeZone);
  const { y, mo, d } = parseYmd(mondayYmd);
  const startMs = zonedWallTimeToUtc(y, mo, d, 0, 0, timeZone);
  const next = new Date(Date.UTC(y, mo - 1, d + 7));
  const endMs = zonedWallTimeToUtc(
    next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { mondayYmd, startMs, endMs };
}
```

- [ ] **Step 4: Export them**

Replace the export block at the bottom of `api/_timezone.js`:

```js
module.exports = {
  zoneOffsetMs, zonedWallTimeToUtc, zoneDateParts, wallTimeExistsInZone,
  parseYmd, formatYmd, weekdayKeyFromYmd, parseHm, isValidTimeZone, WEEKDAY_KEYS,
  weekdayKeyInZone, mondayYmdFor, weekWindow,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/timezone.test.js`
Expected: PASS, including the pre-existing slot-math tests.

- [ ] **Step 6: Commit**

```bash
git add api/_timezone.js test/timezone.test.js
git commit -m "feat(timezone): add Monday-anchored week boundary helpers

weekdayKeyInZone/mondayYmdFor/weekWindow, computed against a given zone rather
than the server's, so the check-in nudge cycle resets on local Monday midnight.
Weeks containing a DST shift are a real 167/169h and still tile exactly."
```

---

### Task 3: The "starting soon" 10-minute copy

**Files:**
- Modify: `api/_email.js:194-213` (after `sendReminder`) and `api/_email.js:215-222` (exports)
- Modify: `api/_checkin-email.js:67-79` (after `sendCheckinReminder`) and `api/_checkin-email.js:81-84` (exports)
- Test: `test/email.test.js` (append), `test/checkin-email.test.js` (append)

**Interfaces:**
- Consumes: `shell`, `headline`, `detailsBox`, `ctaButton`, `footerLine`, `joinRow`, `send`, `formatWhen`, `escapeHtml` — all already exported by `api/_email.js`.
- Produces:
  - `email.sendStartingSoon(b) -> Promise<{ok:true} | {ok:false, reason:string}>` — bilingual, branches on `b.lang === 'ar'`
  - `cemail.sendCheckinStartingSoon(b) -> Promise<{ok:true} | {ok:false, reason:string}>` — English only
  - Both take the same **Booking** object every other sender takes, with all eleven fields always present: `{ eventId, name, email, phone, startMs, endMs, visitorTimeZone, templateTimeZone, manageToken, meetLink, lang }`.

**This is a copy task, not a design task.** The visual pass is finished. Every byte of markup below comes from the shared helpers; there is no new inline style, no new colour, and no new structural element. If a step tempts you to write a `<div style="...">` that is not copied from an existing sender's body paragraph, you are doing the wrong task.

- [ ] **Step 1: Write the failing test for the applicant template**

Append to `test/email.test.js`:

```js
// ---------------------------------------------------------------------------
// The 10-minute "starting soon" touch. The third and most urgent of the three
// cascading pre-call touches: the 24h and 2h touches both reuse sendReminder's
// existing copy, so this is the only genuinely new applicant template.
// ---------------------------------------------------------------------------

async function withSendStub(fn) {
  const calls = [];
  const orig = email.send;
  email.send = async (...args) => { calls.push(args); return { ok: true }; };
  try { await fn(calls); } finally { email.send = orig; }
}

test('sendStartingSoon is exported and resolves (never rejects) on a NaN start', async () => {
  delete process.env.RESEND_API_KEY;
  assert.equal(typeof email.sendStartingSoon, 'function');
  const result = await email.sendStartingSoon({
    eventId: 'evt-1', name: 'Test Visitor', email: 'visitor@example.com', phone: '555-0100',
    startMs: NaN, endMs: NaN, visitorTimeZone: 'America/Toronto',
    templateTimeZone: 'Asia/Riyadh', manageToken: 'tok',
    meetLink: 'https://meet.google.com/abc-defg-hij', lang: 'en',
  });
  assert.equal(result.ok, false);
});

test('the English starting-soon copy is urgent, distinct from the 24h reminder, and keeps the shell', async () => {
  const startMs = Date.parse('2026-10-06T19:00:00Z');
  const b = {
    eventId: 'evt-1', name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100',
    startMs, endMs: startMs + 1800000, visitorTimeZone: 'America/Toronto',
    templateTimeZone: 'America/Toronto', manageToken: 'tok',
    meetLink: 'https://meet.example/abc', lang: 'en',
  };
  await withSendStub(async (calls) => {
    await email.sendStartingSoon(b);
    const soon = calls[0][0];
    calls.length = 0;
    await email.sendReminder(b);
    const reminder = calls[0][0];

    assert.equal(soon.to, 'jane@example.com');
    assert.match(soon.subject, /10 minutes/);
    assert.notEqual(soon.subject, reminder.subject,
      'the 10-minute touch must not reuse the 24h subject -- they arrive the same day');
    assert.notEqual(soon.html, reminder.html, 'and must not reuse its body either');
    assert.match(soon.html, /10 MINUTES/, 'the urgency has to be in the headline, not just the subject');
    // Shared shell, not a second one.
    assert.match(soon.html, /3AMAK TRADES/);
    assert.match(soon.html, /wa\.me\/14382259193/);
    assert.match(soon.html, /dir="ltr"/);
    assert.match(soon.html, /JOIN THE CALL/, 'the join CTA is the whole point of this touch');
    assert.ok(soon.html.includes(email.formatWhen(startMs, 'America/Toronto', 'en')));
    assert.equal(/PLACEHOLDER/.test(soon.subject + soon.html), false);
  });
});

test('the Arabic starting-soon copy is real RTL copy, not the English body in an rtl wrapper', async () => {
  const startMs = Date.parse('2026-10-06T19:00:00Z');
  const ARABIC = /[؀-ۿ]/;
  await withSendStub(async (calls) => {
    await email.sendStartingSoon({
      eventId: 'evt-1', name: 'Sara', email: 'sara@example.com', phone: '555-0100',
      startMs, endMs: startMs + 1800000, visitorTimeZone: 'Asia/Riyadh',
      templateTimeZone: 'America/Toronto', manageToken: 'tok',
      meetLink: 'https://meet.example/abc', lang: 'ar',
    });
    const { subject, html } = calls[0][0];
    assert.match(subject, ARABIC, 'the Arabic subject must actually be in Arabic');
    assert.match(html, /dir="rtl"/);
    assert.match(html, /lang="ar"/);
    assert.equal(/JOIN THE CALL/.test(html), false, 'the CTA must be translated, not left in English');
    assert.match(html, ARABIC);
    // The brand stays in Latin script inside Arabic, the same way every other
    // Arabic template and the site's own Arabic footer do.
    assert.match(html, /3AMAK TRADES/);
    assert.equal(/PLACEHOLDER/.test(subject + html), false);
  });
});

test('starting-soon drops the join row and CTA when there is no Meet link, in both languages', async () => {
  const startMs = Date.parse('2026-10-06T19:00:00Z');
  for (const lang of ['en', 'ar']) {
    await withSendStub(async (calls) => {
      await email.sendStartingSoon({
        eventId: 'evt-1', name: 'Jane', email: 'jane@example.com', phone: '',
        startMs, endMs: startMs + 1800000, visitorTimeZone: 'America/Toronto',
        templateTimeZone: 'America/Toronto', manageToken: 'tok', meetLink: '', lang,
      });
      const { html } = calls[0][0];
      assert.equal(/meet\.example/.test(html), false);
      // joinRow() returns [] and ctaButton() returns '' for a missing link, so
      // the body must have no anchor other than the WhatsApp footer one.
      const anchors = html.match(/<a\s/g) || [];
      assert.equal(anchors.length, 1, `${lang}: only the WhatsApp footer link should remain`);
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/email.test.js`
Expected: FAIL — `email.sendStartingSoon is not a function`.

- [ ] **Step 3: Add `sendStartingSoon` to `api/_email.js`**

Insert immediately after `sendReminder` (after line 213), before the `module.exports` block:

```js
// The third and last pre-call touch: ~10 minutes out. Deliberately a different
// template from sendReminder rather than the same copy sent again -- the 24h and
// 2h touches already use sendReminder, so on a well-noticed booking a reader
// gets that body twice in one day, and a third identical copy ten minutes before
// the call would read as a mail loop rather than as urgency.
//
// Shorter than every other template on purpose. There is nothing to decide at
// this point and no time to read: the only useful content is "now" and the join
// button. Same shell, same helpers, no new styling.
async function sendStartingSoon(b) {
  const ar = b.lang === 'ar';
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = ar ? 'مكالمتك بتبدا بعد ١٠ دقايق ⏳' : 'Your call starts in 10 minutes';
  const html = shell(ar ? `
    ${headline('مكالمتك بتبدا<br>بعد ١٠ دقايق', 'ar')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">أهلاً ${name}، إحنا جاهزين. جهّز حالك وادخل من الرابط.</p>
    ${detailsBox([{ label: 'الموعد', value: when }, ...joinRow(b.meetLink, 'ar')], 'ar')}
    ${ctaButton(b.meetLink, 'انضم هلق')}
    ${footerLine('صار في شي؟', 'راسلنا عالواتساب')}
  ` : `
    ${headline('STARTING IN<br>10 MINUTES', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, we're ready for you. Jump in when you are.</p>
    ${detailsBox([{ label: 'WHEN', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine('Something came up?', 'Message us on WhatsApp')}
  `, b.lang);
  return send({ to: b.email, subject, html });
}
```

Then replace the export block at the bottom of `api/_email.js`:

```js
module.exports = {
  sendBookingConfirmation, sendRescheduleNotice, sendCancellationNotice,
  sendReminder, sendStartingSoon, formatWhen, escapeHtml,
  // Exported for api/_checkin-email.js, which is English-only (check-in.html
  // is explicitly "English-only and dir=ltr", unlike the bilingual apply
  // flow) but reuses the same visual shell rather than a second copy of it.
  send, shell, headline, detailsBox, ctaButton, footerLine, joinRow,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/email.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the check-in template**

Append to `test/checkin-email.test.js`:

```js
// ---------------------------------------------------------------------------
// The check-in audience's own 10-minute touch. English only, same as every
// other template in this file.
// ---------------------------------------------------------------------------

test('sendCheckinStartingSoon is exported and goes through the shared send', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    assert.equal(typeof mod.sendCheckinStartingSoon, 'function');
    const r = await mod.sendCheckinStartingSoon(booking());
    assert.equal(r.ok, true);
    assert.equal(sendSpy.calls.length, 1);
    assert.equal(sendSpy.calls[0][0].to, 'alice@example.com');
  });
  delete require.cache[cePath];
});

test('the check-in starting-soon copy is urgent, English-only, and distinct from the check-in reminder', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    await mod.sendCheckinStartingSoon(booking());
    await mod.sendCheckinReminder(booking());
    const soon = sendSpy.calls[0][0];
    const reminder = sendSpy.calls[1][0];

    assert.match(soon.subject, /10 minutes/);
    assert.match(soon.html, /10 MINUTES/);
    assert.match(soon.html, /check-in/i, 'it must say check-in, not "call" -- a different audience');
    assert.notEqual(soon.subject, reminder.subject);
    assert.notEqual(soon.html, reminder.html);
    assert.match(soon.html, /3AMAK TRADES/);
    assert.match(soon.html, /wa\.me\/14382259193/);
    assert.match(soon.html, /dir="ltr"/);
    assert.equal(/dir="rtl"/.test(soon.html), false, 'the check-in audience has no Arabic branch');
    assert.equal(/PLACEHOLDER/.test(soon.subject + soon.html), false);
    assert.ok(soon.html.includes(baseEmail.formatWhen(START_MS, 'Europe/Istanbul', 'en')),
      'the time must render in the CLIENT timezone, like every other template here');
  });
  delete require.cache[cePath];
});
```

Then extend the existing `SENDERS` array at the top of the file (line 52) so every shared contract test — exported, addresses the client, no placeholder copy, carries the wordmark and WhatsApp footer — covers the new sender too:

```js
const SENDERS = [
  'sendCheckinConfirmation',
  'sendCheckinRescheduleNotice',
  'sendCheckinCancellationNotice',
  'sendCheckinReminder',
  'sendCheckinStartingSoon',
];
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test test/checkin-email.test.js`
Expected: FAIL — `sendCheckinStartingSoon must be exported`.

- [ ] **Step 7: Add `sendCheckinStartingSoon` to `api/_checkin-email.js`**

Insert immediately after `sendCheckinReminder` (after line 79):

```js
// The check-in audience's ~10-minutes-out touch. Mirrors _email.js's
// sendStartingSoon in shape and brevity, and says "check-in" rather than "call"
// for the same reason every template in this file does: a client who has both a
// check-in and (later) something else on the calendar must be able to tell which
// one is about to start from the subject line alone.
async function sendCheckinStartingSoon(b) {
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, 'en'))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = 'Your check-in starts in 10 minutes';
  const html = shell(`
    ${headline('CHECK-IN STARTS<br>IN 10 MINUTES', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, we're ready for you. Jump in when you are.</p>
    ${detailsBox([{ label: 'WHEN', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine('Something came up?', 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: b.email, subject, html });
}
```

Then replace the export block at the bottom of `api/_checkin-email.js`:

```js
module.exports = {
  sendCheckinConfirmation, sendCheckinRescheduleNotice,
  sendCheckinCancellationNotice, sendCheckinReminder, sendCheckinStartingSoon,
};
```

- [ ] **Step 8: Run both email suites to verify they pass**

Run: `node --test test/email.test.js test/checkin-email.test.js`
Expected: PASS. In particular the pre-existing `neither email source file carries placeholder markers any more` test must still pass — the new copy is final, not placeholder.

- [ ] **Step 9: Commit**

```bash
git add api/_email.js api/_checkin-email.js test/email.test.js test/checkin-email.test.js
git commit -m "feat(email): add the 10-minute starting-soon templates

sendStartingSoon (bilingual EN/AR) and sendCheckinStartingSoon (EN only), built
from the existing Minimal Ticket helpers. The 24h and 2h touches keep reusing
the existing reminder copy; only the 10-minute touch needed new wording."
```

---

### Task 4: The weekly check-in nudge copy

**Files:**
- Modify: `api/_checkin-email.js` (after `sendCheckinStartingSoon`) and its export block
- Test: `test/checkin-nudge-email.test.js`

**Interfaces:**
- Consumes: the same `_email.js` helpers as Task 3, plus `baseUrl()` from `api/_site-url.js` (already required at the top of `_checkin-email.js`).
- Produces:
  - `cemail.NUDGE_TIERS` — frozen `['neutral','direct','urgent','lastcall']`, in escalation order
  - `cemail.sendCheckinNudge(n, tier) -> Promise<{ok:true} | {ok:false, reason:string}>`
  - `cemail.sendCheckinAllSet(n) -> Promise<{ok:true} | {ok:false, reason:string}>`
  - Both take a **Nudge recipient** object, a different and much smaller shape than the Booking object: `{ name: string, email: string }`. There is no `meetLink` and no `manageToken`, because a nudge is about a call that does **not** exist yet. `sendCheckinAllSet` additionally reads OPTIONAL `startMs` (number) and `visitorTimeZone` (string) so the reassurance can name the booked time when it is known.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-nudge-email.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const baseEmail = require('../api/_email');

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try { return await fn(); } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

// _checkin-email.js destructures from _email at require-time, so the module
// must be re-required AFTER the stub is installed.
const cePath = require.resolve('../api/_checkin-email');
function freshCe() {
  delete require.cache[cePath];
  return require(cePath);
}

const RECIPIENT = { name: 'Alice Client', email: 'alice@example.com' };

test('the four escalation tiers are exported in escalation order', () => {
  const ce = require('../api/_checkin-email');
  assert.deepEqual(ce.NUDGE_TIERS, ['neutral', 'direct', 'urgent', 'lastcall']);
});

test('every tier sends to the client and carries a real subject and body', async () => {
  const ce = require('../api/_checkin-email');
  for (const tier of ce.NUDGE_TIERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      const r = await mod.sendCheckinNudge(RECIPIENT, tier);
      assert.equal(r.ok, true, `${tier} should resolve ok`);
      assert.equal(sendSpy.calls.length, 1, `${tier} should call send exactly once`);
      const { to, subject, html } = sendSpy.calls[0][0];
      assert.equal(to, 'alice@example.com');
      assert.ok(subject.length > 0, `${tier} needs a subject`);
      assert.ok(html.length > 0, `${tier} needs a body`);
      assert.equal(/PLACEHOLDER/.test(subject + html), false, `${tier} must not be placeholder`);
      assert.match(html, /3AMAK TRADES/, `${tier} must use the shared shell wordmark`);
      assert.match(html, /wa\.me\/14382259193/, `${tier} must carry the WhatsApp footer link`);
      assert.match(html, /dir="ltr"/, `${tier} is English-only`);
    });
    delete require.cache[cePath];
  }
});

// The whole point of four tiers is that they are four DIFFERENT emails. A client
// who ignores Tuesday must not receive the identical text on Thursday.
test('no two tiers share a subject or a body', async () => {
  const ce = require('../api/_checkin-email');
  const seen = [];
  for (const tier of ce.NUDGE_TIERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod.sendCheckinNudge(RECIPIENT, tier);
      seen.push({ tier, ...sendSpy.calls[0][0] });
    });
    delete require.cache[cePath];
  }
  assert.equal(new Set(seen.map(s => s.subject)).size, 4, 'four distinct subjects required');
  assert.equal(new Set(seen.map(s => s.html)).size, 4, 'four distinct bodies required');
});

test('every tier links to /check-in so the ask is actionable', async () => {
  const ce = require('../api/_checkin-email');
  for (const tier of ce.NUDGE_TIERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod.sendCheckinNudge(RECIPIENT, tier);
      assert.match(sendSpy.calls[0][0].html, /\/check-in/, `${tier} must link to /check-in`);
    });
    delete require.cache[cePath];
  }
});

// The spec is explicit: "No skip/opt-out link. The ask always stands."
test('NO tier offers a skip, opt-out, unsubscribe or snooze', async () => {
  const ce = require('../api/_checkin-email');
  for (const tier of ce.NUDGE_TIERS) {
    const sendSpy = spyStub({ ok: true });
    await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
      const mod = freshCe();
      await mod.sendCheckinNudge(RECIPIENT, tier);
      const { subject, html } = sendSpy.calls[0][0];
      assert.equal(/unsubscribe|opt.?out|\bskip\b|snooze|stop these/i.test(subject + html), false,
        `${tier} must not offer a way out -- the spec says the ask always stands`);
    });
    delete require.cache[cePath];
  }
});

test('an unknown tier resolves {ok:false} and sends nothing, rather than throwing', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    const r = await mod.sendCheckinNudge(RECIPIENT, 'nonsense');
    assert.equal(r.ok, false);
    assert.match(r.reason, /tier/i);
    assert.equal(sendSpy.calls.length, 0, 'a bad tier must not send a half-built email');
  });
  delete require.cache[cePath];
});

// A booked client gets a light "you're all set", NOT silence. Branching on
// done-status rather than on silence is the spec's own wording.
test('the all-set reassurance names the booked time when known and asks for nothing', async () => {
  const startMs = Date.UTC(2026, 9, 8, 14, 0, 0);
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    const r = await mod.sendCheckinAllSet({
      ...RECIPIENT, startMs, visitorTimeZone: 'Europe/Istanbul',
    });
    assert.equal(r.ok, true);
    const { to, subject, html } = sendSpy.calls[0][0];
    assert.equal(to, 'alice@example.com');
    assert.match(subject, /all set/i);
    assert.ok(html.includes(baseEmail.formatWhen(startMs, 'Europe/Istanbul', 'en')),
      'the booked time should render in the client timezone when we have it');
    assert.match(html, /3AMAK TRADES/);
    assert.match(html, /wa\.me\/14382259193/);
    assert.equal(/PLACEHOLDER/.test(subject + html), false);
    // No ask, so no booking CTA -- only the WhatsApp footer anchor.
    assert.equal((html.match(/<a\s/g) || []).length, 1,
      'the reassurance must not carry a book-now button; there is nothing to do');
  });
  delete require.cache[cePath];
});

test('the all-set reassurance still works with no known start time', async () => {
  const sendSpy = spyStub({ ok: true });
  await withStubs([{ obj: baseEmail, key: 'send', value: sendSpy }], async () => {
    const mod = freshCe();
    const r = await mod.sendCheckinAllSet(RECIPIENT);
    assert.equal(r.ok, true);
    const { subject, html } = sendSpy.calls[0][0];
    assert.match(subject, /all set/i);
    assert.ok(html.length > 0);
    assert.equal(/NaN|Invalid Date|undefined/.test(html), false,
      'a missing startMs must not leak a formatting artifact into the body');
  });
  delete require.cache[cePath];
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/checkin-nudge-email.test.js`
Expected: FAIL — `ce.NUDGE_TIERS` is `undefined`, so the first `assert.deepEqual` fails.

- [ ] **Step 3: Add the nudge senders to `api/_checkin-email.js`**

Insert immediately after `sendCheckinStartingSoon`:

```js
// ---- the weekly "book your next check-in" cycle --------------------------
//
// A DIFFERENT KIND OF EMAIL from everything above. The five senders above are
// transactional: something happened to a booking that exists. These two are
// about a booking that does NOT exist yet, so they take a far smaller object --
// { name, email } -- and none of the Booking fields (meetLink, manageToken,
// templateTimeZone) apply. sendCheckinAllSet is the one exception and reads an
// OPTIONAL startMs/visitorTimeZone, because by definition it goes to someone
// who did book.
//
// Escalation order, and it is an order: a client who has not booked gets ONE of
// these per week, picked by the day, and a tier is never resent. Four distinct
// texts rather than one text sent four times -- the same message arriving again
// reads as a broken mailer, which is the opposite of escalation.
//
// NO OPT-OUT, deliberately and per spec: these go to people on a manually
// maintained roster of mentorship clients with an active, non-paused package,
// for whom booking a check-in is the thing they are paying for. The ask always
// stands. Do not add an unsubscribe link "for compliance" -- this is a
// transactional obligation reminder, not marketing, and the admin pauses or
// removes a client in /admin when the obligation ends.
const NUDGE_TIERS = Object.freeze(['neutral', 'direct', 'urgent', 'lastcall']);

// Per-tier copy as DATA rather than four near-identical functions, so the thing
// a reviewer actually has to check -- that the four texts really are four
// different texts, and that they escalate -- is readable in one screen.
const NUDGE_COPY = {
  neutral: {
    subject: "Time to book this week's check-in",
    heading: "BOOK THIS<br>WEEK'S CHECK-IN",
    body: "this week's check-in slot is open. Pick a time that works and we'll go through where you're at.",
    cta: 'BOOK MY CHECK-IN',
    footer: 'Need a hand?',
  },
  direct: {
    subject: "Your check-in isn't booked yet",
    heading: 'STILL NOT<br>BOOKED',
    body: "you haven't picked a time for this week's check-in yet. It takes about thirty seconds -- grab a slot while there are still good ones left.",
    cta: 'PICK A TIME',
    footer: 'Something in the way?',
  },
  urgent: {
    subject: 'Only a couple of days left to check in',
    heading: 'THE WEEK IS<br>NEARLY OVER',
    body: "there are only a couple of days left in the week and your check-in still isn't on the calendar. Don't let this one slide -- the whole point is that we catch things early.",
    cta: 'BOOK BEFORE SUNDAY',
    footer: "Can't find a slot that fits?",
  },
  lastcall: {
    subject: "Last call -- this week's check-in closes tonight",
    heading: 'LAST CALL<br>FOR THIS WEEK',
    body: 'this is the last day of the week. Book now and you still get your check-in; after tonight the cycle resets and this week is simply gone.',
    cta: 'BOOK TODAY',
    footer: 'Stuck?',
  },
};

async function sendCheckinNudge(n, tier) {
  const copy = NUDGE_COPY[tier];
  // Resolved BEFORE anything is built, so an unknown tier can never produce a
  // half-rendered email addressed to a real client.
  if (!copy) return { ok: false, reason: `unknown nudge tier: ${String(tier)}` };
  const name = escapeHtml((n && n.name) || 'there');
  const checkinUrl = `${baseUrl()}/check-in`;
  const html = shell(`
    ${headline(copy.heading, 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, ${copy.body}</p>
    ${ctaButton(checkinUrl, copy.cta)}
    ${footerLine(copy.footer, 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: n && n.email, subject: copy.subject, html });
}

// The booked branch of the weekly pass. A client who already booked gets this
// ONCE for the week instead of nothing: silence is indistinguishable from a
// broken cron, and "you're all set" is the one-line acknowledgement that proves
// the system saw them.
//
// No CTA at all -- there is nothing to do, and a button here would undo the
// whole point of branching on done-status rather than on silence. startMs and
// visitorTimeZone are OPTIONAL because the pass reads them off the found
// calendar event, which can carry a malformed start; a missing time degrades to
// the generic sentence rather than printing "Invalid Date" at a paying client.
async function sendCheckinAllSet(n) {
  const name = escapeHtml((n && n.name) || 'there');
  const startMs = n && n.startMs;
  const zone = (n && n.visitorTimeZone) || 'UTC';
  const rendered = Number.isFinite(startMs) ? formatWhen(startMs, zone, 'en') : '';
  const rows = rendered
    ? [{ label: 'YOUR CHECK-IN', value: `${escapeHtml(rendered)} (${escapeHtml(zone)})` }]
    : [];
  const line = rendered
    ? "you're all set for this week -- your check-in is on the calendar."
    : "you're all set for this week -- your check-in is booked.";
  const html = shell(`
    ${headline("YOU'RE ALL SET<br>THIS WEEK", 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, ${line}</p>
    ${detailsBox(rows, 'en')}
    ${footerLine('Need to move it?', 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: n && n.email, subject: "You're all set for this week", html });
}
```

Then replace the export block at the bottom of `api/_checkin-email.js`:

```js
module.exports = {
  sendCheckinConfirmation, sendCheckinRescheduleNotice,
  sendCheckinCancellationNotice, sendCheckinReminder, sendCheckinStartingSoon,
  NUDGE_TIERS, sendCheckinNudge, sendCheckinAllSet,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/checkin-nudge-email.test.js`
Expected: PASS.

- [ ] **Step 5: Run the existing check-in email suite — the transactional senders must be untouched**

Run: `node --test test/checkin-email.test.js`
Expected: PASS. Its `SENDERS` list must still hold only the five transactional senders and must NOT have grown to include the two nudge senders — those take a different object shape and would fail the Booking-shaped contract tests for the wrong reason.

- [ ] **Step 6: Commit**

```bash
git add api/_checkin-email.js test/checkin-nudge-email.test.js
git commit -m "feat(email): add the weekly check-in nudge and all-set templates

Four escalating nudge tiers (neutral/direct/urgent/lastcall) plus the booked
branch's one-time reassurance, built from the existing Minimal Ticket helpers.
No opt-out link, per spec: the ask always stands."
```

---

### Task 5: The daily cron sends the 24h touch on its own flag

**Files:**
- Modify: `api/calendar-reminders.js` — the `handler` body (the per-event loop) and the new helpers above it
- Test: `test/calendar-reminders.test.js` (modify the existing flag-named tests, append new ones)

**Interfaces:**
- Consumes: `touches.TOUCHES`, `touches.touchesForPath`, `touches.PATH_DAILY`, `touches.PATH_FINE`, `touches.touchDueAt`, `touches.reminderWindow` (Task 1); `email.sendReminder`, `email.sendStartingSoon` (Task 3); `cemail.sendCheckinReminder`, `cemail.sendCheckinStartingSoon` (Task 3); the existing `gcal.listEvents`/`patchEvent`/`meetLinkFor`, `loadTemplate`, `loadCheckinTemplate`, `isCheckinEvent`, `makeBookingToken`, `slack.postSystemAlert`.
- Produces (both consumed by Task 6, Task 9 and Task 11):
  - `module.exports.runTouchPass(path, nowMs) -> Promise<{ ok: true, considered: number, sent: number, skipped: number, failures: number, touches: {'24h':number,'2h':number,'10m':number} } | { ok: false, status: number, error: string, message: string }>` — lists this path's window once, loads both templates once, and evaluates every touch the path owns for every event.
  - `module.exports.SENDER_FOR_TOUCH` — `{ '24h': {applicant:'sendReminder', checkin:'sendCheckinReminder'}, '2h': {applicant:'sendReminder', checkin:'sendCheckinReminder'}, '10m': {applicant:'sendStartingSoon', checkin:'sendCheckinStartingSoon'} }` (sender NAMES, looked up on the live module at call time so a test's monkey-patch is seen)
  - The HTTP response body gains a `touches` object alongthe existing `considered`/`sent`/`skipped`, which keep their meanings.

- [ ] **Step 1: Rename the flag in the existing tests so they describe the new world**

In `test/calendar-reminders.test.js`, change the `makeEvent` helper (lines 71–89) and `makeCheckinEvent` (line 694) to take `reminder24hSent` instead of `reminderSent`:

```js
function makeEvent({ id, startMs, endMs, visitorEmail = EMAIL, reminder24hSent, extra = {} }) {
  const priv = {
    bookingSource: guard.EVENT_MARKER,
    visitorName: 'Jane Doe',
    visitorPhone: '555-0100',
    visitorTimeZone: 'America/Toronto',
    lang: 'en',
    ...extra,
  };
  if (visitorEmail !== undefined && visitorEmail !== null) priv.visitorEmail = visitorEmail;
  if (reminder24hSent !== undefined) priv.reminder24hSent = reminder24hSent;
  return {
    id,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs || (startMs + 30 * 60000)).toISOString() },
    hangoutLink: 'https://meet.example/abc',
    extendedProperties: { private: priv },
  };
}
```

```js
function makeCheckinEvent({ id, startMs, endMs, visitorEmail = EMAIL, reminder24hSent }) {
  return makeEvent({ id, startMs, endMs, visitorEmail, reminder24hSent,
    extra: { audience: 'checkin' } });
}
```

Then, in every existing test, replace the identifier `reminderSent` with `reminder24hSent` — the call sites are at lines 228, 230, 279, 295, 314, 831 and 844, and each is either a `makeEvent({... reminderSent: '1' })` argument or an assertion reading `patch.extendedProperties.private.reminderSent`. Rename the test TITLES to match (`'an event with reminder24hSent === "1" is skipped...'`, `'ORDERING: a successful sendReminder results in patchEvent being called setting reminder24hSent to "1"'`, `'a successful check-in reminder sets reminder24hSent AFTER the send, never before'`). Nothing else in those tests changes: the daily cron's window, ordering and failure handling are all deliberately unchanged.

- [ ] **Step 2: Append the new behaviour tests**

Append to `test/calendar-reminders.test.js`:

```js
// ===========================================================================
// THREE TOUCHES, ONE FLAG EACH. The daily cron owns exactly the 24h touch and
// must not fire the other two -- they belong to the external 5-minute poller
// (?touch=fine, Task 6). The failure mode this guards is the obvious one: a
// daily run that sends all three touches at once, so a visitor gets "coming
// up", "coming up" and "starting in 10 minutes" in the same minute, a day
// before the call.
// ===========================================================================

test('the daily pass fires ONLY the 24h touch, and stamps only its flag', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const soonSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true });
  // 90 minutes out: inside the 24h window, and also past both fine nominal
  // moments -- so a path that ignored `path` ownership would send all three.
  const event = makeEvent({ id: 'evt-one-touch', startMs: futureMs(1.5) });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: email, key: 'sendStartingSoon', value: soonSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(reminderSpy.calls.length, 1, 'the 24h touch should have fired');
    assert.equal(soonSpy.calls.length, 0, 'the 10m touch belongs to the fine path, not this one');
    assert.deepEqual(res._json.touches, { '24h': 1, '2h': 0, '10m': 0 });
    const flags = patchSpy.calls.map(c => c[1].extendedProperties.private);
    assert.deepEqual(flags, [{ reminder24hSent: '1' }],
      'exactly one flag, and not the retired reminderSent');
  });
});

test('a "moot" 24h flag is skipped as silently as a sent one -- no email, no alert', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const alertSpy = spyStub(undefined);
  const event = makeEvent({ id: 'evt-moot', startMs: futureMs(2), reminder24hSent: 'moot' });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [event] }) },
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: slack, key: 'postSystemAlert', value: alertSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(reminderSpy.calls.length, 0);
    assert.equal(alertSpy.calls.length, 0,
      'a moot touch is not a failure -- alerting on it would train the owner to ignore #7');
    assert.equal(res._json.skipped, 1);
    assert.deepEqual(res._json.touches, { '24h': 0, '2h': 0, '10m': 0 });
  });
});

test('the retired reminderSent flag no longer suppresses anything', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  // An event written by the OLD code. There is no migration: the flag is dead,
  // and the worst case is one duplicate reminder to a handful of bookings that
  // were in flight at deploy time -- which is the trade this codebase has
  // always made (see calendar-reminders.js's own header comment).
  const legacy = makeEvent({ id: 'evt-legacy', startMs: futureMs(2), extra: { reminderSent: '1' } });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [legacy] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true }) },
    { obj: email, key: 'sendReminder', value: reminderSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(reminderSpy.calls.length, 1);
    assert.deepEqual(res._json.touches, { '24h': 1, '2h': 0, '10m': 0 });
  });
});

test('runTouchPass is exported and reports per-touch counts a caller can log', async () => {
  envSetup();
  assert.equal(typeof handler.runTouchPass, 'function');
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const result = await handler.runTouchPass(handler.PATH_DAILY || 'daily', Date.now());
    assert.equal(result.ok, true);
    assert.equal(result.considered, 0);
    assert.equal(result.sent, 0);
    assert.equal(result.failures, 0);
    assert.deepEqual(result.touches, { '24h': 0, '2h': 0, '10m': 0 });
  });
});

test('the daily pass still lists exactly the existing [now, now+lead] window', async () => {
  envSetup();
  process.env.REMINDER_LEAD_HOURS = '36';
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const before = Date.now();
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    const arg = listSpy.calls[0][0];
    const minMs = Date.parse(arg.timeMinIso);
    const maxMs = Date.parse(arg.timeMaxIso);
    assert.ok(Math.abs(minMs - before) < 5000, 'timeMin is still "now"');
    assert.ok(Math.abs((maxMs - minMs) - 36 * 3600000) < 5000, 'timeMax is still now+lead');
    assert.equal(arg.privateExtendedProperty, `bookingSource=${guard.EVENT_MARKER}`);
  });
  delete process.env.REMINDER_LEAD_HOURS;
});

test('one event that throws does not sink the rest of the batch', async () => {
  envSetup();
  const alertSpy = spyStub(undefined);
  const good = makeEvent({ id: 'evt-good', startMs: futureMs(3) });
  const bad = makeEvent({ id: 'evt-bad', startMs: futureMs(4) });
  const sendSpy = async (b) => {
    if (b.eventId === 'evt-bad') throw new Error('resend exploded');
    return { ok: true };
  };
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [bad, good] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true }) },
    { obj: email, key: 'sendReminder', value: sendSpy },
    { obj: slack, key: 'postSystemAlert', value: alertSpy },
  ], async () => {
    const res = makeRes();
    await handler(reqGet(SECRET), res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._json.touches, { '24h': 1, '2h': 0, '10m': 0 });
    assert.equal(res._json.failures, 1);
    assert.equal(alertSpy.calls.length, 1, 'a real failure DOES alert -- unlike a moot touch');
    assert.match(alertSpy.calls[0][0], /evt-bad/);
    assert.match(alertSpy.calls[0][0], /24h/, 'the alert must name WHICH touch failed');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/calendar-reminders.test.js`
Expected: FAIL — the renamed existing tests fail because the handler still writes `reminderSent`, and the new tests fail on `res._json.touches` being `undefined` and `handler.runTouchPass` not being a function.

- [ ] **Step 4: Add the sender map and the pass**

In `api/calendar-reminders.js`, insert this block immediately after the `const touches = require('./_reminder-touches');` line added in Task 1:

```js
// Which sender each touch uses, per audience, BY NAME. Names rather than
// function references for two reasons: a reference captured here freezes
// whatever the property held at require() time, which defeats the withStubs
// monkey-patching every test in this repo relies on; and reading the live export
// at call time is already the convention three requires above this one follow.
//
// The 24h and 2h touches share the existing reminder copy deliberately -- the
// spec only called for ONE new template, and "your call is coming up" is
// accurate at both distances. Only the 10-minute touch gets its own words.
const SENDER_FOR_TOUCH = {
  '24h': { applicant: 'sendReminder', checkin: 'sendCheckinReminder' },
  '2h': { applicant: 'sendReminder', checkin: 'sendCheckinReminder' },
  '10m': { applicant: 'sendStartingSoon', checkin: 'sendCheckinStartingSoon' },
};

// How far ahead a given path has to LIST. The daily path keeps using
// reminderWindow verbatim, so its listEvents call is byte-for-byte the one that
// shipped. The fine path only needs as far as its widest touch reaches -- two
// hours -- and asking for more would pull in a day of events every five minutes
// for nothing.
function listWindowFor(path, nowMs) {
  if (path === touches.PATH_DAILY) return touches.reminderWindow(nowMs);
  const widestMs = Math.max(...touches.touchesForPath(path).map(t => t.offsetMs));
  return { timeMinMs: nowMs, timeMaxMs: nowMs + widestMs };
}

function emptyTouchCounts() {
  const out = {};
  for (const key of touches.TOUCH_KEYS) out[key] = 0;
  return out;
}

// ONE pass over one path's window, evaluating every touch that path owns.
//
// Both cron paths and the admin catch-up button go through here, so the
// per-touch rules -- which flag suppresses what, which sender to use, what
// counts as a failure worth alerting -- exist once. The alternative (a daily
// loop and a near-identical fine loop) is exactly how the 24h path would
// quietly acquire behaviour the 2h path never got.
async function runTouchPass(path, nowMs) {
  const window = listWindowFor(path, nowMs);
  const owned = touches.touchesForPath(path);

  // Only events this system created can be reminded -- Omar's own meetings are
  // none of our business.
  const listed = await gcal.listEvents({
    timeMinIso: new Date(window.timeMinMs).toISOString(),
    timeMaxIso: new Date(window.timeMaxMs).toISOString(),
    privateExtendedProperty: `bookingSource=${guard.EVENT_MARKER}`,
  });
  if (!listed.ok) {
    const notConnected = listed.reason === gcal.NOT_CONNECTED;
    return {
      ok: false,
      status: notConnected ? 503 : 502,
      error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: listed.reason,
    };
  }

  // BOTH templates, once per run. The two audiences may sit in different
  // timezones and the reminder has to describe the call in the right one.
  // Making the second read conditional on the batch containing a check-in would
  // add a branch to the one function whose failure mode is a silently missed
  // reminder -- one extra blob read is the cheaper trade.
  //
  // Neither loader can fail destructively: both return a usable normalized
  // template alongside a !ok, so a blob hiccup degrades the displayed timezone
  // rather than dropping the reminder.
  const tplRes = await loadTemplate();
  const checkinTplRes = await checkinTemplateMod.loadCheckinTemplate();

  const counts = emptyTouchCounts();
  let sent = 0, skipped = 0, failures = 0;

  for (const event of listed.events) {
    const meta = (event.extendedProperties && event.extendedProperties.private) || {};
    const startMs = Date.parse(event.start && event.start.dateTime);
    // The ONE audience decision. `audience` is absent on every applicant
    // booking (calendar-book.js never writes it), so the default is the
    // applicant sender and no existing behaviour changes.
    const isCheckin = isCheckinEvent(meta);
    const templateTimeZone = isCheckin
      ? checkinTplRes.template.timezone
      : tplRes.template.timezone;

    for (const touch of owned) {
      if (!meta.visitorEmail) { skipped++; continue; }
      // ANY non-empty value suppresses: '1' means sent, 'moot' means there was
      // never a moment to send it. Both are terminal, and a moot touch must NOT
      // be logged or alerted -- it is not a failure, and alerting on the normal
      // case is how an alerts channel becomes noise nobody reads.
      if (meta[touch.flag]) { skipped++; continue; }
      if (!touches.touchDueAt(touch.key, startMs, nowMs)) { skipped++; continue; }

      const senderName = SENDER_FOR_TOUCH[touch.key][isCheckin ? 'checkin' : 'applicant'];
      const sender = isCheckin ? cemail[senderName] : email[senderName];

      try {
        const result = await sender({
          eventId: event.id,
          name: meta.visitorName || '—',
          email: meta.visitorEmail,
          startMs,
          endMs: Date.parse(event.end && event.end.dateTime) || startMs,
          phone: meta.visitorPhone || '',
          visitorTimeZone: meta.visitorTimeZone || 'UTC',
          templateTimeZone,
          manageToken: makeBookingToken(event.id, meta.visitorEmail),
          meetLink: gcal.meetLinkFor(event),
          lang: meta.lang || 'en',
        });

        if (result.ok) {
          // Stamped AFTER a successful send, never before: setting it first
          // risks dropping the touch entirely, setting it after risks a
          // duplicate, and a duplicate reminder is a far smaller failure than a
          // call the visitor forgets. notifyGuests deliberately NOT passed
          // (defaults to off) -- this is a metadata-only patch and Google must
          // not email the attendee about an extendedProperties change.
          await gcal.patchEvent(event.id, {
            extendedProperties: { private: { [touch.flag]: '1' } },
          });
          counts[touch.key]++;
          sent++;
        } else {
          // Flag left unset so a later tick retries. On the daily path there is
          // usually exactly one eligible tick per booking, so in practice this
          // recipient gets nothing -- which is exactly why the alert matters:
          // it is the only signal anyone gets that it happened.
          console.error(`reminder ${touch.key} failed for`, event.id, result.reason);
          failures++;
          await slack.postSystemAlert(`*Reminder send failed* (${touch.key} touch) for \`${event.id}\` `
            + `(${meta.visitorEmail || 'unknown'})${isCheckin ? ' [check-in]' : ''}: ${result.reason}. `
            + `This touch may not be retried before the call.`);
          skipped++;
        }
      } catch (e) {
        // Per-item isolation: one bad event must not sink the whole batch, and
        // it must NOT be marked sent -- a later run should retry it.
        console.error(`reminder ${touch.key} threw for`, event.id, e.message);
        failures++;
        await slack.postSystemAlert(`*Reminder send threw* (${touch.key} touch) for \`${event.id}\` `
          + `(${meta.visitorEmail || 'unknown'})${isCheckin ? ' [check-in]' : ''}: ${e.message}. `
          + `This touch may not be retried before the call.`);
        skipped++;
      }
    }
  }

  return { ok: true, considered: listed.events.length, sent, skipped, failures, touches: counts };
}
```

- [ ] **Step 5: Replace the handler's inline loop with a call to the pass**

In `api/calendar-reminders.js`, replace everything in `handler` from `const now = Date.now();` down to (and including) the final `return res.status(200).json({ ok: true, considered: listed.events.length, sent, skipped });` with:

```js
  const now = Date.now();

  const pass = await runTouchPass(touches.PATH_DAILY, now);
  if (!pass.ok) {
    return res.status(pass.status).json({
      ok: false, error: pass.error, message: pass.message,
    });
  }

  return res.status(200).json({
    ok: true,
    considered: pass.considered,
    sent: pass.sent,
    skipped: pass.skipped,
    failures: pass.failures,
    touches: pass.touches,
  });
```

- [ ] **Step 6: Export the new surface**

Add to the export block at the bottom of `api/calendar-reminders.js`, beside the Task 1 re-exports:

```js
// Exported so Task 6's fine mode, Task 9's admin catch-up and Task 11's
// snapshot can all reuse the ONE per-touch pass rather than each growing a
// near-copy of it.
module.exports.runTouchPass = runTouchPass;
module.exports.SENDER_FOR_TOUCH = SENDER_FOR_TOUCH;
module.exports.PATH_DAILY = touches.PATH_DAILY;
module.exports.PATH_FINE = touches.PATH_FINE;
```

- [ ] **Step 7: Run the suite to verify it passes**

Run: `node --test test/calendar-reminders.test.js`
Expected: PASS, including every renamed pre-existing test — the auth tests, the window tests, the ordering test, the failure-alert tests and the check-in audience branch.

- [ ] **Step 8: Confirm the retired flag is gone from this file**

Run: `node --test test/calendar-reminders.test.js && grep -rn "reminderSent" api/calendar-reminders.js`
Expected: the tests PASS and `grep` prints **nothing**. The other four handlers still reference `reminderSent` — Task 7 is what clears those.

- [ ] **Step 9: Commit**

```bash
git add api/calendar-reminders.js test/calendar-reminders.test.js
git commit -m "feat(reminders): one pass, one flag per touch

runTouchPass(path, now) evaluates every touch its path owns, stamping
reminder24hSent/reminder2hSent/reminder10mSent independently. The daily cron
owns the 24h touch only and its window, ordering and alerting are unchanged. A
'moot' flag suppresses as silently as a sent one -- never an alert."
```

---

### Task 6: The fine-grained 2h/10min mode

**Files:**
- Modify: `api/calendar-reminders.js:117-125` (`authorized`) and the top of `handler`
- Test: `test/calendar-reminders-fine.test.js`

**Interfaces:**
- Consumes: `runTouchPass`, `SENDER_FOR_TOUCH`, `touches.PATH_FINE` (Task 5); `safeEqual`, `verifySession` (already required).
- Produces:
  - `GET /api/calendar-reminders?touch=fine` with `Authorization: Bearer <REMINDER_FINE_CRON_SECRET>` → `200 {ok:true, mode:'fine', considered, sent, skipped, failures, touches}`
  - `module.exports.wantsFineMode(req) -> boolean`
  - `module.exports.authorizedFine(req) -> boolean`
  - The daily GET path is unchanged and now answers with `mode:'daily'`.

**PREREQUISITE — external infrastructure the user must set up. Do this BEFORE Step 1, because nothing in this task can be verified against production without it.**

1. Generate a secret distinct from `CRON_SECRET`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. In the Vercel dashboard for this project, add it as an environment variable named exactly `REMINDER_FINE_CRON_SECRET`, for **Production** (and Preview, if the user wants to test there). Redeploy so the new variable is live.
3. Create one job on cron-job.org (or any equivalent free service):
   - **URL:** `https://3amaktrades.com/api/calendar-reminders?touch=fine`
   - **Method:** GET
   - **Schedule:** every 5 minutes (`*/5 * * * *`)
   - **Header:** `Authorization: Bearer <the secret from step 1>`
   - Enable the service's own failure notifications if it has them.
4. Confirm it works by watching one run's response body: it must be `200` with `{"ok":true,"mode":"fine",...}`. A `401` means the header or the variable is wrong; a `404` means the query string was dropped by the cron service.

**Five minutes is not a preference, it is the floor.** The 10-minute touch's due window is 10 minutes wide, and a window only reliably contains a tick once it is at least a full polling period long. A 15-minute poller sails over the 10-minute touch for most bookings, silently and with no log line. If the user changes the interval, `FINE_CRON_PERIOD_MINUTES` in `api/_reminder-touches.js` must change with it — `touchStatusAt` uses that number to promise a delivery, and a stale belief there is the one failure this whole design exists to prevent.

- [ ] **Step 1: Write the failing test**

Create `test/calendar-reminders-fine.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const email = require('../api/_email');
const cemail = require('../api/_checkin-email');
const slack = require('../api/_slack');
const auth = require('../api/_admin-auth');
const handler = require('../api/calendar-reminders');

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

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try { return await fn(); } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

const DAILY_SECRET = 'test-cron-secret';
const FINE_SECRET = 'test-fine-cron-secret';

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.CRON_SECRET = DAILY_SECRET;
  process.env.REMINDER_FINE_CRON_SECRET = FINE_SECRET;
  store.__setClientForTests(emptyBlobClient());
}

function fineGet(bearer) {
  const headers = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return { method: 'GET', headers, url: '/api/calendar-reminders?touch=fine', query: { touch: 'fine' } };
}

function dailyGet(bearer) {
  const headers = {};
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  return { method: 'GET', headers, url: '/api/calendar-reminders', query: {} };
}

const EMAIL = 'jane@example.com';

function makeEvent({ id, startMs, extra = {} }) {
  return {
    id,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + 30 * 60000).toISOString() },
    hangoutLink: 'https://meet.example/abc',
    extendedProperties: {
      private: {
        bookingSource: guard.EVENT_MARKER,
        visitorName: 'Jane Doe', visitorEmail: EMAIL, visitorPhone: '555-0100',
        visitorTimeZone: 'America/Toronto', lang: 'en',
        ...extra,
      },
    },
  };
}

test('the fine mode is recognised from the query param and from a raw url', () => {
  assert.equal(handler.wantsFineMode({ query: { touch: 'fine' }, url: '/api/calendar-reminders' }), true);
  assert.equal(handler.wantsFineMode({ query: {}, url: '/api/calendar-reminders?touch=fine' }), true);
  assert.equal(handler.wantsFineMode({ query: { touch: ['fine'] }, url: '' }), true,
    'a repeated query param arrives as an array on Vercel');
  assert.equal(handler.wantsFineMode({ query: {}, url: '/api/calendar-reminders' }), false);
  assert.equal(handler.wantsFineMode({ query: { touch: 'daily' }, url: '' }), false);
  assert.equal(handler.wantsFineMode({}), false);
});

// The spec asks for a SECOND, DISTINCT secret. That is only meaningful if
// neither one opens the other's door -- otherwise handing the external service
// a token is handing it the Vercel cron's token too.
test('the two secrets are not interchangeable in either direction', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    let res = makeRes();
    await handler(fineGet(DAILY_SECRET), res);
    assert.equal(res._status, 401, 'CRON_SECRET must not authorize the fine mode');

    res = makeRes();
    await handler(dailyGet(FINE_SECRET), res);
    assert.equal(res._status, 401, 'the fine secret must not authorize the daily run');

    assert.equal(listSpy.calls.length, 0, 'neither rejection may reach the calendar');
  });
});

test('REMINDER_FINE_CRON_SECRET unset -> 401 naming the missing variable, calendar untouched', async () => {
  envSetup();
  delete process.env.REMINDER_FINE_CRON_SECRET;
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const res = makeRes();
    await handler(fineGet('anything'), res);
    assert.equal(res._status, 401);
    assert.match(JSON.stringify(res._json), /REMINDER_FINE_CRON_SECRET not set/);
    assert.equal(listSpy.calls.length, 0);
  });
  process.env.REMINDER_FINE_CRON_SECRET = FINE_SECRET;
});

test('the fine mode lists only two hours ahead, not a whole lead window', async () => {
  envSetup();
  process.env.REMINDER_LEAD_HOURS = '36';
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const before = Date.now();
    const res = makeRes();
    await handler(fineGet(FINE_SECRET), res);
    assert.equal(res._status, 200);
    assert.equal(res._json.mode, 'fine');
    const arg = listSpy.calls[0][0];
    const span = Date.parse(arg.timeMaxIso) - Date.parse(arg.timeMinIso);
    assert.ok(Math.abs(span - 2 * 3600000) < 5000,
      `the fine window should reach exactly as far as the widest fine touch, got ${span}ms`);
    assert.ok(Math.abs(Date.parse(arg.timeMinIso) - before) < 5000);
  });
  delete process.env.REMINDER_LEAD_HOURS;
});

test('at 90 minutes out the fine pass sends the 2h touch and NOT the 10m one', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const soonSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [makeEvent({ id: 'evt-90m', startMs: Date.now() + 90 * 60000 })] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: email, key: 'sendStartingSoon', value: soonSpy },
  ], async () => {
    const res = makeRes();
    await handler(fineGet(FINE_SECRET), res);
    assert.equal(reminderSpy.calls.length, 1, 'the 2h touch reuses the existing reminder copy');
    assert.equal(soonSpy.calls.length, 0, 'the 10m moment has not arrived');
    assert.deepEqual(res._json.touches, { '24h': 0, '2h': 1, '10m': 0 });
    assert.deepEqual(patchSpy.calls.map(c => c[1].extendedProperties.private),
      [{ reminder2hSent: '1' }]);
  });
});

test('at 4 minutes out with the 2h touch already sent, only the 10m touch fires', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const soonSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [makeEvent({ id: 'evt-4m', startMs: Date.now() + 4 * 60000,
        extra: { reminder2hSent: '1' } })] }) },
    { obj: gcal, key: 'patchEvent', value: patchSpy },
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: email, key: 'sendStartingSoon', value: soonSpy },
  ], async () => {
    const res = makeRes();
    await handler(fineGet(FINE_SECRET), res);
    assert.equal(reminderSpy.calls.length, 0);
    assert.equal(soonSpy.calls.length, 1);
    assert.deepEqual(res._json.touches, { '24h': 0, '2h': 0, '10m': 1 });
    assert.deepEqual(patchSpy.calls.map(c => c[1].extendedProperties.private),
      [{ reminder10mSent: '1' }]);
  });
});

// The nightmare this cadence is designed around: both fine touches landing in
// the same tick, two near-identical emails one after the other.
test('a booking 4 minutes out with NOTHING sent gets both fine touches at most once each', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const soonSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [makeEvent({ id: 'evt-both', startMs: Date.now() + 4 * 60000 })] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true }) },
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: email, key: 'sendStartingSoon', value: soonSpy },
  ], async () => {
    const res = makeRes();
    await handler(fineGet(FINE_SECRET), res);
    // Both windows really are open, so both DO fire -- but each exactly once,
    // and this is the case the booking handlers pre-stamp as moot (Task 7) so
    // it cannot arise from a short-notice booking in the first place. It can
    // only arise from a booking that existed before this feature shipped.
    assert.equal(reminderSpy.calls.length, 1);
    assert.equal(soonSpy.calls.length, 1);
    assert.deepEqual(res._json.touches, { '24h': 0, '2h': 1, '10m': 1 });
  });
});

test('the fine pass never fires the 24h touch, however far out the booking is', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [makeEvent({ id: 'evt-far', startMs: Date.now() + 5 * 3600000 })] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true }) },
    { obj: email, key: 'sendReminder', value: reminderSpy },
  ], async () => {
    const res = makeRes();
    await handler(fineGet(FINE_SECRET), res);
    assert.equal(reminderSpy.calls.length, 0,
      'a booking outside the fine window must not be touched by the fine pass');
    assert.deepEqual(res._json.touches, { '24h': 0, '2h': 0, '10m': 0 });
  });
});

test('a check-in booking gets the CHECK-IN senders on the fine path too', async () => {
  envSetup();
  const soonSpy = spyStub({ ok: true });
  const applicantSoonSpy = spyStub({ ok: true });
  await withStubs([
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [makeEvent({ id: 'evt-ci', startMs: Date.now() + 4 * 60000,
        extra: { audience: 'checkin', reminder2hSent: '1' } })] }) },
    { obj: gcal, key: 'patchEvent', value: spyStub({ ok: true }) },
    { obj: cemail, key: 'sendCheckinStartingSoon', value: soonSpy },
    { obj: email, key: 'sendStartingSoon', value: applicantSoonSpy },
  ], async () => {
    const res = makeRes();
    await handler(fineGet(FINE_SECRET), res);
    assert.equal(soonSpy.calls.length, 1);
    assert.equal(applicantSoonSpy.calls.length, 0);
    assert.deepEqual(res._json.touches, { '24h': 0, '2h': 0, '10m': 1 });
  });
});

test('an admin session POST can run the fine mode too, for manual verification', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const cookie = auth.issueSessionCookie().split(';')[0];
    const res = makeRes();
    await handler({ method: 'POST', headers: { cookie }, body: {},
      url: '/api/calendar-reminders?touch=fine', query: { touch: 'fine' } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.mode, 'fine');
    assert.equal(listSpy.calls.length, 1);
  });
});

// Same CSRF reasoning as the existing session path: the cookie is SameSite=Lax
// and DOES ride a top-level cross-site GET, so the cookie route must stay POST.
test('a session COOKIE on a GET does not authorize the fine mode', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([{ obj: gcal, key: 'listEvents', value: listSpy }], async () => {
    const cookie = auth.issueSessionCookie().split(';')[0];
    const res = makeRes();
    await handler({ method: 'GET', headers: { cookie },
      url: '/api/calendar-reminders?touch=fine', query: { touch: 'fine' } }, res);
    assert.equal(res._status, 401);
    assert.equal(listSpy.calls.length, 0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/calendar-reminders-fine.test.js`
Expected: FAIL — `handler.wantsFineMode is not a function`.

- [ ] **Step 3: Add the mode detector and its auth**

In `api/calendar-reminders.js`, insert immediately after the existing `authorized(req)` function (after line 125):

```js
// Is this request aimed at the fine-grained 2h/10min pass?
//
// TWO SIGNALS, for the same reason api/_route-action.js reads two: Vercel's docs
// do not state in one place exactly what reaches a function, and a cron service
// that mangles or re-encodes the query string must fail loudly on auth rather
// than silently fall through to the DAILY pass -- which would send the 24h touch
// every five minutes.
function wantsFineMode(req) {
  const raw = req && req.query && req.query.touch;
  // A repeated query parameter arrives as an array on Vercel.
  const name = Array.isArray(raw) ? raw[0] : raw;
  if (String(name == null ? '' : name) === 'fine') return true;
  return /[?&]touch=fine(?:&|$)/.test(String((req && req.url) || ''));
}

// The fine pass's own bearer secret, DISTINCT from CRON_SECRET and not
// interchangeable with it in either direction. The external cron service is a
// third party holding a credential to this deployment; giving it the same token
// Vercel's own cron uses would mean a leak there is a leak of both.
//
// The admin-session POST path is accepted here as well, so the owner can verify
// the fine pass by hand from /admin without ever learning either secret. GET is
// deliberately excluded from the cookie route for the same SameSite=Lax CSRF
// reason documented on authorized() above.
function authorizedFine(req) {
  const secret = process.env.REMINDER_FINE_CRON_SECRET;
  const header = (req.headers && req.headers.authorization) || '';
  if (secret && safeEqual(header, `Bearer ${secret}`)) return true;
  return req.method === 'POST' && verifySession(req);
}
```

- [ ] **Step 4: Route the handler on the mode**

In `api/calendar-reminders.js`, replace the auth block at the top of `handler` (currently lines 215–219, the `if (req.method !== 'GET' ...)` and `if (!authorized(req)) ...` pair) with:

```js
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const fine = wantsFineMode(req);
  if (fine) {
    if (!authorizedFine(req)) {
      return res.status(401).json({ ok: false,
        error: process.env.REMINDER_FINE_CRON_SECRET
          ? 'unauthorized' : 'REMINDER_FINE_CRON_SECRET not set' });
    }
  } else if (!authorized(req)) {
    return res.status(401).json({ ok: false,
      error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET not set' });
  }
```

Then replace the pass invocation added in Task 5 Step 5 with:

```js
  const now = Date.now();
  const path = fine ? touches.PATH_FINE : touches.PATH_DAILY;

  const pass = await runTouchPass(path, now);
  if (!pass.ok) {
    return res.status(pass.status).json({
      ok: false, error: pass.error, message: pass.message,
    });
  }

  return res.status(200).json({
    ok: true,
    mode: path,
    considered: pass.considered,
    sent: pass.sent,
    skipped: pass.skipped,
    failures: pass.failures,
    touches: pass.touches,
  });
```

- [ ] **Step 5: Export the two new predicates**

Add to the export block at the bottom of `api/calendar-reminders.js`:

```js
// Exported so the fine path's auth and routing can be exercised directly,
// without going through a full handler invocation for every edge case.
module.exports.wantsFineMode = wantsFineMode;
module.exports.authorizedFine = authorizedFine;
```

- [ ] **Step 6: Run both reminder suites to verify they pass**

Run: `node --test test/calendar-reminders-fine.test.js test/calendar-reminders.test.js`
Expected: PASS. The daily suite must be entirely unaffected: `wantsFineMode` returns `false` for every request it builds, so every one of its tests still takes the `authorized` branch and the `PATH_DAILY` pass.

- [ ] **Step 7: Confirm no second Vercel cron was added**

Run: `node -e "const c=require('./vercel.json');console.log(JSON.stringify(c.crons))"`
Expected: exactly `[{"path":"/api/calendar-reminders","schedule":"0 0 * * *"}]`. The 5-minute poller is external infrastructure; a second entry here would both break `test/reminder-delivery-guarantee.test.js`'s schedule parser and exceed the Hobby plan's one-cron-a-day limit.

- [ ] **Step 8: Commit**

```bash
git add api/calendar-reminders.js test/calendar-reminders-fine.test.js
git commit -m "feat(reminders): add the fine-grained 2h/10min cron mode

GET /api/calendar-reminders?touch=fine, gated by its own REMINDER_FINE_CRON_SECRET
(not interchangeable with CRON_SECRET), lists only as far as the widest fine
touch reaches, and runs the 2h and 10min touches. Polled every ~5 minutes by an
external cron service; no new Serverless Function and no new Vercel cron."
```

---

### Task 7: The four booking handlers plan all three touches

**Files:**
- Modify: `api/calendar-reminders.js` (add `applyTouchPlan`, export it and `TOUCH_FLAGS`/`touchByKey`)
- Modify: `api/calendar-book.js:165-201`
- Modify: `api/calendar-reschedule.js:74-84`, `:99-105`, `:151-189`
- Modify: `api/calendar-checkin.js:400-429`, `:594-604`, `:619-625`, `:676-701`
- Test: `test/reminder-delivery-guarantee.test.js` (replaced), `test/calendar-book.test.js:540-790`, `test/calendar-reschedule.test.js:242-700`, `test/calendar-checkin-book.test.js:885-1095`, `test/calendar-checkin-reschedule.test.js:320-940`

**Interfaces:**
- Consumes: `touches.planTouches`, `touches.touchByKey`, `touches.TOUCH_FLAGS` (Task 1); `SENDER_FOR_TOUCH` (Task 5); the existing `gcal.patchEvent`, `slack.postSystemAlert`, and both email modules.
- Produces:
  - `remind.applyTouchPlan({ eventId, booking, isCheckin, nowMs, context }) -> Promise<{ moot: string[], sent: string[], failed: string[] }>` — best-effort, never throws. `booking` is the eleven-field Booking object the calling handler already built; `isCheckin` is a boolean; `context` is a short human string used only in alert text (`'booking'`, `'reschedule'`, `'check-in booking'`, `'check-in reschedule'`).
  - `remind.TOUCH_FLAGS` — `['reminder24hSent','reminder2hSent','reminder10mSent']`
  - `remind.touchByKey(key)` — re-export of the Task 1 lookup
  - **No** `remind.needsImmediateReminder`. After this task the string `needsImmediateReminder` appears nowhere in `api/` or `test/`.

**What actually changes in behaviour, stated plainly, because four test files assert the old behaviour and will all fail:**

Today a booking made 1 hour out triggers one immediate "your call is coming up" email at booking time. After this task it triggers **nothing** immediately: its 24h and 2h touches are stamped `'moot'` and its 10min touch is left to the external 5-minute poller, which sends the "starting in 10 minutes" copy about fifty minutes later. That is the spec's decision, verbatim ("a booking made 1 hour before the call skips the moot 24h and 2h touches and only gets the 10min one"), and it is strictly better: the visitor gets a reminder when it is useful instead of one that arrives alongside their confirmation email.

A booking made 5 minutes out now gets **none** of the three touches, by design — the booking-confirmation email is the only thing that fires. Do not add a fourth "immediate" fallback to cover it. A reminder about a call starting in four minutes, arriving in the same inbox breath as the confirmation, is noise.

- [ ] **Step 1: Write the failing test — the rewritten delivery guarantee**

Replace the whole of `test/reminder-delivery-guarantee.test.js` with:

```js
// Does every booking actually GET its cadence?
//
// Nothing else in the suite answers that. Every other reminder test hands a
// handler an event and checks what it does with it; none of them ask whether
// anything will ever SEE a given booking in the first place.
//
// ===========================================================================
// THE MECHANISM, AS IT NOW STANDS
// ===========================================================================
// There are THREE touches, not one, and TWO crons, not one:
//
//   24h touch   reminder24hSent   Vercel's daily cron        period 24h
//   2h  touch   reminder2hSent    external poller ?touch=fine  period 5min
//   10m touch   reminder10mSent   external poller ?touch=fine  period 5min
//
// Each touch has a DUE WINDOW (api/_reminder-touches.js's touchDueAt) and a
// NOMINAL MOMENT (startMs minus its offset). A run of the owning cron at time T
// sends the touch iff its due window is open at T and its flag is still clear.
//
// A closed-or-half-open interval of length L contains a tick of a period-P cron
// for EVERY phase iff L >= P. That single fact is the whole guarantee, and it is
// applied three times with three different (L, P) pairs instead of once.
//
// ===========================================================================
// WHAT CHANGED FROM THE SINGLE-REMINDER ERA, AND WHY THIS FILE WAS REWRITTEN
// ===========================================================================
// The old invariant was "EVERY booking gets a reminder", delivered either by a
// cron tick or by the booking handler sending one immediately when
// needsImmediateReminder said the cron could not be trusted. That predicate is
// gone: a single yes/no cannot say WHICH of three touches is at risk, and it has
// no way to express the third outcome the cadence introduces -- a touch that is
// MOOT, whose moment was already in the past when the booking was made. The 24h
// touch of a call booked an hour from now is not late and not failed; there was
// never an instant at which it could have gone out.
//
// So the property proved here is now:
//
//   (1) COVERAGE. Every booking with at least 10 minutes of notice gets at
//       least one touch. Below 10 minutes it gets none of the three, by design,
//       and the booking-confirmation email is the only thing that fires.
//
//   (2) SOUNDNESS, both directions. Whenever planTouches leaves a touch to a
//       cron, a tick of that cron provably lands inside the touch's due window
//       for every phase. Whenever it calls a touch moot, that touch's nominal
//       moment really is in the past. "Covered by one of the two" alone is not
//       enough -- a predicate that marked everything 'immediate' would satisfy
//       it while emailing every visitor three times at booking time.
//
//   (3) NO DOUBLE DELIVERY. A touch sent immediately is stamped, and a stamped
//       flag suppresses the cron. A touch stamped 'moot' is likewise suppressed.
//       So each touch fires at most once per booking, from exactly one source.
//
// WHAT WENT WRONG BEFORE, concretely, and why the notice-quality assertions are
// still here. With the old single reminder, minNoticeHours 12 and the cron at
// 13:00 UTC, the simulation reported ~7% of bookings reminded with under 12
// hours notice and a worst case of ZERO. DELIVERY is now unconditional above 10
// minutes of notice; the QUALITY of the cron-delivered 24h touch still is not,
// so that band stays pinned -- for exactly the pairs the daily cron is
// responsible for.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const av = require('../api/_availability');
const remind = require('../api/calendar-reminders');
const touches = require('../api/_reminder-touches');

const HOUR = 3600000;
const MINUTE = 60000;
const DAY = 86400000;
const VERCEL_JSON = path.join(__dirname, '..', 'vercel.json');

// Read the LIVE schedule rather than restating it, so editing vercel.json is
// what re-runs this proof. A non-daily schedule is not merely a different number
// here: it changes the period the invariant is measured against, so it must be
// read, not assumed.
function cronPeriodHours() {
  const cfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  const jobs = (cfg.crons || []).filter(c => c.path === '/api/calendar-reminders');
  assert.equal(jobs.length, 1,
    'vercel.json must register exactly one cron for /api/calendar-reminders');
  const m = /^(\d+) (\d+) \* \* \*$/.exec(jobs[0].schedule);
  assert.ok(m, `expected a once-daily "M H * * *" schedule, got "${jobs[0].schedule}". `
    + 'A different shape changes the tick period this whole proof rests on -- if the '
    + 'plan now allows more frequent crons, update this parser, _reminder-touches.js\'s '
    + 'CRON_PERIOD_HOURS, and the invariant together.');
  return { periodHours: 24, minute: +m[1], hour: +m[2], schedule: jobs[0].schedule };
}

// The deployed lead time (a Vercel env var) and the value the code falls back to
// if that var ever goes missing. The guarantee has to hold for BOTH: a dropped
// env var must not silently downgrade delivery.
const LEAD_HOURS_CASES = [36, 24];

function withLead(hours, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'REMINDER_LEAD_HOURS');
  const prev = process.env.REMINDER_LEAD_HOURS;
  process.env.REMINDER_LEAD_HOURS = String(hours);
  try {
    assert.equal(touches.leadHours(), hours, 'the module must be reading the env var live');
    return fn();
  } finally {
    if (had) process.env.REMINDER_LEAD_HOURS = prev;
    else delete process.env.REMINDER_LEAD_HOURS;
  }
}

// ---------------------------------------------------------------------------
// The arithmetic half
// ---------------------------------------------------------------------------

test('vercel.json and CRON_PERIOD_HOURS still agree, and there is still one daily cron', () => {
  const live = cronPeriodHours();
  assert.equal(touches.CRON_PERIOD_HOURS, live.periodHours,
    `vercel.json schedules "${live.schedule}" but CRON_PERIOD_HOURS says `
    + `${touches.CRON_PERIOD_HOURS}h. A belief that runs behind reality is the dangerous `
    + 'direction: every booking in between would be left to a run that is not coming.');
  // The fine path is EXTERNAL infrastructure, deliberately not a Vercel cron --
  // the Hobby plan allows one job a day, which is the entire reason it exists.
  const cfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
  assert.equal((cfg.crons || []).length, 1,
    'a second Vercel cron would exceed the Hobby plan AND break this proof\'s parser');
});

test('the fine poller period is short enough for the narrowest touch it owns', () => {
  const narrowest = Math.min(...touches.touchesForPath(touches.PATH_FINE).map(t => t.offsetMs));
  const period = touches.pathPeriodMs(touches.PATH_FINE);
  assert.ok(narrowest >= period,
    `the fine poller ticks every ${period / MINUTE}min but its narrowest due window is `
    + `${narrowest / MINUTE}min wide. A period longer than the window it is meant to catch `
    + 'cannot be trusted to ever land inside it -- the touch is simply never sent, silently.');
});

test('the daily cron can be relied on for the 24h touch at both lead settings', () => {
  for (const lead of LEAD_HOURS_CASES) {
    withLead(lead, () => {
      // Not moot means notice >= 24h, and then the daily interval is
      // min(notice, lead) >= min(24h, lead). That is >= the 24h period exactly
      // when lead >= 24h, which both deployed cases satisfy.
      assert.ok(lead >= touches.CRON_PERIOD_HOURS,
        `REMINDER_LEAD_HOURS=${lead} is below the cron period, so the 24h touch falls to `
        + 'the immediate path for EVERY booking -- allowed, but no longer a cron guarantee');
      const now = Date.UTC(2026, 9, 6, 12, 0, 0);
      assert.equal(touches.touchStatusAt('24h', now + 24 * HOUR, now), 'cron');
      assert.equal(touches.touchStatusAt('24h', now + 10 * DAY, now), 'cron');
    });
  }
});

// ---------------------------------------------------------------------------
// (1) COVERAGE, by brute force over the real predicates
// ---------------------------------------------------------------------------

// Every booking-time x slot-time pair on a fine grid, at the shipped
// minNoticeHours of 24 AND at a lowered 1 and 0 -- which is what proves
// same-day and same-hour booking are SAFE rather than merely allowed. The
// minimum-notice floor is admin-settable (api/_availability.js clamps it to
// 0..720) and the admin page POSTs straight through, so a proof measured only on
// DEFAULT_TEMPLATE proves nothing about production. That is the exact bug this
// file was rewritten around once already.
const NOTICE_REGIMES = [24, 1, 0];

// The shortest touch's offset is the coverage floor: below it, every touch is
// moot and the confirmation email is deliberately the only thing that fires.
const COVERAGE_FLOOR_MS = Math.min(...touches.TOUCHES.map(t => t.offsetMs));

test('COVERAGE: every booking with at least 10 minutes of notice gets at least one touch', () => {
  assert.equal(COVERAGE_FLOOR_MS, 10 * MINUTE, 'the floor is the 10-minute touch');
  for (const lead of LEAD_HOURS_CASES) {
    withLead(lead, () => {
      for (const minNoticeHours of NOTICE_REGIMES) {
        const floorMs = Math.max(minNoticeHours * HOUR, COVERAGE_FLOOR_MS);
        let pairs = 0, covered = 0;
        // Booking instants across a day, slot instants across the next eight.
        for (let bMin = 0; bMin < 24 * 60; bMin += 37) {
          const B = Date.UTC(2026, 9, 6, 0, 0, 0) + bMin * MINUTE;
          for (let sMin = 0; sMin < 8 * 24 * 60; sMin += 23) {
            const S = B + sMin * MINUTE;
            if (S - B < floorMs) continue; // the template would refuse this booking
            pairs++;
            const plan = touches.planTouches(S, B);
            if (plan.immediate.length + plan.cron.length > 0) covered++;
          }
        }
        assert.ok(pairs > 1000, `expected a real sweep, got ${pairs} pairs`);
        assert.equal(covered, pairs,
          `lead=${lead} minNotice=${minNoticeHours}: ${pairs - covered} of ${pairs} bookings `
          + 'would get NO touch at all -- no email, no log line, no trace');
      }
    });
  }
});

test('BELOW the floor, all three touches are moot -- deliberately, not by accident', () => {
  withLead(36, () => {
    const B = Date.UTC(2026, 9, 6, 12, 0, 0);
    for (const noticeMs of [0, MINUTE, 5 * MINUTE, 9 * MINUTE, COVERAGE_FLOOR_MS - 1]) {
      const plan = touches.planTouches(B + noticeMs, B);
      assert.deepEqual(plan.moot, ['24h', '2h', '10m'],
        `at ${noticeMs / MINUTE}min notice every touch should be moot`);
      assert.deepEqual(plan.immediate, [],
        'and NOTHING should be sent at booking time -- a reminder about a call four minutes '
        + 'away, arriving beside the confirmation email, is noise, not a safety net');
    }
  });
});

// ---------------------------------------------------------------------------
// (2) SOUNDNESS: a touch left to a cron is really delivered by it
// ---------------------------------------------------------------------------

test('SOUNDNESS: for every booking pair, every cron-assigned touch is really caught', () => {
  for (const lead of LEAD_HOURS_CASES) {
    withLead(lead, () => {
      let assertions = 0;
      for (let bMin = 0; bMin < 24 * 60; bMin += 53) {
        const B = Date.UTC(2026, 9, 6, 0, 0, 0) + bMin * MINUTE;
        for (let sMin = 10; sMin < 5 * 24 * 60; sMin += 41) {
          const S = B + sMin * MINUTE;
          for (const key of touches.planTouches(S, B).cron) {
            const touch = touches.touchByKey(key);
            const periodMs = touches.pathPeriodMs(touch.path);
            // The booking's phase relative to the owning cron is arbitrary, so
            // the worst phase is what has to hold. Eight samples per period.
            for (let p = 0; p < 8; p++) {
              const firstTick = B + Math.floor((p / 8) * periodMs);
              let hit = false;
              for (let T = firstTick; T <= S + periodMs; T += periodMs) {
                if (T >= B && touches.touchDueAt(key, S, T)) { hit = true; break; }
              }
              assert.ok(hit, `lead=${lead}: the ${key} touch of a booking made at `
                + `${new Date(B).toISOString()} for ${new Date(S).toISOString()} was left to `
                + `the ${touch.path} cron, but NO tick at phase ${p}/8 ever lands in its due `
                + 'window. That is a silently missed email.');
              assertions++;
            }
          }
        }
      }
      assert.ok(assertions > 2000, `expected a real sweep, made ${assertions} assertions`);
    });
  }
});

test('SOUNDNESS: a touch marked moot really has an unreachable nominal moment', () => {
  withLead(36, () => {
    for (let sMin = 0; sMin < 3 * 24 * 60; sMin += 17) {
      const B = Date.UTC(2026, 9, 6, 12, 0, 0);
      const S = B + sMin * MINUTE;
      for (const key of touches.planTouches(S, B).moot) {
        assert.ok(S - touches.touchByKey(key).offsetMs < B,
          `${key} was called moot at ${sMin}min notice, but its nominal moment is still ahead`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (3) NO DOUBLE DELIVERY
// ---------------------------------------------------------------------------

test('every touch is owned by exactly one cron path, and the three flags are distinct', () => {
  const byPath = {};
  for (const t of touches.TOUCHES) {
    byPath[t.path] = (byPath[t.path] || 0) + 1;
    assert.ok(t.path === touches.PATH_DAILY || t.path === touches.PATH_FINE,
      `${t.key} is assigned to the unknown path "${t.path}"`);
  }
  assert.equal(Object.values(byPath).reduce((a, b) => a + b, 0), touches.TOUCHES.length,
    'a touch owned by two paths would be sent twice, once per cron');
  assert.equal(new Set(touches.TOUCH_FLAGS).size, 3,
    'two touches sharing a flag means one of them suppresses the other');
  assert.equal(new Set(touches.TOUCH_KEYS).size, 3);
});

test('the 24h touch is on the DAILY path and the two fine touches are not', () => {
  // Stated separately from the table because this is the load-bearing split: the
  // daily cron must never fire the 10-minute copy a day early, and the 5-minute
  // poller must never fire the 24h copy twelve times an hour.
  assert.equal(touches.touchByKey('24h').path, touches.PATH_DAILY);
  assert.equal(touches.touchByKey('2h').path, touches.PATH_FINE);
  assert.equal(touches.touchByKey('10m').path, touches.PATH_FINE);
});

// ---------------------------------------------------------------------------
// The retired predicate
// ---------------------------------------------------------------------------

test('needsImmediateReminder is gone -- applyTouchPlan is what handlers call now', () => {
  assert.equal(remind.needsImmediateReminder, undefined,
    'an alias here would let a call site keep compiling while meaning something else');
  assert.equal(typeof remind.applyTouchPlan, 'function');
  assert.equal(typeof remind.planTouches, 'function');
  assert.deepEqual(remind.TOUCH_FLAGS,
    ['reminder24hSent', 'reminder2hSent', 'reminder10mSent']);
});

// ---------------------------------------------------------------------------
// Quality of the daily-cron 24h touch (unchanged concern, narrowed scope)
// ---------------------------------------------------------------------------

test('QUALITY: a cron-delivered 24h touch still arrives with real notice', () => {
  const live = cronPeriodHours();
  withLead(36, () => {
    let worstNoticeMs = Infinity, checked = 0;
    for (let sMin = 24 * 60; sMin < 10 * 24 * 60; sMin += 29) {
      const B = Date.UTC(2026, 9, 6, 0, 0, 0);
      const S = B + sMin * MINUTE;
      if (!touches.planTouches(S, B).cron.includes('24h')) continue;
      // Ticks land at the live schedule's hour:minute each day.
      for (let day = 0; day < 12; day++) {
        const T = Date.UTC(2026, 9, 6 + day, live.hour, live.minute, 0);
        if (T >= B && touches.touchDueAt('24h', S, T)) {
          worstNoticeMs = Math.min(worstNoticeMs, S - T);
          checked++;
          break;
        }
      }
    }
    assert.ok(checked > 100, `expected a real sweep, checked ${checked}`);
    // The 24h touch is the only one with a quality claim: the 2h and 10m touches
    // are pinned to within one 5-minute tick of their nominal moments by
    // construction, which the SOUNDNESS sweep above already establishes.
    assert.ok(worstNoticeMs >= 0,
      'a 24h touch must never be delivered after the call has started');
    assert.ok(worstNoticeMs <= 36 * HOUR + MINUTE,
      'and never earlier than the lead window allows');
  });
});

test('the default template still satisfies its own minimum-notice contract', () => {
  const tpl = av.normalizeTemplate(av.DEFAULT_TEMPLATE);
  assert.ok(Number.isFinite(tpl.minNoticeHours) && tpl.minNoticeHours >= 0,
    'minNoticeHours must be a real number -- the coverage sweep above measures against it');
  // Not asserted to be >= 24 any more, deliberately: the whole point of the
  // cadence is that a lowered floor is now SAFE, and pinning it here would
  // re-introduce the coupling this file was rewritten to remove.
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/reminder-delivery-guarantee.test.js`
Expected: FAIL — `typeof remind.applyTouchPlan` is `'undefined'`. The arithmetic, coverage and soundness tests should already PASS against Task 1's module; if any of them fails, Task 1 is wrong and must be fixed before continuing.

- [ ] **Step 3: Add `applyTouchPlan` to `api/calendar-reminders.js`**

Insert immediately after `runTouchPass` (the function added in Task 5):

```js
// What a BOOKING or RESCHEDULE handler does about the cadence, at the moment the
// event is created or moved. The complement of runTouchPass: that one asks "is
// this touch due right now", this one asks "will anything ever send it".
//
// Three outcomes per touch, and all three have to be acted on:
//
//   moot       stamp the flag so no cron sends it later. The nominal moment is
//              already behind us -- a 24h touch for a call booked an hour from
//              now. NOT a failure: no alert, no error, nothing in #7. If this
//              were left unstamped, tonight's daily cron would cheerfully send
//              "your call is coming up" about a call that already happened.
//   immediate  send it here and stamp it. The owning cron cannot be RELIED ON to
//              land in the due window, and the alternative is a recipient who
//              never hears from us with no log line and no trace.
//   cron       do nothing. A tick provably lands in the window.
//
// BEST-EFFORT THROUGHOUT, like the confirmation email and the Slack post the
// callers already treat this way: an event that is already on the calendar must
// never be reported as failed because a reminder would not send. Every error is
// caught here, and the caller does not need its own try/catch.
//
// One patch for ALL the moot flags rather than one patch each: these are
// metadata-only writes against a Google API with per-user rate limits, and the
// short-notice case stamps two of them.
async function applyTouchPlan({ eventId, booking, isCheckin, nowMs, context }) {
  const plan = touches.planTouches(booking.startMs, nowMs);
  const out = { moot: plan.moot.slice(), sent: [], failed: [] };

  if (plan.moot.length) {
    const priv = {};
    for (const key of plan.moot) priv[touches.touchByKey(key).flag] = 'moot';
    try {
      // notifyGuests deliberately NOT passed (defaults to off): metadata only,
      // so Google must not email the attendee about an extendedProperties
      // change.
      await gcal.patchEvent(eventId, { extendedProperties: { private: priv } });
    } catch (e) {
      // Logged, NOT alerted. The consequence of a failed moot stamp is one
      // stale-but-harmless touch later ("coming up" about a call an hour away),
      // not a missed one -- and #7 is for things that cost someone a call.
      console.error(`could not stamp moot touches on ${eventId} (${context}):`, e.message);
    }
  }

  for (const key of plan.immediate) {
    const touch = touches.touchByKey(key);
    const senderName = SENDER_FOR_TOUCH[key][isCheckin ? 'checkin' : 'applicant'];
    // Read off the live module at call time, so a test's monkey-patch is seen.
    const sender = isCheckin ? cemail[senderName] : email[senderName];
    try {
      const result = await sender(booking);
      if (result.ok) {
        await gcal.patchEvent(eventId, {
          extendedProperties: { private: { [touch.flag]: '1' } },
        });
        out.sent.push(key);
      } else {
        out.failed.push(key);
        console.error(`immediate ${key} touch failed on ${context}:`, result.reason);
        await slack.postSystemAlert(`*Immediate reminder failed* (${key} touch) on ${context} `
          + `for \`${eventId}\` (${booking.email || 'unknown'})`
          + `${isCheckin ? ' [check-in]' : ''}: ${result.reason}. `
          + `This booking is too close to rely on the cron, so this touch likely never arrives.`);
      }
    } catch (e) {
      out.failed.push(key);
      console.error(`immediate ${key} touch threw on ${context}:`, e.message);
      await slack.postSystemAlert(`*Immediate reminder threw* (${key} touch) on ${context} `
        + `for \`${eventId}\` (${booking.email || 'unknown'})`
        + `${isCheckin ? ' [check-in]' : ''}: ${e.message}. `
        + `This booking is too close to rely on the cron, so this touch likely never arrives.`);
    }
  }

  return out;
}
```

Then add to the export block at the bottom of the file:

```js
// The four booking/reschedule handlers call this instead of the retired
// needsImmediateReminder. Kept here, beside runTouchPass and the window
// arithmetic it is the complement of, is what stops the two halves of the
// guarantee drifting apart.
module.exports.applyTouchPlan = applyTouchPlan;
module.exports.TOUCH_FLAGS = touches.TOUCH_FLAGS;
module.exports.touchByKey = touches.touchByKey;
```

- [ ] **Step 4: Rewrite the applicant booking handler's short-notice block**

In `api/calendar-book.js`, replace lines 160–201 (the `// ---- Short-notice reminder` comment block through the closing brace of the `if (remind.needsImmediateReminder(...))` statement) with:

```js
  // ---- The three-touch cadence --------------------------------------------
  // Every booking gets up to three pre-call touches: ~24h, ~2h and ~10min out.
  // Which of them are actually reachable depends on how much notice THIS
  // booking had, so the decision is made per booking rather than enforced by a
  // template-wide minimum-notice floor. See applyTouchPlan and
  // api/_reminder-touches.js.
  //
  // A booking three days out: nothing happens here, all three touches are left
  // to their crons. A booking an hour out: the 24h and 2h touches are stamped
  // moot (their moments are gone) and the 10-minute touch is left to the
  // external 5-minute poller. A booking five minutes out: all three are moot
  // and the confirmation email above is the only thing that fires -- which is
  // correct, not a gap.
  //
  // Deliberately placed AFTER the double-booking rollback check above: that
  // branch returns 409, so a booking that got rolled back never reaches this and
  // nobody is reminded about a call that no longer exists. Best-effort, like the
  // confirmation email and the Slack post above -- applyTouchPlan swallows its
  // own errors, so a confirmed booking is never undone by a reminder that would
  // not send.
  await remind.applyTouchPlan({
    eventId, booking, isCheckin: false, nowMs: Date.now(), context: 'booking',
  });
  // -------------------------------------------------------------------------
```

- [ ] **Step 5: Rewrite the applicant reschedule handler's three flag sites**

In `api/calendar-reschedule.js`:

**(a)** Replace lines 74–84 (the `originalReminderSent` capture and the move patch) with:

```js
  // Captured BEFORE the move clears them: if the move is rolled back below, a
  // booking whose touches had already gone out must not be re-armed and sent a
  // second time. All three flags, not one -- a partially-sent cadence
  // (reminder24hSent='1', reminder2hSent='') has to come back exactly as it was.
  const originalTouchFlags = {};
  for (const flag of remind.TOUCH_FLAGS) originalTouchFlags[flag] = meta[flag] || '';

  // A moved call needs its WHOLE cadence again, so every flag is cleared --
  // including a 'moot' one, because mootness was a fact about the OLD start and
  // says nothing about the new one.
  const clearedTouchFlags = {};
  for (const flag of remind.TOUCH_FLAGS) clearedTouchFlags[flag] = '';

  const patched = await gcal.patchEvent(event.id, {
    start: { dateTime: new Date(startMs).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endMs).toISOString(), timeZone: 'UTC' },
    extendedProperties: { private: clearedTouchFlags },
  }, { notifyGuests: true });
```

**(b)** In the rollback branch (lines 99–105), replace the `extendedProperties` line:

```js
        await gcal.patchEvent(event.id, {
          start: { dateTime: new Date(oldStart).toISOString(), timeZone: 'UTC' },
          end: { dateTime: new Date(oldEnd).toISOString(), timeZone: 'UTC' },
          // Undo the cadence re-arm too, or a booking whose touches had already
          // been sent gets them all again after a lost race.
          extendedProperties: { private: originalTouchFlags },
        }, { notifyGuests: true });
```

**(c)** Replace lines 151–189 (the `// ---- Short-notice reminder` block through the closing brace) with:

```js
  // ---- The three-touch cadence, re-planned for the NEW start --------------
  // The move just cleared all three flags, so the moved call is owed its whole
  // cadence again -- and a visitor moving a call to this afternoon has re-armed
  // touches that nothing will ever send unless they are re-planned here. That is
  // worse than the booking path's version of the same hole: there the flags were
  // never set, here they were cleared deliberately, so the cadence is owed.
  //
  // Evaluated against the NEW start, and only on the path where that new time
  // actually stuck: the rollback branch above returns 409, so a lost race never
  // reaches here. That is the right split -- after a rollback the booking sits at
  // its ORIGINAL time, whose own cadence was planned when it was first created,
  // and originalTouchFlags has been put back untouched.
  await remind.applyTouchPlan({
    eventId: event.id, booking, isCheckin: false, nowMs: Date.now(), context: 'reschedule',
  });
  // -------------------------------------------------------------------------
```

- [ ] **Step 6: Make the same two changes in the check-in handlers**

In `api/calendar-checkin.js`:

**(a)** Replace lines 400–429 (the book handler's short-notice block) with:

```js
  // ---- The three-touch cadence (mirrors calendar-book.js exactly) ----------
  // The check-in audience gets the identical ~24h/~2h/~10min treatment, with
  // the check-in senders chosen by applyTouchPlan's isCheckin flag. After the
  // rollback check above for the same reason as the applicant path: that branch
  // returns 409, so a withdrawn booking is never reminded about.
  await remind.applyTouchPlan({
    eventId, booking, isCheckin: true, nowMs: Date.now(), context: 'check-in booking',
  });
  // -------------------------------------------------------------------------
```

**(b)** Replace lines 594–604 (the reschedule handler's capture and move patch) with:

```js
  // Captured BEFORE the move clears them -- see calendar-reschedule.js for the
  // full reasoning. All three flags, so a partially-sent cadence comes back
  // exactly as it was.
  const originalTouchFlags = {};
  for (const flag of remind.TOUCH_FLAGS) originalTouchFlags[flag] = meta[flag] || '';

  const clearedTouchFlags = {};
  for (const flag of remind.TOUCH_FLAGS) clearedTouchFlags[flag] = '';

  const patched = await gcal.patchEvent(event.id, {
    start: { dateTime: new Date(startMs).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endMs).toISOString(), timeZone: 'UTC' },
    // A moved check-in needs its whole cadence again.
    extendedProperties: { private: clearedTouchFlags },
  }, { notifyGuests: true });
```

**(c)** In the rollback branch (lines 619–625), replace the `extendedProperties` line with `extendedProperties: { private: originalTouchFlags },` keeping the surrounding comment.

**(d)** Replace lines 676–701 (the reschedule handler's short-notice block through its closing brace) with:

```js
  // ---- The three-touch cadence, re-planned for the NEW start --------------
  // Mirrors calendar-reschedule.js exactly. The move cleared all three flags, so
  // the moved check-in is owed its whole cadence again, evaluated against the
  // NEW start and only on the path where that new time stuck -- the rollback
  // branch above returns 409, and after a rollback the booking is back at its
  // original time with originalTouchFlags restored untouched.
  await remind.applyTouchPlan({
    eventId: event.id, booking, isCheckin: true, nowMs: Date.now(),
    context: 'check-in reschedule',
  });
  // -------------------------------------------------------------------------
```

- [ ] **Step 7: Update the four handlers' test files**

These four files assert the OLD single-reminder behaviour and will all fail. The edits are mechanical, and the same four edits apply to each file:

1. **Flag rename.** Every `reminderSent` identifier becomes the right one of the three. In the reschedule files the move patch now writes three keys, so an assertion like `assert.equal(payload.extendedProperties.private.reminderSent, '')` becomes:
   ```js
   assert.deepEqual(payload.extendedProperties.private, {
     reminder24hSent: '', reminder2hSent: '', reminder10mSent: '',
   });
   ```
   and the lost-race rollback assertion becomes:
   ```js
   assert.deepEqual(patchSpy.calls[1][1].extendedProperties.private, {
     reminder24hSent: '1', reminder2hSent: '', reminder10mSent: '',
   });
   ```
   (with whichever original flags the fixture set — the point of the test is that they come back exactly as they were, not that they are all `'1'`).

2. **`SHORT NOTICE` tests invert.** `test/calendar-book.test.js:643`, `test/calendar-reschedule.test.js:572`, `test/calendar-checkin-book.test.js:957` and `test/calendar-checkin-reschedule.test.js:811` each assert that a 1h-notice booking sends a reminder immediately. Replace each with its new expectation. For `test/calendar-book.test.js`:

```js
// A 1-hour-notice booking no longer sends anything at booking time. Its 24h and
// 2h touches are MOOT -- their moments passed before the booking existed -- and
// its 10-minute touch is left to the external 5-minute poller, which has a
// 10-minute window and a 5-minute period, so it provably lands. See
// test/reminder-delivery-guarantee.test.js for the proof.
test('SHORT NOTICE: a 1h-notice booking stamps the moot touches and sends nothing immediately', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const soonSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true });
  await withStubs([
    ...bookingStubs({ patchSpy }),
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: email, key: 'sendStartingSoon', value: soonSpy },
  ], async () => {
    const res = makeRes();
    await handler(bookReq({ startMs: Date.now() + 3600000 }), res);
    assert.equal(res._status, 200);
    assert.equal(reminderSpy.calls.length, 0,
      'the 24h/2h copy must NOT arrive beside the confirmation email');
    assert.equal(soonSpy.calls.length, 0,
      'the 10-minute copy belongs to the poller, fifty minutes from now');
    const flagPatch = patchSpy.calls.find(c => c[1].extendedProperties
      && c[1].extendedProperties.private
      && c[1].extendedProperties.private.reminder24hSent !== undefined);
    assert.ok(flagPatch, `expected a moot-stamp patch, got ${JSON.stringify(patchSpy.calls)}`);
    assert.deepEqual(flagPatch[1].extendedProperties.private,
      { reminder24hSent: 'moot', reminder2hSent: 'moot' },
      'both unreachable touches stamped moot in ONE patch; the 10m flag stays clear');
  });
});

test('VERY SHORT NOTICE: a 5-minute-notice booking stamps all three moot and sends nothing', async () => {
  envSetup();
  const reminderSpy = spyStub({ ok: true });
  const soonSpy = spyStub({ ok: true });
  const patchSpy = spyStub({ ok: true });
  await withStubs([
    ...bookingStubs({ patchSpy }),
    { obj: email, key: 'sendReminder', value: reminderSpy },
    { obj: email, key: 'sendStartingSoon', value: soonSpy },
  ], async () => {
    const res = makeRes();
    await handler(bookReq({ startMs: Date.now() + 5 * 60000 }), res);
    assert.equal(res._status, 200);
    assert.equal(reminderSpy.calls.length + soonSpy.calls.length, 0,
      'the confirmation email is deliberately the only thing that fires this close in');
    const flagPatch = patchSpy.calls.find(c => c[1].extendedProperties
      && c[1].extendedProperties.private
      && c[1].extendedProperties.private.reminder24hSent !== undefined);
    assert.deepEqual(flagPatch[1].extendedProperties.private,
      { reminder24hSent: 'moot', reminder2hSent: 'moot', reminder10mSent: 'moot' });
  });
});
```

Adapt the stub/request helpers (`bookingStubs`, `bookReq`, `envSetup`) to whatever the file already uses — these four files each have their own local versions, and the names above are illustrative of the existing ones. Write the equivalent pair in each of the other three files, swapping `email.sendReminder`/`email.sendStartingSoon` for `cemail.sendCheckinReminder`/`cemail.sendCheckinStartingSoon` in the two check-in files and driving the reschedule files through their reschedule request instead.

3. **`NORMAL NOTICE` tests tighten.** `test/calendar-book.test.js:695` and its three siblings assert that a booking two days out triggers no immediate reminder and no flag patch. Keep them, and make the flag assertion cover all three flags:
```js
    assert.equal(patchSpy.calls.filter(c => c[1].extendedProperties
      && c[1].extendedProperties.private
      && remind.TOUCH_FLAGS.some(f => c[1].extendedProperties.private[f] !== undefined)).length, 0,
      'a well-noticed booking leaves every flag clear -- all three touches are the crons\' job');
```
(requiring `const remind = require('../api/calendar-reminders');` at the top of the file if it is not already there).

4. **The failed-send tests keep their point.** `test/calendar-book.test.js:780` asserts a failed send never marks the flag. That path is now only reachable when a touch is `'immediate'`, which needs `REMINDER_LEAD_HOURS` below 24 — so wrap the test body in a lead override:
```js
  const had = process.env.REMINDER_LEAD_HOURS;
  process.env.REMINDER_LEAD_HOURS = '12';
  try { /* existing body, asserting reminder24hSent is never set to '1' */ }
  finally {
    if (had === undefined) delete process.env.REMINDER_LEAD_HOURS;
    else process.env.REMINDER_LEAD_HOURS = had;
  }
```

- [ ] **Step 8: Run the five affected suites**

Run: `node --test test/reminder-delivery-guarantee.test.js test/calendar-book.test.js test/calendar-reschedule.test.js test/calendar-checkin-book.test.js test/calendar-checkin-reschedule.test.js`
Expected: PASS, all five.

- [ ] **Step 9: Confirm the retired flag and predicate are gone everywhere**

Run: `grep -rn "reminderSent\|needsImmediateReminder" api/ test/ ; echo "exit=$?"`
Expected: `grep` prints **nothing** and `exit=1` (no matches). Any hit is a call site this task missed — the whole point of deleting rather than aliasing the name is that the compiler and this grep find them for you.

- [ ] **Step 10: Run the whole suite**

Run: `npm test`
Expected: PASS. This is the first point at which the full three-touch cadence is coherent end to end — flags, both cron paths, and all four booking handlers.

- [ ] **Step 11: Commit**

```bash
git add api/calendar-reminders.js api/calendar-book.js api/calendar-reschedule.js api/calendar-checkin.js test/
git commit -m "feat(reminders): plan all three touches at booking and reschedule time

applyTouchPlan replaces needsImmediateReminder in all four handlers: moot
touches are stamped so no cron sends them, unreliable ones are sent on the
spot, reachable ones are left alone. Reschedules clear and restore all three
flags. reminder-delivery-guarantee.test.js is rewritten around the new
invariant: every booking with 10+ minutes of notice gets at least one touch,
and nothing is ever delivered twice."
```

---

### Task 8: The cadence state document

**Files:**
- Create: `api/_checkin-cadence.js`
- Test: `test/checkin-cadence.test.js`

**Interfaces:**
- Consumes: `store.readJson`/`store.writeJson`/`store.CHECKIN_CADENCE_BLOB` (Task 1); `cemail.NUDGE_TIERS` (Task 4); `cc.isAccessActive` from the existing `api/_checkin-clients.js`. (No cycle: `_checkin-clients.js` requires only `_blob-store.js`, and `_checkin-email.js` requires only `_email.js` and `_site-url.js`.)
- Produces `require('./_checkin-cadence')` →
  - `NUDGE_TIERS` — re-exported from `_checkin-email.js` so there is ONE list, not two
  - `TIER_BY_WEEKDAY` — frozen `{ mon:null, tue:'neutral', wed:null, thu:'direct', fri:null, sat:'urgent', sun:'lastcall' }`
  - `tierForWeekday(weekdayKey) -> 'neutral'|'direct'|'urgent'|'lastcall'|null`
  - `hasCheckinObligation(client, nowMs) -> boolean` — the nudge scope filter: an active, non-paused package that is not the "No package" sentinel
  - `emptyWeekEntry() -> { reassuranceSent: false, nudges: { neutral:false, direct:false, urgent:false, lastcall:false } }`
  - `emptyDayEntry() -> { heartbeatTs: null, touches: {'24h':0,'2h':0,'10m':0}, nudges: {neutral:0,direct:0,urgent:0,lastcall:0,reassurance:0}, failures: 0 }`
  - `emptyNudgeCounts() -> { neutral:0, direct:0, urgent:0, lastcall:0, reassurance:0 }`
  - `normalizeState(raw) -> { weeks: object, days: object }` — total, never throws, never drops a well-formed field
  - `loadState() -> Promise<{ ok: boolean, state: {weeks,days}, reason?: string }>` — a missing blob is `ok:true` with an empty state, not an error
  - `saveState(state) -> Promise<{ ok: boolean, reason?: string }>`
  - `mutate(fn) -> Promise<{ ok: boolean, state: {weeks,days}, reason?: string }>` — read, hand the normalized state to `fn`, write it back
  - `weekEntry(state, mondayYmd, email) -> entry` — creates the week and the client's entry in place and returns it
  - `dayEntry(state, dayYmd) -> entry` — creates the day in place and returns it

**THE ONE HARD RULE IN THIS MODULE: `mutate()` must never be called from inside another `mutate()` callback, and nothing here may be wrapped in a serializing queue.** The spec calls this out in advance as the nested-queue deadlock: if the write step were queued and something upstream queued its caller on the same queue, the outer call would hold the slot the inner call waits on, forever. A single read-merge-write is idempotent enough for this data — two simultaneous runs can at worst lose one increment of a counter that exists to be glanced at in Slack. Do not "harden" this.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-cadence.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const cemail = require('../api/_checkin-email');
const cadence = require('../api/_checkin-cadence');

// A blob client backed by one in-memory document, so a read-modify-write can be
// observed end to end rather than stubbed into always returning null.
function memoryBlobClient(initial) {
  const box = { text: initial === undefined ? null : JSON.stringify(initial) };
  return {
    box,
    get: async () => (box.text === null ? null : { stream: box.text }),
    put: async (_path, body) => { box.text = body; return {}; },
  };
}

// _blob-store reads with `new Response(result.stream).text()`, so the fake's
// `stream` can simply be the string -- Response accepts one.
function envSetup(initial) {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const client = memoryBlobClient(initial);
  store.__setClientForTests(client);
  return client;
}

test('the tier list is the SAME list the email module exports, not a second copy', () => {
  assert.deepEqual(cadence.NUDGE_TIERS, cemail.NUDGE_TIERS);
  assert.deepEqual(cadence.NUDGE_TIERS, ['neutral', 'direct', 'urgent', 'lastcall']);
});

test('the day mapping escalates across the week and leaves three quiet days', () => {
  assert.deepEqual(cadence.TIER_BY_WEEKDAY, {
    mon: null, tue: 'neutral', wed: null, thu: 'direct',
    fri: null, sat: 'urgent', sun: 'lastcall',
  });
  assert.equal(cadence.tierForWeekday('tue'), 'neutral');
  assert.equal(cadence.tierForWeekday('sun'), 'lastcall');
  assert.equal(cadence.tierForWeekday('mon'), null);
  assert.equal(cadence.tierForWeekday('nonsense'), null);
  assert.equal(cadence.tierForWeekday(undefined), null);

  // The mapped days must appear in escalation order as the week runs, or a
  // client would get "last call" on Tuesday and "just checking" on Sunday.
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    .map(cadence.tierForWeekday).filter(Boolean);
  assert.deepEqual(order, cadence.NUDGE_TIERS);
});

// The spec's exclusion list, and the trap inside it: isAccessActive() alone is
// the WRONG filter, because a durationMonths === 0 ("No package") client has a
// null expiresAt and therefore reads as active.
test('hasCheckinObligation excludes paused, expired AND no-package clients', () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const base = { name: 'C', email: 'c@x.co', durationMonths: 12,
    pausedAt: null, expiresAt: Date.UTC(2027, 0, 1) };
  assert.equal(cadence.hasCheckinObligation(base, now), true);
  assert.equal(cadence.hasCheckinObligation({ ...base, pausedAt: now - 1000 }, now), false);
  assert.equal(cadence.hasCheckinObligation({ ...base, expiresAt: now - 1000 }, now), false);
  assert.equal(cadence.hasCheckinObligation({ ...base, durationMonths: 0, expiresAt: null }, now),
    false, 'a "No package" client has no weekly check-in obligation, per spec');
  // A -1 ("Custom", exact end date) client DOES have an obligation -- they have
  // a real package, just one whose end the admin set by hand.
  assert.equal(cadence.hasCheckinObligation({ ...base, durationMonths: -1 }, now), true);
  // A null expiresAt on a REAL package means "not configured yet" and stays
  // active, same as everywhere else in the system.
  assert.equal(cadence.hasCheckinObligation({ ...base, expiresAt: null }, now), true);
  assert.equal(cadence.hasCheckinObligation(null, now), false);
});

test('an empty week entry has every tier unsent', () => {
  assert.deepEqual(cadence.emptyWeekEntry(), {
    reassuranceSent: false,
    nudges: { neutral: false, direct: false, urgent: false, lastcall: false },
  });
});

test('an empty day entry counts every touch and tier at zero', () => {
  assert.deepEqual(cadence.emptyDayEntry(), {
    heartbeatTs: null,
    touches: { '24h': 0, '2h': 0, '10m': 0 },
    nudges: { neutral: 0, direct: 0, urgent: 0, lastcall: 0, reassurance: 0 },
    failures: 0,
  });
});

test('a missing blob is a normal first run, not an error', async () => {
  envSetup(undefined);
  const loaded = await cadence.loadState();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.state, { weeks: {}, days: {} });
});

test('weekEntry and dayEntry create their slots in place and return the same object twice', async () => {
  envSetup(undefined);
  const { state } = await cadence.loadState();
  const a = cadence.weekEntry(state, '2026-10-05', 'alice@example.com');
  a.nudges.neutral = true;
  const b = cadence.weekEntry(state, '2026-10-05', 'alice@example.com');
  assert.equal(b.nudges.neutral, true, 'the second call must return the SAME entry, not a fresh one');
  assert.deepEqual(Object.keys(state.weeks), ['2026-10-05']);

  const d1 = cadence.dayEntry(state, '2026-10-07');
  d1.touches['2h'] = 3;
  assert.equal(cadence.dayEntry(state, '2026-10-07').touches['2h'], 3);
});

test('emails are keyed case-insensitively, so one client is never two rows', async () => {
  envSetup(undefined);
  const { state } = await cadence.loadState();
  cadence.weekEntry(state, '2026-10-05', 'Alice@Example.COM').reassuranceSent = true;
  const again = cadence.weekEntry(state, '2026-10-05', 'alice@example.com');
  assert.equal(again.reassuranceSent, true);
  assert.deepEqual(Object.keys(state.weeks['2026-10-05']), ['alice@example.com']);
});

test('a round trip through the blob preserves every flag', async () => {
  const client = envSetup(undefined);
  const { state } = await cadence.loadState();
  cadence.weekEntry(state, '2026-10-05', 'alice@example.com').nudges.direct = true;
  cadence.dayEntry(state, '2026-10-08').heartbeatTs = '1760000000.000100';
  const saved = await cadence.saveState(state);
  assert.equal(saved.ok, true);
  assert.ok(client.box.text, 'something must actually have been written');

  const reread = await cadence.loadState();
  assert.equal(reread.state.weeks['2026-10-05']['alice@example.com'].nudges.direct, true);
  assert.equal(reread.state.days['2026-10-08'].heartbeatTs, '1760000000.000100');
});

// The bug class this codebase has been bitten by twice: a field normalization
// does not carry through vanishes on the next save.
test('normalizeState keeps every well-formed field and substitutes safe defaults for junk', () => {
  const out = cadence.normalizeState({
    weeks: {
      '2026-10-05': {
        'alice@example.com': { reassuranceSent: true, nudges: { direct: true } },
        'bob@example.com': 'not an object',
      },
      'not-a-monday-key': { 'x@y.co': {} },
    },
    days: {
      '2026-10-08': { heartbeatTs: '123.456', touches: { '2h': 4 }, failures: 2 },
      '2026-10-09': null,
    },
    somethingElse: 'dropped',
  });

  const alice = out.weeks['2026-10-05']['alice@example.com'];
  assert.equal(alice.reassuranceSent, true);
  assert.deepEqual(alice.nudges, { neutral: false, direct: true, urgent: false, lastcall: false },
    'a partially-written nudges object is filled out, not replaced');
  assert.deepEqual(out.weeks['2026-10-05']['bob@example.com'], cadence.emptyWeekEntry(),
    'a junk entry becomes an empty one rather than crashing a later read');
  assert.equal(out.weeks['not-a-monday-key'], undefined,
    'a key that is not a YYYY-MM-DD date is dropped -- it can only be corruption');

  const day = out.days['2026-10-08'];
  assert.equal(day.heartbeatTs, '123.456');
  assert.deepEqual(day.touches, { '24h': 0, '2h': 4, '10m': 0 });
  assert.equal(day.failures, 2);
  assert.deepEqual(out.days['2026-10-09'], cadence.emptyDayEntry());
  assert.equal(out.somethingElse, undefined);
});

test('normalizeState never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, 0, '', 'nope', [], { weeks: 7, days: 'x' }]) {
    const out = cadence.normalizeState(junk);
    assert.deepEqual(Object.keys(out).sort(), ['days', 'weeks']);
    assert.equal(typeof out.weeks, 'object');
    assert.equal(typeof out.days, 'object');
  }
});

test('mutate reads, applies the callback, and writes back in one pass', async () => {
  const client = envSetup(undefined);
  const r = await cadence.mutate((state) => {
    cadence.dayEntry(state, '2026-10-08').touches['10m'] += 1;
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.days['2026-10-08'].touches['10m'], 1);
  assert.equal(JSON.parse(client.box.text).days['2026-10-08'].touches['10m'], 1);

  // Idempotent in the sense that matters: calling it again sees the WRITTEN
  // value, not a stale in-memory one.
  const again = await cadence.mutate((state) => {
    cadence.dayEntry(state, '2026-10-08').touches['10m'] += 1;
  });
  assert.equal(again.state.days['2026-10-08'].touches['10m'], 2);
});

test('mutate surfaces a write failure instead of pretending it worked', async () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  store.__setClientForTests({
    get: async () => null,
    put: async () => { throw new Error('blob store on fire'); },
  });
  const r = await cadence.mutate((state) => { cadence.dayEntry(state, '2026-10-08').failures = 1; });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fire/);
});

// The deadlock the spec caught in advance. Asserted as a source-level property
// because the failure mode is a hang, which a normal test cannot observe without
// hanging too.
test('the module contains no queue, lock or mutex', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_checkin-cadence.js'), 'utf8');
  for (const word of ['Queue', 'queue', 'Mutex', 'mutex', 'acquireLock', 'withLock']) {
    assert.equal(src.includes(word), false,
      `_checkin-cadence.js must stay queue-free -- found "${word}". A queued write called `
      + 'from inside another queued call waits forever on a slot its own caller holds.');
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/checkin-cadence.test.js`
Expected: FAIL — `Cannot find module '../api/_checkin-cadence'`.

- [ ] **Step 3: Create `api/_checkin-cadence.js`**

```js
// The state behind the weekly check-in nudge cycle, and the small per-day
// counters the Slack heartbeat renders.
//
// ONE document, checkin-cadence-state.json, with two independent sections:
//
//   weeks   per Monday-anchored week, per client: which of the four escalation
//           tiers have already gone out, and whether the booked-branch
//           reassurance has. This is what makes the pass safe to run twice --
//           the admin's catch-up button is gated by exactly the same flags as
//           the automated run.
//   days    per calendar day: the heartbeat message's Slack ts, plus the
//           counters that message displays. Here rather than in its own
//           document because the two are written in the same cron tick and a
//           second blob would double the reads for nothing.
//
// NO QUEUE, NO LOCK, NO MUTEX -- deliberately, and this is load-bearing rather
// than laziness. Both the daily cron and the external 5-minute poller can touch
// the day counters at the same moment. The tempting fix is to serialize the
// write; the trap (caught in the design review, before it was built) is that a
// serialized write called from inside another serialized call waits forever on
// the slot its own caller is holding. The whole system then stops, silently,
// and the thing that stops is the thing that was supposed to TELL you it
// stopped. A plain read-merge-write is used instead. Its worst case is a lost
// increment on one counter that exists to be glanced at in Slack; the queue's
// worst case is a dead cron. Do not add one.
const store = require('./_blob-store');
const cc = require('./_checkin-clients');
const { NUDGE_TIERS } = require('./_checkin-email');

// ONE source of truth for the tier list: it is re-exported from the email
// module rather than restated, so a fifth tier cannot exist in the state
// machine without existing in the copy.
//
// The day mapping the spec left to implementation. Three quiet days on purpose:
// a nudge every single day is not escalation, it is a mail loop, and the client
// stops reading before the tier that was supposed to land does.
const TIER_BY_WEEKDAY = Object.freeze({
  mon: null,
  tue: 'neutral',
  wed: null,
  thu: 'direct',
  fri: null,
  sat: 'urgent',
  sun: 'lastcall',
});

function tierForWeekday(weekdayKey) {
  return TIER_BY_WEEKDAY[weekdayKey] || null;
}

// Who the weekly nudge applies to. NOT simply isAccessActive(): that returns
// true for a durationMonths === 0 ("No package") client, because their computed
// expiresAt is null and a null expiry means "no package configured yet, still
// active" to every booking-access check in the system. For BOOKING access that
// is right -- a No-package client may book whenever they like. For the weekly
// OBLIGATION it is wrong: the spec excludes them explicitly, because an
// admin-chosen ongoing/indefinite arrangement carries no weekly check-in
// commitment, and nudging one every Tuesday is a support ticket.
//
// Lives here rather than in _checkin-clients.js on purpose: isAccessActive is
// about whether someone MAY book, this is about whether someone OWES a booking,
// and conflating the two is how a No-package client ends up either nudged or
// locked out depending on which question got asked.
function hasCheckinObligation(client, nowMs) {
  if (!cc.isAccessActive(client, nowMs)) return false;
  return Number(client && client.durationMonths) !== 0;
}

const TOUCH_COUNT_KEYS = ['24h', '2h', '10m'];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyNudgeCounts() {
  const out = { reassurance: 0 };
  for (const tier of NUDGE_TIERS) out[tier] = 0;
  return out;
}

function emptyWeekEntry() {
  const nudges = {};
  for (const tier of NUDGE_TIERS) nudges[tier] = false;
  return { reassuranceSent: false, nudges };
}

function emptyDayEntry() {
  const touches = {};
  for (const key of TOUCH_COUNT_KEYS) touches[key] = 0;
  return { heartbeatTs: null, touches, nudges: emptyNudgeCounts(), failures: 0 };
}

function count(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// Defensive on READ as well as on write, like api/_checkin-clients.js, so a
// hand-edited blob (or one written before a field existed) still works. The
// rule throughout: FILL OUT a partially-written object, never replace it -- a
// normalization that drops an unrecognised-but-valid field is how state
// silently vanishes on the next save, which has bitten this codebase twice.
function normalizeWeekEntry(raw) {
  const out = emptyWeekEntry();
  if (!raw || typeof raw !== 'object') return out;
  out.reassuranceSent = raw.reassuranceSent === true;
  const nudges = (raw.nudges && typeof raw.nudges === 'object') ? raw.nudges : {};
  for (const tier of NUDGE_TIERS) out.nudges[tier] = nudges[tier] === true;
  return out;
}

function normalizeDayEntry(raw) {
  const out = emptyDayEntry();
  if (!raw || typeof raw !== 'object') return out;
  out.heartbeatTs = typeof raw.heartbeatTs === 'string' && raw.heartbeatTs ? raw.heartbeatTs : null;
  const touches = (raw.touches && typeof raw.touches === 'object') ? raw.touches : {};
  for (const key of TOUCH_COUNT_KEYS) out.touches[key] = count(touches[key]);
  const nudges = (raw.nudges && typeof raw.nudges === 'object') ? raw.nudges : {};
  for (const key of Object.keys(out.nudges)) out.nudges[key] = count(nudges[key]);
  out.failures = count(raw.failures);
  return out;
}

function normalizeState(raw) {
  const out = { weeks: {}, days: {} };
  if (!raw || typeof raw !== 'object') return out;

  const weeks = (raw.weeks && typeof raw.weeks === 'object' && !Array.isArray(raw.weeks))
    ? raw.weeks : {};
  for (const mondayYmd of Object.keys(weeks)) {
    // A key that is not a calendar date can only be corruption, and keeping it
    // would make the document grow without ever being read.
    if (!YMD_RE.test(mondayYmd)) continue;
    const clients = (weeks[mondayYmd] && typeof weeks[mondayYmd] === 'object') ? weeks[mondayYmd] : {};
    const bucket = {};
    for (const email of Object.keys(clients)) {
      const key = String(email).trim().toLowerCase();
      if (!key) continue;
      bucket[key] = normalizeWeekEntry(clients[email]);
    }
    out.weeks[mondayYmd] = bucket;
  }

  const days = (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days))
    ? raw.days : {};
  for (const dayYmd of Object.keys(days)) {
    if (!YMD_RE.test(dayYmd)) continue;
    out.days[dayYmd] = normalizeDayEntry(days[dayYmd]);
  }

  return out;
}

// A missing blob is not an error: it is a deployment where the cadence has
// never run. An empty state simply means nobody has been nudged yet.
async function loadState() {
  const read = await store.readJson(store.CHECKIN_CADENCE_BLOB);
  if (!read.ok) return { ok: false, reason: read.reason, state: normalizeState(null) };
  return { ok: true, state: normalizeState(read.data) };
}

async function saveState(state) {
  return store.writeJson(store.CHECKIN_CADENCE_BLOB, normalizeState(state));
}

// THE read-merge-write. `fn` receives the freshly-read, normalized state and
// mutates it in place; the result is written back.
//
// NEVER call mutate() from inside an fn passed to mutate(). It would work today
// (there is no lock to deadlock on) but it is the exact shape the spec warned
// about, and the day someone "makes it safe" by adding a queue is the day the
// inner call waits forever. Collect what you want to change and apply it in ONE
// callback instead.
async function mutate(fn) {
  const loaded = await loadState();
  if (!loaded.ok) return { ok: false, reason: loaded.reason, state: loaded.state };
  fn(loaded.state);
  const written = await saveState(loaded.state);
  if (!written.ok) return { ok: false, reason: written.reason, state: loaded.state };
  return { ok: true, state: loaded.state };
}

// Creates the slot in place if it is not there and returns it, so a caller can
// read-and-set in one expression without a three-line existence dance at every
// call site. Email is lower-cased here and nowhere else, which is what keeps
// one client from becoming two rows.
function weekEntry(state, mondayYmd, email) {
  if (!state.weeks[mondayYmd]) state.weeks[mondayYmd] = {};
  const key = String(email || '').trim().toLowerCase();
  if (!state.weeks[mondayYmd][key]) state.weeks[mondayYmd][key] = emptyWeekEntry();
  return state.weeks[mondayYmd][key];
}

function dayEntry(state, dayYmd) {
  if (!state.days[dayYmd]) state.days[dayYmd] = emptyDayEntry();
  return state.days[dayYmd];
}

module.exports = {
  NUDGE_TIERS, TIER_BY_WEEKDAY, TOUCH_COUNT_KEYS, tierForWeekday,
  hasCheckinObligation,
  emptyWeekEntry, emptyDayEntry, emptyNudgeCounts, normalizeState,
  loadState, saveState, mutate, weekEntry, dayEntry,
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/checkin-cadence.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_checkin-cadence.js test/checkin-cadence.test.js
git commit -m "feat(cadence): add the checkin-cadence-state.json module

Per-week, per-client nudge flags plus per-day heartbeat counters, with the
Tue/Thu/Sat/Sun escalation mapping. Read-merge-write only -- no queue, no lock,
per the nested-deadlock the design review caught in advance."
```

---

### Task 9: The weekly nudge pass, and the admin catch-up that replays it

**Files:**
- Modify: `api/calendar-reminders.js` (add `runWeeklyNudgePass`, call it on the daily path, widen the response)
- Modify: `admin.html:630-633` (button label) and `admin.html:2231-2268` (`wireRemindersCatchup`)
- Test: `test/checkin-nudge-pass.test.js`

**Interfaces:**
- Consumes: `cadence.hasCheckinObligation`/`tierForWeekday`/`loadState`/`mutate`/`weekEntry`/`emptyNudgeCounts` (Task 8); `cemail.sendCheckinNudge`/`sendCheckinAllSet` (Task 4); `cc.loadClients`/`normalizeEmail` from `api/_checkin-clients.js`; `tz.weekWindow`/`weekdayKeyInZone` (Task 2); `loadCheckinTemplate`; `gcal.listEvents`; `isCheckinEvent`; `guard.EVENT_MARKER`.
- Produces:
  - `module.exports.runWeeklyNudgePass(nowMs) -> Promise<{ ok: true, mondayYmd: string, weekdayKey: string, tier: string|null, considered: number, sent: number, skipped: number, failures: number, nudges: {neutral,direct,urgent,lastcall,reassurance} } | { ok: false, reason: string }>`
  - The daily response body gains `nudges` (the same counts object) and `mondayYmd`. The fine response does **not** — the nudge pass is daily-only.

**Why this lives in `calendar-reminders.js` rather than in `_checkin-cadence.js`:** the pass needs the Google client, the check-in template loader, the booking guard's marker and the check-in email senders — the same four collaborators `runTouchPass` already has wired up, and it is invoked from exactly one place, this cron. Putting it in the state module would drag all four into a file whose whole value is being the small, pure, easily-tested one.

- [ ] **Step 1: Write the failing test**

Create `test/checkin-nudge-pass.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const cc = require('../api/_checkin-clients');
const cemail = require('../api/_checkin-email');
const cadence = require('../api/_checkin-cadence');
const loadCheckinMod = require('../api/_load-checkin-template');
const handler = require('../api/calendar-reminders');

function memoryBlobClient() {
  const box = { text: null };
  return {
    box,
    get: async () => (box.text === null ? null : { stream: box.text }),
    put: async (_p, body) => { box.text = body; return {}; },
  };
}

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try { return await fn(); } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

const ZONE = 'America/Toronto';

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REMINDER_FINE_CRON_SECRET = 'test-fine-cron-secret';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  return store.__setClientForTests(memoryBlobClient()) || null;
}

// A real instant in a known week: 2026-10-05 is a Monday, so the week runs
// 05 Oct (Mon) through 11 Oct (Sun) in Toronto.
function at(day, hour) {
  const tz = require('../api/_timezone');
  return tz.zonedWallTimeToUtc(2026, 10, day, hour, 0, ZONE);
}

function client(email, overrides = {}) {
  return {
    name: 'Client ' + email, email, phone: '',
    startDate: '2026-01-01', durationMonths: 12, customEndDate: '',
    pausedAt: null, expiresAt: Date.UTC(2027, 0, 1), paymentsByMonth: {},
    ...overrides,
  };
}

function checkinEvent(email, startMs) {
  return {
    id: 'evt-' + email,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + 900000).toISOString() },
    extendedProperties: { private: {
      bookingSource: guard.EVENT_MARKER, audience: 'checkin',
      visitorEmail: email, visitorName: 'Client', visitorTimeZone: 'Europe/Istanbul',
    } },
  };
}

function templateStub() {
  return { obj: loadCheckinMod, key: 'loadCheckinTemplate',
    value: async () => ({ ok: true, template: { timezone: ZONE } }) };
}

test('a not-booked active client gets exactly the day\'s tier', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  const allSetSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
    { obj: cemail, key: 'sendCheckinAllSet', value: allSetSpy },
  ], async () => {
    // Thursday 08 Oct -> 'direct'
    const r = await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(r.ok, true);
    assert.equal(r.mondayYmd, '2026-10-05');
    assert.equal(r.weekdayKey, 'thu');
    assert.equal(r.tier, 'direct');
    assert.equal(nudgeSpy.calls.length, 1);
    assert.equal(nudgeSpy.calls[0][0].email, 'a@x.co');
    assert.equal(nudgeSpy.calls[0][1], 'direct');
    assert.equal(allSetSpy.calls.length, 0);
    assert.deepEqual(r.nudges,
      { neutral: 0, direct: 1, urgent: 0, lastcall: 0, reassurance: 0 });
  });
});

test('a booked client gets the reassurance instead, carrying the booked time', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  const allSetSpy = spyStub({ ok: true });
  const bookedAt = at(9, 14);
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [checkinEvent('a@x.co', bookedAt)] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
    { obj: cemail, key: 'sendCheckinAllSet', value: allSetSpy },
  ], async () => {
    const r = await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(nudgeSpy.calls.length, 0, 'a booked client must never be nudged to book');
    assert.equal(allSetSpy.calls.length, 1);
    assert.equal(allSetSpy.calls[0][0].email, 'a@x.co');
    assert.equal(allSetSpy.calls[0][0].startMs, bookedAt);
    assert.equal(allSetSpy.calls[0][0].visitorTimeZone, 'Europe/Istanbul');
    assert.deepEqual(r.nudges,
      { neutral: 0, direct: 0, urgent: 0, lastcall: 0, reassurance: 1 });
  });
});

// The spec's exclusion, and the one with a real cost if it is wrong: a paused or
// no-package client has no check-in obligation, and nudging them weekly is a
// support ticket at best.
test('paused, expired and no-package clients are excluded entirely', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  const now = at(8, 10);
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [
      client('active@x.co'),
      client('paused@x.co', { pausedAt: now - 86400000 }),
      client('expired@x.co', { expiresAt: now - 86400000 }),
      client('nopackage@x.co', { durationMonths: 0, expiresAt: null }),
    ] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    const r = await handler.runWeeklyNudgePass(now);
    const nudged = nudgeSpy.calls.map(c => c[0].email).sort();
    // The no-package client is the subtle one: a durationMonths === 0 client has
    // a null expiresAt, so isAccessActive() says yes. hasCheckinObligation() is
    // what says no, and using the wrong one here is the single most likely way
    // this pass annoys a real person weekly.
    assert.deepEqual(nudged, ['active@x.co']);
    assert.equal(r.considered, 1, 'only clients with a real obligation are even considered');
  });
});

test('a tier already sent this week is not resent, and lower tiers are not re-fired', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  const stubs = [
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ];
  await withStubs(stubs, async () => {
    await handler.runWeeklyNudgePass(at(7, 10)); // Wed -> no tier, nothing
    assert.equal(nudgeSpy.calls.length, 0, 'Wednesday is a quiet day');

    await handler.runWeeklyNudgePass(at(8, 10)); // Thu -> direct
    await handler.runWeeklyNudgePass(at(8, 23)); // Thu again (admin catch-up)
    assert.equal(nudgeSpy.calls.length, 1, 'the same tier must never be sent twice in a week');

    await handler.runWeeklyNudgePass(at(10, 10)); // Sat -> urgent
    assert.deepEqual(nudgeSpy.calls.map(c => c[1]), ['direct', 'urgent'],
      'a later tier fires without re-firing the earlier one');
  });
});

test('the reassurance is sent at most once a week', async () => {
  envSetup();
  const allSetSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [checkinEvent('a@x.co', at(9, 14))] }) },
    { obj: cemail, key: 'sendCheckinAllSet', value: allSetSpy },
  ], async () => {
    await handler.runWeeklyNudgePass(at(6, 10));
    await handler.runWeeklyNudgePass(at(8, 10));
    await handler.runWeeklyNudgePass(at(11, 10));
    assert.equal(allSetSpy.calls.length, 1);
  });
});

test('the week resets on Monday: the next week starts from a clean slate', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    const a = await handler.runWeeklyNudgePass(at(6, 10));   // Tue 06 Oct -> neutral
    const b = await handler.runWeeklyNudgePass(at(13, 10));  // Tue 13 Oct -> neutral again
    assert.equal(a.mondayYmd, '2026-10-05');
    assert.equal(b.mondayYmd, '2026-10-12');
    assert.deepEqual(nudgeSpy.calls.map(c => c[1]), ['neutral', 'neutral']);
  });
});

test('a booking OUTSIDE this week does not count as booked', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [checkinEvent('a@x.co', at(14, 10))] }) }, // next week
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(nudgeSpy.calls.length, 1, 'next week\'s booking does not satisfy this week');
  });
});

test('an APPLICANT booking by the same person does not count as a check-in', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  const applicantEvent = checkinEvent('a@x.co', at(9, 14));
  delete applicantEvent.extendedProperties.private.audience;
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [applicantEvent] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(nudgeSpy.calls.length, 1);
  });
});

test('the week is listed ONCE, not once per client', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients:
      ['a', 'b', 'c', 'd', 'e'].map(n => client(`${n}@x.co`)) }) },
    { obj: gcal, key: 'listEvents', value: listSpy },
    { obj: cemail, key: 'sendCheckinNudge', value: spyStub({ ok: true }) },
  ], async () => {
    await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(listSpy.calls.length, 1, 'five clients must not mean five calendar reads');
    const arg = listSpy.calls[0][0];
    assert.equal(Date.parse(arg.timeMaxIso) - Date.parse(arg.timeMinIso), 7 * 86400000);
  });
});

test('a failed send does NOT mark the tier, so the next run retries it', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: false, reason: 'resend down' });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    const first = await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(first.failures, 1);
    assert.deepEqual(first.nudges, { neutral: 0, direct: 0, urgent: 0, lastcall: 0, reassurance: 0 });
    await handler.runWeeklyNudgePass(at(8, 11));
    assert.equal(nudgeSpy.calls.length, 2, 'an unmarked tier must be retried');
  });
});

test('the daily cron runs the nudge pass and reports it; the fine pass does not', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    const makeRes = () => ({ _status: null, _json: null,
      status(c) { this._status = c; return this; },
      json(p) { this._json = p; return this; },
      setHeader() { return this; }, end() { return this; } });

    const daily = makeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' },
      url: '/api/calendar-reminders', query: {} }, daily);
    assert.equal(daily._status, 200);
    assert.ok(daily._json.nudges, 'the daily response must report the nudge pass');
    assert.equal(typeof daily._json.mondayYmd, 'string');

    const fine = makeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer test-fine-cron-secret' },
      url: '/api/calendar-reminders?touch=fine', query: { touch: 'fine' } }, fine);
    assert.equal(fine._json.nudges, undefined,
      'the 5-minute poller must NOT run a weekly pass twelve times an hour');
  });
});

// The whole point of the dedup flags: the admin's catch-up button is safe to
// click repeatedly.
test('ADMIN CATCH-UP: clicking the button twice sends each thing exactly once', async () => {
  envSetup();
  const auth = require('../api/_admin-auth');
  const nudgeSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    const cookie = auth.issueSessionCookie().split(';')[0];
    const makeRes = () => ({ _status: null, _json: null,
      status(c) { this._status = c; return this; },
      json(p) { this._json = p; return this; },
      setHeader() { return this; }, end() { return this; } });
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: {},
        url: '/api/calendar-reminders', query: {} }, res);
      assert.equal(res._status, 200);
    }
    assert.ok(nudgeSpy.calls.length <= 1,
      `the catch-up button must be safe to click repeatedly, sent ${nudgeSpy.calls.length}`);
  });
});

test('a calendar failure fails the nudge pass WITHOUT sending anything', async () => {
  envSetup();
  const nudgeSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'calendar down' }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
  ], async () => {
    const r = await handler.runWeeklyNudgePass(at(8, 10));
    assert.equal(r.ok, false);
    assert.match(r.reason, /calendar down/);
    assert.equal(nudgeSpy.calls.length, 0,
      'without the week\'s bookings we cannot tell who booked -- nudging everyone would be worse than nudging nobody');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/checkin-nudge-pass.test.js`
Expected: FAIL — `handler.runWeeklyNudgePass is not a function`.

- [ ] **Step 3: Add the pass to `api/calendar-reminders.js`**

Add these requires beside the existing ones at the top of the file:

```js
const tz = require('./_timezone');
const cc = require('./_checkin-clients');
const cadence = require('./_checkin-cadence');
```

Then insert `runWeeklyNudgePass` immediately after `applyTouchPlan`:

```js
// The check-in audience's recurring obligation, once a week, Monday-reset.
//
// Unlike the pre-call touches, this is not about a booking that exists -- it is
// about one that SHOULD. A client with an active package is expected to book a
// check-in every week, and this pass is what notices they have not.
//
// BRANCHES ON DONE-STATUS, NOT ON SILENCE. A client who already booked gets a
// one-time "you're all set" rather than nothing. Nothing is indistinguishable
// from a broken cron, and a weekly system the client cannot see working is one
// they stop trusting.
//
// Day-level granularity is enough here, so this rides the once-daily cron and
// needs no new infrastructure -- the external 5-minute poller deliberately does
// NOT run it.
async function runWeeklyNudgePass(nowMs) {
  // The week is anchored to the CHECK-IN template's own timezone, not UTC and
  // not the server's: "this week" has to mean the same week to Omar and to the
  // client, and the reset has to happen at a local Monday midnight.
  const tplRes = await checkinTemplateMod.loadCheckinTemplate();
  const zone = tplRes.template.timezone;
  const week = tz.weekWindow(nowMs, zone);
  const weekdayKey = tz.weekdayKeyInZone(nowMs, zone);
  const tier = cadence.tierForWeekday(weekdayKey);

  const base = {
    mondayYmd: week.mondayYmd, weekdayKey, tier,
    considered: 0, sent: 0, skipped: 0, failures: 0, nudges: cadence.emptyNudgeCounts(),
  };

  const loadedClients = await cc.loadClients();
  // Scope, per spec: only clients with an active, non-paused, real package.
  // hasCheckinObligation, NOT isAccessActive -- the latter returns true for a
  // "No package" client, who has no weekly obligation to nudge about.
  const active = (loadedClients.clients || []).filter(c => cadence.hasCheckinObligation(c, nowMs));
  base.considered = active.length;
  if (!active.length) return { ok: true, ...base };

  // ONE listEvents for the whole week, grouped by attendee email -- not one call
  // per client. With a roster of any size the per-client version is both slow
  // and a fast route to Google's rate limit.
  const listed = await gcal.listEvents({
    timeMinIso: new Date(week.startMs).toISOString(),
    timeMaxIso: new Date(week.endMs).toISOString(),
    privateExtendedProperty: `bookingSource=${guard.EVENT_MARKER}`,
  });
  if (!listed.ok) {
    // Fail the whole pass rather than proceeding. Without the week's bookings we
    // cannot tell who booked, and the failure mode of guessing is nudging a
    // client who already did -- which is worse than nudging nobody, because it
    // tells them the system is not looking.
    return { ok: false, reason: listed.reason, ...base };
  }

  const bookedByEmail = new Map();
  for (const event of listed.events) {
    const meta = (event.extendedProperties && event.extendedProperties.private) || {};
    // The shared calendar carries both audiences. An APPLICANT call this client
    // happens to have booked is not a check-in and does not discharge the
    // obligation.
    if (!isCheckinEvent(meta)) continue;
    const startMs = Date.parse(event.start && event.start.dateTime);
    if (!Number.isFinite(startMs)) continue;
    // listEvents returns anything INTERSECTING the window; the week boundary is
    // half-open, so re-state it locally rather than trusting the overlap.
    if (startMs < week.startMs || startMs >= week.endMs) continue;
    const key = cc.normalizeEmail(meta.visitorEmail);
    if (!key) continue;
    const prev = bookedByEmail.get(key);
    // The EARLIEST booking of the week, so the reassurance names the one that is
    // actually next rather than whichever Google listed first.
    if (!prev || startMs < prev.startMs) {
      bookedByEmail.set(key, { startMs, visitorTimeZone: meta.visitorTimeZone || 'UTC' });
    }
  }

  // Read the dedup state ONCE to decide, then apply every mark in ONE mutate at
  // the end. Not a mutate per client: that would be N reads and N writes of the
  // same document, and -- far worse -- it is the shape that invites someone to
  // wrap the loop in a queue, which is the deadlock the spec warned about.
  const loaded = await cadence.loadState();
  const marks = [];

  for (const client of active) {
    const entry = cadence.weekEntry(loaded.state, week.mondayYmd, client.email);
    const booked = bookedByEmail.get(cc.normalizeEmail(client.email)) || null;

    if (booked) {
      if (entry.reassuranceSent) { base.skipped++; continue; }
      try {
        const sent = await cemail.sendCheckinAllSet({
          name: client.name, email: client.email,
          startMs: booked.startMs, visitorTimeZone: booked.visitorTimeZone,
        });
        if (sent.ok) {
          marks.push({ email: client.email, field: 'reassurance' });
          base.nudges.reassurance++;
          base.sent++;
        } else {
          // NOT marked, so the next run retries. A reassurance that never
          // arrives is a small loss, but silently recording it as sent would
          // make the loss permanent and invisible.
          base.failures++;
          console.error('check-in reassurance failed for', client.email, sent.reason);
          await slack.postSystemAlert(`*Check-in reassurance failed* for ${client.email}: ${sent.reason}`);
        }
      } catch (e) {
        base.failures++;
        console.error('check-in reassurance threw for', client.email, e.message);
        await slack.postSystemAlert(`*Check-in reassurance threw* for ${client.email}: ${e.message}`);
      }
      continue;
    }

    // Not booked. Three of the seven days map to no tier at all -- a nudge every
    // day is a mail loop, not escalation.
    if (!tier) { base.skipped++; continue; }
    if (entry.nudges[tier]) { base.skipped++; continue; }
    try {
      const sent = await cemail.sendCheckinNudge({ name: client.name, email: client.email }, tier);
      if (sent.ok) {
        marks.push({ email: client.email, field: tier });
        base.nudges[tier]++;
        base.sent++;
      } else {
        base.failures++;
        console.error(`check-in ${tier} nudge failed for`, client.email, sent.reason);
        await slack.postSystemAlert(`*Check-in nudge failed* (${tier}) for ${client.email}: ${sent.reason}`);
      }
    } catch (e) {
      base.failures++;
      console.error(`check-in ${tier} nudge threw for`, client.email, e.message);
      await slack.postSystemAlert(`*Check-in nudge threw* (${tier}) for ${client.email}: ${e.message}`);
    }
  }

  if (marks.length) {
    // Re-read inside mutate rather than writing back `loaded.state`: the fine
    // poller may have touched the day counters while this pass was sending, and
    // a stale whole-document write would discard them. This is the ONE write.
    const written = await cadence.mutate((state) => {
      for (const mark of marks) {
        const entry = cadence.weekEntry(state, week.mondayYmd, mark.email);
        if (mark.field === 'reassurance') entry.reassuranceSent = true;
        else entry.nudges[mark.field] = true;
      }
    });
    if (!written.ok) {
      // The emails ARE sent and cannot be unsent; the dedup record is what
      // failed. Loud, because the consequence is a repeat next run.
      console.error('cadence state write failed after sending:', written.reason);
      await slack.postSystemAlert(`*Cadence state write FAILED* after sending ${marks.length} `
        + `check-in nudge(s): ${written.reason}. Those clients may be nudged again.`);
    }
  }

  return { ok: true, ...base };
}
```

- [ ] **Step 4: Run the nudge pass from the daily path only**

In `api/calendar-reminders.js`, replace the response block added in Task 6 Step 4 with:

```js
  const now = Date.now();
  const path = fine ? touches.PATH_FINE : touches.PATH_DAILY;

  const pass = await runTouchPass(path, now);
  if (!pass.ok) {
    return res.status(pass.status).json({
      ok: false, error: pass.error, message: pass.message,
    });
  }

  const body = {
    ok: true,
    mode: path,
    considered: pass.considered,
    sent: pass.sent,
    skipped: pass.skipped,
    failures: pass.failures,
    touches: pass.touches,
  };

  // Daily only. Day-level granularity is all the weekly cycle needs, and running
  // it on the 5-minute poller would mean 288 passes a day over the whole client
  // roster for at most one useful send.
  //
  // Wrapped so the nudge half can never take down the reminder half: a reminder
  // that does not go out costs someone a call they booked, which is strictly
  // worse than a nudge that slips a day.
  if (!fine) {
    try {
      const nudges = await runWeeklyNudgePass(now);
      body.mondayYmd = nudges.mondayYmd;
      body.weekdayKey = nudges.weekdayKey;
      body.tier = nudges.tier;
      body.nudges = nudges.nudges;
      body.nudgesSent = nudges.sent;
      body.nudgeFailures = nudges.failures;
      if (!nudges.ok) body.nudgeError = nudges.reason;
    } catch (e) {
      console.error('weekly nudge pass threw:', e.message);
      await slack.postSystemAlert(`*Weekly check-in nudge pass threw*: ${e.message}. `
        + `Pre-call reminders were unaffected.`);
      body.nudgeError = e.message;
    }
  }

  return res.status(200).json(body);
```

Add to the export block:

```js
// Exported so the weekly cycle can be exercised directly, and so Task 11's
// snapshot can describe a week without re-deriving how one is computed.
module.exports.runWeeklyNudgePass = runWeeklyNudgePass;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/checkin-nudge-pass.test.js`
Expected: PASS.

- [ ] **Step 6: Extend the admin catch-up button to say what it now does**

In `admin.html`, replace the `reminders-catchup` block (lines 630–633) with:

```html
            <div class="reminders-catchup">
              <button type="button" class="btn-primary" id="sendRemindersNowBtn">Send Due Reminders &amp; Nudges Now</button>
              <span id="sendRemindersStatus" class="field-hint"></span>
            </div>
```

Then in `wireRemindersCatchup` (lines 2231–2268), update the confirm text and the success line. Replace the `window.confirm` call with:

```js
        if (!window.confirm('Send due reminder emails now (applicants + check-ins), and run '
          + 'this week\'s check-in nudge pass? This sends real email. It is safe to click more '
          + 'than once: anything already sent this week is skipped.')) {
          return;
        }
```

and replace the success branch with:

```js
        if (res.status === 200 && data.ok) {
          const t = data.touches || {};
          const n = data.nudges || {};
          const nudgeTotal = Object.keys(n).reduce((sum, k) => sum + (n[k] || 0), 0);
          statusEl.textContent =
            `Reminders: ${data.sent} sent (24h ${t['24h'] || 0}, 2h ${t['2h'] || 0}, `
            + `10m ${t['10m'] || 0}) of ${data.considered} considered. `
            + `Nudges: ${nudgeTotal} sent${data.tier ? ` (today's tier: ${data.tier})` : ' (no tier today)'}.`
            + (data.nudgeError ? ` Nudge pass error: ${data.nudgeError}` : '');
          return;
        }
```

- [ ] **Step 7: Verify the admin page still parses and its ids are intact**

Run: `node --test test/admin-page-structure.test.js`
Expected: PASS — `sendRemindersNowBtn` and `sendRemindersStatus` keep their ids, so nothing in that suite moves.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add api/calendar-reminders.js admin.html test/checkin-nudge-pass.test.js
git commit -m "feat(cadence): weekly check-in nudge pass on the daily cron

Monday-reset, anchored to the check-in template's timezone, scoped to
isAccessActive clients. Booked clients get a one-time reassurance; not-booked
clients get the day's escalation tier, once per week each. One listEvents for
the whole week, one state write for the whole pass. The admin catch-up button
replays it and is safe to click repeatedly."
```

---

### Task 10: The daily live-updating heartbeat

**Files:**
- Modify: `api/_slack.js:69` (after `postToSlack`) and `api/_slack.js:93-98` (exports)
- Create: `api/_cadence-slack.js`
- Modify: `api/calendar-reminders.js` (publish the heartbeat at the end of every run, both paths)
- Test: `test/cadence-heartbeat.test.js`

**Interfaces:**
- Consumes: `cadence.mutate`/`loadState`/`dayEntry`/`emptyNudgeCounts` (Task 8); `slack.postToSlack`/`CHANNEL_SYSTEM_ALERTS` (existing).
- Produces:
  - `slack.updateSlackMessage(channelId, ts, message) -> Promise<{ok:true, ts:string} | {ok:false, reason:string}>` — `chat.update`, **no webhook fallback** (an Incoming Webhook returns no `ts` and cannot edit anything)
  - `require('./_cadence-slack')` →
    - `dayKeyFor(nowMs) -> 'YYYY-MM-DD'` (UTC — see the comment in Step 3 for why this one is UTC while the week is not)
    - `heartbeatMessage(dayYmd, dayEntry, nowMs) -> { username, icon_emoji, text, blocks }`
    - `publishHeartbeat({ nowMs, touchCounts, nudgeCounts, failures }) -> Promise<{ok:boolean, ts:string|null, updated:boolean, reason?:string}>` — adds this run's counts to the day, rebuilds the message, and `chat.update`s it in place (or posts it fresh the first time that day)
- The daily and fine responses both gain `heartbeatTs` (string or `null`).

- [ ] **Step 1: Write the failing test**

Create `test/cadence-heartbeat.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const slack = require('../api/_slack');
const cadence = require('../api/_checkin-cadence');
const cs = require('../api/_cadence-slack');

function memoryBlobClient() {
  const box = { text: null };
  return {
    box,
    get: async () => (box.text === null ? null : { stream: box.text }),
    put: async (_p, body) => { box.text = body; return {}; },
  };
}

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try { return await fn(); } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const client = memoryBlobClient();
  store.__setClientForTests(client);
  return client;
}

const NOW = Date.UTC(2026, 9, 8, 0, 0, 30);

test('the day key is the UTC calendar day, matching the cron boundary', () => {
  assert.equal(cs.dayKeyFor(Date.UTC(2026, 9, 8, 0, 0, 30)), '2026-10-08');
  assert.equal(cs.dayKeyFor(Date.UTC(2026, 9, 8, 23, 59, 59)), '2026-10-08');
  assert.equal(cs.dayKeyFor(Date.UTC(2026, 9, 9, 0, 0, 0)), '2026-10-09');
});

test('the heartbeat renders every touch, every tier and the failure count', () => {
  const day = cadence.emptyDayEntry();
  day.touches['24h'] = 3; day.touches['2h'] = 1; day.touches['10m'] = 2;
  day.nudges.direct = 4; day.nudges.reassurance = 2;
  day.failures = 1;
  const msg = cs.heartbeatMessage('2026-10-08', day, NOW);
  const flat = JSON.stringify(msg);
  assert.match(flat, /2026-10-08/);
  for (const n of ['3', '1', '2', '4']) assert.ok(flat.includes(n));
  for (const label of ['24h', '2h', '10m', 'direct', 'reassurance']) {
    assert.ok(flat.includes(label), `the heartbeat must name "${label}"`);
  }
  assert.match(flat, /blocks/);
  assert.equal(typeof msg.text, 'string');
  assert.ok(msg.text.length > 0, 'a fallback text is required or the notification is blank');
});

// The liveness requirement, and the reason this feature exists at all: an
// all-zero day must still LOOK different from the previous tick, or a healthy
// quiet day is indistinguishable from a dead cron.
test('a zero-count heartbeat still carries a moving timestamp', () => {
  const day = cadence.emptyDayEntry();
  const a = JSON.stringify(cs.heartbeatMessage('2026-10-08', day, NOW));
  const b = JSON.stringify(cs.heartbeatMessage('2026-10-08', day, NOW + 5 * 60000));
  assert.notEqual(a, b,
    'two ticks of a quiet day must render differently -- otherwise "nothing changed" and '
    + '"the cron is dead" look identical, which is the exact thing the heartbeat is for');
  assert.match(a, /0/);
});

test('the FIRST publish of a day posts a new message and stores its ts', async () => {
  const client = envSetup();
  const postSpy = spyStub({ ts: '1760000000.000100' });
  const updateSpy = spyStub({ ok: true, ts: 'x' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'updateSlackMessage', value: updateSpy },
  ], async () => {
    const r = await cs.publishHeartbeat({
      nowMs: NOW, touchCounts: { '24h': 2, '2h': 0, '10m': 0 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 0,
    });
    assert.equal(r.ok, true);
    assert.equal(r.updated, false);
    assert.equal(r.ts, '1760000000.000100');
    assert.equal(postSpy.calls.length, 1);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_SYSTEM_ALERTS,
      'the heartbeat reuses the EXISTING alerts channel -- no new channel');
    assert.equal(updateSpy.calls.length, 0);
    const saved = JSON.parse(client.box.text);
    assert.equal(saved.days['2026-10-08'].heartbeatTs, '1760000000.000100');
    assert.equal(saved.days['2026-10-08'].touches['24h'], 2);
  });
});

test('EVERY later tick updates the SAME message in place and accumulates the counts', async () => {
  envSetup();
  const postSpy = spyStub({ ts: '1760000000.000100' });
  const updateSpy = spyStub({ ok: true, ts: '1760000000.000100' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'updateSlackMessage', value: updateSpy },
  ], async () => {
    await cs.publishHeartbeat({ nowMs: NOW, touchCounts: { '24h': 1, '2h': 0, '10m': 0 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 0 });
    const second = await cs.publishHeartbeat({ nowMs: NOW + 300000,
      touchCounts: { '24h': 0, '2h': 2, '10m': 1 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 1 });

    assert.equal(second.ok, true);
    assert.equal(second.updated, true);
    assert.equal(postSpy.calls.length, 1, 'only the first tick of the day posts');
    assert.equal(updateSpy.calls.length, 1);
    assert.equal(updateSpy.calls[0][0], slack.CHANNEL_SYSTEM_ALERTS);
    assert.equal(updateSpy.calls[0][1], '1760000000.000100');
    const flat = JSON.stringify(updateSpy.calls[0][2]);
    assert.ok(flat.includes('1'), 'the accumulated 24h count must still be shown');
    assert.ok(flat.includes('2'), 'and the new 2h count');
  });
});

test('a tick on a NEW day posts a fresh message rather than editing yesterday\'s', async () => {
  envSetup();
  const postSpy = spyStub({ ts: '1.1' });
  const updateSpy = spyStub({ ok: true, ts: '1.1' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'updateSlackMessage', value: updateSpy },
  ], async () => {
    await cs.publishHeartbeat({ nowMs: NOW, touchCounts: { '24h': 1, '2h': 0, '10m': 0 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 0 });
    await cs.publishHeartbeat({ nowMs: NOW + 86400000,
      touchCounts: { '24h': 1, '2h': 0, '10m': 0 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 0 });
    assert.equal(postSpy.calls.length, 2, 'each day gets its own parent message');
  });
});

// Somebody deletes the message, or Slack rejects the edit. The heartbeat must
// recover on its own -- an alerts channel that silently stops updating is worse
// than one that posts a duplicate.
test('a failed update falls back to posting fresh and re-stores the new ts', async () => {
  const client = envSetup();
  const postSpy = spyStub({ ts: 'second.ts' });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: spyStub({ ts: 'first.ts' }) },
    { obj: slack, key: 'updateSlackMessage', value: spyStub({ ok: false, reason: 'message_not_found' }) },
  ], async () => {
    await cs.publishHeartbeat({ nowMs: NOW, touchCounts: { '24h': 0, '2h': 0, '10m': 0 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 0 });
  });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'updateSlackMessage', value: spyStub({ ok: false, reason: 'message_not_found' }) },
  ], async () => {
    const r = await cs.publishHeartbeat({ nowMs: NOW + 300000,
      touchCounts: { '24h': 0, '2h': 0, '10m': 0 },
      nudgeCounts: cadence.emptyNudgeCounts(), failures: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.updated, false);
    assert.equal(r.ts, 'second.ts');
    assert.equal(JSON.parse(client.box.text).days['2026-10-08'].heartbeatTs, 'second.ts');
  });
});

test('publishHeartbeat never throws, even with no Slack and no blob', async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  store.__setClientForTests({ get: async () => { throw new Error('nope'); },
    put: async () => { throw new Error('nope'); } });
  const r = await cs.publishHeartbeat({ nowMs: NOW,
    touchCounts: { '24h': 0, '2h': 0, '10m': 0 },
    nudgeCounts: cadence.emptyNudgeCounts(), failures: 0 });
  assert.equal(typeof r, 'object');
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, 'string');
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
});

// The nested-queue deadlock the spec caught in advance, as a source-level
// assertion -- the failure mode is a hang, which a test cannot observe without
// hanging too.
test('the heartbeat module contains no queue, lock or mutex', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_cadence-slack.js'), 'utf8');
  for (const word of ['Queue', 'queue', 'Mutex', 'mutex', 'acquireLock', 'withLock']) {
    assert.equal(src.includes(word), false,
      `_cadence-slack.js must stay queue-free -- found "${word}". Both the daily cron and the `
      + '5-minute poller publish a heartbeat, and a queued write called from inside another '
      + 'queued call waits forever on a slot its own caller holds.');
  }
});

test('updateSlackMessage refuses quietly with no bot token and never falls back to a webhook', async () => {
  const hadToken = process.env.SLACK_BOT_TOKEN;
  const hadHook = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/none';
  try {
    const r = await slack.updateSlackMessage('C123', '1.1', { text: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /token|ts/i);
  } finally {
    if (hadToken === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = hadToken;
    if (hadHook === undefined) delete process.env.SLACK_WEBHOOK_URL; else process.env.SLACK_WEBHOOK_URL = hadHook;
  }
});

test('updateSlackMessage refuses when there is no ts to edit', async () => {
  const had = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  try {
    const r = await slack.updateSlackMessage('C123', null, { text: 'x' });
    assert.equal(r.ok, false);
  } finally {
    if (had === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = had;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/cadence-heartbeat.test.js`
Expected: FAIL — `Cannot find module '../api/_cadence-slack'`.

- [ ] **Step 3: Add `updateSlackMessage` to `api/_slack.js`**

Insert immediately after `postToSlack` (after line 69):

```js
// Edits a message already in the channel, in place. The heartbeat's whole value
// is that it is ONE message per day that visibly moves, rather than a stream of
// near-identical posts nobody reads.
//
// NO WEBHOOK FALLBACK, unlike postToSlack above, and that is not an oversight:
// an Incoming Webhook returns no message ts and has no edit endpoint, so there
// is nothing for a fallback to do. A failure here is reported to the caller,
// which posts a fresh message instead -- see _cadence-slack.js's
// publishHeartbeat.
async function updateSlackMessage(channelId, ts, message) {
  const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!BOT_TOKEN) return { ok: false, reason: 'SLACK_BOT_TOKEN not set' };
  if (!ts) return { ok: false, reason: 'no message ts to update' };
  try {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channelId, ts, ...message }),
    });
    const data = await res.json();
    if (data.ok) return { ok: true, ts: data.ts || ts };
    // message_not_found means somebody deleted it; the caller recovers by
    // posting fresh rather than going quiet.
    console.error('Slack chat.update error:', data.error);
    return { ok: false, reason: data.error || 'unknown chat.update error' };
  } catch (e) {
    console.error('Slack chat.update threw:', e.message);
    return { ok: false, reason: e.message || String(e) };
  }
}
```

Then replace the export block at the bottom of `api/_slack.js`:

```js
module.exports = {
  postToSlack, getPermalink, postSystemAlert, updateSlackMessage,
  CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS, CHANNEL_WARM_LEADS,
  CHANNEL_NEW_CALLS_BOOKED, CHANNEL_RESCHEDULED_CALLS, CHANNEL_CANCELLED_CALLS, CHANNEL_SYSTEM_ALERTS,
  CHANNEL_CHECKIN_BOOKED, CHANNEL_CHECKIN_RESCHEDULED, CHANNEL_CHECKIN_CANCELLED,
};
```

- [ ] **Step 4: Create `api/_cadence-slack.js`**

```js
// The two AMBIENT-VISIBILITY messages, both in the existing #7-system-alerts.
//
// The channel already carries failure alerts via postSystemAlert, and that stays
// exactly as it is. What is added here answers a different question: not "did
// something break" but "is any of this running at all". Those are not the same
// question, and a channel that only ever speaks when something breaks cannot
// answer the second one -- silence reads as health right up until the moment it
// turns out to have meant the cron died three weeks ago.
//
// NO QUEUE, NO LOCK, NO MUTEX -- see the same note in _checkin-cadence.js. Both
// the daily cron and the external 5-minute poller publish a heartbeat, so two
// writers really do exist; the answer is a plain read-merge-write, not a
// serializer. Every mutate() call below is at the TOP level of its function and
// never inside another mutate's callback.
const slack = require('./_slack');
const cadence = require('./_checkin-cadence');

// The heartbeat's day key is UTC, while the weekly nudge cycle's week key is the
// check-in template's local zone. That looks inconsistent and is deliberate:
// they group different things. The week is about the CLIENT's obligation, so it
// has to reset on the client's Monday. The day here is just a bucket for one
// cron cycle's counters, and the Vercel cron fires at 00:00 UTC -- so a UTC day
// key means each day's first tick is the daily cron itself, which is the run
// that opens the message. Any other anchor would have the poller create the
// day's message in the middle of the previous day's.
function dayKeyFor(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function totalOf(obj) {
  return Object.keys(obj).reduce((sum, k) => sum + (Number(obj[k]) || 0), 0);
}

// Rebuilt from the day's CURRENT counts on every tick, including ticks where
// nothing happened. The `updated` line is what makes a quiet day legible: all
// zeros plus a timestamp five minutes newer than last time says "running, and
// nothing was due". All zeros plus a timestamp from yesterday says the cron is
// dead. Without the timestamp those two render identically, which is exactly
// the ambiguity this message exists to remove.
function heartbeatMessage(dayYmd, dayEntry, nowMs) {
  const t = dayEntry.touches;
  const n = dayEntry.nudges;
  const touchTotal = totalOf(t);
  const nudgeTotal = totalOf(n);
  const headline = `:heartbeat: *Cadence heartbeat — ${dayYmd}*`;
  const touchLine = `*Pre-call touches:* ${touchTotal}`
    + `  ·  24h ${t['24h']}  ·  2h ${t['2h']}  ·  10m ${t['10m']}`;
  const nudgeLine = `*Check-in nudges:* ${nudgeTotal}`
    + `  ·  neutral ${n.neutral}  ·  direct ${n.direct}  ·  urgent ${n.urgent}`
    + `  ·  lastcall ${n.lastcall}  ·  reassurance ${n.reassurance}`;
  const failureLine = dayEntry.failures > 0
    ? `:warning: *Failures today:* ${dayEntry.failures} — see the alerts above`
    : '*Failures today:* 0';
  return {
    username: '3AMAK Bot',
    icon_emoji: ':heartbeat:',
    // A fallback `text` is required: without it the Slack notification and the
    // channel list preview are blank.
    text: `Cadence heartbeat ${dayYmd}: ${touchTotal} touches, ${nudgeTotal} nudges, `
      + `${dayEntry.failures} failures`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: headline } },
      { type: 'section', text: { type: 'mrkdwn', text: `${touchLine}\n${nudgeLine}\n${failureLine}` } },
      { type: 'context', elements: [{ type: 'mrkdwn',
          text: `Updated ${new Date(nowMs).toUTCString()} · if this stops moving, the cron stopped` }] },
    ],
  };
}

// Add this run's counts to the day, rebuild the message, and edit it in place.
//
// TWO mutate() calls, sequentially, never nested -- the second only runs when a
// fresh post gave us a new ts to remember. Writing the ts inside the first
// callback is impossible (we do not have it yet) and calling publishHeartbeat
// from inside a mutate callback is forbidden; see the module header.
//
// Best-effort throughout: a heartbeat that cannot be published must never fail
// the cron run whose work it was reporting on.
async function publishHeartbeat({ nowMs, touchCounts, nudgeCounts, failures }) {
  const dayYmd = dayKeyFor(nowMs);
  let dayEntry;

  try {
    const recorded = await cadence.mutate((state) => {
      const day = cadence.dayEntry(state, dayYmd);
      for (const key of cadence.TOUCH_COUNT_KEYS) {
        day.touches[key] += Number((touchCounts || {})[key]) || 0;
      }
      for (const key of Object.keys(day.nudges)) {
        day.nudges[key] += Number((nudgeCounts || {})[key]) || 0;
      }
      day.failures += Number(failures) || 0;
    });
    if (!recorded.ok) return { ok: false, ts: null, updated: false, reason: recorded.reason };
    dayEntry = cadence.dayEntry(recorded.state, dayYmd);
  } catch (e) {
    return { ok: false, ts: null, updated: false, reason: e.message || String(e) };
  }

  const message = heartbeatMessage(dayYmd, dayEntry, nowMs);

  if (dayEntry.heartbeatTs) {
    const updated = await slack.updateSlackMessage(
      slack.CHANNEL_SYSTEM_ALERTS, dayEntry.heartbeatTs, message);
    if (updated.ok) return { ok: true, ts: dayEntry.heartbeatTs, updated: true };
    // The message is gone (deleted by hand, or the ts is stale). Fall through and
    // post fresh: an alerts channel that silently stops updating is worse than
    // one that occasionally shows two heartbeats for the same day.
    console.error('heartbeat update failed, posting fresh:', updated.reason);
  }

  const posted = await slack.postToSlack(slack.CHANNEL_SYSTEM_ALERTS, message);
  if (!posted || !posted.ts) {
    // postToSlack already logged. With no ts there is nothing to remember, and
    // the next tick will simply try to post again.
    return { ok: false, ts: null, updated: false, reason: 'no message ts returned by Slack' };
  }

  try {
    await cadence.mutate((state) => {
      cadence.dayEntry(state, dayYmd).heartbeatTs = posted.ts;
    });
  } catch (e) {
    // The message IS posted; only the bookmark failed. The next tick posts a
    // second one rather than editing this -- visible duplication, not silence.
    console.error('could not store heartbeat ts:', e.message);
  }

  return { ok: true, ts: posted.ts, updated: false };
}

module.exports = { dayKeyFor, heartbeatMessage, publishHeartbeat };
```

- [ ] **Step 5: Publish the heartbeat at the end of every cron run**

In `api/calendar-reminders.js`, add the require beside the others:

```js
const cslackCadence = require('./_cadence-slack');
```

Then, in `handler`, insert immediately before the final `return res.status(200).json(body);`:

```js
  // The heartbeat, on EVERY tick of EITHER path -- including ticks where nothing
  // was due. That is the entire point: a message that visibly moves on a quiet
  // day is what distinguishes "healthy and quiet" from "dead". Publishing it
  // only when something was sent would make the two look identical again.
  //
  // Best-effort and last: the work is already done, and a Slack hiccup must not
  // turn a successful run into a 5xx that makes the cron service retry it and
  // double-send.
  try {
    const beat = await cslackCadence.publishHeartbeat({
      nowMs: now,
      touchCounts: pass.touches,
      nudgeCounts: body.nudges || null,
      failures: (pass.failures || 0) + (body.nudgeFailures || 0),
    });
    body.heartbeatTs = beat.ts;
  } catch (e) {
    console.error('heartbeat publish threw:', e.message);
    body.heartbeatTs = null;
  }

```

- [ ] **Step 6: Run the heartbeat tests to verify they pass**

Run: `node --test test/cadence-heartbeat.test.js`
Expected: PASS.

- [ ] **Step 7: Run the reminder suites — the heartbeat must not have disturbed them**

Run: `node --test test/calendar-reminders.test.js test/calendar-reminders-fine.test.js test/checkin-nudge-pass.test.js`
Expected: PASS. In those suites `SLACK_BOT_TOKEN` and `SLACK_WEBHOOK_URL` are unset, so `postToSlack` logs and returns `{ts:null}`, `publishHeartbeat` returns `{ok:false}`, and the handler records `heartbeatTs: null` without changing any other field. If a test fails on an unexpected `postToSlack` call count, stub `slack.postToSlack` in that test rather than making the heartbeat conditional.

- [ ] **Step 8: Commit**

```bash
git add api/_slack.js api/_cadence-slack.js api/calendar-reminders.js test/cadence-heartbeat.test.js
git commit -m "feat(alerts): daily live-updating cadence heartbeat

One chat.update-refreshed message per UTC day in the existing #7-system-alerts,
rebuilt from the day's counts on every tick of either cron path -- including
quiet ticks, so a healthy quiet day cannot be mistaken for a dead cron. Plain
read-merge-write, no queue, with a post-fresh fallback if the edit is rejected."
```

---

### Task 11: The on-demand cadence snapshot

**Files:**
- Modify: `api/calendar-reminders.js` (add `buildCadenceSnapshot`, route `{cadenceStatus:true}`)
- Modify: `api/_cadence-slack.js` (add `snapshotMessage`, `postCadenceSnapshot`)
- Modify: `admin.html:630-634` (the new button) and `admin.html:2270+` (`wireCadenceStatus`, and its call in `init()`)
- Test: `test/cadence-snapshot.test.js`, `test/admin-page-structure.test.js` (append)

**Interfaces:**
- Consumes: `cadence.loadState`/`weekEntry`/`dayEntry`/`NUDGE_TIERS`/`tierForWeekday`/`hasCheckinObligation`/`emptyNudgeCounts` (Task 8); `cc.loadClients`/`normalizeEmail`; `tz.weekWindow`/`weekdayKeyInZone`/`WEEKDAY_KEYS`; `gcal.listEvents`; `isCheckinEvent`; `cslackCadence.dayKeyFor` (Task 10); `verifySession` (already required at the top of `calendar-reminders.js`).
- Produces:
  - `module.exports.buildCadenceSnapshot(nowMs) -> Promise<{ ok: true, snapshot: Snapshot } | { ok: false, reason: string }>` where **Snapshot** is exactly:
    ```
    {
      mondayYmd: string, dayYmd: string, weekdayKey: string, timeZone: string,
      activeClients: number, booked: number, notBooked: number,
      sentThisWeek: { neutral:number, direct:number, urgent:number, lastcall:number, reassurance:number },
      projection: Array<{ dayYmd: string, weekdayKey: string, tier: string, wouldSend: number }>,
      touchesToday: { '24h':number, '2h':number, '10m':number },
      failuresToday: number
    }
    ```
  - `cslackCadence.snapshotMessage(snapshot, nowMs) -> { username, icon_emoji, text, blocks }`
  - `cslackCadence.postCadenceSnapshot(snapshot, nowMs) -> Promise<{ok:boolean, ts:string|null, reason?:string}>` — a fresh, STANDALONE post; never an edit, never the heartbeat's ts
  - `POST /api/calendar-reminders` with body `{ cadenceStatus: true }`, admin session only → `200 {ok:true, snapshot, posted:boolean}`

- [ ] **Step 1: Write the failing test**

Create `test/cadence-snapshot.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../api/_blob-store');
const gcal = require('../api/_google-calendar');
const guard = require('../api/_booking-guard');
const slack = require('../api/_slack');
const auth = require('../api/_admin-auth');
const tzmod = require('../api/_timezone');
const cc = require('../api/_checkin-clients');
const cadence = require('../api/_checkin-cadence');
const cs = require('../api/_cadence-slack');
const loadCheckinMod = require('../api/_load-checkin-template');
const handler = require('../api/calendar-reminders');

function memoryBlobClient() {
  const box = { text: null };
  return { box,
    get: async () => (box.text === null ? null : { stream: box.text }),
    put: async (_p, body) => { box.text = body; return {}; } };
}

async function withStubs(patches, fn) {
  const originals = patches.map(p => ({ obj: p.obj, key: p.key, orig: p.obj[p.key] }));
  for (const p of patches) p.obj[p.key] = p.value;
  try { return await fn(); } finally {
    for (const o of originals) o.obj[o.key] = o.orig;
  }
}

function spyStub(result) {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

function makeRes() {
  return { _status: null, _json: null,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader() { return this; }, end() { this._ended = true; return this; } };
}

const ZONE = 'America/Toronto';

function envSetup() {
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  const client = memoryBlobClient();
  store.__setClientForTests(client);
  return client;
}

function at(day, hour) { return tzmod.zonedWallTimeToUtc(2026, 10, day, hour, 0, ZONE); }

function client(email, overrides = {}) {
  return { name: 'C ' + email, email, phone: '', startDate: '2026-01-01',
    durationMonths: 12, customEndDate: '', pausedAt: null,
    expiresAt: Date.UTC(2027, 0, 1), paymentsByMonth: {}, ...overrides };
}

function checkinEvent(email, startMs) {
  return { id: 'evt-' + email,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + 900000).toISOString() },
    extendedProperties: { private: { bookingSource: guard.EVENT_MARKER, audience: 'checkin',
      visitorEmail: email, visitorName: 'C', visitorTimeZone: ZONE } } };
}

function templateStub() {
  return { obj: loadCheckinMod, key: 'loadCheckinTemplate',
    value: async () => ({ ok: true, template: { timezone: ZONE } }) };
}

test('the snapshot reports the real week so far AND a labelled projection of what is left', async () => {
  envSetup();
  // Pre-load state: on this Thursday, 'neutral' already went out to both on Tue.
  await cadence.mutate((state) => {
    cadence.weekEntry(state, '2026-10-05', 'a@x.co').nudges.neutral = true;
    cadence.weekEntry(state, '2026-10-05', 'b@x.co').nudges.neutral = true;
    const day = cadence.dayEntry(state, cs.dayKeyFor(at(8, 10)));
    day.touches['24h'] = 2; day.touches['10m'] = 1; day.failures = 1;
  });

  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true,
      clients: [client('a@x.co'), client('b@x.co'), client('c@x.co')] }) },
    // c@x.co booked; a and b did not.
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true,
      events: [checkinEvent('c@x.co', at(9, 14))] }) },
  ], async () => {
    const r = await handler.buildCadenceSnapshot(at(8, 10)); // Thursday
    assert.equal(r.ok, true);
    const s = r.snapshot;
    assert.equal(s.mondayYmd, '2026-10-05');
    assert.equal(s.weekdayKey, 'thu');
    assert.equal(s.timeZone, ZONE);
    assert.equal(s.activeClients, 3);
    assert.equal(s.booked, 1);
    assert.equal(s.notBooked, 2);

    // The REAL log: what the state actually records for this week.
    assert.deepEqual(s.sentThisWeek,
      { neutral: 2, direct: 0, urgent: 0, lastcall: 0, reassurance: 0 });

    // The PROJECTION: the remaining mapped days of this week, and how many
    // not-booked clients would receive each tier if nothing changes.
    assert.deepEqual(s.projection.map(p => p.weekdayKey), ['sat', 'sun']);
    assert.deepEqual(s.projection.map(p => p.tier), ['urgent', 'lastcall']);
    assert.deepEqual(s.projection.map(p => p.wouldSend), [2, 2]);
    assert.deepEqual(s.projection.map(p => p.dayYmd), ['2026-10-10', '2026-10-11']);

    assert.deepEqual(s.touchesToday, { '24h': 2, '2h': 0, '10m': 1 });
    assert.equal(s.failuresToday, 1);
  });
});

test('the projection is empty on the last day of the week', async () => {
  envSetup();
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const r = await handler.buildCadenceSnapshot(at(11, 20)); // Sunday evening
    assert.equal(r.snapshot.weekdayKey, 'sun');
    assert.deepEqual(r.snapshot.projection, [],
      'Sunday is the last mapped day -- there is nothing left to project');
  });
});

test('a client who already has a tier marked is not counted in that tier\'s projection', async () => {
  envSetup();
  await cadence.mutate((state) => {
    cadence.weekEntry(state, '2026-10-05', 'a@x.co').nudges.urgent = true;
  });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true,
      clients: [client('a@x.co'), client('b@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
  ], async () => {
    const r = await handler.buildCadenceSnapshot(at(8, 10)); // Thursday
    const urgent = r.snapshot.projection.find(p => p.tier === 'urgent');
    assert.equal(urgent.wouldSend, 1, 'a@x.co already has urgent marked');
    const lastcall = r.snapshot.projection.find(p => p.tier === 'lastcall');
    assert.equal(lastcall.wouldSend, 2);
  });
});

test('the rendered message labels the projection as a projection, unmistakably', () => {
  const snapshot = {
    mondayYmd: '2026-10-05', dayYmd: '2026-10-08', weekdayKey: 'thu', timeZone: ZONE,
    activeClients: 3, booked: 1, notBooked: 2,
    sentThisWeek: { neutral: 2, direct: 0, urgent: 0, lastcall: 0, reassurance: 1 },
    projection: [
      { dayYmd: '2026-10-10', weekdayKey: 'sat', tier: 'urgent', wouldSend: 2 },
      { dayYmd: '2026-10-11', weekdayKey: 'sun', tier: 'lastcall', wouldSend: 2 },
    ],
    touchesToday: { '24h': 2, '2h': 0, '10m': 1 },
    failuresToday: 0,
  };
  const msg = cs.snapshotMessage(snapshot, Date.UTC(2026, 9, 8, 15, 0, 0));
  const flat = JSON.stringify(msg);
  assert.match(flat, /2026-10-05/);
  assert.match(flat, /PROJECTED|Projected|projection/,
    'the forecast half must be labelled, or it reads as a record of things already sent');
  assert.match(flat, /urgent/);
  assert.match(flat, /lastcall/);
  assert.match(flat, /sat/i);
  assert.ok(msg.text.length > 0);
});

test('postCadenceSnapshot posts a STANDALONE message and never edits the heartbeat', async () => {
  envSetup();
  const postSpy = spyStub({ ts: 'snap.ts' });
  const updateSpy = spyStub({ ok: true, ts: 'x' });
  await cadence.mutate((state) => {
    cadence.dayEntry(state, '2026-10-08').heartbeatTs = 'heartbeat.ts';
  });
  await withStubs([
    { obj: slack, key: 'postToSlack', value: postSpy },
    { obj: slack, key: 'updateSlackMessage', value: updateSpy },
  ], async () => {
    const r = await cs.postCadenceSnapshot({
      mondayYmd: '2026-10-05', dayYmd: '2026-10-08', weekdayKey: 'thu', timeZone: ZONE,
      activeClients: 0, booked: 0, notBooked: 0,
      sentThisWeek: cadence.emptyNudgeCounts(), projection: [],
      touchesToday: { '24h': 0, '2h': 0, '10m': 0 }, failuresToday: 0,
    }, Date.UTC(2026, 9, 8, 15, 0, 0));
    assert.equal(r.ok, true);
    assert.equal(r.ts, 'snap.ts');
    assert.equal(postSpy.calls.length, 1);
    assert.equal(postSpy.calls[0][0], slack.CHANNEL_SYSTEM_ALERTS);
    assert.equal(updateSpy.calls.length, 0,
      'the snapshot is a fresh post -- editing the heartbeat would destroy the liveness signal');
  });
  const after = await cadence.loadState();
  assert.equal(after.state.days['2026-10-08'].heartbeatTs, 'heartbeat.ts',
    'and it must not overwrite the heartbeat ts');
});

test('the snapshot endpoint requires an admin session, not the cron secret', async () => {
  envSetup();
  const listSpy = spyStub({ ok: true, events: [] });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [] }) },
    { obj: gcal, key: 'listEvents', value: listSpy },
    { obj: slack, key: 'postToSlack', value: spyStub({ ts: 'snap.ts' }) },
  ], async () => {
    // The real cron's bearer token must NOT be able to trigger a Slack post.
    let res = makeRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer test-cron-secret' },
      body: { cadenceStatus: true }, url: '/api/calendar-reminders', query: {} }, res);
    assert.equal(res._status, 403);

    // A GET cannot reach it at all, for the same SameSite=Lax reason bulkCancel
    // is POST-only.
    const cookie = auth.issueSessionCookie().split(';')[0];
    res = makeRes();
    await handler({ method: 'GET', headers: { cookie },
      url: '/api/calendar-reminders?cadenceStatus=1', query: { cadenceStatus: '1' } }, res);
    assert.notEqual(res._status, 200);
  });
});

test('an admin session POST returns the snapshot and posts it to Slack', async () => {
  envSetup();
  const postSpy = spyStub({ ts: 'snap.ts' });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: slack, key: 'postToSlack', value: postSpy },
  ], async () => {
    const cookie = auth.issueSessionCookie().split(';')[0];
    const res = makeRes();
    await handler({ method: 'POST', headers: { cookie }, body: { cadenceStatus: true },
      url: '/api/calendar-reminders', query: {} }, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.posted, true);
    assert.equal(res._json.snapshot.activeClients, 1);
    assert.equal(postSpy.calls.length, 1);
  });
});

test('the snapshot request sends NO email and runs no pass', async () => {
  envSetup();
  const cemail = require('../api/_checkin-email');
  const email = require('../api/_email');
  const nudgeSpy = spyStub({ ok: true });
  const reminderSpy = spyStub({ ok: true });
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: true, events: [] }) },
    { obj: slack, key: 'postToSlack', value: spyStub({ ts: 'snap.ts' }) },
    { obj: cemail, key: 'sendCheckinNudge', value: nudgeSpy },
    { obj: email, key: 'sendReminder', value: reminderSpy },
  ], async () => {
    const cookie = auth.issueSessionCookie().split(';')[0];
    const res = makeRes();
    await handler({ method: 'POST', headers: { cookie }, body: { cadenceStatus: true },
      url: '/api/calendar-reminders', query: {} }, res);
    assert.equal(nudgeSpy.calls.length, 0, '"Check Cadence Status" must be READ-ONLY');
    assert.equal(reminderSpy.calls.length, 0);
  });
});

test('a calendar failure surfaces as a 502 rather than a half-built snapshot', async () => {
  envSetup();
  await withStubs([
    templateStub(),
    { obj: cc, key: 'loadClients', value: async () => ({ ok: true, clients: [client('a@x.co')] }) },
    { obj: gcal, key: 'listEvents', value: async () => ({ ok: false, reason: 'calendar down' }) },
  ], async () => {
    const cookie = auth.issueSessionCookie().split(';')[0];
    const res = makeRes();
    await handler({ method: 'POST', headers: { cookie }, body: { cadenceStatus: true },
      url: '/api/calendar-reminders', query: {} }, res);
    assert.equal(res._status, 502);
    assert.equal(res._json.ok, false);
    assert.match(JSON.stringify(res._json), /calendar down/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/cadence-snapshot.test.js`
Expected: FAIL — `handler.buildCadenceSnapshot is not a function`.

- [ ] **Step 3: Add `buildCadenceSnapshot` to `api/calendar-reminders.js`**

Insert immediately after `runWeeklyNudgePass`:

```js
// The on-demand answer to "is the cadence actually working", for the moment the
// owner wants to look rather than wait for the next heartbeat.
//
// STRICTLY READ-ONLY. It sends no email, runs no pass and marks no flag -- the
// owner must be able to press the button in /admin as often as they like,
// including while wondering whether the automated run is misbehaving, without
// the act of looking changing what happens.
//
// Returns DATA, not a Slack payload: the rendering lives in _cadence-slack.js so
// the arithmetic can be asserted without parsing blocks, and so the admin page
// can show the same numbers it posts.
async function buildCadenceSnapshot(nowMs) {
  const tplRes = await checkinTemplateMod.loadCheckinTemplate();
  const zone = tplRes.template.timezone;
  const week = tz.weekWindow(nowMs, zone);
  const weekdayKey = tz.weekdayKeyInZone(nowMs, zone);

  const loadedClients = await cc.loadClients();
  // The SAME filter runWeeklyNudgePass uses. If these two ever disagree, the
  // snapshot describes a cadence that is not the one running.
  const active = (loadedClients.clients || []).filter(c => cadence.hasCheckinObligation(c, nowMs));

  const listed = await gcal.listEvents({
    timeMinIso: new Date(week.startMs).toISOString(),
    timeMaxIso: new Date(week.endMs).toISOString(),
    privateExtendedProperty: `bookingSource=${guard.EVENT_MARKER}`,
  });
  if (!listed.ok) return { ok: false, reason: listed.reason };

  const bookedEmails = new Set();
  for (const event of listed.events) {
    const meta = (event.extendedProperties && event.extendedProperties.private) || {};
    if (!isCheckinEvent(meta)) continue;
    const startMs = Date.parse(event.start && event.start.dateTime);
    if (!Number.isFinite(startMs) || startMs < week.startMs || startMs >= week.endMs) continue;
    const key = cc.normalizeEmail(meta.visitorEmail);
    if (key) bookedEmails.add(key);
  }

  const loaded = await cadence.loadState();
  const dayYmd = cslackCadence.dayKeyFor(nowMs);
  const day = cadence.dayEntry(loaded.state, dayYmd);

  // The REAL half: what the week's state actually records. Counted from the
  // stored flags rather than from today's run, so it covers the whole week so
  // far including runs this process never saw.
  const sentThisWeek = cadence.emptyNudgeCounts();
  const notBookedActive = [];
  for (const client of active) {
    const key = cc.normalizeEmail(client.email);
    const entry = cadence.weekEntry(loaded.state, week.mondayYmd, client.email);
    if (entry.reassuranceSent) sentThisWeek.reassurance++;
    for (const tier of cadence.NUDGE_TIERS) {
      if (entry.nudges[tier]) sentThisWeek[tier]++;
    }
    if (!bookedEmails.has(key)) notBookedActive.push({ client, entry });
  }

  // The PROJECTED half: the mapped days still ahead this week, and how many
  // not-booked clients each would reach if nothing changes. Clearly separated
  // from the real half in both the data shape and the rendering, because a
  // forecast presented as a record is worse than no forecast.
  const todayIndex = tz.WEEKDAY_KEYS.indexOf(weekdayKey);
  const projection = [];
  // Monday is index 0 of the week, whatever its index in WEEKDAY_KEYS (which is
  // Sunday-first). Walk the seven calendar days of THIS week and keep the ones
  // strictly after today.
  for (let offset = 0; offset < 7; offset++) {
    const dayMs = week.startMs + offset * 86400000;
    // Re-read the weekday from the instant rather than incrementing a name, so a
    // DST shift inside the week cannot slide the labels.
    const key = tz.weekdayKeyInZone(dayMs + 12 * 3600000, zone);
    if (tz.WEEKDAY_KEYS.indexOf(key) === todayIndex) continue;
    if (dayMs + 12 * 3600000 <= nowMs) continue; // already past
    const tier = cadence.tierForWeekday(key);
    if (!tier) continue;
    const wouldSend = notBookedActive.filter(x => !x.entry.nudges[tier]).length;
    projection.push({
      dayYmd: new Date(dayMs + 12 * 3600000).toISOString().slice(0, 10),
      weekdayKey: key, tier, wouldSend,
    });
  }

  return {
    ok: true,
    snapshot: {
      mondayYmd: week.mondayYmd,
      dayYmd,
      weekdayKey,
      timeZone: zone,
      activeClients: active.length,
      booked: active.length - notBookedActive.length,
      notBooked: notBookedActive.length,
      sentThisWeek,
      projection,
      touchesToday: { ...day.touches },
      failuresToday: day.failures,
    },
  };
}
```

Then, inside `handler`, immediately after the existing `bulkCancel` branch, add:

```js
  // Read-only status report. POST + admin session ONLY, never the cron bearer:
  // real cron has no business posting an owner-facing summary, and a bearer that
  // could would make CRON_SECRET a Slack-posting credential.
  if (req.method === 'POST' && req.body && req.body.cadenceStatus === true) {
    if (!verifySession(req)) {
      return res.status(403).json({ ok: false, error: 'ADMIN_SESSION_REQUIRED',
        message: 'The cadence snapshot is an admin-session action, not a cron action.' });
    }
    const built = await buildCadenceSnapshot(Date.now());
    if (!built.ok) {
      return res.status(502).json({ ok: false, error: 'UPSTREAM', message: built.reason });
    }
    const posted = await cslackCadence.postCadenceSnapshot(built.snapshot, Date.now());
    return res.status(200).json({ ok: true, snapshot: built.snapshot, posted: posted.ok });
  }
```

Add to the export block:

```js
module.exports.buildCadenceSnapshot = buildCadenceSnapshot;
```

- [ ] **Step 4: Add the snapshot renderer to `api/_cadence-slack.js`**

Insert before the `module.exports` line:

```js
// The on-demand snapshot. A fresh, STANDALONE post -- never an edit, and
// deliberately not the heartbeat's message: editing the heartbeat would destroy
// the one property it is for (a timestamp that moves on its own schedule), and
// a snapshot the owner asked for should stay where they asked for it, in the
// channel history, rather than being overwritten by the next cron tick.
function snapshotMessage(snapshot, nowMs) {
  const s = snapshot.sentThisWeek;
  const t = snapshot.touchesToday;
  const realLines = [
    `*Clients with an active package:* ${snapshot.activeClients}`
    + `  ·  booked this week ${snapshot.booked}  ·  not yet ${snapshot.notBooked}`,
    `*Sent so far this week:*  neutral ${s.neutral}  ·  direct ${s.direct}`
    + `  ·  urgent ${s.urgent}  ·  lastcall ${s.lastcall}  ·  reassurance ${s.reassurance}`,
    `*Pre-call touches today:* 24h ${t['24h']}  ·  2h ${t['2h']}  ·  10m ${t['10m']}`
    + `  ·  failures ${snapshot.failuresToday}`,
  ];
  // Labelled every way it can be: in the heading, on every line, and with the
  // tilde. A forecast that reads as a record of things already sent is the one
  // way this message can actively mislead.
  const projectedLines = snapshot.projection.length
    ? snapshot.projection.map(p =>
        `~ *PROJECTED* ${p.weekdayKey} ${p.dayYmd}: \`${p.tier}\` to ${p.wouldSend} client(s)`)
    : ['~ *PROJECTED*: nothing left this week — Sunday is the last nudge day'];

  return {
    username: '3AMAK Bot',
    icon_emoji: ':mag:',
    text: `Cadence status for the week of ${snapshot.mondayYmd}: `
      + `${snapshot.booked}/${snapshot.activeClients} booked`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn',
          text: `:mag: *Cadence status — week of ${snapshot.mondayYmd}*`
            + `\n_${snapshot.weekdayKey}, ${snapshot.dayYmd}, ${snapshot.timeZone}_` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*ACTUAL*\n${realLines.join('\n')}` } },
      { type: 'section', text: { type: 'mrkdwn',
          text: `*PROJECTED — not sent yet, what the remaining days would do*\n`
            + projectedLines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn',
          text: `Requested from /admin · ${new Date(nowMs).toUTCString()}` }] },
    ],
  };
}

// Best-effort, like every other Slack call in this codebase: the owner pressed a
// button to LOOK at something, and a Slack hiccup must not turn that into an
// error page when the numbers are already computed and returned to the page.
async function postCadenceSnapshot(snapshot, nowMs) {
  try {
    const posted = await slack.postToSlack(
      slack.CHANNEL_SYSTEM_ALERTS, snapshotMessage(snapshot, nowMs));
    return { ok: !!(posted && posted.ts), ts: (posted && posted.ts) || null };
  } catch (e) {
    console.error('postCadenceSnapshot threw:', e.message);
    return { ok: false, ts: null, reason: e.message || String(e) };
  }
}
```

and replace the export line:

```js
module.exports = { dayKeyFor, heartbeatMessage, publishHeartbeat, snapshotMessage, postCadenceSnapshot };
```

- [ ] **Step 5: Run the snapshot tests to verify they pass**

Run: `node --test test/cadence-snapshot.test.js`
Expected: PASS.

- [ ] **Step 6: Add the admin button**

In `admin.html`, replace the `reminders-catchup` block (as left by Task 9) with:

```html
            <div class="reminders-catchup">
              <button type="button" class="btn-primary" id="sendRemindersNowBtn">Send Due Reminders &amp; Nudges Now</button>
              <span id="sendRemindersStatus" class="field-hint"></span>
              <button type="button" class="btn-primary" id="cadenceStatusBtn">Check Cadence Status</button>
              <span id="cadenceStatusStatus" class="field-hint"></span>
            </div>
```

Then add this function immediately after `wireRemindersCatchup` (around line 2269):

```js
    // Read-only: posts a status summary to #7-system-alerts and shows the same
    // numbers here. Sends no email and marks nothing, so unlike the catch-up
    // button above it needs no confirm dialog -- pressing it cannot change
    // anything, which is the whole point of having it.
    function wireCadenceStatus() {
      $('cadenceStatusBtn').addEventListener('click', async () => {
        const btn = $('cadenceStatusBtn');
        const statusEl = $('cadenceStatusStatus');
        btn.disabled = true;
        statusEl.textContent = 'Checking…';

        let res, data;
        try {
          res = await fetch('/api/calendar-reminders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cadenceStatus: true }),
          });
          data = await res.json().catch(() => ({}));
        } catch (err) {
          statusEl.textContent = 'Network error -- try again.';
          btn.disabled = false;
          return;
        }
        btn.disabled = false;

        if (res.status === 401 || res.status === 403) { showGate(); return; }

        if (res.status === 200 && data.ok && data.snapshot) {
          const s = data.snapshot;
          statusEl.textContent =
            `Week of ${s.mondayYmd}: ${s.booked}/${s.activeClients} booked, `
            + `${s.notBooked} not yet. Touches today: 24h ${s.touchesToday['24h']}, `
            + `2h ${s.touchesToday['2h']}, 10m ${s.touchesToday['10m']}. `
            + (data.posted ? 'Posted to #7-system-alerts.' : 'Could not post to Slack.');
          return;
        }
        statusEl.textContent = data.error || data.message || `Failed (status ${res.status}).`;
      });
    }
```

Finally, add `wireCadenceStatus();` beside the existing `wireRemindersCatchup();` call inside `init()`.

- [ ] **Step 7: Assert the new admin ids**

Append to `test/admin-page-structure.test.js`:

```js
test('the cadence catch-up and status controls both exist, with distinct ids', () => {
  const ids = new Set(idsIn(html));
  for (const id of ['sendRemindersNowBtn', 'sendRemindersStatus',
    'cadenceStatusBtn', 'cadenceStatusStatus']) {
    assert.ok(ids.has(id), `missing cadence control "${id}"`);
  }
});

test('both cadence buttons are wired, and the status one is wired read-only', () => {
  assert.match(html, /wireRemindersCatchup\(\);/, 'the catch-up button must still be wired');
  assert.match(html, /wireCadenceStatus\(\);/, 'the status button must be wired in init()');
  // The catch-up button sends real email and must keep its confirm; the status
  // button changes nothing and must not have one (a pointless dialog trains the
  // owner to click through the one that matters).
  const statusFn = html.slice(html.indexOf('function wireCadenceStatus'));
  const body = statusFn.slice(0, statusFn.indexOf('\n    }'));
  assert.equal(/window\.confirm/.test(body), false,
    'the read-only status button must not ask for confirmation');
  assert.match(body, /cadenceStatus:\s*true/);
});
```

- [ ] **Step 8: Run the admin structure suite**

Run: `node --test test/admin-page-structure.test.js`
Expected: PASS, including the pre-existing "no id appears twice in admin.html" test.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 10: Final sweep for retired names and forbidden patterns**

Run: `grep -rn "reminderSent\|needsImmediateReminder" api/ test/ ; grep -rln "new Queue\|withLock\|acquireLock\|Mutex" api/ ; ls api/*.js api/admin/*.js | grep -v "/_" | wc -l`
Expected: the first two greps print **nothing**, and the count is **12** — the Serverless Function cap, unchanged. A 13 means a new endpoint file was created somewhere and the deployment will fail to build.

- [ ] **Step 11: Commit**

```bash
git add api/calendar-reminders.js api/_cadence-slack.js admin.html test/cadence-snapshot.test.js test/admin-page-structure.test.js
git commit -m "feat(alerts): on-demand cadence status snapshot

A new admin-session-gated 'Check Cadence Status' button posts a standalone
message to the existing #7-system-alerts: this week's real nudge log plus a
clearly-labelled projection for the remaining days, and today's touch counts.
Strictly read-only -- no email, no flags, no confirm dialog."
```

---

## Self-Review

Run this yourself after the last task, before handing off.

**1. Spec coverage** — every requirement in `docs/superpowers/specs/2026-10-06-cadence-and-alerts-design.md` mapped to a task:

| Spec requirement | Task |
| --- | --- |
| Applicant cadence is pre-call reminders only — no nudge-to-book for applicants | Global Constraints; no task adds one |
| Three cascading touches per booked call: ~24h, ~2h, ~10min | 1 (the table), 5 (24h), 6 (2h + 10m) |
| Each touch fires only if still reachable given the booking's actual notice | 1 (`touchStatusAt`), 7 (`applyTouchPlan` acts on it) |
| A booking made 1h out skips the moot 24h/2h touches and gets only the 10min one | 1 (asserted as a named spec-example test), 7 (handler behaviour + rewritten `SHORT NOTICE` tests) |
| A booking made 5min out gets none of the three | 1 (named spec-example test), 7 (`VERY SHORT NOTICE` test) |
| A moot touch must not be logged or alerted as a failure | 5 (silent skip, asserted), 7 (`applyTouchPlan` logs nothing to Slack for moot) |
| A straightforward extension of `needsImmediateReminder`, not a per-client tracking system | 1 (same `min(interval) >= period` reasoning, generalized), 7 (same four call sites) |
| Check-in audience gets the same 3-touch treatment | 5, 6 (`SENDER_FOR_TOUCH`'s `checkin` column), 7 (`isCheckin: true` at both check-in call sites) |
| PLUS a separate recurring weekly nudge for check-in clients | 4 (copy), 8 (state), 9 (pass) |
| Cycle weekly, Monday-reset, anchored to the check-in template's timezone | 2 (`weekWindow`), 9 (uses `loadCheckinTemplate().template.timezone`) |
| Branch on done-status, not silence: booked → one-time reassurance | 4 (`sendCheckinAllSet`), 9 (booked branch, `reassuranceSent`) |
| Not booked → escalating nudge matching the day of week | 4 (`NUDGE_COPY`), 8 (`TIER_BY_WEEKDAY`), 9 (not-booked branch) |
| neutral → direct → urgent → last-call, one tier per day-band, never the same text resent | 8 (Tue/Thu/Sat/Sun mapping, asserted in escalation order), 4 (four distinct subjects and bodies, asserted) |
| No skip/opt-out link | 4 (asserted: no tier may contain unsubscribe/opt-out/skip/snooze) |
| Scope: only `isAccessActive()` clients; "No package" and paused excluded | 8 (`hasCheckinObligation`), 9 + 11 (both use it), Global Constraints |
| `checkin-cadence-state.json` with the exact `weeks` shape | 1 (blob name), 8 (`normalizeState`, round-trip test) |
| New Monday-anchored week helper — genuinely new, not an extension | 2 |
| Weekly pass runs once a day inside the existing `calendar-reminders.js` cron | 9 (daily path only; the fine path is asserted NOT to run it) |
| One `listEvents` for the week, grouped by attendee email, not one per client | 9 (asserted: five clients, one call) |
| Admin "Send Due Reminders Now" also replays the weekly pass, safe to click repeatedly | 9 (endpoint + button + the triple-click idempotence test) |
| Daily live-updating heartbeat, `chat.update`, rebuilt every cron tick including quiet ones | 10 |
| Heartbeat shows today's touches, today's nudges by tier, today's failure count | 10 (asserted) |
| Quiet-but-healthy must look different from a dead cron | 10 (the moving-timestamp test) |
| On-demand snapshot: admin-session-gated button + fresh standalone message | 11 |
| Snapshot = this week's real log + a clearly-labelled projection + today's touch counts | 11 (`sentThisWeek` / `projection` / `touchesToday`, and the "labels the projection" test) |
| No new per-event "Sent" message stream | Global Constraints; no task posts per send |
| Existing `postSystemAlert` failure alerts unchanged, no new channel | 10, 11 (both post to `CHANNEL_SYSTEM_ALERTS`); `postSystemAlert` itself is never edited |
| Avoid the nested-queue deadlock; single idempotent read-merge-write | 8 and 10 (both carry a source-level no-queue assertion), Global Constraints |
| External ~5-minute cron, bearer secret, a second distinct secret | 6 (prerequisite setup block + `REMINDER_FINE_CRON_SECRET`, with the not-interchangeable test) |
| 5 minutes specifically, because the 10-min window is 10 min wide | 1 (`FINE_CRON_PERIOD_MINUTES` comment), 6 (prerequisite warning), 7 (the "period short enough for the narrowest touch" test) |
| Out of scope: applicant nudge-to-book, nudge opt-out link, per-send Slack stream, changes to the four existing templates, a pruning policy, changes to the booking flows | Global Constraints; 3 and 4 add senders without touching existing ones; 8 documents the no-pruning decision |

No spec requirement is unmapped.

**Two things the self-review caught and fixed inline, worth flagging to a reviewer:**

1. **`isAccessActive()` is the wrong filter on its own.** The spec says a `durationMonths === 0` ("No package") client is excluded from the nudge, but `isAccessActive()` returns `true` for them — their computed `expiresAt` is `null`, and a null expiry means "active" to every booking-access check in the codebase. Tasks 9 and 11 originally read `cc.isAccessActive` directly, which would have nudged every No-package client weekly. Fixed by adding `hasCheckinObligation()` to Task 8 and using it in both places, with a test that names the trap.
2. **The 24h touch's mootness must NOT use `leadHours()`.** `REMINDER_LEAD_HOURS` is 36 in production, so measuring mootness against it would mark the 24h touch moot for every booking made with under 36 hours of notice — which is most bookings, and a plain regression against today's behaviour. Task 1 uses a fixed 24h nominal for mootness while the daily cron's listing window keeps using `leadHours()`, and Task 1 carries a named `REGRESSION GUARD` test for exactly this.

**2. Placeholder scan** — searched for every pattern in the skill's No-Placeholders list:

- No "TBD", no "TODO", no "implement later", no "fill in details".
- No "add appropriate error handling", "add validation" or "handle edge cases" — every error path is written out, including the deliberate asymmetry that a failed moot-stamp is logged while a failed send is alerted.
- No "write tests for the above" — every test step contains complete runnable code.
- No "similar to Task N" standing in for code. Task 7's four call sites are each written out in full even though three are near-identical, and Task 7 Step 7's instruction to "write the equivalent pair in each of the other three files" is accompanied by the complete code for the first one plus the exact substitution (`cemail.sendCheckinReminder`/`sendCheckinStartingSoon`) for the others — this is the one place the plan asks for adaptation rather than transcription, and it does so because the four test files each have their own local stub helpers whose names only the implementer can see.
- The word "placeholder" appears only in this section and in the two steps that assert `PLACEHOLDER` does **not** appear in the email sources.
- `REMINDER_FINE_CRON_SECRET` is the one value a human must generate rather than copy from this document. Task 6's PREREQUISITE block says exactly how, and there is no fake value left in the plan to be pasted by accident.

**3. Type and signature consistency** — checked across tasks:

- `TOUCH_KEYS` / `TOUCH_FLAGS` / `TOUCHES` (Task 1) — consumed under those exact names in 5, 6, 7, and re-exported as `remind.TOUCH_FLAGS` in 7 for the two reschedule handlers.
- `planTouches(startMs, nowMs) -> {moot, immediate, cron}` (Task 1) — consumed only in 7, via `applyTouchPlan`, with those exact three array names.
- `touchDueAt(key, startMs, nowMs)` and `touchStatusAt(key, startMs, nowMs)` (Task 1) — same argument order at every call site (5, 6, and both proof files). `touchDueAt` is `wouldRemind` for `'24h'` by construction, which Task 1 asserts directly rather than by inspection.
- `pathPeriodMs(path)` / `touchesForPath(path)` take the path CONSTANT (`PATH_DAILY` / `PATH_FINE`), never the string literal, at every call site.
- `runTouchPass(path, nowMs)` returns `{ok, considered, sent, skipped, failures, touches}` on success and `{ok:false, status, error, message}` on failure (Task 5) — the handler in 5, 6 and 9 destructures exactly those fields, and nothing reads a `reason` off the success shape or a `touches` off the failure shape.
- `SENDER_FOR_TOUCH[key][audience]` is a sender NAME (string), looked up on the live module (Task 5) — used identically in `runTouchPass` (5) and `applyTouchPlan` (7). Both branch `isCheckin ? cemail[name] : email[name]`, never a captured reference.
- The **Booking** object is the same eleven fields everywhere: `{eventId, name, email, phone, startMs, endMs, visitorTimeZone, templateTimeZone, manageToken, meetLink, lang}`. `runTouchPass` builds one; the four handlers already build one and pass it straight to `applyTouchPlan`; `sendStartingSoon` and `sendCheckinStartingSoon` (Task 3) read only fields in that set.
- The **Nudge recipient** object is deliberately a DIFFERENT, smaller shape: `{name, email}`, plus optional `startMs`/`visitorTimeZone` on `sendCheckinAllSet` only (Task 4). Task 9 constructs exactly that and nothing more. `test/checkin-email.test.js`'s `SENDERS` list is explicitly kept to the five Booking-shaped senders so the two shapes are never checked against each other's contract tests.
- `NUDGE_TIERS` has ONE definition, in `api/_checkin-email.js` (Task 4), re-exported by `_checkin-cadence.js` (Task 8) and asserted equal in Task 8's first test. The four tier strings appear as object keys in `NUDGE_COPY` (4), `emptyWeekEntry().nudges` (8), `emptyNudgeCounts()` (8) and `TIER_BY_WEEKDAY`'s values (8) — all four spellings verified character by character: `neutral`, `direct`, `urgent`, `lastcall` (one word, no hyphen, no camelCase).
- `emptyNudgeCounts()` has five keys — the four tiers plus `reassurance` — and that same five-key object flows `runWeeklyNudgePass` → `body.nudges` → `publishHeartbeat({nudgeCounts})` → `day.nudges` → `heartbeatMessage` → `snapshot.sentThisWeek` → `snapshotMessage`. Every consumer either iterates `Object.keys` or names all five; none assumes four.
- `TOUCH_COUNT_KEYS` in `_checkin-cadence.js` (Task 8) is `['24h','2h','10m']`, the same three strings as `TOUCH_KEYS` in `_reminder-touches.js` (Task 1). Two lists, deliberately: the cadence module must not require the reminder module (it is about clients, not calls), and Task 5's `emptyTouchCounts()` builds from `TOUCH_KEYS` while Task 10's accumulator iterates `TOUCH_COUNT_KEYS` — they are asserted equal indirectly by Task 10's heartbeat test, which feeds a `{'24h','2h','10m'}` object produced by `runTouchPass` into `publishHeartbeat` and reads the stored result back.
- `loadState()` / `mutate(fn)` both return `{ok, state, reason?}` with `state` always a `{weeks, days}` object even on failure (Task 8) — Tasks 9, 10 and 11 all read `.state` without a null check, which is only safe because of that guarantee.
- `weekEntry(state, mondayYmd, email)` and `dayEntry(state, dayYmd)` have that exact argument order at all six call sites (8, 9, 10, 11).
- `dayKeyFor(nowMs)` lives in `_cadence-slack.js` (Task 10) and is used by Task 11's `buildCadenceSnapshot` — not re-derived there, so the snapshot's "today" is always the heartbeat's "today".
- `publishHeartbeat({nowMs, touchCounts, nudgeCounts, failures})` is called with exactly that object in Task 10 Step 5, with `nudgeCounts: body.nudges || null` — and `publishHeartbeat` guards `(nudgeCounts || {})`, so the fine path's `null` is safe.
- `postCadenceSnapshot(snapshot, nowMs)` and `snapshotMessage(snapshot, nowMs)` take the Snapshot object documented field-for-field in Task 11's Interfaces block; Task 11's renderer test constructs one by hand from that list, so a field added to the builder without being added to the documented shape fails there.
- `updateSlackMessage(channelId, ts, message)` (Task 10) is called with that argument order in `publishHeartbeat` and asserted at that order in the test.
- One naming overlap worth flagging: `api/_checkin-cadence.js` exports `mutate`, and `api/calendar-reminders.js` has a local `runWeeklyNudgePass` that calls `cadence.mutate`. There is no bare `mutate` in `calendar-reminders.js`, so no shadowing — but do not "simplify" by destructuring `mutate` from the cadence module there, because the whole-module access is what makes the no-nested-mutate rule visible at the call site.

**4. Serverless Function count** — re-verified, because this is the constraint that fails the build rather than a test: the plan creates `api/_reminder-touches.js`, `api/_checkin-cadence.js` and `api/_cadence-slack.js`, all `_`-prefixed, and adds **zero** non-`_` files under `api/`. The count stays at 12. Task 11 Step 10 asserts it mechanically.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-06-cadence-and-alerts.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute tasks in one session with checkpoints for review. **REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

Which approach?

**Before either one starts**, note the two human-in-the-loop items, because neither is something an implementing agent can do:

- **Task 6's PREREQUISITE** needs the owner to generate `REMINDER_FINE_CRON_SECRET`, add it to Vercel, redeploy, and create the every-5-minutes job on cron-job.org pointing at `/api/calendar-reminders?touch=fine`. The code and tests can all be written and merged without it; the 2h and 10min touches simply never fire in production until it exists.
- **Task 7 changes production behaviour for short-notice bookings** (a 1h-notice booking stops getting an immediate reminder and starts getting a 10-minute one instead). That is the spec's decision, but it only becomes true once the external cron from Task 6 is live — so Task 6's infrastructure should be in place BEFORE Task 7 ships, or short-notice bookings get no pre-call touch at all in the window between the two.
