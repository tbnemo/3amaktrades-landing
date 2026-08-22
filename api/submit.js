const { postToSlack, CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS } = require('./_slack');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, country, experience, budget, looking, goal, phone, email, lang, partial } = req.body;

  const footer = `Sent by <https://3amaktrades-landing.vercel.app|3AMAK Bot> · ${new Date().toUTCString()}`;

  const message = partial ? {
    username: '3AMAK Bot',
    icon_emoji: ':bar_chart:',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Lead Captured — Incomplete', emoji: false } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Name:* ${name}\n*Phone:* ${phone}\n*Email:* ${email}` }
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
        text: { type: 'mrkdwn', text: `*Name:* ${name}\n*Phone:* ${phone}\n*Email:* ${email}\n*Country:* ${country}\n*Experience:* ${experience}\n*Budget:* ${budget}\n*Looking for:* ${looking}\n*Goal:* ${goal}\n*Language:* ${lang}` }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }
    ]
  };

  await postToSlack(partial ? CHANNEL_INCOMPLETE_LEADS : CHANNEL_NEW_APPLICATIONS, message);

  return res.status(200).json({ ok: true });
};
