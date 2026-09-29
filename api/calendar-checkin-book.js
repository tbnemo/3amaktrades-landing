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
