const auth = require('../_admin-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  if (!process.env.ADMIN_PASSCODE) {
    // Being explicit beats a generic 401: the user has to know the gate is
    // unconfigured rather than assume they typed the wrong passcode.
    return res.status(503).json({ error: 'ADMIN_PASSCODE is not set on this deployment' });
  }
  if (!auth.checkPasscode(body.passcode)) {
    return res.status(401).json({ error: 'wrong passcode' });
  }
  res.setHeader('Set-Cookie', auth.issueSessionCookie());
  return res.status(200).json({ ok: true });
};
