const { postToSlack, CHANNEL_NEW_APPLICATIONS } = require('./_slack');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, phone } = req.body;

  await postToSlack(CHANNEL_NEW_APPLICATIONS, {
    username: '3AMAK Bot',
    icon_emoji: ':fire:',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🔥 *Warm lead* — ${name} (${phone}) just opened WhatsApp to text us.` }
      }
    ]
  });

  return res.status(200).json({ ok: true });
};
