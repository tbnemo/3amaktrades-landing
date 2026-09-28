// Shared front half of reschedule and cancel: prove the caller owns this
// booking, then hand back the event.
const gcal = require('./_google-calendar');
const guard = require('./_booking-guard');
const { verifyBookingToken, normalizeEmail } = require('./_booking-token');

async function loadBooking({ eventId, email, token }) {
  if (!eventId || !email || !token) {
    return { ok: false, status: 400, error: 'BAD_REQUEST',
      message: 'eventId, email and token are required' };
  }
  if (!verifyBookingToken(eventId, email, token)) {
    return { ok: false, status: 403, error: 'FORBIDDEN',
      message: 'That link is not valid for this booking.' };
  }

  const got = await gcal.getEvent(eventId);
  if (!got.ok) {
    if (got.reason === gcal.NOT_CONNECTED) {
      return { ok: false, status: 503, error: 'CALENDAR_NOT_CONNECTED',
        message: 'The calendar is unavailable.' };
    }
    return { ok: false, status: 404, error: 'NOT_FOUND',
      message: 'That booking no longer exists.' };
  }
  const event = got.event;
  const meta = (event.extendedProperties && event.extendedProperties.private) || {};

  if (meta.bookingSource !== guard.EVENT_MARKER) {
    // Never let a booking token touch an event this system did not create.
    return { ok: false, status: 403, error: 'FORBIDDEN',
      message: 'That booking is not managed here.' };
  }
  if (normalizeEmail(meta.visitorEmail) !== normalizeEmail(email)) {
    return { ok: false, status: 403, error: 'FORBIDDEN',
      message: 'That link is not valid for this booking.' };
  }
  return { ok: true, event, meta };
}

module.exports = { loadBooking };
