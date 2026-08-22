const { postToSlack, CHANNEL_NEW_APPLICATIONS } = require('./_slack');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, phone, ts } = req.body;

  const message = {
    username: '3AMAK Bot',
    icon_emoji: ':fire:',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `🔥 *Warm lead* — ${name} (${phone}) just opened WhatsApp to text us.` }
      }
    ],
  };
  // Reply into the original application's thread when we have its ts, instead
  // of posting a new top-level message -- keeps the channel from getting noisy.
  if (ts) message.thread_ts = ts;

  await postToSlack(CHANNEL_NEW_APPLICATIONS, message);

  return res.status(200).json({ ok: true });
};
