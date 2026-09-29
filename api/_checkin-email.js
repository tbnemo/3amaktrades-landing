// Transactional email for the CHECK-IN audience.
//
// ############################################################################
// # ALL COPY IN THIS FILE IS PLACEHOLDER. Do not treat it as finished text.   #
// # Final wording and layout are a separate, collaborative design pass with   #
// # the user. Only the SENDING MECHANISM and TRIGGER POINTS are complete.     #
// ############################################################################
//
// The Resend POST (`send`) and the timezone formatter (`formatWhen`) are reused
// from api/_email.js rather than reimplemented: those are transport-layer
// plumbing, not audience-facing copy, so sharing them does not compromise the
// "fully separate lifecycle" decision -- and it means an env-var or retry fix
// never has to be made twice.
//
// NOTE: these emails deliberately advertise no reschedule/cancel links, exactly
// as the applicant ones do. The endpoints exist and are tested, but nothing
// reads a `booking` query param yet, so a link would drop the client on a page
// that cannot act on it. `manageToken` is still minted and still valid, so the
// flow can be wired up later without reworking anything here.
const { send, formatWhen } = require('./_email');
const { escapeHtml, safeUrl } = require('./_html');
const { baseUrl } = require('./_site-url');

// A shared placeholder shell so the real design pass has one obvious place to
// land, instead of four diverging ad-hoc layouts.
function shell(bodyHtml) {
  // PLACEHOLDER COPY — collaborative design pass pending
  return `<div style="font-family:system-ui,sans-serif;background:#050505;color:#F2EEE4;padding:24px">
    <p style="color:#D4AF37;font-weight:700">3AMAK TRADES</p>
    ${bodyHtml}
    <p style="color:#8B887F;font-size:12px">PLACEHOLDER EMAIL — final copy pending.</p>
  </div>`;
}

// The booking time in the CLIENT's own zone -- the one genuinely load-bearing
// value in these otherwise-placeholder bodies.
function whenHtml(b) {
  return `<strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
     (${escapeHtml(b.visitorTimeZone)})`;
}

// safeUrl, not escapeHtml: escaping alone would not stop a `javascript:` URL,
// and these links are rendered inside mail clients.
function joinHtml(b) {
  const href = safeUrl(b.meetLink);
  if (!href) return '';
  // PLACEHOLDER COPY — collaborative design pass pending
  return `<p>[PLACEHOLDER] Join link: <a href="${href}">${escapeHtml(b.meetLink)}</a></p>`;
}

async function sendCheckinConfirmation(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call is booked';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your check-in call is confirmed for ${whenHtml(b)}.</p>
    ${joinHtml(b)}`);
  return send({ to: b.email, subject, html });
}

async function sendCheckinRescheduleNotice(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call was moved';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your check-in call is now ${whenHtml(b)}.</p>
    ${joinHtml(b)}`);
  return send({ to: b.email, subject, html });
}

async function sendCheckinCancellationNotice(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call was cancelled';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your check-in call on
       ${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} is cancelled.</p>
    <p>[PLACEHOLDER] <a href="${escapeHtml(baseUrl())}/check-in">Book another check-in</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendCheckinReminder(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your check-in call is coming up';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Reminder: your check-in call is ${whenHtml(b)}.</p>
    ${joinHtml(b)}`);
  return send({ to: b.email, subject, html });
}

module.exports = {
  sendCheckinConfirmation, sendCheckinRescheduleNotice,
  sendCheckinCancellationNotice, sendCheckinReminder,
};
