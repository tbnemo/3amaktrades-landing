// The five CHECK-IN-audience endpoints, in one Serverless Function.
//
// They used to be five files: checkin-verify.js, calendar-checkin-availability.js,
// calendar-checkin-book.js, calendar-checkin-cancel.js and
// calendar-checkin-reschedule.js. The Hobby plan allows 12 Serverless Functions
// per deployment and every non-`_` .js file under api/ becomes one, so this
// deployment was failing to build at 19. Nothing below changes behaviour: each
// handler is its original body, and each original PUBLIC PATH still works,
// preserved by `rewrites` in vercel.json:
//
//   /api/checkin-verify                 -> verify
//   /api/calendar-checkin-availability  -> availability
//   /api/calendar-checkin-book          -> book
//   /api/calendar-checkin-cancel        -> cancel
//   /api/calendar-checkin-reschedule    -> reschedule
//
// check-in.html / check-in.js still call those exact paths and were not touched.
// See api/_route-action.js for how a request is matched back to its handler, and
// why no rewrite destination carries a query string.
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const guard = require('./_booking-guard');
const cc = require('./_checkin-clients');
const ct = require('./_checkin-token');
const rl = require('./_checkin-verify-rate-limit');
const cslack = require('./_checkin-slack');
const cemail = require('./_checkin-email');
const { AUDIENCE_CHECKIN, isCheckinEvent } = require('./_checkin-audience');
const { postSystemAlert } = require('./_slack');
const { makeBookingToken } = require('./_booking-token');
const { loadCheckinTemplate } = require('./_load-checkin-template');
const { loadBooking } = require('./_load-booking');
const { resolveAction, notFound } = require('./_route-action');

// ===========================================================================
// POST /api/checkin-verify
// { email?, phone? } -> { ok:true, name, verifyToken } | { ok:false }
//
// The light self-serve gate on /check-in: no account system, no password, just
// "are you on the manually-maintained client list". The token it hands back is
// what the book handler below requires, so verification is enforced at the API
// boundary rather than only in the page's UI -- without it, anyone could skip
// this step and POST straight to the booking endpoint.
//
// Rate limiting runs BEFORE the roster lookup and is keyed on whatever
// identifier was submitted (see api/_checkin-verify-rate-limit.js) -- a
// stranger hammering one guessed address gets throttled without affecting
// any other visitor's ability to verify.
// ===========================================================================
async function verifyHandler(req, res) {
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

  const identifier = email || phone;

  const limit = await rl.check(identifier);
  if (!limit.allowed) {
    if (limit.locked) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED',
        message: 'Too many attempts. Try again in a few minutes.',
        retryAfterSec: limit.retryAfterSec });
    }
    // limit.unavailable: fail CLOSED, same discipline as the admin gate --
    // letting the lookup through when the counter can't be read hands back
    // unlimited guessing just by making the Blob store flaky.
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not check that right now.' });
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
    // Count the miss against the identifier that was actually submitted, then
    // reply exactly like before: 200, not 401/403, nothing but {ok:false}. The
    // page shows one generic message; the status line and the body must not
    // distinguish "not on the list" from anything else, and the rate-limit
    // check above is likewise indistinguishable from a normal miss until the
    // 6th attempt in a window.
    await rl.recordFailure(identifier);
    return res.status(200).json({ ok: false });
  }

  // A correct guess clears this identifier's own failure history.
  await rl.clear(identifier);

  // Safe to be a SPECIFIC, non-generic message here (unlike the roster-
  // membership failure above): reaching this branch already required a
  // successful roster match, so the visitor has already proven they're a
  // real client -- this reveals nothing to someone who hasn't already
  // guessed correctly.
  if (!cc.isAccessActive(client)) {
    return res.status(403).json({ ok: false, error: 'ACCESS_INACTIVE',
      message: "Your check-in access isn't currently active. Contact Omar directly." });
  }

  // Always scoped to the record's EMAIL, even when the visitor typed a phone:
  // email is guaranteed present, is the record key, and is the only channel the
  // confirmation can reach them on. The email itself is deliberately NOT
  // returned -- the book handler recovers it from the token.
  return res.status(200).json({
    ok: true,
    name: client.name,
    verifyToken: ct.makeVerifyToken(client.email),
  });
}

// ===========================================================================
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
// trip. The token gate lives on the book handler, where it matters.
// ===========================================================================
const MAX_DAYS = 31;

async function availabilityHandler(req, res) {
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
}

// ===========================================================================
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
// ===========================================================================
function badRequest(res, message) {
  return res.status(400).json({ ok: false, error: 'BAD_REQUEST', message });
}

function storageMissing(res) {
  return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
    message: 'Booking storage is not set up yet.' });
}

async function bookHandler(req, res) {
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
  // Defense in depth for the race window between verifying (minting the
  // token) and actually confirming the booking, during which an admin could
  // pause this client. verifyHandler already checked this at mint time, but
  // that check is now stale.
  if (!cc.isAccessActive(client)) {
    return res.status(403).json({ ok: false, error: 'ACCESS_INACTIVE',
      message: "Your check-in access isn't currently active. Contact Omar directly." });
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
}

// ===========================================================================
// POST /api/calendar-checkin-cancel
// { eventId, email, token }
//
// Mirrors calendar-cancel.js, calling the CHECK-IN senders. As with the
// reschedule endpoint, nothing links here yet -- it is built and tested, and a
// client who needs to cancel contacts Omar directly for now.
// ===========================================================================
async function cancelHandler(req, res) {
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
}

// ===========================================================================
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
// ===========================================================================
async function rescheduleHandler(req, res) {
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
    // Fail open, as in the book handler: the move already happened. But this is
    // the only double-booking protection on this path, so log and alert.
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
}

// ===========================================================================
// Dispatch
// ===========================================================================

// Keyed on the ORIGINAL public path segment, which is also what each rewrite's
// `:action` parameter captures. The consolidated landing path
// (/api/calendar-checkin) is deliberately absent, so a direct hit on it
// resolves to nothing rather than to an arbitrary handler.
const ROUTES = {
  'checkin-verify': verifyHandler,
  'calendar-checkin-availability': availabilityHandler,
  'calendar-checkin-book': bookHandler,
  'calendar-checkin-cancel': cancelHandler,
  'calendar-checkin-reschedule': rescheduleHandler,
};

module.exports = async function handler(req, res) {
  const route = resolveAction(req, ROUTES);
  if (!route) return notFound(res);
  return route(req, res);
};

// Named handles so each endpoint stays independently reachable and testable,
// matching this codebase's existing habit of hanging extra properties off the
// exported handler (see calendar-oauth-callback.js's __pageForTests). Vercel
// routes the exported function; extra properties on it are inert.
module.exports.verify = verifyHandler;
module.exports.availability = availabilityHandler;
module.exports.book = bookHandler;
module.exports.cancel = cancelHandler;
module.exports.reschedule = rescheduleHandler;
module.exports.__routesForTests = ROUTES;
