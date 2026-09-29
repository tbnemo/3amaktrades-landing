# Mentorship Check-In Booking — Design Spec

**Trigger:** a second booking audience on top of the existing Calendar system (`docs/superpowers/specs/2026-09-24-calendar-booking-design.md`). Existing mentorship clients need to book "check-in" calls, separate from the new-applicant booking flow that spec covers, but reading the same underlying Google Calendar so the two audiences can't double-book Omar's time.

## Goal

Existing clients get a link to a page where they verify who they are, then book a check-in call on Omar's calendar, on hours he sets independently of his new-applicant hours. This is layered on top of the existing calendar booking system, not a replacement for any part of it.

## Decisions made (do not re-ask)

- **Access:** a direct link (`/check-in`), gated by a light self-serve verification step (email or phone, checked against a manually-maintained client list) — no account system, no password.
- **Client list:** maintained manually by Omar from the admin page. Add a client once when they sign on, remove them if they stop. No CRM sync, no CSV import. **Email is required on every entry** — it's the only channel confirmation/reschedule/cancellation notices go through, so a phone-only entry would silently get none. Phone is optional, stored only as a second way for a visitor to verify (some clients may not want to type an email on their phone). Email (lowercased) is the entry's key, since it's guaranteed present; the admin `DELETE` identifies a record by that key.
- **Admin hours:** configured from the same `admin.html` page as the new-applicant hours, behind a tab bar (**New Applicants** / **Check-Ins**), not a separate page or separate login.
- **Slot settings independent:** check-in slot duration, buffer, and minimum notice are configured separately from the new-applicant template — they are very likely shorter/more frequent, and there's no reason to couple the two.
- **Lifecycle fully separate:** dedicated booking/reschedule/cancel endpoints, dedicated Slack channels, dedicated email templates. The only two things shared with the new-applicant system are the underlying Google Calendar (so double-booking guard logic must see both audiences) and the reminders cron (see below — a platform constraint, not a design preference).
- **Frontend fully separate:** `/check-in` is its own standalone page with its own independently-written slot-picker UI. It shares no widget code with the existing applicant booking widget (`booking-widget.js`). A future divergence in look/behavior between the two is expected, not an edge case to avoid.
- **Failed verification:** a generic message — "We couldn't verify that email or phone. If you're a current client, contact Omar directly." — no hint about what specifically didn't match, and no distinction shown between "not on the list" and any other failure.
- **Slack:** three dedicated channels, mirroring the new-applicant structure exactly — `#8-checkin-booked`, `#9-checkin-rescheduled`, `#10-checkin-cancelled`. Backend failures (guard skips, rollback failures, email failures) reuse the *existing* `#7-system-alerts` channel — that channel is infra-level and audience-agnostic, so a duplicate would just split one signal across two places.
- **Email:** new placeholder-copy templates, separate from the new-applicant ones, following the same "mechanism now, real copy later in a collaborative pass" convention already established for that system.
- **No self-serve manage-booking UI in this build:** the reschedule/cancel *endpoints* are built and tested (see below), but — matching the existing new-applicant precedent, where those endpoints are also built but nothing yet links to them from an email — `check-in.html` does not include a "manage my booking" page or link. A client who needs to reschedule contacts Omar directly for now; wiring a self-serve link into the confirmation email is a natural follow-up once real email copy is written, not part of this build.

## Architecture

Builds directly on the existing serverless-function convention under `api/`. Two new private Vercel Blob documents (see `api/_blob-store.js` for the existing pattern):

1. `checkin-availability-template.json` — same shape as `availability-template.json` (`{ timezone, days: {...}, slotMinutes, bufferMinutes, minNoticeHours }`), but a fully independent document. **Timezone is separately admin-editable here too** — Omar may want check-ins in a different zone than new-applicant hours if his schedule shifts, though it will often match.
2. `checkin-clients.json` — `{ clients: [{ name, email, phone }] }`. `email` is always present (see the Decisions section — it's the record's key); `phone` is optional. Matching against a submitted email/phone is case-insensitive on email, and compares phone on digits-only (strip formatting) so `+1 (555) 010-0100` and `5550100100` match the same stored record.

No new blob for OAuth — the existing `oauth-refresh-token.json` and the existing Google Calendar connection are reused as-is. There is exactly one Google Calendar and one OAuth connection in this whole system; check-in booking does not add a second one.

### Calendar tagging (the one point of real coupling)

Both audiences write events onto the same calendar, so the double-booking guard (`api/_booking-guard.js`) must recognize events from *either* flow as "ours" for rollback purposes. The guard's existing `EVENT_MARKER` (`bookingSource: '3amak-booking'`) stays a single shared constant — unchanged, not duplicated — written by both `calendar-book.js` and the new `calendar-checkin-book.js`. This is what lets two bookings from either audience race each other and still resolve correctly (one survives via the existing id tie-break, or yields to a genuine foreign event) without touching `_booking-guard.js` at all.

What *does* distinguish the two audiences is a new field: `extendedProperties.private.audience`, set to `'checkin'` by the check-in flow (the existing applicant flow does not set this field at all — its absence means "applicant", so no changes to `calendar-book.js`'s write path are needed). Every place that reads an event's metadata back (`calendar-reminders.js`, the reschedule/cancel handlers) checks this field to decide which templates/channels to use.

### New endpoints

- `POST /api/checkin-verify` — body `{ email?, phone? }`. Looks up `checkin-clients.json`, matching on either field per the rule above. On a match: returns `{ ok: true, name, verifyToken }`.

  `verifyToken` is a **new** signing primitive, not a reuse of the existing `manageToken` (`api/_booking-token.js`) — that helper is a stateless HMAC over `(eventId, email)` with no expiry field at all (deliberately: rotating the secret is its only revocation method), and there is no `eventId` yet at verify time anyway. Instead, add `makeVerifyToken(email)` / `verifyVerifyToken(email, token)` to a new `api/_checkin-token.js`, HMAC-signing `checkin-verify-v1|<normalizedEmail>|<expiryEpochMs>` (same `sessionSecret()` signing key as the rest of the admin/booking token machinery, same constant-time comparison discipline as `verifyBookingToken`) and encoding the expiry alongside the signature (e.g. `<base64url signature>.<expiryEpochMs>`) so verification can check `Date.now() < expiryEpochMs` before comparing the HMAC. The token is always scoped to the matched client record's **email** — even when the visitor typed a phone to verify, the record's email (guaranteed present, see Decisions) is what gets signed into the token and later used to address the confirmation email — expiring 10 minutes after issue (enough to complete one booking, short enough that a leaked/logged token is useless soon after). On no match: `{ ok: false }`, no further detail, matching the generic-message decision above.

  This token exists to close an obvious hole: without server-side enforcement, anyone could skip the verification UI and POST straight to the booking endpoint with an arbitrary email. `calendar-checkin-book.js` requires and validates this token before inserting an event — verification is enforced at the API boundary, not just in the page's UI.

- `GET /api/calendar-checkin-availability?date=YYYY-MM-DD[&days=N]` — mirrors `calendar-availability.js` exactly, reading `checkin-availability-template.json` instead of `availability-template.json`. Same free/busy computation against the same calendar (so an applicant's booked slot correctly shows as unavailable here, and vice versa).
- `POST /api/calendar-checkin-book` — mirrors `calendar-book.js`: same pre-insert free/busy re-verify, same post-insert overlap guard using the shared `EVENT_MARKER`/`shouldRollBack`, same token-minting for manage links. Additionally requires `verifyToken` in the body and rejects with 403 if it's missing, expired, or invalid for the email carried inside it (the booking's `visitorEmail` is taken from the *token's* email, not re-read from the request body, so it always matches the verified client record even if the visitor originally typed a phone). Writes `audience: 'checkin'` into `extendedProperties.private`. Calls the new check-in Slack/email senders (below), not the existing ones.
- `POST /api/calendar-checkin-reschedule`, `POST /api/calendar-checkin-cancel` — mirror `calendar-reschedule.js`/`calendar-cancel.js` exactly (same rollback discipline, same `reminderSent` re-arm/restore handling), operating on check-in events and calling the check-in Slack/email senders. **Defense in depth:** the shared `manageToken` mechanism doesn't encode which audience an event belongs to (it's just an HMAC over `eventId+email`, unchanged from the applicant version), so both handlers explicitly reject with 403 if the loaded event's `extendedProperties.private.audience !== 'checkin'` — a check-in manage link must never be able to act on an applicant booking, even if some future bug ever caused an eventId/email pair to be reused or guessed across audiences.
- `GET/POST /api/admin/checkin-availability` — mirrors `api/admin/availability.js`, reading/writing `checkin-availability-template.json`. Same passcode gate (`_admin-auth.js`), same validation-before-normalize discipline.
- `GET/POST/DELETE /api/admin/checkin-clients` — list, add, and remove entries in `checkin-clients.json`. Same passcode gate. `POST` validates that `email` is present and non-empty (phone is optional) before appending; adding an email already on the list replaces that entry rather than duplicating it. `DELETE` takes `{ email }` and removes the matching entry.

### Reminders cron — shared, not duplicated

`calendar-reminders.js` stays a **single cron job**, unchanged in its scheduling and window logic. This is a platform constraint as much as a design choice: Vercel's Hobby plan caps the number and frequency of cron jobs, and this project already uses its one daily slot for the existing reminders run. Rather than fight that limit, the existing loop (which already walks every event carrying the shared `bookingSource` marker) branches on `meta.audience` to decide which `sendReminder` — the applicant one or the check-in one — to call for that event. Everything else about the reminder-delivery guarantee (the `min(minNoticeHours, REMINDER_LEAD_HOURS) ≥ cronPeriodHours` invariant, the "flag after send, never before" ordering, per-item isolation) applies identically to both audiences, since it's the same loop.

### Slack wiring

New file `api/_checkin-slack.js`, structurally mirroring `api/_booking-slack.js` (`postCheckinBookingCreated`, `postCheckinBookingChanged(b, kind)`), posting to the three new channel constants added to `api/_slack.js` (`CHANNEL_CHECKIN_BOOKED`, `CHANNEL_CHECKIN_RESCHEDULED`, `CHANNEL_CHECKIN_CANCELLED`). Cross-channel context (linking a reschedule/cancellation back to the original booking message) uses the same `getPermalink` approach already shipped for the applicant channels, since Slack still can't thread across channels here either. Backend-failure alerts from the new endpoints call the existing shared `postSystemAlert` — no new alert channel.

### Email templates (mechanism only — copy TBD with user)

New file `api/_checkin-email.js`, exporting `sendCheckinConfirmation`, `sendCheckinRescheduleNotice`, `sendCheckinCancellationNotice`, `sendCheckinReminder` — separate placeholder copy from the applicant templates, following the same "PLACEHOLDER COPY" marking convention already in `api/_email.js`. The low-level Resend-sending call and the `formatWhen` timezone-formatting helper are reused from `api/_email.js` (exported from there for this purpose) rather than reimplemented — that is transport-layer plumbing, not audience-facing copy, so sharing it doesn't compromise the "fully separate lifecycle" decision.

### `/check-in` page

A new standalone `check-in.html`, independently written (no shared code with `booking-widget.js`, per the explicit decision above), matching the site's existing Bullion black/gold visual identity (same CSS custom properties, fonts, zero-radius, RTL-aware logical properties as the rest of the site — no fresh visual exploration).

Flow:
1. A short form: "Enter your email or phone to book a check-in call" → `POST /api/checkin-verify`.
2. On success: a day-picker + time-slot grid (built independently for this page) fetching from `/api/calendar-checkin-availability`, confirm step collects nothing further (name and email come back from `checkin-verify`'s match) and posts to `/api/calendar-checkin-book` with the `verifyToken` attached.
3. On a 409 (slot taken between load and confirm): same "expected race, not an error" handling as the applicant widget — clear the selection, tell the visitor plainly, re-fetch.
4. On failed verification: the generic message from the Decisions section, with no retry-guessing affordance beyond letting them try again.

### `admin.html` changes

A tab bar added at the top of the existing admin page: **New Applicants** (today's hours form, unchanged, becomes the default/first tab) and **Check-Ins** (a sub-tab or stacked sections: the check-in hours form, mirroring the applicant one, and a client-list manager — a simple table of name/email/phone rows, an add form requiring email, and a remove action per row). One passcode session covers both tabs; no new login flow.

## Explicitly out of scope for this build

- Any CRM sync or import for the client list (manual admin entry only).
- A client-facing account/login system — verification is per-visit (email/phone check), not a persistent session identity.
- A self-serve "manage my booking" page or link for check-in clients (see Decisions — the reschedule/cancel endpoints are built, but nothing links to them yet, matching the existing applicant precedent).
- Changing anything about the existing new-applicant booking flow, its endpoints, its Slack channels, or its email templates.
- Final email copy for the check-in templates (separate collaborative step, same as the applicant emails).
- A second Google Calendar or a second OAuth connection.
