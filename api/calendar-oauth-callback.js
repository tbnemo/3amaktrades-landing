// LOCKED PATH: /api/calendar-oauth-callback is registered on the Google Cloud
// OAuth client. Renaming this file breaks the consent round-trip until the
// Google Cloud console is updated to match.
const auth = require('./_admin-auth');
const gcal = require('./_google-calendar');

function page(title, body) {
  // Deliberately minimal: this is a redirect waypoint Omar sees for a moment,
  // not a designed surface.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{background:#050505;color:#F2EEE4;font-family:system-ui,sans-serif;padding:48px;}
a{color:#D4AF37;}code{color:#8B887F;}</style></head>
<body><h1 style="color:#D4AF37">${title}</h1>${body}
<p><a href="/admin.html">Back to the admin page</a></p></body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { code, state, error } = req.query || {};

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (error) return res.status(400).send(page('Connection cancelled', `<p><code>${error}</code></p>`));
  if (!code) return res.status(400).send(page('Missing code', '<p>Google returned no authorization code.</p>'));
  if (!auth.verifyState(state)) {
    return res.status(400).send(page('Expired or invalid link',
      '<p>Start the connection again from the admin page.</p>'));
  }

  const exchanged = await gcal.exchangeCodeForTokens(code);
  if (!exchanged.ok) {
    return res.status(502).send(page('Could not exchange the code',
      `<p><code>${exchanged.reason}</code></p>`));
  }

  const saved = await gcal.saveRefreshToken(exchanged.refreshToken);
  if (!saved.ok) {
    const hint = saved.reason === 'BLOB_NOT_CONFIGURED'
      ? '<p>The Vercel Blob store does not exist yet, so there is nowhere to save the token. Create it in the Vercel dashboard (Storage &rarr; Create Database &rarr; Blob), redeploy, then connect again.</p>'
      : `<p><code>${saved.reason}</code></p>`;
    return res.status(503).send(page('Calendar authorised, but not saved', hint));
  }

  res.writeHead(302, { Location: '/admin.html?connected=1' });
  return res.end();
};
