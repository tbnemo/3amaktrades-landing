const { postToSlack, getPermalink, CHANNEL_NEW_APPLICATIONS, CHANNEL_WARM_LEADS } = require('./_slack');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, phone, ts } = req.body;

  const permalink = await getPermalink(CHANNEL_NEW_APPLICATIONS, ts);
  const linkText = permalink ? `\n<${permalink}|View full application>` : '';

  await postToSlack(CHANNEL_WARM_LEADS, {
    username: '3AMAK Bot',
    icon_emoji: ':fire:',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🔥 *Warm lead* — ${name} (${phone}) just opened WhatsApp to text us.${linkText}` }
      }
    ],
  });

  return res.status(200).json({ ok: true });
};
