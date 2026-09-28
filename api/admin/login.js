const auth = require('../_admin-auth');
const rateLimit = require('../_login-rate-limit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  if (!process.env.ADMIN_PASSCODE) {
    // Being explicit beats a generic 401: the user has to know the gate is
    // unconfigured rather than assume they typed the wrong passcode. Checked
    // before the rate limiter so a misconfigured deployment says so plainly
    // instead of burning attempts against a passcode that cannot exist.
    return res.status(503).json({ error: 'ADMIN_PASSCODE is not set on this deployment' });
  }

  // Before the comparison, never after: the point is to stop attempts, and an
  // attempt that gets compared has already cost whatever a comparison costs.
  const gate = await rateLimit.check();
  if (!gate.allowed) {
    if (gate.unavailable) {
      // Fail closed. See the note in api/_login-rate-limit.js: allowing logins
      // while the counter is unreadable would restore unlimited guessing to
      // anyone who can make the Blob store unreachable.
      return res.status(503).json({
        error: 'Login is temporarily unavailable -- the attempt log could not be read. '
          + 'If the Vercel Blob store does not exist yet, create it and redeploy.',
      });
    }
    res.setHeader('Retry-After', String(gate.retryAfterSec));
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} minute(s).`,
      retryAfterSec: gate.retryAfterSec,
    });
  }

  if (!auth.checkPasscode(body.passcode)) {
    const after = await rateLimit.recordFailure();
    if (after.locked) {
      // The attempt that trips the threshold reports the lockout directly, rather
      // than a bare 401 followed by a surprising 429 on the next try.
      res.setHeader('Retry-After', String(after.retryAfterSec));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(after.retryAfterSec / 60)} minute(s).`,
        retryAfterSec: after.retryAfterSec,
      });
    }
    return res.status(401).json({ error: 'wrong passcode' });
  }

  // A correct passcode wipes the counter, so typos on the way in never carry over.
  await rateLimit.clear();
  res.setHeader('Set-Cookie', auth.issueSessionCookie());
  return res.status(200).json({ ok: true });
};
