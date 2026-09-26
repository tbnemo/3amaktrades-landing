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
