// POST /api/calendar-cancel
// { eventId, email, token }
const gcal = require('./_google-calendar');
const email = require('./_email');
const bslack = require('./_booking-slack');
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

  const startMs = Date.parse(event.start && event.start.dateTime) || Date.now();
  const endMs = Date.parse(event.end && event.end.dateTime) || startMs;

  const deleted = await gcal.deleteEvent(event.id);
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
  catch (e) { console.error('cancel email failed:', e.message); }

  return res.status(200).json({ ok: true });
};
