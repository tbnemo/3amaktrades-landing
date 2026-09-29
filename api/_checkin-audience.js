// The one field that distinguishes the two booking audiences sharing a single
// Google Calendar. Deliberately NOT part of _booking-guard.js: the guard is
// audience-blind on purpose (both audiences write the same EVENT_MARKER so a
// race between them still resolves), and giving it an audience opinion is
// exactly how the shared-marker property would get broken later.
//
// The applicant flow does not write this field at all -- its ABSENCE means
// "applicant" -- so calendar-book.js needs no change.
const AUDIENCE_CHECKIN = 'checkin';

// `meta` is always an event's `extendedProperties.private` object (or the empty
// object callers substitute when it is missing), never the event itself.
function isCheckinEvent(meta) {
  return !!meta && meta.audience === AUDIENCE_CHECKIN;
}

module.exports = { AUDIENCE_CHECKIN, isCheckinEvent };
