// POST /api/calendar-book
// { name, email, phone, start (ISO), visitorTimeZone, lang }
const tz = require('./_timezone');
const av = require('./_availability');
const gcal = require('./_google-calendar');
const store = require('./_blob-store');
const guard = require('./_booking-guard');
const email = require('./_email');
const bslack = require('./_booking-slack');
const { postSystemAlert } = require('./_slack');
const { makeBookingToken } = require('./_booking-token');
const { loadTemplate } = require('./_load-template');
// The whole module, not the function, so the short-notice decision is read off
// the live export at call time -- same reason calendar-reminders.js itself keeps
// `slack` and `cemail` whole.
const remind = require('./calendar-reminders');

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
    // Real attendee, not just metadata, so the event lands on the client's own
    // calendar (paired with notifyGuests: true below, which is what actually
    // makes Google send them the invite).
    attendees: [{ email: addr, displayName: name }],
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
  }, { notifyGuests: true });
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
      // notifyGuests: true -- the client may already have the Google invite
      // for this event in their inbox/calendar from the insert above; the
      // rollback must clear it off their calendar too, not just ours.
      await gcal.deleteEvent(eventId, { notifyGuests: true });
      return res.status(409).json({ ok: false, error: 'SLOT_TAKEN',
        message: 'Someone booked that time a moment before you.' });
    }
  } else {
    // Deliberately fail OPEN -- the event already exists, and failing the request
    // now would tell the visitor "not booked" about a booking that is on the
    // calendar. But this is the ONLY double-booking protection there is, so a
    // skipped check must never be silent.
    console.error('double-booking guard SKIPPED for event', eventId,
      '-- listEvents failed:', after.reason);
    await postSystemAlert(`*Double-booking guard skipped* for event \`${eventId}\` -- `
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

  // Slack and email must never cost a confirmed booking, so both are best-effort
  // and their failures are logged rather than returned.
  let slackTs = null;
  try {
    const posted = await bslack.postBookingCreated(booking);
    slackTs = (posted && posted.ts) || null;
  } catch (e) { console.error('booking slack failed:', e.message); }

  if (slackTs) {
    // Stored so a later reschedule/cancel can link back to this message
    // (posted to a different channel, so a permalink now, not a real thread).
    await gcal.patchEvent(eventId, {
      extendedProperties: { private: { slackTs } },
    });
  }

  try {
    const sent = await email.sendBookingConfirmation(booking);
    if (!sent.ok) {
      console.error('confirmation email failed:', sent.reason);
      await postSystemAlert(`*Booking confirmation email failed* for \`${eventId}\` (${addr}): ${sent.reason}`);
    }
  } catch (e) {
    console.error('confirmation email threw:', e.message);
    await postSystemAlert(`*Booking confirmation email threw* for \`${eventId}\` (${addr}): ${e.message}`);
  }

  // ---- Short-notice reminder ----------------------------------------------
  // The reminder cron runs once a day, so it can only be RELIED ON to catch a
  // booking whose min(notice, REMINDER_LEAD_HOURS) is at least a full cron
  // period; below that the one eligible tick can fall outside the interval
  // entirely and the visitor gets NO reminder, ever, silently. That is the
  // hole that used to force _availability.js's minNoticeHours to stay at 24.
  //
  // So when the cron cannot be trusted with this booking, we send the reminder
  // NOW and mark the event reminded, which is what the cron looks at -- it will
  // skip this event rather than send a second copy. At normal notice the test
  // is false and nothing here runs at all: the >=24h path is exactly the
  // behaviour that shipped before.
  //
  // Deliberately placed AFTER the double-booking rollback check above: that
  // branch returns 409, so a booking that got rolled back never reaches this
  // and nobody is reminded about a call that no longer exists. Best-effort,
  // like the confirmation email and the Slack post above -- a confirmed
  // booking must never be undone by a reminder that would not send.
  if (remind.needsImmediateReminder(startMs, Date.now())) {
    try {
      const sent = await email.sendReminder(booking);
      if (sent.ok) {
        // notifyGuests deliberately NOT passed (so it defaults to off): this is
        // a metadata-only patch, exactly like the slackTs one above, and Google
        // must not email the attendee about an extendedProperties change.
        await gcal.patchEvent(eventId, {
          extendedProperties: { private: { reminderSent: '1' } },
        });
      } else {
        console.error('short-notice reminder failed:', sent.reason);
        await postSystemAlert(`*Short-notice reminder failed* for \`${eventId}\` (${addr}): ${sent.reason}. `
          + `This booking is too close to rely on the daily cron, so it likely gets no reminder at all.`);
      }
    } catch (e) {
      console.error('short-notice reminder threw:', e.message);
      await postSystemAlert(`*Short-notice reminder threw* for \`${eventId}\` (${addr}): ${e.message}. `
        + `This booking is too close to rely on the daily cron, so it likely gets no reminder at all.`);
    }
  }
  // -------------------------------------------------------------------------

  return res.status(200).json({
    ok: true, eventId, manageToken: token,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    meetLink,
  });
};
