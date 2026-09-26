// Transactional email via Resend's REST API (no SDK -- one endpoint).
//
// ############################################################################
// # ALL COPY IN THIS FILE IS PLACEHOLDER. Do not treat it as finished text.   #
// # Final wording and layout are a separate, collaborative design pass with   #
// # the user. Only the SENDING MECHANISM and TRIGGER POINTS are complete.     #
// ############################################################################
const nodeFetch = require('node-fetch');
const { escapeHtml } = require('./_html');

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  // Resend's shared sender works before 3amaktrades.com is verified for sending.
  return process.env.RESEND_FROM || '3AMAK Trades <onboarding@resend.dev>';
}

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://3amaktrades.com';
}

// Renders the booking time in the visitor's own zone -- the one thing in these
// emails that is genuinely load-bearing rather than placeholder.
function formatWhen(startMs, timeZone, lang) {
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en-GB', {
      timeZone, dateStyle: 'full', timeStyle: 'short',
    }).format(startMs);
  } catch (e) {
    return new Date(startMs).toISOString();
  }
}

function manageLinks(b) {
  const q = `eventId=${encodeURIComponent(b.eventId)}`
    + `&email=${encodeURIComponent(b.email)}`
    + `&token=${encodeURIComponent(b.manageToken || '')}`;
  return {
    reschedule: `${baseUrl()}/?booking=reschedule&${q}`,
    cancel: `${baseUrl()}/?booking=cancel&${q}`,
  };
}

async function send({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, reason: 'RESEND_API_KEY not set' };
  }
  if (!to) return { ok: false, reason: 'no recipient' };
  try {
    const res = await nodeFetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => `HTTP ${res.status}`);
      return { ok: false, reason: detail.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

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

async function sendBookingConfirmation(b) {
  const links = manageLinks(b);
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call is booked';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your call is confirmed for
       <strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
       (${escapeHtml(b.visitorTimeZone)}).</p>
    ${b.meetLink ? `<p>[PLACEHOLDER] Join link: <a href="${escapeHtml(b.meetLink)}">${escapeHtml(b.meetLink)}</a></p>` : ''}
    <p>[PLACEHOLDER] <a href="${escapeHtml(links.reschedule)}">Reschedule</a>
       &middot; <a href="${escapeHtml(links.cancel)}">Cancel</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendRescheduleNotice(b) {
  const links = manageLinks(b);
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call was moved';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your call is now
       <strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
       (${escapeHtml(b.visitorTimeZone)}).</p>
    ${b.meetLink ? `<p>[PLACEHOLDER] Join link: <a href="${escapeHtml(b.meetLink)}">${escapeHtml(b.meetLink)}</a></p>` : ''}
    <p>[PLACEHOLDER] <a href="${escapeHtml(links.reschedule)}">Reschedule again</a>
       &middot; <a href="${escapeHtml(links.cancel)}">Cancel</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendCancellationNotice(b) {
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call was cancelled';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Your call on
       ${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} is cancelled.</p>
    <p>[PLACEHOLDER] <a href="${escapeHtml(baseUrl())}/#apply">Book another time</a></p>`);
  return send({ to: b.email, subject, html });
}

async function sendReminder(b) {
  const links = manageLinks(b);
  // PLACEHOLDER COPY — collaborative design pass pending
  const subject = '[PLACEHOLDER] Your call is coming up';
  // PLACEHOLDER COPY — collaborative design pass pending
  const html = shell(`
    <p>Hi ${escapeHtml(b.name)},</p>
    <p>[PLACEHOLDER] Reminder: your call is
       <strong>${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))}</strong>
       (${escapeHtml(b.visitorTimeZone)}).</p>
    ${b.meetLink ? `<p>[PLACEHOLDER] Join link: <a href="${escapeHtml(b.meetLink)}">${escapeHtml(b.meetLink)}</a></p>` : ''}
    <p>[PLACEHOLDER] <a href="${escapeHtml(links.cancel)}">Cancel</a></p>`);
  return send({ to: b.email, subject, html });
}

module.exports = {
  sendBookingConfirmation, sendRescheduleNotice, sendCancellationNotice,
  sendReminder, formatWhen, manageLinks, escapeHtml,
};
