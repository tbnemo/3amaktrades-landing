// List, add/replace, and remove entries in checkin-clients.json. Passcode-gated
// by the same session cookie as every other admin endpoint -- this list is the
// entire access control on who may book a check-in call.
const auth = require('../_admin-auth');
const store = require('../_blob-store');
const cc = require('../_checkin-clients');

const STORE_MISSING_MESSAGE = 'The Vercel Blob store does not exist yet, so the client list '
  + 'cannot be saved. Create it in the Vercel dashboard (Storage -> Create Database -> Blob) '
  + 'and redeploy.';

function readFailure(res, reason) {
  const missing = reason === store.BLOB_NOT_CONFIGURED;
  return res.status(missing ? 503 : 502).json({
    ok: false, errors: [missing ? STORE_MISSING_MESSAGE : reason],
  });
}

function writeFailure(res, reason) {
  const missing = reason === store.BLOB_NOT_CONFIGURED;
  return res.status(missing ? 503 : 502).json({
    ok: false, errors: [missing ? STORE_MISSING_MESSAGE : reason],
  });
}

module.exports = async function handler(req, res) {
  // The roster changes the moment Omar edits it, and a cached 401 or a cached
  // stale list is worse than no caching at all.
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const read = await cc.loadClients();
    if (!read.ok && read.reason === store.BLOB_NOT_CONFIGURED) {
      // Mirrors admin/availability.js: still a 200, so the manager renders and
      // says what is missing rather than failing opaquely.
      return res.status(200).json({ ok: true, clients: [], storageMissing: true });
    }
    if (!read.ok) return res.status(502).json({ ok: false, errors: [read.reason] });
    return res.status(200).json({ ok: true, clients: read.clients, storageMissing: false });
  }

  if (req.method === 'POST') {
    const incoming = (req.body && req.body.client) || null;
    // Validate BEFORE reading the list: a bad entry must not even cost a read.
    const check = cc.validateClient(incoming);
    if (!check.ok) return res.status(400).json({ ok: false, errors: check.errors });

    const read = await cc.loadClients();
    // A write built on a failed read would replace the whole roster with this
    // one entry -- a silent wipe of every other client.
    if (!read.ok) return readFailure(res, read.reason);

    const clients = cc.upsertClient(read.clients, incoming);
    const written = await cc.saveClients(clients);
    if (!written.ok) return writeFailure(res, written.reason);
    return res.status(200).json({ ok: true, clients });
  }

  if (req.method === 'DELETE') {
    // Body first, query second: some proxies and fetch implementations drop a
    // body on DELETE, which would otherwise 400 every remove.
    const email = (req.body && req.body.email) || (req.query && req.query.email) || '';
    if (!cc.normalizeEmail(email)) {
      return res.status(400).json({ ok: false, errors: ['email is required'] });
    }

    const read = await cc.loadClients();
    if (!read.ok) return readFailure(res, read.reason);

    const { clients, removed } = cc.removeClient(read.clients, email);
    if (!removed) {
      // Not an idempotent 200 on purpose: the admin page removes by clicking a
      // row it just rendered, so "not on the list" means the list changed
      // underneath and the operator should see that, not a false success.
      return res.status(404).json({ ok: false, errors: ['That email is not on the list.'] });
    }
    const written = await cc.saveClients(clients);
    if (!written.ok) return writeFailure(res, written.reason);
    return res.status(200).json({ ok: true, clients });
  }

  return res.status(405).end();
};
