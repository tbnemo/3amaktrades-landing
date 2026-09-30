// Shared dispatch helper for the CONSOLIDATED api files.
//
// WHY THIS EXISTS: the Hobby plan caps a deployment at 12 Serverless Functions,
// and every .js file under api/ that is not `_`-prefixed becomes one. Several
// endpoints that used to be a file each now share one file, and their ORIGINAL
// public paths are preserved by `rewrites` in vercel.json. This resolves which
// of those endpoints a given request was actually aimed at.
//
// WHY IT READS TWO SIGNALS: Vercel's docs do not state in one place exactly what
// a rewritten request looks like from inside the function. Two things ARE
// documented, and this helper is correct if EITHER of them holds:
//
//   1. `req.url` is the path the runtime observes, and a rewrite does not change
//      it -- only an explicit `request.path` transform does ("The `request.path`
//      transform overrides the path that the target runtime observes for a
//      request. This is the URL path your Function reads from `req.url`."
//      -- /docs/project-configuration/vercel-json). Then the original path
//      segment is sitting right there in req.url.
//   2. "With `rewrites`, named parameters pass through in the query string"
//      (same page). Every rewrite feeding these files names its matched segment
//      `:action`, so the segment arrives as req.query.action.
//
// The PATH is checked first, so a direct request can never talk its way into a
// different endpoint's handler by hand-writing an ?action= parameter.
//
// NOTE, and this is the load-bearing part: no rewrite feeding these files puts a
// literal query string in its `destination`. That is deliberate. The docs do not
// say whether a destination's own query string MERGES with the request's query
// string or REPLACES it, and several of these endpoints depend on the caller's
// query surviving (?date=/&days= on check-in availability, ?email= on the admin
// client DELETE). A destination carrying no query string cannot disturb the
// request's own, so the question never arises.

// The last path segment of the request, with any query/fragment and trailing
// slashes stripped. '/api/calendar-checkin-book?x=1' -> 'calendar-checkin-book'.
function requestPathSegment(req) {
  const raw = String((req && req.url) || '');
  const path = raw.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

// `segmentMap` maps an ORIGINAL public path segment -> a handler key. The same
// map serves both signals, because each rewrite's `:action` parameter captures
// exactly that original segment.
//
// Returns the handler key, or null when the request matched no known endpoint
// (a direct hit on the consolidated file's own landing path, for instance).
function resolveAction(req, segmentMap) {
  const seg = requestPathSegment(req);
  if (Object.prototype.hasOwnProperty.call(segmentMap, seg)) return segmentMap[seg];

  const raw = req && req.query && req.query.action;
  // A repeated query parameter arrives as an array on Vercel.
  const name = Array.isArray(raw) ? raw[0] : raw;
  const key = name == null ? '' : String(name);
  if (Object.prototype.hasOwnProperty.call(segmentMap, key)) return segmentMap[key];

  return null;
}

// The reply for a request that resolved to no known endpoint. Deliberately says
// nothing about what the file does hold, and is never cached.
function notFound(res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
}

module.exports = { requestPathSegment, resolveAction, notFound };
