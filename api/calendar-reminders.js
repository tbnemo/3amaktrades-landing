// GET /api/calendar-reminders -- invoked by Vercel Cron.
//
// R8: with no bookings table, "already reminded" is a flag on the event itself
// (extendedProperties.private.reminderSent). Setting it before sending would risk
// dropping a reminder; setting it after risks sending twice. We set it AFTER a
// successful send, because a duplicate reminder is a far smaller failure than a
// call the visitor forgets.
const gcal = require('./_google-calendar');
const guard = require('./_booking-guard');
const email = require('./_email');
const { loadTemplate } = require('./_load-template');
const { makeBookingToken } = require('./_booking-token');
const { safeEqual, verifySession } = require('./_admin-auth');
// Whole module objects, not destructured -- so a test's monkey-patch of a
// property (`slack.postSystemAlert = spy`) is visible here at call time
// instead of being frozen to whatever the property held at require() time.
const slack = require('./_slack');
const cemail = require('./_checkin-email');
const { isCheckinEvent } = require('./_checkin-audience');
const checkinTemplateMod = require('./_load-checkin-template');

// Read per call rather than captured once at module load. This single number, the
// cron period, and the template's minNoticeHours are the three things the whole
// delivery guarantee rests on (see test/reminder-delivery-guarantee.test.js), and
// a module-load constant is unreachable from a test that wants to vary it -- which
// is exactly why the window behaviour went untested through two review rounds.
// Env vars are fixed for the life of a deployment, so reading per call costs
// nothing.
function leadHours() {
  const n = Number(process.env.REMINDER_LEAD_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

// The window handed to listEvents: bookings starting between now and now+lead.
function reminderWindow(nowMs) {
  return { timeMinMs: nowMs, timeMaxMs: nowMs + leadHours() * 60 * 60 * 1000 };
}

// Whether a cron run happening at nowMs would send this booking's reminder.
// listEvents returns everything INTERSECTING the window, so a call already under
// way comes back too -- the lower bound is what drops it, because reminding
// someone about a call that has started is worse than useless. The upper bound
// re-states Google's own filter locally, so the rule lives in one place and the
// delivery simulation can exercise the real thing instead of a copy of it.
function wouldRemind(startMs, nowMs) {
  if (!Number.isFinite(startMs)) return false;
  const { timeMinMs, timeMaxMs } = reminderWindow(nowMs);
  return startMs >= timeMinMs && startMs <= timeMaxMs;
}

// Two independent ways in, both sufficient on their own: Vercel's own cron
// carries the CRON_SECRET bearer token on a GET (unchanged, below); an
// admin's browser carries their own signed session cookie instead, via the
// "Send Due Reminders Now" catch-up button on admin.html -- recovering from
// a day the once-daily cron missed entirely, without exposing CRON_SECRET to
// the client.
//
// The session path is POST-ONLY. The session cookie is SameSite=Lax, which
// IS attached on a top-level cross-site GET (a plain link, a redirect,
// window.open) -- a bearer-only endpoint never had that exposure, since
// browsers never attach an Authorization header automatically. Restricting
// the cookie path to POST forces a CORS preflight on the admin's own
// `Content-Type: application/json` fetch, which a hostile page's simple
// top-level navigation cannot replicate without our server opting in via
// CORS headers (it does not) -- closing the CSRF hole while costing real
// cron nothing, since cron never sends a session cookie either way.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const header = (req.headers && req.headers.authorization) || '';
  // Constant-time, matching how this codebase compares every other secret against
  // attacker-supplied input. safeEqual length-checks before timingSafeEqual, which
  // throws on a length mismatch.
  if (secret && safeEqual(header, `Bearer ${secret}`)) return true;
  return req.method === 'POST' && verifySession(req);
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  if (!authorized(req)) {
    return res.status(401).json({ ok: false,
      error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET not set' });
  }

  const now = Date.now();
  const listWindow = reminderWindow(now);

  // Only events this system created can be reminded -- Omar's own meetings are
  // none of our business.
  const listed = await gcal.listEvents({
    timeMinIso: new Date(listWindow.timeMinMs).toISOString(),
    timeMaxIso: new Date(listWindow.timeMaxMs).toISOString(),
    privateExtendedProperty: `bookingSource=${guard.EVENT_MARKER}`,
  });
  if (!listed.ok) {
    const notConnected = listed.reason === gcal.NOT_CONNECTED;
    return res.status(notConnected ? 503 : 502).json({
      ok: false, error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: listed.reason,
    });
  }

  // BOTH templates, once per run. The two audiences may sit in different
  // timezones, and the reminder has to describe the call in the right one.
  // Making the second read conditional on the batch containing a check-in would
  // add a branch to the one function whose failure mode is a silently missed
  // reminder -- one extra blob read a day is the cheaper trade.
  //
  // Neither loader can fail destructively: both return a usable normalized
  // template alongside a !ok, so a blob hiccup degrades the displayed timezone
  // rather than dropping the reminder.
  const tplRes = await loadTemplate();
  const checkinTplRes = await checkinTemplateMod.loadCheckinTemplate();
  let sent = 0, skipped = 0;

  for (const event of listed.events) {
    const meta = (event.extendedProperties && event.extendedProperties.private) || {};
    if (meta.reminderSent === '1') { skipped++; continue; }
    if (!meta.visitorEmail) { skipped++; continue; }

    const startMs = Date.parse(event.start && event.start.dateTime);
    if (!wouldRemind(startMs, now)) { skipped++; continue; }

    // The ONE audience decision in this loop. `audience` is absent on every
    // applicant booking (calendar-book.js never writes it), so the default is
    // the applicant sender and no existing behaviour changes.
    const isCheckin = isCheckinEvent(meta);
    const sendReminderFor = isCheckin ? cemail.sendCheckinReminder : email.sendReminder;
    const templateTimeZone = isCheckin
      ? checkinTplRes.template.timezone
      : tplRes.template.timezone;

    try {
      const result = await sendReminderFor({
        eventId: event.id,
        name: meta.visitorName || '—',
        email: meta.visitorEmail,
        phone: meta.visitorPhone || '',
        startMs,
        endMs: Date.parse(event.end && event.end.dateTime) || startMs,
        visitorTimeZone: meta.visitorTimeZone || 'UTC',
        templateTimeZone,
        manageToken: makeBookingToken(event.id, meta.visitorEmail),
        meetLink: gcal.meetLinkFor(event),
        lang: meta.lang || 'en',
      });

      if (result.ok) {
        await gcal.patchEvent(event.id, {
          extendedProperties: { private: { reminderSent: '1' } },
        });
        sent++;
      } else {
        // Leave the flag unset so the next run retries -- though with the
        // current cron/window settings there's exactly one eligible tick per
        // booking, so in practice this recipient gets no reminder at all.
        // That's exactly why this alert matters: it's the only signal anyone
        // gets that it happened.
        console.error('reminder failed for', event.id, result.reason);
        await slack.postSystemAlert(`*Reminder send failed* for \`${event.id}\` (${meta.visitorEmail || 'unknown'})`
          + `${isCheckin ? ' [check-in]' : ''}: ${result.reason}. `
          + `With the current settings this booking likely gets no reminder at all.`);
        skipped++;
      }
    } catch (e) {
      // Per-item isolation: one bad event must not sink the whole batch, and it
      // must NOT be marked reminded -- the next run should retry it.
      console.error('reminder threw for', event.id, e.message);
      await slack.postSystemAlert(`*Reminder send threw* for \`${event.id}\` (${meta.visitorEmail || 'unknown'})`
        + `${isCheckin ? ' [check-in]' : ''}: ${e.message}. `
        + `With the current settings this booking likely gets no reminder at all.`);
      skipped++;
    }
  }

  return res.status(200).json({ ok: true, considered: listed.events.length, sent, skipped });
}

module.exports = handler;
// Exported so the delivery guarantee can be proved against the REAL window
// arithmetic rather than a re-implementation of it in a test.
module.exports.leadHours = leadHours;
module.exports.reminderWindow = reminderWindow;
module.exports.wouldRemind = wouldRemind;
