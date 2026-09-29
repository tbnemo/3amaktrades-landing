// POST /api/checkin-verify
// { email?, phone? } -> { ok:true, name, verifyToken } | { ok:false }
//
// The light self-serve gate on /check-in: no account system, no password, just
// "are you on the manually-maintained client list". The token it hands back is
// what api/calendar-checkin-book.js requires, so verification is enforced at
// the API boundary rather than only in the page's UI -- without it, anyone
// could skip this step and POST straight to the booking endpoint.
//
// Rate limiting runs BEFORE the roster lookup and is keyed on whatever
// identifier was submitted (see api/_checkin-verify-rate-limit.js) -- a
// stranger hammering one guessed address gets throttled without affecting
// any other visitor's ability to verify.
const cc = require('./_checkin-clients');
const ct = require('./_checkin-token');
const rl = require('./_checkin-verify-rate-limit');
const store = require('./_blob-store');

module.exports = async function handler(req, res) {
  // A cached verification response would be a cached credential.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const email = cc.normalizeEmail(body.email);
  const phone = cc.normalizePhone(body.phone);

  // Not about the roster, so this cannot leak anything about it: the request
  // simply carried no identifier to look up.
  if (!email && !phone) {
    return res.status(400).json({ ok: false, error: 'BAD_REQUEST',
      message: 'Enter an email or a phone number.' });
  }

  const identifier = email || phone;

  const limit = await rl.check(identifier);
  if (!limit.allowed) {
    if (limit.locked) {
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED',
        message: 'Too many attempts. Try again in a few minutes.',
        retryAfterSec: limit.retryAfterSec });
    }
    // limit.unavailable: fail CLOSED, same discipline as the admin gate --
    // letting the lookup through when the counter can't be read hands back
    // unlimited guessing just by making the Blob store flaky.
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not check that right now.' });
  }

  const read = await cc.loadClients();
  if (!read.ok) {
    if (read.reason === store.BLOB_NOT_CONFIGURED) {
      return res.status(503).json({ ok: false, error: 'BLOB_NOT_CONFIGURED',
        message: 'Check-in booking is not set up yet.' });
    }
    return res.status(502).json({ ok: false, error: 'UPSTREAM',
      message: 'Could not check that right now.' });
  }

  const client = cc.findClient(read.clients, { email, phone });
  if (!client) {
    // Count the miss against the identifier that was actually submitted, then
    // reply exactly like before: 200, not 401/403, nothing but {ok:false}. The
    // page shows one generic message; the status line and the body must not
    // distinguish "not on the list" from anything else, and the rate-limit
    // check above is likewise indistinguishable from a normal miss until the
    // 6th attempt in a window.
    await rl.recordFailure(identifier);
    return res.status(200).json({ ok: false });
  }

  // A correct guess clears this identifier's own failure history.
  await rl.clear(identifier);

  // Always scoped to the record's EMAIL, even when the visitor typed a phone:
  // email is guaranteed present, is the record key, and is the only channel the
  // confirmation can reach them on. The email itself is deliberately NOT
  // returned -- calendar-checkin-book.js recovers it from the token.
  return res.status(200).json({
    ok: true,
    name: client.name,
    verifyToken: ct.makeVerifyToken(client.email),
  });
};
