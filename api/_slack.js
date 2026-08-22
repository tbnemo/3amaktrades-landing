const fetch = require('node-fetch');

const CHANNEL_NEW_APPLICATIONS = 'C0B3EAGNATT'; // #1-new-applications
const CHANNEL_INCOMPLETE_LEADS = 'C0BRK4HDFFH'; // #2-incomplete-leads

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
      body: JSON.stringify({ channel: channelId, ...message }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Slack chat.postMessage error:', data.error);
    return;
  }

  const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
  if (!WEBHOOK) {
    console.error('Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL is set');
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) console.error('Slack webhook error:', await res.text());
}

module.exports = { postToSlack, CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS };
