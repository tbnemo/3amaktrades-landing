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
