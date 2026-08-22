const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, phone } = req.body;

  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

  if (!SLACK_WEBHOOK) {
    console.error('SLACK_WEBHOOK_URL not set');
    return res.status(200).json({ ok: true });
  }

  const message = {
    username: '3AMAK Bot',
    icon_emoji: ':fire:',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🔥 *Warm lead* — ${name} (${phone}) just opened WhatsApp to text us.` }
      }
    ]
  };

  const slackRes = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!slackRes.ok) {
    console.error('Slack error:', await slackRes.text());
  }

  return res.status(200).json({ ok: true });
};
