// Check-in bookings get their own three channels (#8/#9/#10), structurally
// mirroring the applicant set (#4/#5/#6). A separate file rather than an
// audience parameter on _booking-slack.js: the two audiences' message copy is
// expected to diverge, and a channel-picking parameter is one typo away from
// posting a client's check-in into the new-applicant channel.
//
// Backend FAILURES from the check-in endpoints do NOT come here -- they call
// the shared postSystemAlert (#7-system-alerts), which is infra-level and
// audience-agnostic.
const slack = require('./_slack');
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

async function postCheckinBookingCreated(b) {
  return slack.postToSlack(slack.CHANNEL_CHECKIN_BOOKED, {
    username: '3AMAK Bot',
    icon_emoji: ':repeat:',
    blocks: [
      { type: 'header',
        text: { type: 'plain_text', text: '🔄 Check-in booked', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text:
          `*Client:* ${b.name}\n*Email:* ${b.email}\n*Phone:* ${b.phone || '—'}\n${whenLine(b)}`
          + (b.meetLink ? `\n*Meet:* ${b.meetLink}` : '') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

// `kind` is 'rescheduled' or 'cancelled'. Each posts to its own channel
// (#9/#10), separate from where the original booking lives (#8) -- Slack
// cannot thread across channels, so `originalTs` (the event's stored slackTs)
// is resolved to a permalink back to the original message instead. When
// originalTs is null the link line is simply omitted.
async function postCheckinBookingChanged(b, kind, originalTs) {
  const icon = kind === 'cancelled' ? '❌' : '🔁';
  const channel = kind === 'cancelled'
    ? slack.CHANNEL_CHECKIN_CANCELLED
    : slack.CHANNEL_CHECKIN_RESCHEDULED;
  const permalink = originalTs
    ? await slack.getPermalink(slack.CHANNEL_CHECKIN_BOOKED, originalTs)
    : null;
  const text = `${icon} *Check-in ${kind}* — ${b.name} (${b.email})\n${whenLine(b)}`
    + (permalink ? `\n<${permalink}|Original check-in booking>` : '');
  return slack.postToSlack(channel, {
    username: '3AMAK Bot',
    icon_emoji: ':repeat:',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer() }] },
    ],
  });
}

module.exports = { postCheckinBookingCreated, postCheckinBookingChanged };
