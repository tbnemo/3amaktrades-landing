// The one place that decides what public origin this deployment answers on.
//
// This lived as an identical copy in both _google-calendar.js and _email.js,
// which is the worst possible pair to let diverge: one copy builds the OAuth
// redirect URI (which must byte-match Google Cloud) and the other builds the
// links inside every transactional email.
//
// VERCEL_URL is the per-DEPLOYMENT hostname and changes every deploy, so it can
// never match the single redirect URI registered in Google Cloud. Prefer the
// stable production domain; VERCEL_URL is a last resort for local/preview work.
function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://3amaktrades.com';
}

module.exports = { baseUrl };
