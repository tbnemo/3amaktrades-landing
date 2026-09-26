// The availability check and the event insert are two separate API calls, so two
// visitors can both pass the check before either inserts. This module is the
// only thing standing between that race and a genuine double-booking.
const EVENT_MARKER = '3amak-booking';

function instant(side) {
  // All-day events expose `date` rather than `dateTime` and never block a slot.
  if (!side || !side.dateTime) return null;
  const ms = Date.parse(side.dateTime);
  return Number.isFinite(ms) ? ms : null;
}

function overlapping(events, startMs, endMs) {
  return (events || []).filter(e => {
    if (!e || e.status === 'cancelled') return false;
    if (e.transparency === 'transparent') return false; // marked "free", not busy
    const s = instant(e.start), en = instant(e.end);
    if (s === null || en === null) return false;
    // Strict inequality: an event ending exactly when the slot starts does not
    // overlap it, so back-to-back bookings stay legal.
    return s < endMs && en > startMs;
  });
}

// R5: the spec says "roll back if more than one now exists", but applied
// literally both sides of a simultaneous race would cancel and nobody would end
// up booked. A deterministic tie-break on event id means exactly one survives.
function shouldRollBack(ourEventId, overlappingEvents) {
  if (!overlappingEvents || overlappingEvents.length <= 1) return false;
  const winner = overlappingEvents
    .map(e => e.id)
    .filter(Boolean)
    .sort()[0];
  return winner !== ourEventId;
}

module.exports = { EVENT_MARKER, overlapping, shouldRollBack };
