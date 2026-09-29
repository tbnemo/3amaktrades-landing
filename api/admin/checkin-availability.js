// Read/write the CHECK-IN weekly template. Passcode-gated behind the same
// session cookie as every other admin endpoint -- one login covers both tabs of
// admin.html. Deliberately a separate handler from admin/availability.js rather
// than one endpoint taking an audience parameter: an off-by-one in that
// parameter would silently overwrite the wrong audience's hours.
const auth = require('../_admin-auth');
const av = require('../_availability');
const store = require('../_blob-store');
const { loadCheckinTemplate } = require('../_load-checkin-template');

module.exports = async function handler(req, res) {
  // Mirrors admin/checkin-clients.js: the template changes the moment Omar
  // edits it, and a cached 401 or a cached stale template is worse than no
  // caching at all.
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
};
