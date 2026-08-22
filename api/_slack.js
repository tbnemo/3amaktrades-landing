const fetch = require('node-fetch');

const CHANNEL_NEW_APPLICATIONS = 'C0B3EAGNATT'; // #1-new-applications
const CHANNEL_INCOMPLETE_LEADS = 'C0BRK4HDFFH'; // #2-incomplete-leads
const CHANNEL_WARM_LEADS = 'C0BRXBD8QAZ'; // #3-warm-leads

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
// Falls back to SLACK_WEBHOOK_URL (single-channel only) if no bot token is set.
async function postToSlack(channelId, message) {
  const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

  if (BOT_TOKEN) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: channelId, unfurl_links: false, unfurl_media: false, ...message }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Slack chat.postMessage error:', data.error);
    return { ts: data.ts || null }; // ts lets a later reply thread onto this message
  }

  const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
  if (!WEBHOOK) {
    console.error('Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL is set');
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

module.exports = { postToSlack, getPermalink, CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS, CHANNEL_WARM_LEADS };
