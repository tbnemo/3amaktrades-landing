const { postToSlack, isRepeatSubmission, CHANNEL_NEW_APPLICATIONS, CHANNEL_INCOMPLETE_LEADS } = require('./_slack');

// Honeypot: real users never see or fill this field. Any value means a bot filled the form.
function isBot(req) {
  return !!(req.body && req.body.website);
}

function priorityTag(budgetCode) {
  if (budgetCode === '3k+') return '🔥 ';
  if (budgetCode === '1k-3k') return '⭐ ';
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (isBot(req)) return res.status(200).json({ ok: true }); // silently drop, don't tip off the bot

  const { name, country, experience, budget, budgetCode, looking, goal, phone, email, lang, partial } = req.body;

  const footer = `Sent by <https://3amaktrades-landing.vercel.app|3AMAK Bot> · ${new Date().toUTCString()}`;
  const isRepeat = await isRepeatSubmission(CHANNEL_NEW_APPLICATIONS, phone);
  const repeatTag = isRepeat ? '🔁 ' : '';

  const message = partial ? {
    username: '3AMAK Bot',
    icon_emoji: ':bar_chart:',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${repeatTag}Lead Captured — Incomplete`, emoji: true } },
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
      { type: 'header', text: { type: 'plain_text', text: `${repeatTag}${priorityTag(budgetCode)}New Application`, emoji: true } },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Name:* ${name}\n*Phone:* ${phone}\n*Email:* ${email}\n*Country:* ${country}\n*Experience:* ${experience}\n*Budget:* ${budget}\n*Looking for:* ${looking}\n*Goal:* ${goal}\n*Language:* ${lang}` }
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] }
    ]
  };

  const { ts } = await postToSlack(partial ? CHANNEL_INCOMPLETE_LEADS : CHANNEL_NEW_APPLICATIONS, message);

  // ts lets the client thread a later "warm lead" WhatsApp-click ping onto this
  // exact message instead of posting a separate top-level message.
  return res.status(200).json({ ok: true, ts });
};
