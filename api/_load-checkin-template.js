// The check-in audience's hours. Structurally identical to _load-template.js
// but bound to a DIFFERENT blob: check-in slot length, buffer, minimum notice
// and timezone are set independently of the new-applicant hours, because
// check-ins are very likely shorter and more frequent and there is no reason to
// couple the two.
//
// Returns the same {ok, template, usedDefault|reason} shape as loadTemplate(),
// so any reader can be pointed at either loader without reshaping its result.
const store = require('./_blob-store');
const av = require('./_availability');

// A missing blob is not an error: it is a deployment that has never saved
// check-in hours. Serving the normalized default keeps /check-in functional on
// day one, exactly as loadTemplate() does for the applicant widget. That the
// two share a FIRST-RUN default is incidental -- they diverge the moment either
// is saved.
async function loadCheckinTemplate() {
  const read = await store.readJson(store.CHECKIN_AVAILABILITY_BLOB);
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

module.exports = { loadCheckinTemplate };
