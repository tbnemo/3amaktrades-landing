# Booking Cadence + System Alerts — Design Spec

**Trigger:** two sibling trigger phrases invoked together — **"Email cadence build out"** (richer pre-call reminders for both booking audiences, plus a recurring nudge-to-book cycle for check-in clients) and **"System Alerts build out"** (visibility into whether that cadence is actually running). Layered on top of the existing Calendar booking system (`docs/superpowers/specs/2026-09-24-calendar-booking-design.md`), the check-in booking system (`docs/superpowers/specs/2026-09-29-checkin-booking-design.md`), and the just-finished real email copy pass (the "Minimal Ticket" shell in `api/_email.js`/`api/_checkin-email.js`).

## Goal

Replace the single flat pre-call reminder with three cascading touches, scaled to however much notice a booking actually has. Separately, give check-in clients (who are expected to book a check-in periodically, not just once) a recurring weekly nudge if they haven't booked yet this cycle. Give the business owner ambient and on-demand visibility that all of this is actually firing, reusing the existing failure-alert channel rather than standing up a parallel one.

## Decisions made (do not re-ask)

- **Applicant cadence is pre-call reminders only** — no nudge-to-book sequence for applicants who never booked. Three cascading touches per booked call: **~24h before, ~2h before, ~10min before**. Each touch fires only if it's still reachable given the booking's actual notice — a booking made 1 hour before the call skips the moot 24h and 2h touches and only gets the 10min one; a booking made 5 minutes out gets none of the three (the existing booking-confirmation email is the only thing that fires). This is a straightforward extension of the existing `needsImmediateReminder` escape valve, not a new per-client tracking system.
- **Check-in cadence is both**: the same 3-touch pre-call reminder treatment for an already-booked check-in call, **plus** a separate recurring weekly "book your next check-in" nudge for clients who haven't booked one yet this cycle.
  - **Cycle: weekly, Monday-reset** (Mon–Sun), anchored to the check-in template's own timezone (not UTC).
  - **Branch on done-status, not silence**: a client who already booked this week's check-in gets a one-time, light "you're all set" reassurance touch — not nothing. A client who hasn't gets an escalating nudge matching the day of week.
  - **Escalation across the week**: neutral → direct → urgent → last-call, one tier per day-band (exact day mapping decided at implementation time, e.g. Tue/Thu/Sat/Sun) — never the same text resent.
  - **No skip/opt-out link.** The ask always stands.
  - **Scope**: only clients with an active, non-paused package (`isAccessActive()` from `api/_checkin-clients.js`). A "No package" (`durationMonths === 0`) or currently-paused client has no check-in obligation and is excluded from the nudge entirely.
- **System alerts — both requested, additive to what exists**: there is already a `#7-system-alerts` Slack channel (`CHANNEL_SYSTEM_ALERTS` in `api/_slack.js`) with a working `postSystemAlert()`, used today purely for failures (e.g. "Reminder send failed"). That stays exactly as-is. New, on top of it:
  1. **Daily live-updating heartbeat** — one parent message per day in the same channel, refreshed in place (`chat.update`) on every cron tick, not just on an actual send: today's reminder touches sent, today's check-in nudges sent (by tier), and today's failure count. Doubles as a liveness signal — if it stops updating, something is actually broken; if it updates with all-zero counts, everything is fine and simply quiet.
  2. **On-demand snapshot** — a new admin-session-gated button ("Check Cadence Status") posting a fresh, standalone message: this week's check-in cadence so far (real log, Monday-through-today) plus a clearly-labeled projection for the remaining days, and today's reminder-touch counts.
  - **No new per-event "Sent" message stream.** We are explicitly not adding a standalone Slack post for every individual reminder/nudge send — that's shape 2 from the System Alerts framework, and it's not wanted here beyond the failure case that already exists.

## Architecture

### Three-touch pre-call reminders (both audiences)

Each booking's calendar event currently carries one flag, `extendedProperties.private.reminderSent`, cleared/set by the single existing reminder. This splits into three independent flags: `reminder24hSent`, `reminder2hSent`, `reminder10mSent`.

- **The 24h touch** rides the existing once-daily Vercel cron (`calendar-reminders.js`, `vercel.json`'s `0 0 * * *` entry) — unchanged window math, just renamed from the current single-touch logic.
- **The 2h and 10min touches** cannot ride that cron: Vercel Hobby allows only once-daily scheduling, and a call booked for 3pm needs something checking specifically around 1pm and again around 2:50pm. These two touches get a **new fine-grained path**: a bearer-secret-protected mode/endpoint, polled every **~5 minutes** by an external free cron service (cron-job.org or equivalent) that the user sets up themselves. Five minutes, not ten or fifteen, because the 10-minute touch's usable window is itself only 10 minutes wide (from *call − 10min* to *call start*) — the same "an interval must be at least a full period long to guarantee a hit regardless of phase" reasoning `needsImmediateReminder` already uses for the 24h case applies here: a cron period longer than the window it's meant to catch cannot be trusted to ever land inside it.
- `needsImmediateReminder` generalizes from one check to three: at booking/reschedule time, evaluate each touch independently — can its relevant cron (daily, or the new 5-minute external one) be trusted to catch it before the call? If not, send that touch immediately instead of waiting. A touch whose window has **already fully passed** by booking time (the 24h touch for a booking made 1h out) is not sent by either path — it is moot, not a failure, and must not be logged or alerted as one.
- **New copy**: a more urgent "starting soon" variant for the 10-minute touch, in both `api/_email.js` (applicant, bilingual EN/AR) and `api/_checkin-email.js` (check-in, EN-only) — same Minimal Ticket shell and shared helpers (`shell`, `headline`, `detailsBox`, `ctaButton`, `footerLine`) as every other template, not a new visual pass. The existing 24h-equivalent copy (`sendReminder` / `sendCheckinReminder`) is reused for the 24h touch; the 2h touch reuses the same copy as the existing single reminder did (no behavior change there beyond timing), and only the 10-minute touch needs genuinely new wording.

### Check-in weekly nudge-to-book

New private Vercel Blob document, `checkin-cadence-state.json` (added to `api/_blob-store.js` alongside the existing pattern):

```
{
  "weeks": {
    "<Monday-date-of-the-ISO-week, YYYY-MM-DD>": {
      "<client email, lowercased>": {
        "reassuranceSent": false,
        "nudges": { "neutral": false, "direct": false, "urgent": false, "lastcall": false }
      }
    }
  }
}
```

A new Monday-anchored week-boundary helper is added (there is no existing one in `api/_timezone.js` — this is genuinely new to the codebase, not an extension of something already there), matching the "weeks are always Monday–Sunday, never raw `getDay()`" convention established on the Built By Stones project, computed against the check-in template's own configured timezone.

Once per day, the same `calendar-reminders.js` cron run also executes the weekly-nudge pass (day-level granularity is sufficient here — no new infra needed for this half):

1. List every check-in client from `checkin-clients.json` where `isAccessActive()` is true.
2. For each, check whether a check-in-audience event (`extendedProperties.private.audience === 'checkin'`) exists with `startMs` inside the current Monday–Sunday window (one `listEvents` call for the week, grouped by attendee email, rather than one call per client).
3. **Booked**: send the "you're all set" reassurance touch once (`reassuranceSent`), if not already sent this week.
4. **Not booked**: send today's escalation tier (one of neutral/direct/urgent/lastcall, mapped to day-of-week), if that tier hasn't already been sent this week. Lower tiers already sent are not resent once a later tier fires.

**Admin catch-up**: the existing "Send Due Reminders Now" admin button/endpoint (`admin.html` → `POST /api/calendar-reminders`) is extended to also safely replay the weekly-nudge pass — safe to click repeatedly, since it's gated by the same per-week/per-client dedup flags as the automated run.

### System alerts

- **Heartbeat**: a new helper (in `api/_slack.js` or a new `api/_cadence-slack.js`) that maintains one `chat.update`-refreshed message per day in the existing `CHANNEL_SYSTEM_ALERTS`. Rebuilt from the day's current counts every time the cron runs — including runs where nothing happened — so the message visibly moves on a quiet-but-healthy day instead of looking identical to a dead cron.
- **On-demand snapshot**: new admin-session-gated endpoint + `admin.html` button, posting a fresh, standalone (non-updating) message: this week's check-in cadence log so far plus a clearly-labeled projection for the remaining days, and today's reminder-touch counts.
- **Concurrency note (nested-queue deadlock, caught in advance)**: both the daily cron and the new 5-minute external cron can independently trigger a heartbeat update around the same moment. If the heartbeat's "update the message" step were wrapped in a serializing queue, and something upstream also wrapped the *caller* of that step in the same queue, the outer call would occupy the slot the inner call waits on forever. The implementation keeps the heartbeat update as a single, non-nested, idempotent read-merge-write against blob-stored day state — never a queue-wrapped function called from inside another queue-wrapped function.
- Reuses `postToSlack` / `CHANNEL_SYSTEM_ALERTS` from the existing `api/_slack.js`. No new channel, no change to the existing failure-only alerts.

### External infrastructure (new, required)

One external cron job (cron-job.org or equivalent free service), configured by the user, hitting the new fine-grained reminder endpoint every ~5 minutes with a bearer-secret header (same auth shape as the existing `CRON_SECRET` check, a second distinct secret). Required for the 2h/10min touches to be reliable; nothing else in this build needs it.

## Explicitly out of scope

- Any nudge-to-book sequence for new applicants who never booked a call — applicants get pre-call reminders only, per the decision above.
- A skip/opt-out link for the check-in weekly nudge.
- A standalone Slack message for every individual reminder/nudge send (System Alerts "shape 2" beyond the failure case that already exists).
- Any change to the real email copy/visual shell just finished for the four existing template types — the new "starting soon" and weekly-nudge templates reuse that same shell and helpers, not a new design pass.
- A retention/pruning policy for old weeks in `checkin-cadence-state.json` — left to grow for now; revisit if it becomes a real size concern.
- Changing anything about the new-applicant or check-in booking flows themselves, their Slack channels, or their existing confirmation/reschedule/cancellation templates.
