// POST /api/calendar-cancel
// { eventId, email, token }
const gcal = require('./_google-calendar');
const email = require('./_email');
const bslack = require('./_booking-slack');
const { isCheckinEvent } = require('./_checkin-audience');
const { postSystemAlert } = require('./_slack');
const { loadTemplate } = require('./_load-template');
const { loadBooking } = require('./_load-booking');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const loaded = await loadBooking(req.body || {});
  if (!loaded.ok) {
    return res.status(loaded.status).json({ ok: false, error: loaded.error,
      message: loaded.message });
  }
  const { event, meta } = loaded;

  // DEFENSE IN DEPTH, mirroring calendar-checkin-cancel.js's own check in
  // reverse, and it MUST come before the delete: a 403 that arrives after the
  // event is already gone is not a rejection. manageToken encodes no
  // audience, so nothing upstream stops a check-in booking's token arriving
  // here. Same message as the check-in side's own check, so the two are
  // indistinguishable from outside.
  if (isCheckinEvent(meta)) {
    return res.status(403).json({ ok: false, error: 'FORBIDDEN',
      message: 'That booking is not managed here.' });
  }

  const startMs = Date.parse(event.start && event.start.dateTime) || Date.now();
  const endMs = Date.parse(event.end && event.end.dateTime) || startMs;

  const deleted = await gcal.deleteEvent(event.id, { notifyGuests: true });
  if (!deleted.ok) {
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not cancel the booking.' });
  }

  const tplRes = await loadTemplate();
  const booking = {
    eventId: event.id, name: meta.visitorName || '—', email: meta.visitorEmail,
    phone: meta.visitorPhone || '', startMs, endMs,
    visitorTimeZone: meta.visitorTimeZone || 'UTC',
    templateTimeZone: tplRes.template.timezone,
    manageToken: '', meetLink: '', lang: meta.lang || 'en',
  };

  // Best-effort: the slot is already freed, which is what the visitor asked for.
  try { await bslack.postBookingChanged(booking, 'cancelled', meta.slackTs || null); }
  catch (e) { console.error('cancel slack failed:', e.message); }
  try { await email.sendCancellationNotice(booking); }
  catch (e) {
    console.error('cancel email failed:', e.message);
    await postSystemAlert(`*Cancellation email failed* for \`${event.id}\` (${meta.visitorEmail}): ${e.message}`);
  }

  return res.status(200).json({ ok: true });
};
