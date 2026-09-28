const auth = require('../_admin-auth');
const store = require('../_blob-store');
const gcal = require('../_google-calendar');

module.exports = async function handler(req, res) {
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
};
