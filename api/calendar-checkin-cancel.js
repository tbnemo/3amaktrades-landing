// POST /api/calendar-checkin-cancel
// { eventId, email, token }
//
// Mirrors calendar-cancel.js, calling the CHECK-IN senders. As with the
// reschedule endpoint, nothing links here yet -- it is built and tested, and a
// client who needs to cancel contacts Omar directly for now.
const gcal = require('./_google-calendar');
const cslack = require('./_checkin-slack');
const cemail = require('./_checkin-email');
const { isCheckinEvent } = require('./_checkin-audience');
const { postSystemAlert } = require('./_slack');
const { loadCheckinTemplate } = require('./_load-checkin-template');
const { loadBooking } = require('./_load-booking');

module.exports = async function handler(req, res) {
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
};
