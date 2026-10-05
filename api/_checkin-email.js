// Transactional email for the CHECK-IN audience.
//
// Reuses the Resend POST (`send`), the timezone formatter (`formatWhen`), and
// the whole Minimal Ticket visual shell from api/_email.js: these are
// transport/visual plumbing, not audience-specific copy, so sharing them does
// not compromise the "fully separate lifecycle" decision -- an env-var, retry,
// or visual fix never has to be made twice.
//
// English-only, deliberately: check-in.html is itself "English-only and
// dir=ltr" (the check-in audience is a known, small client list), so there is
// no Arabic branch here the way there is in _email.js's bilingual apply flow.
//
// NOTE: these emails deliberately advertise no reschedule/cancel links, exactly
// as the applicant ones do. The endpoints exist and are tested, but nothing
// reads a `booking` query param yet, so a link would drop the client on a page
// that cannot act on it. `manageToken` is still minted and still valid, so the
// flow can be wired up later without reworking anything here. The WhatsApp
// footer line is the stand-in contact path.
const {
  send, formatWhen, escapeHtml, shell, headline, detailsBox, ctaButton,
  footerLine, joinRow,
} = require('./_email');
const { baseUrl } = require('./_site-url');

async function sendCheckinConfirmation(b) {
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, 'en'))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = 'Your check-in call is booked';
  const html = shell(`
    ${headline('YOUR CHECK-IN<br>IS BOOKED', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, you're confirmed. We'll see you then.</p>
    ${detailsBox([{ label: 'WHEN', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine('Need to change anything?', 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: b.email, subject, html });
}

async function sendCheckinRescheduleNotice(b) {
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, 'en'))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = 'Your check-in call was moved';
  const html = shell(`
    ${headline('YOUR CHECK-IN<br>WAS MOVED', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, here's your new time.</p>
    ${detailsBox([{ label: 'NEW TIME', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine('Not expecting this?', 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: b.email, subject, html });
}

async function sendCheckinCancellationNotice(b) {
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, 'en'))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const checkinUrl = `${baseUrl()}/check-in`;
  const subject = 'Your check-in call was cancelled';
  const html = shell(`
    ${headline('YOUR CHECK-IN IS<br>CANCELLED', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, your check-in on <span style="text-decoration:line-through;color:#8B887F;">${when}</span> has been cancelled.</p>
    ${ctaButton(checkinUrl, 'BOOK ANOTHER CHECK-IN')}
    ${footerLine('Questions?', 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: b.email, subject, html });
}

async function sendCheckinReminder(b) {
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, 'en'))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = 'Your check-in call is coming up';
  const html = shell(`
    ${headline('YOUR CHECK-IN IS<br>COMING UP', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, quick reminder — your check-in is coming up.</p>
    ${detailsBox([{ label: 'WHEN', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine("Can't make it?", 'Message us on WhatsApp')}
  `, 'en');
  return send({ to: b.email, subject, html });
}

module.exports = {
  sendCheckinConfirmation, sendCheckinRescheduleNotice,
  sendCheckinCancellationNotice, sendCheckinReminder,
};
