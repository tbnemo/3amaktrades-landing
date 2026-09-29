// Bookings get their own dedicated channels (#4/#5/#6), separate from
// #3-warm-leads -- a booked call is a structurally different, later-funnel
// event than a WhatsApp-click ping, and mixing them buried booking activity
// in general warm-lead noise. Reuses postToSlack rather than adding a
// second notification path.
const { postToSlack, getPermalink,
  CHANNEL_NEW_CALLS_BOOKED, CHANNEL_RESCHEDULED_CALLS, CHANNEL_CANCELLED_CALLS } = require('./_slack');
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
  return postToSlack(CHANNEL_NEW_CALLS_BOOKED, {
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

// `kind` is 'rescheduled' or 'cancelled'. Each now posts to its own channel
// (#5/#6), separate from where the original booking lives (#4) -- Slack
// can't thread across channels, so `originalTs` (the event's stored
// slackTs) is used to fetch a permalink back to the original message
// instead, kept as a link rather than lost context.
async function postBookingChanged(b, kind, originalTs) {
  const icon = kind === 'cancelled' ? '❌' : '🔁';
  const channel = kind === 'cancelled' ? CHANNEL_CANCELLED_CALLS : CHANNEL_RESCHEDULED_CALLS;
  const permalink = originalTs ? await getPermalink(CHANNEL_NEW_CALLS_BOOKED, originalTs) : null;
  const text = `${icon} *Call ${kind}* — ${b.name} (${b.email})\n${whenLine(b)}`
    + (permalink ? `\n<${permalink}|Original booking>` : '');
  return postToSlack(channel, {
    username: '3AMAK Bot',
    icon_emoji: ':calendar:',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

module.exports = { postBookingCreated, postBookingChanged };
