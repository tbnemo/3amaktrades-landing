// The two CHECK-IN admin endpoints, in one Serverless Function.
//
// They used to be admin/checkin-availability.js and admin/checkin-clients.js.
// The Hobby plan allows 12 Serverless Functions per deployment and every non-`_`
// .js file under api/ becomes one, so this deployment was failing to build at
// 19. Nothing below changes behaviour: each handler is its original body, and
// both original PUBLIC PATHS still work, preserved by `rewrites` in vercel.json:
//
//   /api/admin/checkin-availability  -> availability
//   /api/admin/checkin-clients       -> clients
//
// admin.html still calls those exact paths and was not touched. Note that the
// clients DELETE still reads `req.query.email` as a fallback -- no rewrite here
// puts a query string in its destination, precisely so a caller's own query
// survives untouched. See api/_route-action.js.
const auth = require('../_admin-auth');
const av = require('../_availability');
const store = require('../_blob-store');
const cc = require('../_checkin-clients');
const { loadCheckinTemplate } = require('../_load-checkin-template');
const { resolveAction, notFound } = require('../_route-action');

// ===========================================================================
// Read/write the CHECK-IN weekly template. Passcode-gated behind the same
// session cookie as every other admin endpoint -- one login covers both tabs of
// admin.html. Deliberately a separate handler from admin/availability.js rather
// than one endpoint taking an audience parameter: an off-by-one in that
// parameter would silently overwrite the wrong audience's hours.
// ===========================================================================
async function availabilityHandler(req, res) {
  // Mirrors the clients handler: the template changes the moment Omar edits it,
  // and a cached 401 or a cached stale template is worse than no caching at all.
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const tplRes = await loadCheckinTemplate();
    if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
      // Still return the defaults so the form renders and Omar can see the
      // shape of what he will be editing once storage exists.
      return res.status(200).json({ ok: true, template: tplRes.template,
        usedDefault: true, storageMissing: true });
    }
    if (!tplRes.ok) {
      // A genuine read failure (a real Blob API error, corrupted JSON,
      // network failure) -- NOT the legitimate "never saved yet" case above.
      // loadCheckinTemplate() still hands back a default template on this
      // path, but it must never be served as ok:true: the admin page would
      // render it as if it were Omar's real saved check-in hours, and a
      // Save from there would silently overwrite them with defaults he
      // never chose.
      return res.status(502).json({
        ok: false,
        errors: [`Failed to load the saved check-in hours (${tplRes.reason}). ` +
          'Do not save from this page until this is resolved -- the form has ' +
          'not loaded real data, and saving now would overwrite the real ' +
          'check-in hours with defaults.'],
      });
    }
    return res.status(200).json({ ok: true, template: tplRes.template,
      usedDefault: !!tplRes.usedDefault, storageMissing: false });
  }

  if (req.method === 'POST') {
    const incoming = (req.body && req.body.template) || null;
    // Validate BEFORE normalizing: normalizing alone would silently rewrite a
    // mistake (an end time before its start) into something Omar did not choose.
    const check = av.validateTemplate(incoming);
    if (!check.ok) {
      return res.status(400).json({ ok: false, errors: check.errors });
    }
    const template = av.normalizeTemplate(incoming);
    const written = await store.writeJson(store.CHECKIN_AVAILABILITY_BLOB, template);
    if (!written.ok) {
      const missing = written.reason === store.BLOB_NOT_CONFIGURED;
      return res.status(missing ? 503 : 502).json({
        ok: false,
        errors: [missing
          ? 'The Vercel Blob store does not exist yet, so check-in hours cannot be saved. Create it in the Vercel dashboard (Storage -> Create Database -> Blob) and redeploy.'
          : written.reason],
      });
    }
    return res.status(200).json({ ok: true, template });
  }

  return res.status(405).end();
}

// ===========================================================================
// List, add/replace, and remove entries in checkin-clients.json. Passcode-gated
// by the same session cookie as every other admin endpoint -- this list is the
// entire access control on who may book a check-in call.
// ===========================================================================
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

async function clientsHandler(req, res) {
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
    // Lifecycle actions (renew/pause/resume) are distinguished by a `command`
    // field in the JSON body -- a separate, inner concept from the route-level
    // `?action=` that _route-action.js uses purely for file consolidation.
    // Checked first so a command-carrying body never falls through to the
    // upsert logic below, and everything else falls through unchanged.
    if (req.body && req.body.command) {
      const { command, email } = req.body;
      if (!cc.normalizeEmail(email)) {
        return res.status(400).json({ ok: false, errors: ['email is required'] });
      }
      const read = await cc.loadClients();
      if (!read.ok) return readFailure(res, read.reason);

      const client = cc.findClient(read.clients, { email });
      if (!client) {
        return res.status(404).json({ ok: false, errors: ['That email is not on the list.'] });
      }

      let updated;
      if (command === 'renew') updated = cc.renewClient(client);
      else if (command === 'pause') updated = cc.pauseClient(client);
      else if (command === 'resume') updated = cc.resumeClient(client);
      else return res.status(400).json({ ok: false, errors: [`unknown command: ${command}`] });

      const clients = cc.upsertClient(read.clients, updated);
      const written = await cc.saveClients(clients);
      if (!written.ok) return writeFailure(res, written.reason);
      return res.status(200).json({ ok: true, clients });
    }

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
}

// ===========================================================================
// Dispatch
// ===========================================================================

// Keyed on the ORIGINAL public path segment, which is also what each rewrite's
// `:action` parameter captures. The consolidated landing path
// (/api/admin/checkin) is deliberately absent, so a direct hit on it resolves
// to nothing rather than to an arbitrary handler.
const ROUTES = {
  'checkin-availability': availabilityHandler,
  'checkin-clients': clientsHandler,
};

module.exports = async function handler(req, res) {
  const route = resolveAction(req, ROUTES);
  // Before any auth check, and deliberately so: a 404 for a path this file does
  // not serve leaks nothing about the admin surface either way.
  if (!route) return notFound(res);
  return route(req, res);
};

module.exports.availability = availabilityHandler;
module.exports.clients = clientsHandler;
module.exports.__routesForTests = ROUTES;
