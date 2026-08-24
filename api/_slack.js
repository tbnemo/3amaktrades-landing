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

// Checks the last ~200 messages in a channel for this phone number, so a
// repeat application can be flagged instead of looking like a fresh lead.
async function isRepeatSubmission(channelId, phone) {
  const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!BOT_TOKEN || !phone || phone === '—') return false;
  try {
    const res = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&limit=200`, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    const data = await res.json();
    if (!data.ok) { console.error('Slack conversations.history error:', data.error); return false; }
    return data.messages.some(m => m.text && m.text.includes(phone));
  } catch (e) {
    console.error('isRepeatSubmission threw:', e.message);
    return false;
  }
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

module.exports = { postToSlack, getPermalink, isRepeatSubmission, CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS, CHANNEL_WARM_LEADS };
