const fetch = require('node-fetch');

const CHANNEL_NEW_APPLICATIONS = 'C0B3EAGNATT'; // #1-new-applications
const CHANNEL_INCOMPLETE_LEADS = 'C0BRK4HDFFH'; // #3-incomplete-leads (channel renamed since; routes by ID, unaffected)
const CHANNEL_WARM_LEADS = 'C0BRXBD8QAZ'; // #2-warm-leads (channel renamed since; routes by ID, unaffected)
const CHANNEL_NEW_CALLS_BOOKED = 'C0C5EU42DDF'; // #4-new-calls-booked
const CHANNEL_RESCHEDULED_CALLS = 'C0C5CRRRJP4'; // #5-rescheduled-calls
const CHANNEL_CANCELLED_CALLS = 'C0C5EU6RPLZ'; // #6-cancelled-calls
const CHANNEL_SYSTEM_ALERTS = 'C0C56PC8BPV'; // #7-system-alerts

// The check-in audience's own three channels, mirroring #4/#5/#6 exactly.
// Backend FAILURES from the check-in endpoints do NOT get a channel here --
// they reuse postSystemAlert/#7-system-alerts, which is infra-level and
// audience-agnostic; a duplicate would split one signal across two places.
const CHANNEL_CHECKIN_BOOKED = 'C0C5FTTA081';      // #8-checkin-booked
const CHANNEL_CHECKIN_RESCHEDULED = 'C0C5FTTP1J5'; // #9-checkin-rescheduled
const CHANNEL_CHECKIN_CANCELLED = 'C0C5C1U12DC';   // #10-checkin-cancelled

// Gets a shareable link to a specific message, so a ping in another channel
// can point back to the full application instead of repeating its contents.
async function getPermalink(channelId, messageTs) {
  const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!BOT_TOKEN || !messageTs) return null;
  const url = `https://slack.com/api/chat.getPermalink?channel=${channelId}&message_ts=${messageTs}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${BOT_TOKEN}` } });
  const data = await res.json();
  if (!data.ok) { console.error('Slack chat.getPermalink error:', data.error); return null; }
  return data.permalink;
}

// Posts to Slack via the bot token (chat.postMessage) so any channel can be
// targeted by ID without needing a separate Incoming Webhook per channel.
// If the bot token is missing OR fails for any reason (revoked, rate-limited,
// Slack outage), falls back to SLACK_WEBHOOK_URL so the lead isn't silently
// lost -- it'll land in whatever channel that webhook is bound to instead.
async function postToSlack(channelId, message) {
  const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

  if (BOT_TOKEN) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${BOT_TOKEN}`,
        },
        body: JSON.stringify({ channel: channelId, unfurl_links: false, unfurl_media: false, ...message }),
      });
      const data = await res.json();
      if (data.ok) return { ts: data.ts || null }; // ts lets a later reply thread onto this message
      console.error('Slack chat.postMessage error:', data.error, '-- falling back to webhook');
    } catch (e) {
      console.error('Slack chat.postMessage threw:', e.message, '-- falling back to webhook');
    }
  }

  const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
  if (!WEBHOOK) {
    console.error('Bot token failed/unset and SLACK_WEBHOOK_URL not set -- message lost:', JSON.stringify(message).slice(0, 200));
    return { ts: null };
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) console.error('Slack webhook error:', await res.text());
  return { ts: null }; // incoming webhooks don't return a message ts, no threading possible
}

// Best-effort, self-swallowing: a backend failure (calendar unreachable, an
// email that wouldn't send, an OAuth exchange that failed) should still get
// SOME visibility instead of only hitting console.error where nobody's
// watching a serverless function's logs -- but a failure to post the alert
// itself must never mask or crash whatever actually broke, so every error
// here is caught and swallowed, never rethrown.
async function postSystemAlert(text) {
  try {
    await postToSlack(CHANNEL_SYSTEM_ALERTS, {
      username: '3AMAK Bot',
      icon_emoji: ':rotating_light:',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:rotating_light: ${text}` } },
        { type: 'context', elements: [{ type: 'mrkdwn',
            text: `Sent by <https://3amaktrades.com|3AMAK Bot> · ${new Date().toUTCString()}` }] },
      ],
    });
  } catch (e) {
    console.error('postSystemAlert threw (alert itself failed to send):', e.message);
  }
}

module.exports = {
  postToSlack, getPermalink, postSystemAlert,
  CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS, CHANNEL_WARM_LEADS,
  CHANNEL_NEW_CALLS_BOOKED, CHANNEL_RESCHEDULED_CALLS, CHANNEL_CANCELLED_CALLS, CHANNEL_SYSTEM_ALERTS,
  CHANNEL_CHECKIN_BOOKED, CHANNEL_CHECKIN_RESCHEDULED, CHANNEL_CHECKIN_CANCELLED,
};
