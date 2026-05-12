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
        text: { type: 'plain_text', text: '🟢 New Application — 3AMAK Trades', emoji: true }
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*👤 Name:*\n${name}` },
          { type: 'mrkdwn', text: `*🎂 Age:*\n${age}` },
          { type: 'mrkdwn', text: `*🌍 Country:*\n${country}` },
          { type: 'mrkdwn', text: `*💼 Occupation:*\n${occupation}` },
          { type: 'mrkdwn', text: `*📊 Experience:*\n${experience}` },
          { type: 'mrkdwn', text: `*⏰ Hours/day:*\n${hours}` },
          { type: 'mrkdwn', text: `*💰 Budget:*\n${budget}` },
          { type: 'mrkdwn', text: `*🎯 Looking for:*\n${looking}` },
          { type: 'mrkdwn', text: `*🏆 Goal:*\n${goal}` },
          { type: 'mrkdwn', text: `*🌐 Form language:*\n${lang}` },
        ]
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Submitted via 3amaktrades-landing · ${new Date().toUTCString()}` }]
      }
    ]
  };

  try {
    const slackRes = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!slackRes.ok) {
      console.error('Slack error:', await slackRes.text());
    }
  } catch (e) {
    console.error('Fetch error:', e.message);
  }

  return res.status(200).json({ ok: true });
};
