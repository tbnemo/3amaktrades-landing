// Transactional email via Resend's REST API (no SDK -- one endpoint).
//
// Visual direction and copy were decided in a collaborative design pass with
// the user (the "Minimal Ticket" style): dark shell, centered wordmark, a
// bordered details box, one gold CTA, a WhatsApp footer line in place of a
// reply-to address (nothing reads replies to the sending inbox). These
// templates are bilingual -- lang:'en' and lang:'ar' are both real, finished
// copy, matching the voice already used on the apply form (including staying
// in Latin script for "3AMAK Trades" and "Google Meet" inside Arabic text,
// the same way the site's own Arabic footer does).
const nodeFetch = require('node-fetch');
const { escapeHtml, safeUrl } = require('./_html');
const { baseUrl } = require('./_site-url');

const RESEND_URL = 'https://api.resend.com/emails';
const WHATSAPP_URL = 'https://wa.me/14382259193';

function fromAddress() {
  // Resend's shared sender works before 3amaktrades.com is verified for sending.
  return process.env.RESEND_FROM || '3AMAK Trades <onboarding@resend.dev>';
}

// Renders the booking time in the visitor's own zone -- the one thing in these
// emails that is genuinely load-bearing rather than copy.
//
// Never throws: these senders must always resolve to {ok,...}, because an email
// formatting quirk must not cost a booking that is already on the calendar.
// Note the catch below cannot be the only guard -- new Date(NaN).toISOString()
// itself throws, so a non-finite instant has to be rejected up front.
function formatWhen(startMs, timeZone, lang) {
  if (!Number.isFinite(startMs)) return '';
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en-GB', {
      timeZone, dateStyle: 'full', timeStyle: 'short',
    }).format(startMs);
  } catch (e) {
    // Reached when timeZone is invalid. startMs is known finite here, but keep
    // this defensive rather than assuming.
    const d = new Date(startMs);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
  }
}

// NOTE: these emails deliberately advertise no reschedule/cancel links. The
// endpoints exist and are tested, but nothing reads a `booking` query param yet,
// so a link would have dropped the visitor on the homepage with no explanation.
// `manageToken` is still minted and still valid, so the flow can be wired up
// later without reworking anything here. The WhatsApp footer line is the
// stand-in contact path -- it matches how the rest of the site already routes
// "talk to a human" rather than an unmonitored reply-to inbox.

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

// ---- shared visual building blocks (Minimal Ticket) ------------------------

function displayFont(lang) {
  return lang === 'ar' ? "'Cairo',sans-serif" : "'Big Shoulders Display',sans-serif";
}

function wordmark(lang) {
  const label = lang === 'ar' ? '<bdi dir="ltr">3AMAK TRADES</bdi>' : '3AMAK TRADES';
  return `<div style="font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:12px;letter-spacing:3px;color:#D4AF37;">${label}</div>
    <div style="width:36px;height:2px;background:#7A6218;margin:12px auto;"></div>`;
}

function headline(html, lang) {
  return `<div style="font-family:${displayFont(lang)};font-weight:800;font-size:22px;color:#F2EEE4;line-height:1.3;margin-bottom:14px;">${html}</div>`;
}

// rows: [{label, value}], value pre-escaped/trusted by the caller.
function detailsBox(rows, lang) {
  if (!rows.length) return '';
  const align = lang === 'ar' ? 'right' : 'left';
  const items = rows.map((r, i) => `
    <div style="color:#8B887F;font-size:10px;letter-spacing:1px;margin-bottom:3px;">${r.label}</div>
    <div style="color:${r.color || '#F2EEE4'};font-size:15px;font-weight:600;${i < rows.length - 1 ? 'margin-bottom:10px;' : ''}">${r.value}</div>`).join('');
  return `<div style="border:1px solid #7A6218;padding:14px;text-align:${align};margin-bottom:16px;">${items}</div>`;
}

// Omitted entirely (returns '') when href is missing or unsafe -- callers rely
// on this to drop a join CTA when there is no meetLink, without a separate check.
function ctaButton(href, label) {
  const url = safeUrl(href);
  if (!url) return '';
  return `<a href="${url}" style="display:block;background:#D4AF37;color:#0A0802;font-weight:700;font-size:13px;letter-spacing:1px;padding:11px;margin-bottom:14px;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function footerLine(preamble, waLabel) {
  return `<p style="color:#8B887F;font-size:12px;margin:0;">${preamble} <a href="${WHATSAPP_URL}" style="color:#D4AF37;text-decoration:none;">${waLabel}</a>.</p>`;
}

function shell(bodyHtml, lang) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const font = lang === 'ar' ? "'Cairo',system-ui,sans-serif" : "'Inter',system-ui,sans-serif";
  return `<div dir="${dir}" lang="${lang === 'ar' ? 'ar' : 'en'}" style="font-family:${font};background:#050505;padding:32px 24px;text-align:center;max-width:480px;margin:0 auto;">
    ${wordmark(lang)}
    ${bodyHtml}
  </div>`;
}

function joinRow(meetLink, lang) {
  if (!safeUrl(meetLink)) return [];
  const label = lang === 'ar' ? 'رابط الانضمام' : 'JOIN LINK';
  const value = lang === 'ar' ? '<bdi dir="ltr">Google Meet</bdi>' : 'Google Meet';
  return [{ label, value, color: '#D4AF37' }];
}

// ---- senders -----------------------------------------------------------

async function sendBookingConfirmation(b) {
  const ar = b.lang === 'ar';
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = ar ? 'تم حجز مكالمتك 🎉' : 'Your call is booked';
  const html = shell(ar ? `
    ${headline('تم حجز مكالمتك 🎉', 'ar')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">أهلاً ${name}، موعدك مع <bdi dir="ltr">3AMAK Trades</bdi> مثبت.</p>
    ${detailsBox([{ label: 'الموعد', value: when }, ...joinRow(b.meetLink, 'ar')], 'ar')}
    ${ctaButton(b.meetLink, 'انضم للمكالمة')}
    ${footerLine('بدك تغيّر شي؟', 'راسلنا عالواتساب')}
  ` : `
    ${headline('YOUR CALL<br>IS BOOKED', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, you're confirmed. We'll see you then.</p>
    ${detailsBox([{ label: 'WHEN', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine('Need to change anything?', 'Message us on WhatsApp')}
  `, b.lang);
  return send({ to: b.email, subject, html });
}

async function sendRescheduleNotice(b) {
  const ar = b.lang === 'ar';
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = ar ? 'تم تغيير موعد مكالمتك' : 'Your call was moved';
  const html = shell(ar ? `
    ${headline('تم تغيير موعد مكالمتك', 'ar')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">أهلاً ${name}، هاد الموعد الجديد لمكالمتك.</p>
    ${detailsBox([{ label: 'الموعد الجديد', value: when }, ...joinRow(b.meetLink, 'ar')], 'ar')}
    ${ctaButton(b.meetLink, 'انضم للمكالمة')}
    ${footerLine('مو متوقع هالشي؟', 'راسلنا عالواتساب')}
  ` : `
    ${headline('YOUR CALL<br>WAS MOVED', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, here's your new time.</p>
    ${detailsBox([{ label: 'NEW TIME', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine('Not expecting this?', 'Message us on WhatsApp')}
  `, b.lang);
  return send({ to: b.email, subject, html });
}

async function sendCancellationNotice(b) {
  const ar = b.lang === 'ar';
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const applyUrl = `${baseUrl()}/#apply`;
  const subject = ar ? 'مكالمتك انلغت' : 'Your call was cancelled';
  const html = shell(ar ? `
    ${headline('مكالمتك انلغت', 'ar')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">أهلاً ${name}، مكالمتك يوم <span style="text-decoration:line-through;color:#8B887F;">${when}</span> انلغت.</p>
    ${ctaButton(applyUrl, 'احجز موعد جديد')}
    ${footerLine('عندك سؤال؟', 'راسلنا عالواتساب')}
  ` : `
    ${headline('YOUR CALL IS<br>CANCELLED', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, your call on <span style="text-decoration:line-through;color:#8B887F;">${when}</span> has been cancelled.</p>
    ${ctaButton(applyUrl, 'BOOK ANOTHER TIME')}
    ${footerLine('Questions?', 'Message us on WhatsApp')}
  `, b.lang);
  return send({ to: b.email, subject, html });
}

async function sendReminder(b) {
  const ar = b.lang === 'ar';
  const when = `${escapeHtml(formatWhen(b.startMs, b.visitorTimeZone, b.lang))} (${escapeHtml(b.visitorTimeZone)})`;
  const name = escapeHtml(b.name);
  const subject = ar ? 'مكالمتك قريبة ⏰' : 'Your call is coming up';
  const html = shell(ar ? `
    ${headline('مكالمتك قريبة ⏰', 'ar')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">أهلاً ${name}، تذكير بسيط — مكالمتك معنا قريبة.</p>
    ${detailsBox([{ label: 'الموعد', value: when }, ...joinRow(b.meetLink, 'ar')], 'ar')}
    ${ctaButton(b.meetLink, 'انضم للمكالمة')}
    ${footerLine('ما رح تلحق؟', 'راسلنا عالواتساب')}
  ` : `
    ${headline('YOUR CALL IS<br>COMING UP', 'en')}
    <p style="color:#F2EEE4;font-size:14px;margin:0 0 16px;">Hi ${name}, quick reminder — you're on with us soon.</p>
    ${detailsBox([{ label: 'WHEN', value: when }, ...joinRow(b.meetLink, 'en')], 'en')}
    ${ctaButton(b.meetLink, 'JOIN THE CALL')}
    ${footerLine("Can't make it?", 'Message us on WhatsApp')}
  `, b.lang);
  return send({ to: b.email, subject, html });
}

module.exports = {
  sendBookingConfirmation, sendRescheduleNotice, sendCancellationNotice,
  sendReminder, formatWhen, escapeHtml,
  // Exported for api/_checkin-email.js, which is English-only (check-in.html
  // is explicitly "English-only and dir=ltr", unlike the bilingual apply
  // flow) but reuses the same visual shell rather than a second copy of it.
  send, shell, headline, detailsBox, ctaButton, footerLine, joinRow,
};
