const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, age, country, occupation, experience, hours, budget, looking, goal, phone, email, lang, partial } = req.body;

  const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

  if (!SLACK_WEBHOOK) {
    console.error('SLACK_WEBHOOK_URL not set');
    return res.status(200).json({ ok: true });
  }

  const footer = `Sent by <https://3amaktrades-landing.vercel.app|3AMAK Bot> · ${new Date().toUTCString()}`;

  const message = partial ? {
    username: '3AMAK Bot',
    icon_emoji: ':bar_chart:',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Lead Captured — Incomplete', emoji: false } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Name:* ${name}\n*Age:* ${age}\n*Phone:* ${phone}\n*Email:* ${email}` }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }
    ]
  } : {
    username: '3AMAK Bot',
    icon_emoji: ':bar_chart:',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'New Application', emoji: false } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Name:* ${name}\n*Age:* ${age}\n*Phone:* ${phone}\n*Email:* ${email}\n*Country:* ${country}\n*Occupation:* ${occupation}\n*Experience:* ${experience}\n*Hours / day:* ${hours}\n*Budget:* ${budget}\n*Looking for:* ${looking}\n*Goal:* ${goal}\n*Language:* ${lang}` }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }
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
