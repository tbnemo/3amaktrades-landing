// Read/write the weekly template. Passcode-gated -- these hours decide when
// strangers can put things on Omar's calendar.
const auth = require('../_admin-auth');
const av = require('../_availability');
const store = require('../_blob-store');
const { loadTemplate } = require('../_load-template');

module.exports = async function handler(req, res) {
  if (!auth.requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    const tplRes = await loadTemplate();
    if (!tplRes.ok && tplRes.reason === store.BLOB_NOT_CONFIGURED) {
      // Still return the defaults so the form renders and Omar can see the shape
      // of what he will be editing once storage exists.
      return res.status(200).json({ ok: true, template: tplRes.template,
        usedDefault: true, storageMissing: true });
    }
    if (!tplRes.ok) {
      // A genuine read failure (a real Blob API error, corrupted JSON,
      // network failure) -- NOT the legitimate "never saved yet" case above.
      // loadTemplate() still hands back a default template on this path, but
      // it must never be served as ok:true: the admin page would render it
      // as if it were Omar's real saved hours, and a Save from there would
      // silently overwrite them with defaults he never chose.
      return res.status(502).json({
        ok: false,
        errors: [`Failed to load the saved applicant hours (${tplRes.reason}). ` +
          'Do not save from this page until this is resolved -- the form has ' +
          'not loaded real data, and saving now would overwrite the real ' +
          'hours with defaults.'],
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
    const written = await store.writeJson(store.AVAILABILITY_BLOB, template);
    if (!written.ok) {
      const missing = written.reason === store.BLOB_NOT_CONFIGURED;
      return res.status(missing ? 503 : 502).json({
        ok: false,
        errors: [missing
          ? 'The Vercel Blob store does not exist yet, so hours cannot be saved. Create it in the Vercel dashboard (Storage -> Create Database -> Blob) and redeploy.'
          : written.reason],
      });
    }
    return res.status(200).json({ ok: true, template });
  }

  return res.status(405).end();
};
