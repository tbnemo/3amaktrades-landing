// Admin gate: one shared passcode plus an HMAC-signed session cookie. This
// manages one person's calendar, so a full user-account system would be
// scaffolding nobody needs.
const crypto = require('crypto');

const SESSION_COOKIE = 'amak_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ADMIN_SESSION_SECRET is optional: deriving it from GOOGLE_CLIENT_SECRET under a
// fixed label keeps the two keys separate while leaving ADMIN_PASSCODE as the
// only variable the user strictly has to set.
function sessionSecret() {
  if (process.env.ADMIN_SESSION_SECRET) return process.env.ADMIN_SESSION_SECRET;
  if (process.env.GOOGLE_CLIENT_SECRET) {
    return crypto.createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET)
      .update('amak-admin-session-v1').digest('hex');
  }
  return null;
}

function sign(value) {
  const secret = sessionSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

// Constant-time comparison so a wrong passcode leaks nothing through timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkPasscode(candidate) {
  const expected = process.env.ADMIN_PASSCODE;
  if (!expected) return false;                 // fail closed, never open
  if (typeof candidate !== 'string' || !candidate) return false;
  return safeEqual(candidate, expected);
}

function issueSessionCookie(ttlMs = SESSION_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs }), 'utf8')
    .toString('base64url');
  const sig = sign(payload);
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  return `${SESSION_COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function verifySession(req) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot), sig = raw.slice(dot + 1);
  const expected = sign(payload);
  if (!expected || !safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch (e) {
    return false;
  }
}

function requireAdmin(req, res) {
  if (verifySession(req)) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// Signed, short-lived state on the OAuth round-trip so the callback cannot be
// driven by a link someone else crafted.
function signState() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 10 * 60 * 1000, n: crypto.randomBytes(8).toString('hex'),
  }), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyState(state) {
  if (typeof state !== 'string' || !state) return false;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = state.slice(0, dot), sig = state.slice(dot + 1);
  const expected = sign(payload);
  if (!expected || !safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch (e) {
    return false;
  }
}

module.exports = {
  SESSION_COOKIE, sessionSecret, checkPasscode, issueSessionCookie,
  clearSessionCookie, verifySession, requireAdmin, signState, verifyState,
};
