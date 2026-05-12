const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, age, country, occupation, experience, hours, budget, looking, goal, lang } = req.body;

  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

  if (!SLACK_WEBHOOK) {
    console.error('SLACK_WEBHOOK_URL not set');
    return res.status(200).json({ ok: true });
  }

  const message = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'New Application — 3AMAK Trades', emoji: false }
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Name*\n${name}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Age*\n${age}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Country*\n${country}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Occupation*\n${occupation}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Experience*\n${experience}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Hours / day*\n${hours}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Budget*\n${budget}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Looking for*\n${looking}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Goal*\n${goal}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Language*\n${lang}` } },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Submitted · ${new Date().toUTCString()}` }]
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
