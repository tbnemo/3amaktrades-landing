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
const { safeEqual } = require('./_admin-auth');

const LEAD_HOURS = Number(process.env.REMINDER_LEAD_HOURS) || 24;

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  // Fail closed: without a secret this endpoint would let anyone trigger a mail
  // run against every upcoming booking.
  if (!secret) return false;
  const header = (req.headers && req.headers.authorization) || '';
  // Constant-time, matching how this codebase compares every other secret against
  // attacker-supplied input. safeEqual length-checks before timingSafeEqual, which
  // throws on a length mismatch.
  return safeEqual(header, `Bearer ${secret}`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!authorized(req)) {
    return res.status(401).json({ ok: false,
      error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET not set' });
  }

  const now = Date.now();
  const windowEnd = now + LEAD_HOURS * 60 * 60 * 1000;

  // Only events this system created can be reminded -- Omar's own meetings are
  // none of our business.
  const listed = await gcal.listEvents({
    timeMinIso: new Date(now).toISOString(),
    timeMaxIso: new Date(windowEnd).toISOString(),
    privateExtendedProperty: `bookingSource=${guard.EVENT_MARKER}`,
  });
  if (!listed.ok) {
    const notConnected = listed.reason === gcal.NOT_CONNECTED;
    return res.status(notConnected ? 503 : 502).json({
      ok: false, error: notConnected ? 'CALENDAR_NOT_CONNECTED' : 'UPSTREAM',
      message: listed.reason,
    });
  }

  const tplRes = await loadTemplate();
  let sent = 0, skipped = 0;

  for (const event of listed.events) {
    const meta = (event.extendedProperties && event.extendedProperties.private) || {};
    if (meta.reminderSent === '1') { skipped++; continue; }
    if (!meta.visitorEmail) { skipped++; continue; }

    const startMs = Date.parse(event.start && event.start.dateTime);
    if (!Number.isFinite(startMs) || startMs < now) { skipped++; continue; }

    try {
      const result = await email.sendReminder({
        eventId: event.id,
        name: meta.visitorName || '—',
        email: meta.visitorEmail,
        phone: meta.visitorPhone || '',
        startMs,
        endMs: Date.parse(event.end && event.end.dateTime) || startMs,
        visitorTimeZone: meta.visitorTimeZone || 'UTC',
        templateTimeZone: tplRes.template.timezone,
        manageToken: makeBookingToken(event.id, meta.visitorEmail),
        meetLink: event.hangoutLink || '',
        lang: meta.lang || 'en',
      });

      if (result.ok) {
        await gcal.patchEvent(event.id, {
          extendedProperties: { private: { reminderSent: '1' } },
        });
        sent++;
      } else {
        // Leave the flag unset so the next run retries.
        console.error('reminder failed for', event.id, result.reason);
        skipped++;
      }
    } catch (e) {
      // Per-item isolation: one bad event must not sink the whole batch, and it
      // must NOT be marked reminded -- the next run should retry it.
      console.error('reminder threw for', event.id, e.message);
      skipped++;
    }
  }

  return res.status(200).json({ ok: true, considered: listed.events.length, sent, skipped });
};
