# Calendar Booking System — Design Spec

**Trigger:** "Calendar build out" (see project memory `calendar-build-out-trigger.md`). A standalone Google Calendar booking system, built from scratch — not a Calendly/Cal.com embed. That decision is not open for re-litigation.

## Goal

Let a visitor who's already applied and is on the $1k+ budget tier book a call directly with Omar, without a DM round-trip. Everyone else keeps the existing WhatsApp/Instagram/Discord confirmation-screen paths, unchanged.

## Scope: Tier 1 — pure booking, no tracking

- Connect one Google Calendar (Omar's), set weekly availability, embed a booking widget.
- No admin client list, no packages, no client-facing login. A booking either exists on the calendar or it doesn't — the calendar itself is the record.
- Explicitly NOT in scope: Tier 2 client list, Tier 3 package lifecycle. Do not build either "just in case."

## Decisions made (do not re-ask)

- **Calendar provider:** Google Calendar. OAuth already set up — see Credentials below.
- **Calendars:** single calendar, Omar's own. No multi-staff scheduling.
- **Availability model:** fixed weekly template (day-enabled + start/end time per day), but the **timezone the template is interpreted in is admin-editable**, not hardcoded — Omar splits time between Canada and Turkey and needs to switch it himself from the admin page. A plain dropdown of IANA timezone names (or a searchable combobox) is enough; no need to derive it from a "pick your country" abstraction.
- **Visitor timezone:** auto-detected via `Intl.DateTimeFormat().resolvedOptions().timeZone`, but shown as an editable dropdown, not a fixed label — same auto-detect-but-overridable pattern already shipped for the phone country-code picker elsewhere on this site.
- **Email templates:** in scope. Resend is the provider (`RESEND_API_KEY` already set in Vercel, Production + Preview). **Template wording/layout needs a hands-on collaborative pass with the user** — drafts shown, reactions incorporated, iterated — not written and shipped unilaterally. This spec defines *which* transactional emails exist and *what triggers them*, not their final copy. Implementation should stand up the sending mechanism with clearly-labeled placeholder content, and treat final copy as a separate, explicitly flagged follow-up step done live with the user.
- **Slack:** booking events notify through the *existing* pipeline (`api/_slack.js`), not new notification logic. Same channel/threading conventions already established there.
- **Hosting:** Vercel (already the site's host). Persistent storage: **Vercel Blob** — two JSON blobs (`oauth-refresh-token.json`, `availability-template.json`), read/write via `@vercel/blob`. Chosen over standing up a separate KV/Redis marketplace integration because it's a first-party Vercel primitive, needs no additional account linking, and two small JSON documents is exactly what it's for — no relational database or real key-value store is warranted at this scale.
- **Visual identity:** match the existing Bullion black/gold system already on the site (`--void`, `--band`, `--gold`, `--gold-lo`, `--ink`, `--bone`, `--dim`; Big Shoulders Display / Changa fonts; zero border-radius; logical CSS properties for RTL). No fresh visual exploration — this is going onto an existing branded site.
- **Where it surfaces on the site:** a new "Book a Call" option on the Apply form's confirmation screen (`#formConfirm`), shown *only* when `payload.budgetCode` is `'1k-3k'` or `'3k+'`. Sits alongside the existing WhatsApp/Instagram row for those tiers (not a replacement). The `<500` tier keeps seeing Discord-only, per the standing rule already shipped this session; the `500-1k` tier keeps WhatsApp+Instagram+Discord, no calendar option.

## Credentials already provisioned (do not recreate)

All four saved as Vercel env vars on `3amaktrades-landing`, Production + Preview:

- `RESEND_API_KEY` — Resend, "Sending access" scope only.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from a new, dedicated Google Cloud project ("3AMAK Trades Calendar", project ID `amak-trades-calendar`). Calendar API enabled. OAuth consent screen: External, Testing status, scope `https://www.googleapis.com/auth/calendar` added, test user `omar3halabi@gmail.com` added. OAuth client (Web application) has one authorized redirect URI: `https://3amaktrades.com/api/calendar-oauth-callback`. **The redirect endpoint's path is locked to that exact value — do not rename it without also updating the Google Cloud client.**

Still needed before this can go live end-to-end (not blocking implementation, but blocking real testing): the user creating a Vercel Blob store on this project from the dashboard (Storage → Create Database → Blob) — the MCP-connected Vercel access used to set up the credentials above returned 403 Forbidden trying to provision it directly — and Omar completing the one-time "connect my calendar" OAuth click from the admin page once it exists.

## Architecture

Serverless functions under `api/`, following the existing convention (`api/submit.js`, `api/_slack.js`, `api/wa-click.js` are the precedent — same platform, same deploy pipeline, no new hosting decision needed). Two Vercel Blob JSON documents for all persistent state:

1. `oauth-refresh-token.json` — the Google OAuth refresh token (never the access token long-term — derive access tokens on demand, cache them keyed on the refresh token's own value, not just an expiry timestamp, to avoid serving a stale token after Omar reconnects or switches accounts).
2. `availability-template.json` — `{ timezone: "America/Toronto", days: { mon: {enabled, start, end}, tue: {...}, ... }, slotMinutes, bufferMinutes, minNoticeHours }`.

No relational database, no KV/Redis integration — two small JSON blobs is well within scope for this build.

### Endpoints

- `GET /api/calendar-oauth-start` — admin-only (passcode-gated), redirects into Google's consent screen.
- `GET /api/calendar-oauth-callback` — exchanges the code for tokens, persists the refresh token, redirects back to the admin page. Must match the exact redirect URI registered above.
- `GET /api/calendar-availability?date=YYYY-MM-DD` — computes open slots for that day from the template + live Google free/busy data. Slots are computed on request, never pre-generated or stored.
- `POST /api/calendar-book` — creates the calendar event. After insert, immediately re-count events overlapping that exact window and roll back (delete) if more than one now exists — the initial availability check and the insert are not atomic, so this second check is the only thing preventing a genuine double-booking race.
- `POST /api/calendar-reschedule`, `POST /api/calendar-cancel` — same overlap-safety discipline as booking.
- `GET /api/admin/availability`, `POST /api/admin/availability` — read/write the weekly template (including timezone) and slot/buffer/notice constants. Passcode-gated.
- Admin gate: shared passcode + HMAC-signed session cookie. No full user-account system — this manages one person's calendar.

### Booking widget

A single self-contained vanilla-JS file (`booking-widget.js`, zero dependencies), scoped `<style>` injected once, mounted via `BookingWidget.mount(container, options)` so it can be reused wherever it's needed (the Apply confirmation screen now; potentially a reschedule flow later via a `mode` option, not required for this build).

- **Progressive reveal, not one big form:** day picker strip first → time slots for the picked day (fetched live) → contact fields (name/email/phone — reuse what the Apply form already collected via `extraFields`, don't re-ask) → confirm button, revealed in that order.
- Auto-select the first day with real openings on load, not blindly "today" (today's hours may have already passed).
- Visitor timezone: auto-detected, shown as an editable dropdown per the decision above; re-fetch slots for the selected day if the visitor changes it.
- Treat a 409 on submit (slot taken between page-load and confirm) as an expected race, not an error: clear the selected slot, tell the visitor plainly, silently re-fetch fresh slots for that day.
- Preserve visitor-typed input across re-renders if the implementation re-renders via `innerHTML` (the simplest approach, fine at this scale) — keep typed values in state separate from the render function, and explicitly save/restore `scrollLeft` on the day-picker strip across re-renders.
- `onBooked` / `onDuplicate` / `onUnavailable` callbacks, not a fixed built-in ending — the embedding page (the confirmation screen) decides what happens next.
- Native `<input type=date>`/`<input type=time>` cannot be restyled — build the day/time pickers as custom components from scratch, not by fighting the native controls.

### Email templates (mechanism only — copy TBD with user)

Triggered by: booking confirmation, reschedule, cancellation, a reminder before the call. Sent via Resend from whatever sending domain is verified (starts on Resend's shared domain if `3amaktrades.com`'s own sending domain isn't verified yet — that's a fine starting point, not a blocker). Placeholder subject/body content, clearly marked as placeholder in the code, swapped out in the follow-up collaborative design pass.

### Slack wiring

Reuse `api/_slack.js`'s existing send function/channel routing rather than writing a second notification path. A new booking posts the same way an application currently does; a cancellation/reschedule threads onto that same message if `_slack.js`'s existing threading mechanism supports it (check before assuming — it may not, in which case a plain new message is fine).

## Explicitly out of scope for this build

- Tier 2/3 client tracking, packages, or login.
- Multi-staff/multi-calendar scheduling.
- Final email copy (separate collaborative step).
- A `www` redirect or any other unrelated site change.
