const store = require('./_blob-store');
const av = require('./_availability');

// A missing blob is not an error: it is a deployment that has never saved hours.
// Serving the normalized default keeps the widget functional on day one.
async function loadTemplate() {
  const read = await store.readJson(store.AVAILABILITY_BLOB);
  if (!read.ok) {
    return {
      ok: false, reason: read.reason,
      template: av.normalizeTemplate(av.DEFAULT_TEMPLATE),
    };
  }
  return {
    ok: true,
    template: av.normalizeTemplate(read.data || av.DEFAULT_TEMPLATE),
    usedDefault: !read.data,
  };
}

module.exports = { loadTemplate };
