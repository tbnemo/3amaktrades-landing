// The two admin session endpoints, in one Serverless Function.
//
// They used to be admin/login.js and admin/status.js. The Hobby plan allows 12
// Serverless Functions per deployment and every non-`_` .js file under api/
// becomes one, so this deployment was failing to build at 19. Nothing below
// changes behaviour: each handler is its original body, and both original
// PUBLIC PATHS still work, preserved by `rewrites` in vercel.json:
//
//   /api/admin/login   -> login   (POST, creates the session; NOT session-gated)
//   /api/admin/status  -> status  (GET,  session-gated)
//
// admin.html still calls those exact paths and was not touched.
//
// The two endpoints have deliberately different gates -- login must be reachable
// without a session because it is what mints one -- so each handler keeps its
// OWN gate, exactly as before. Dispatch cannot skip a gate: whichever handler a
// request lands on enforces its own.
const auth = require('../_admin-auth');
const rateLimit = require('../_login-rate-limit');
const store = require('../_blob-store');
const gcal = require('../_google-calendar');
const { resolveAction, notFound } = require('../_route-action');

// ===========================================================================
// POST /api/admin/login
// ===========================================================================
async function loginHandler(req, res) {
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
}

// ===========================================================================
// GET /api/admin/status
// ===========================================================================
async function statusHandler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!auth.requireAdmin(req, res)) return;

  const blobConfigured = store.isConfigured();
  const calendarConnected = blobConfigured ? await gcal.isConnected() : false;

  return res.status(200).json({
    ok: true,
    blobConfigured,
    calendarConnected,
    calendarId: gcal.calendarId(),
    redirectUri: gcal.redirectUri(),
    resendConfigured: !!process.env.RESEND_API_KEY,
    // Surfaced so the admin page can say exactly what is still missing rather
    // than failing opaquely while the Blob store does not exist yet.
    blockers: [
      !blobConfigured && 'Vercel Blob store not created (Storage -> Create Database -> Blob)',
      blobConfigured && !calendarConnected && 'Google Calendar not connected yet',
      !process.env.RESEND_API_KEY && 'RESEND_API_KEY missing',
    ].filter(Boolean),
  });
}

// ===========================================================================
// Dispatch
// ===========================================================================

// Keyed on the ORIGINAL public path segment, which is also what each rewrite's
// `:action` parameter captures. The consolidated landing path (/api/admin/auth)
// is deliberately absent, so a direct hit on it resolves to nothing rather than
// to an arbitrary handler.
const ROUTES = {
  login: loginHandler,
  status: statusHandler,
};

module.exports = async function handler(req, res) {
  const route = resolveAction(req, ROUTES);
  if (!route) return notFound(res);
  return route(req, res);
};

module.exports.login = loginHandler;
module.exports.status = statusHandler;
module.exports.__routesForTests = ROUTES;
