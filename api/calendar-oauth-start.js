const auth = require('./_admin-auth');
const gcal = require('./_google-calendar');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  // Passcode-gated: an open consent-start endpoint lets anyone begin an OAuth
  // flow against our client id.
  if (!auth.verifySession(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google OAuth env vars missing' });
  }
  res.writeHead(302, { Location: gcal.consentUrl(auth.signState()) });
  return res.end();
};
