// Google Calendar via raw REST. The googleapis SDK is a very large dependency
// for the six calls this system makes.
//
// Every function returns {ok, ...} and never throws: a Google outage must show
// the visitor "couldn't load times" rather than a 500 stack trace.
const nodeFetch = require('node-fetch');
const store = require('./_blob-store');
const { baseUrl } = require('./_site-url');

const NOT_CONNECTED = 'CALENDAR_NOT_CONNECTED';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

let doFetch = (...args) => nodeFetch(...args);
function __setFetchForTests(fn) { doFetch = fn; }

// Cached access token. Keyed on the refresh token's own VALUE, not merely an
// expiry: if Omar reconnects (or switches Google accounts) the stored refresh
// token changes, and an expiry-only cache would keep serving a token minted for
// the previous account until it timed out.
let tokenCache = { refreshToken: null, accessToken: null, expiresAtMs: 0 };
function __resetTokenCacheForTests() {
  tokenCache = { refreshToken: null, accessToken: null, expiresAtMs: 0 };
}

function calendarId() { return process.env.GOOGLE_CALENDAR_ID || 'primary'; }

// LOCKED to the URI registered on the Google Cloud OAuth client. Renaming the
// endpoint file -- or letting baseUrl() resolve to a per-deployment hostname --
// breaks the consent round-trip with redirect_uri_mismatch.
function redirectUri() { return `${baseUrl()}/api/calendar-oauth-callback`; }

function consentUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',   // without this, a reconnect returns no refresh token
    include_granted_scopes: 'true',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function readErr(res) {
  try { return (await res.text()).slice(0, 300); }
  catch (e) { return `HTTP ${res.status}`; }
}

async function exchangeCodeForTokens(code) {
  try {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!res.ok) return { ok: false, reason: await readErr(res) };
    const data = await res.json();
    if (!data.refresh_token) {
      return { ok: false, reason: 'Google returned no refresh_token (re-consent required)' };
    }
    return { ok: true, refreshToken: data.refresh_token };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function saveRefreshToken(refreshToken) {
  const res = await store.writeJson(store.OAUTH_BLOB, {
    refreshToken, savedAt: new Date().toISOString(),
  });
  __resetTokenCacheForTests(); // a new token invalidates anything cached
  return res;
}

async function loadRefreshToken() {
  const read = await store.readJson(store.OAUTH_BLOB);
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.data || !read.data.refreshToken) return { ok: false, reason: NOT_CONNECTED };
  return { ok: true, refreshToken: read.data.refreshToken };
}

async function isConnected() {
  const r = await loadRefreshToken();
  return r.ok;
}

async function getAccessToken() {
  const rt = await loadRefreshToken();
  if (!rt.ok) return { ok: false, reason: rt.reason };

  const fresh = tokenCache.accessToken
    && tokenCache.refreshToken === rt.refreshToken
    && Date.now() < tokenCache.expiresAtMs - 60_000; // 60s safety margin
  if (fresh) return { ok: true, accessToken: tokenCache.accessToken };

  try {
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: rt.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) return { ok: false, reason: await readErr(res) };
    const data = await res.json();
    if (!data.access_token) return { ok: false, reason: 'no access_token in response' };
    tokenCache = {
      refreshToken: rt.refreshToken,
      accessToken: data.access_token,
      expiresAtMs: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return { ok: true, accessToken: data.access_token };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function authed(path, { method = 'GET', body = null, query = null } = {}) {
  const tok = await getAccessToken();
  if (!tok.ok) return { ok: false, reason: tok.reason };
  const url = new URL(`${CAL_BASE}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
  }
  try {
    const res = await doFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${tok.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return { ok: false, reason: await readErr(res), status: res.status };
    if (res.status === 204) return { ok: true, data: null };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

async function freeBusy(timeMinIso, timeMaxIso) {
  const res = await authed('/freeBusy', {
    method: 'POST',
    body: { timeMin: timeMinIso, timeMax: timeMaxIso, timeZone: 'UTC',
            items: [{ id: calendarId() }] },
  });
  if (!res.ok) return res;
  const cal = res.data && res.data.calendars && res.data.calendars[calendarId()];
  const raw = (cal && cal.busy) || [];
  return {
    ok: true,
    busy: raw.map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
            .filter(b => Number.isFinite(b.start) && Number.isFinite(b.end)),
  };
}

async function listEvents({ timeMinIso, timeMaxIso, privateExtendedProperty = null }) {
  const res = await authed(`/calendars/${encodeURIComponent(calendarId())}/events`, {
    query: {
      timeMin: timeMinIso, timeMax: timeMaxIso,
      singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false',
      maxResults: 250,
      privateExtendedProperty: privateExtendedProperty || undefined,
    },
  });
  if (!res.ok) return res;
  return { ok: true, events: (res.data && res.data.items) || [] };
}

// R7: ask for a Google Meet link, but never let conferencing failure cost a
// booking -- some calendars reject conference creation outright.
async function insertEvent(event) {
  const path = `/calendars/${encodeURIComponent(calendarId())}/events`;
  const first = await authed(path, {
    method: 'POST', body: event,
    query: { conferenceDataVersion: event.conferenceData ? 1 : 0, sendUpdates: 'none' },
  });
  if (first.ok) return { ok: true, event: first.data };
  if (event.conferenceData && /conference/i.test(first.reason || '')) {
    const { conferenceData, ...withoutConference } = event;
    const retry = await authed(path, {
      method: 'POST', body: withoutConference,
      query: { conferenceDataVersion: 0, sendUpdates: 'none' },
    });
    if (retry.ok) return { ok: true, event: retry.data };
    return { ok: false, reason: retry.reason };
  }
  return { ok: false, reason: first.reason };
}

// A Meet link arrives EITHER as the top-level hangoutLink or only inside
// conferenceData.entryPoints, depending on how the event was created. Reading
// just one of the two silently drops the join link out of an email, so all three
// senders resolve it through here rather than each keeping their own guess.
function meetLinkFor(event) {
  if (!event) return '';
  if (event.hangoutLink) return event.hangoutLink;
  const points = (event.conferenceData && event.conferenceData.entryPoints) || [];
  const video = points.find(p => p && p.entryPointType === 'video');
  return (video && video.uri) || '';
}

async function getEvent(eventId) {
  const res = await authed(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`);
  if (!res.ok) return res;
  return { ok: true, event: res.data };
}

async function patchEvent(eventId, patch) {
  const res = await authed(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: patch, query: { sendUpdates: 'none' } });
  if (!res.ok) return res;
  return { ok: true, event: res.data };
}

async function deleteEvent(eventId) {
  const res = await authed(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', query: { sendUpdates: 'none' } });
  // A 410/404 means it is already gone, which is the state we wanted.
  if (!res.ok && !/410|404/.test(String(res.status))) return res;
  return { ok: true };
}

module.exports = {
  NOT_CONNECTED, SCOPE, consentUrl, redirectUri, calendarId, baseUrl,
  exchangeCodeForTokens, saveRefreshToken, isConnected, getAccessToken,
  freeBusy, listEvents, getEvent, insertEvent, patchEvent, deleteEvent, meetLinkFor,
  __resetTokenCacheForTests, __setFetchForTests,
};
