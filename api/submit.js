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
  postSystemAlert,
  CHANNEL_NEW_APPLICATIONS,
  CHANNEL_INCOMPLETE_LEADS,
  CHANNEL_WARM_LEADS,
} = require('./_slack');
const applicants = require('./_applicants');
const store = require('./_blob-store');
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

  // A resubmission with the same email OR phone (current or previously used)
  // updates the one stored record instead of becoming a second one -- see
  // api/_applicants.js. Partial (incomplete) submissions are a different
  // concept entirely (an abandoned form, handled by the separate
  // abandoned-form capture flow) and are never written here.
  let isUpdate = false;
  let submissionCount = 1;
  if (!partial) {
    const read = await applicants.loadApplicants();
    // Fail OPEN: a Blob hiccup (or the store not being configured yet) must
    // never drop a real application just because the dedup check couldn't
    // run. Worst case on a failure here is a false "New Application" label
    // on a genuine resubmission -- not a lost lead.
    if (read.ok) {
      const result = applicants.upsertApplicant(read.applicants, {
        name, country, experience, budget, budgetCode, looking, goal, phone, email, lang,
      });
      isUpdate = result.isUpdate;
      submissionCount = result.record.submissionCount;
      const written = await applicants.saveApplicants(result.applicants);
      if (!written.ok && written.reason !== store.BLOB_NOT_CONFIGURED) {
        console.error('applicants save failed:', written.reason);
        await postSystemAlert(`*Applicant store write failed* for \`${email}\`: ${written.reason}. `
          + `The Slack post still went out; the dedup record just didn't save this time.`);
      }
    } else if (read.reason !== store.BLOB_NOT_CONFIGURED) {
      console.error('applicants load failed:', read.reason);
      await postSystemAlert(`*Applicant store read failed* for \`${email}\`: ${read.reason}. `
        + `The Slack post still went out; this submission could not be checked against past ones.`);
    }
  }
  const updateTag = isUpdate ? `🔁 Updated (${submissionCount}x) — ` : '';

  const message = partial ? {
    username: '3AMAK Bot',
    icon_emoji: ':bar_chart:',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Lead Captured — Incomplete', emoji: true } },
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
      { type: 'header', text: { type: 'plain_text', text: `${updateTag}${priorityTag(budgetCode)}New Application`, emoji: true } },
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

// Only the rewritten path is keyed here. 'submit' is deliberately NOT a key,
// and that is load-bearing: /api/submit is this file's own filesystem route, so
// under the reading of Vercel's docs where a rewritten request already carries
// the DESTINATION path, a rewritten /api/wa-click arrives looking exactly like a
// direct /api/submit. If 'submit' were a key the path would win and a warm-lead
// ping would silently post as a New Application, so the ?action= parameter has
// to be the tie-break.
//
// Which is why this one rewrite -- alone among the rules in vercel.json -- does
// put the endpoint in its destination query string
// (/api/submit?action=wa-click). It can safely do that because wa-click's only
// caller is navigator.sendBeacon('/api/wa-click', <JSON blob>) in index.html,
// which sends NO query string of its own: there is nothing of the caller's for a
// destination query string to merge with or replace, so this rule is correct
// under every reading of Vercel's behaviour rather than only the two the
// path-encoded form relies on. The other endpoints all have callers that DO
// send a query string (?date=/&days=, ?email=), so they stay query-string-free.
//
// The consequence, accepted deliberately: POST /api/submit?action=wa-click also
// reaches the wa-click handler. That grants nothing -- /api/wa-click is itself a
// public unauthenticated endpoint -- and is far better than the alternative
// failure mode above.
const ROUTES = {
  'wa-click': waClickHandler,
};

module.exports = async function handler(req, res) {
  const route = resolveAction(req, ROUTES);
  // Not a silent fallback: /api/submit is NOT rewritten, so a direct request
  // legitimately resolves to no keyed route and the submit handler is simply
  // what /api/submit means. Every consolidated file that serves only rewritten
  // paths 404s instead.
  return (route || submitHandler)(req, res);
};

module.exports.submit = submitHandler;
module.exports.waClick = waClickHandler;
module.exports.__routesForTests = ROUTES;
