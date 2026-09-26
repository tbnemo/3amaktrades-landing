// Shared HTML escaping for any endpoint that renders a page. Deliberately a
// module rather than a per-file copy: two divergent escapers in one codebase is
// how one of them later gets fixed and the other does not.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
