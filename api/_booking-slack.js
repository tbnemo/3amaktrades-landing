// R4: bookings go to #3-warm-leads -- a booked call is warmer than a raw
// application, and that channel already receives warm signals from wa-click.js.
// Reuses postToSlack rather than adding a second notification path.
const { postToSlack, CHANNEL_WARM_LEADS } = require('./_slack');
const { formatWhen } = require('./_email');

function footer() {
  return `Sent by <https://3amaktrades.com|3AMAK Bot> · ${new Date().toUTCString()}`;
}

function whenLine(b) {
  const visitor = formatWhen(b.startMs, b.visitorTimeZone, 'en');
  const omar = formatWhen(b.startMs, b.templateTimeZone, 'en');
  // Both zones, because Omar's own wall-clock time is the one he acts on.
  return `*When:* ${omar} (${b.templateTimeZone})\n*Their time:* ${visitor} (${b.visitorTimeZone})`;
}

async function postBookingCreated(b) {
  return postToSlack(CHANNEL_WARM_LEADS, {
    username: '3AMAK Bot',
    icon_emoji: ':calendar:',
    blocks: [
      { type: 'header',
        text: { type: 'plain_text', text: '📅 Call booked', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text:
          `*Name:* ${b.name}\n*Email:* ${b.email}\n*Phone:* ${b.phone || '—'}\n${whenLine(b)}`
          + (b.meetLink ? `\n*Meet:* ${b.meetLink}` : '') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

// `kind` is 'rescheduled' or 'cancelled'. threadTs comes from the event's stored
// slackTs, so a change lands under the original booking rather than as noise.
async function postBookingChanged(b, kind, threadTs) {
  const icon = kind === 'cancelled' ? '❌' : '🔁';
  const message = {
    username: '3AMAK Bot',
    icon_emoji: ':calendar:',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text:
          `${icon} *Call ${kind}* — ${b.name} (${b.email})\n${whenLine(b)}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  };
  // Threading needs SLACK_BOT_TOKEN; the webhook fallback returns no ts, in
  // which case this posts as a normal top-level message.
  if (threadTs) message.thread_ts = threadTs;
  return postToSlack(CHANNEL_WARM_LEADS, message);
}

module.exports = { postBookingCreated, postBookingChanged };
