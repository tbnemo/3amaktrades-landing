// The two lead-capture endpoints, in one Serverless Function.
//
// api/wa-click.js was folded in here. The Hobby plan allows 12 Serverless
// Functions per deployment and every non-`_` .js file under api/ becomes one, so
// this deployment was failing to build at 19. Nothing below changes behaviour:
// each handler is its original body, and both PUBLIC PATHS still work:
//
//   /api/submit    -> submit    (served DIRECTLY by this file, no rewrite)
//   /api/wa-click  -> wa-click  (preserved by a `rewrites` rule in vercel.json)
//
// /api/submit is deliberately left on its own filesystem route rather than being
// rewritten like the other consolidations: it is the site's lead-capture path,
// and it gains no new routing indirection from this change. index.html still
// calls both exact paths and was not touched.
const {
  postToSlack,
  getPermalink,
  isRepeatSubmission,
  CHANNEL_NEW_APPLICATIONS,
  CHANNEL_INCOMPLETE_LEADS,
  CHANNEL_WARM_LEADS,
} = require('./_slack');
const { resolveAction } = require('./_route-action');

// Honeypot: real users never see or fill this field. Any value means a bot filled the form.
function isBot(req) {
  return !!(req.body && req.body.website);
}

function priorityTag(budgetCode) {
  if (budgetCode === '3k+') return '🔥 ';
  if (budgetCode === '1k-3k') return '⭐ ';
  return '';
}

// ===========================================================================
// POST /api/submit
// ===========================================================================
async function submitHandler(req, res) {
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
}

// ===========================================================================
// POST /api/wa-click
// ===========================================================================
async function waClickHandler(req, res) {
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
}

// ===========================================================================
// Dispatch
// ===========================================================================

// Only the rewritten path is keyed here. 'submit' is deliberately NOT a key:
// /api/submit is this file's own filesystem route, so under the reading of
// Vercel's docs where a rewritten request already carries the destination path,
// a rewritten /api/wa-click would look identical to a direct /api/submit and the
// `:action` query parameter is the only thing telling them apart. Honouring that
// parameter means POST /api/submit?action=wa-click also reaches the wa-click
// handler -- which grants nothing, since /api/wa-click is itself a public
// unauthenticated endpoint, and is strictly better than the alternative of a
// warm-lead ping silently posting as a New Application.
const ROUTES = {
  'wa-click': waClickHandler,
};

module.exports = async function handler(req, res) {
  const route = resolveAction(req, ROUTES);
  return (route || submitHandler)(req, res);
};

module.exports.submit = submitHandler;
module.exports.waClick = waClickHandler;
module.exports.__routesForTests = ROUTES;
