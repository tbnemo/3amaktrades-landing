// The Hobby plan allows 12 Serverless Functions per deployment, and every .js
// file under api/ that is not `_`-prefixed becomes one. The api/ directory grew
// to 19, so every deployment silently failed to build with
// `exceeded_serverless_functions_per_deployment` and the site served stale code
// for several commits.
//
// The fix consolidated several endpoints into shared files and preserved their
// original public paths with `rewrites` in vercel.json. That makes two new
// things load-bearing, and both are asserted here:
//
//   1. The FUNCTION COUNT itself. This is the test that would have caught the
//      incident, so it is the first one.
//   2. The correspondence between each rewrite in vercel.json and the dispatch
//      table in the file it points at. A rewrite whose segment no handler
//      answers is a dead public endpoint, and neither `npm test` on the handlers
//      nor the Vercel build would flag it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requestPathSegment, resolveAction, notFound } = require('../api/_route-action');

const REPO = path.join(__dirname, '..');
const API = path.join(REPO, 'api');

// Every .js file under api/ that is not `_`-prefixed, at any depth -- which is
// what Vercel counts, and is deliberately NOT depth-limited: burying a handler
// one directory deeper hides it from a `-maxdepth 2` count but not from the cap.
function functionFiles(dir = API, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...functionFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.js') && !entry.name.startsWith('_')) {
      out.push(rel);
    }
  }
  return out;
}

const HOBBY_FUNCTION_CAP = 12;

test('api/ stays within the Hobby plan Serverless Function cap', () => {
  const files = functionFiles();
  assert.ok(files.length <= HOBBY_FUNCTION_CAP,
    `api/ has ${files.length} function-producing files (${files.sort().join(', ')}), but the `
    + `Hobby plan allows at most ${HOBBY_FUNCTION_CAP} per deployment. Exceeding it fails the `
    + 'build with exceeded_serverless_functions_per_deployment and the site keeps serving the '
    + 'last deployment that did build -- silently. Consolidate an endpoint rather than raising '
    + 'this number.');
});

// ---------------------------------------------------------------------------
// requestPathSegment
// ---------------------------------------------------------------------------

test('requestPathSegment reads the last path segment, ignoring query and fragment', () => {
  assert.equal(requestPathSegment({ url: '/api/calendar-checkin-book' }), 'calendar-checkin-book');
  assert.equal(requestPathSegment({ url: '/api/calendar-checkin-availability?date=2026-01-01&days=3' }),
    'calendar-checkin-availability');
  assert.equal(requestPathSegment({ url: '/api/admin/checkin-clients?email=a@b.c' }), 'checkin-clients');
  assert.equal(requestPathSegment({ url: '/api/wa-click#frag' }), 'wa-click');
  assert.equal(requestPathSegment({ url: '/api/admin/login/' }), 'login');
});

test('requestPathSegment is safe on a request with no url at all', () => {
  assert.equal(requestPathSegment({}), '');
  assert.equal(requestPathSegment(undefined), '');
  assert.equal(requestPathSegment({ url: null }), '');
});

// ---------------------------------------------------------------------------
// resolveAction
// ---------------------------------------------------------------------------

const MAP = { 'checkin-verify': 'verify', 'calendar-checkin-book': 'book' };

test('resolves from the request path -- the reading where a rewrite leaves req.url alone', () => {
  assert.equal(resolveAction({ url: '/api/checkin-verify' }, MAP), 'verify');
  assert.equal(resolveAction({ url: '/api/calendar-checkin-book' }, MAP), 'book');
});

test('resolves from the rewrite\'s :action parameter -- the reading where req.url is the destination', () => {
  // /api/calendar-checkin is the consolidated landing path: no handler claims it,
  // so the query parameter is the only signal left.
  assert.equal(
    resolveAction({ url: '/api/calendar-checkin', query: { action: 'checkin-verify' } }, MAP),
    'verify');
  assert.equal(
    resolveAction({ url: '/api/calendar-checkin?date=x', query: { action: 'calendar-checkin-book', date: 'x' } }, MAP),
    'book');
});

test('the path wins over a conflicting ?action= parameter', () => {
  // Otherwise a direct request could talk its way into another endpoint's handler.
  assert.equal(
    resolveAction({ url: '/api/checkin-verify', query: { action: 'calendar-checkin-book' } }, MAP),
    'verify');
});

test('a repeated ?action= parameter arrives as an array and uses the first value', () => {
  assert.equal(
    resolveAction({ url: '/api/calendar-checkin', query: { action: ['checkin-verify', 'calendar-checkin-book'] } }, MAP),
    'verify');
});

test('an unknown endpoint resolves to null rather than to an arbitrary handler', () => {
  assert.equal(resolveAction({ url: '/api/calendar-checkin' }, MAP), null);
  assert.equal(resolveAction({ url: '/api/nope', query: { action: 'nope' } }, MAP), null);
  assert.equal(resolveAction({}, MAP), null);
});

test('inherited Object properties are not routes', () => {
  // A lookup that walked the prototype chain would turn `?action=constructor`
  // into a "match" that resolves to a function.
  for (const probe of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    assert.equal(resolveAction({ url: `/api/${probe}` }, MAP), null, `path ${probe}`);
    assert.equal(resolveAction({ url: '/api/calendar-checkin', query: { action: probe } }, MAP), null,
      `?action=${probe}`);
  }
});

test('notFound is a 404 that is never cached and describes nothing', () => {
  const res = {
    _status: null, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
  };
  notFound(res);
  assert.equal(res._status, 404);
  assert.deepEqual(res._json, { ok: false, error: 'NOT_FOUND' });
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

// ---------------------------------------------------------------------------
// vercel.json rewrites <-> dispatch tables
// ---------------------------------------------------------------------------

const vercelJson = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));

// destination path -> the module that serves it. Every consolidated file must
// appear here, and every rewrite must point at one of them.
const CONSOLIDATED = {
  '/api/calendar-checkin': require('../api/calendar-checkin'),
  '/api/admin/checkin': require('../api/admin/checkin'),
  '/api/admin/auth': require('../api/admin/auth'),
  '/api/submit': require('../api/submit'),
};

test('every rewrite points at a consolidated file whose dispatch table answers its segment', () => {
  assert.ok(Array.isArray(vercelJson.rewrites) && vercelJson.rewrites.length > 0);

  for (const rule of vercelJson.rewrites) {
    const mod = CONSOLIDATED[rule.destination];
    assert.ok(mod, `rewrite destination ${rule.destination} is not a known consolidated file`);

    // "/api/admin/:action(checkin-clients)" -> "checkin-clients"
    const m = /:action\(([^)]+)\)/.exec(rule.source);
    assert.ok(m, `rewrite source ${rule.source} must capture its segment as :action(...), so the `
      + 'segment survives as a query parameter under the reading of Vercel\'s docs where a '
      + 'rewritten request carries the destination path');
    const segment = m[1];

    // The source's literal path must end in the same segment, so BOTH signals
    // (req.url's path and the :action parameter) name the same endpoint.
    const literal = rule.source.replace(/:action\(([^)]+)\)/, '$1');
    assert.equal(literal.slice(literal.lastIndexOf('/') + 1), segment,
      `rewrite source ${rule.source} must end in the segment it captures`);

    assert.ok(Object.prototype.hasOwnProperty.call(mod.__routesForTests, segment),
      `nothing in ${rule.destination} answers '${segment}', so the public path ${literal} is dead`);
  }
});

test('no rewrite destination carries a query string', () => {
  // This is the invariant the whole dispatch design rests on. Vercel's docs do
  // not state whether a destination's query string MERGES with the request's own
  // or REPLACES it, and these endpoints depend on the caller's query surviving
  // (?date=/&days= on check-in availability, ?email= on the admin client
  // DELETE). A destination with no query string cannot disturb the request's.
  for (const rule of vercelJson.rewrites) {
    assert.equal(rule.destination.includes('?'), false,
      `rewrite to ${rule.destination} adds a query string; pass the endpoint in the PATH instead`);
  }
});

test('every public path the consolidated files used to serve still has a rewrite', () => {
  const covered = new Set(vercelJson.rewrites.map(
    r => r.source.replace(/:action\(([^)]+)\)/, '$1')));

  // The exact paths check-in.html/check-in.js, admin.html and index.html call.
  const required = [
    '/api/checkin-verify',
    '/api/calendar-checkin-availability',
    '/api/calendar-checkin-book',
    '/api/calendar-checkin-cancel',
    '/api/calendar-checkin-reschedule',
    '/api/admin/checkin-availability',
    '/api/admin/checkin-clients',
    '/api/admin/login',
    '/api/admin/status',
    '/api/wa-click',
  ];
  for (const p of required) {
    assert.ok(covered.has(p), `${p} lost its rewrite -- that public path is now a 404`);
  }
});

test('the consolidated files expose every original handler by name', () => {
  const checkin = require('../api/calendar-checkin');
  for (const name of ['verify', 'availability', 'book', 'cancel', 'reschedule']) {
    assert.equal(typeof checkin[name], 'function', `calendar-checkin.${name}`);
  }
  const adminCheckin = require('../api/admin/checkin');
  for (const name of ['availability', 'clients']) {
    assert.equal(typeof adminCheckin[name], 'function', `admin/checkin.${name}`);
  }
  const adminAuth = require('../api/admin/auth');
  for (const name of ['login', 'status']) {
    assert.equal(typeof adminAuth[name], 'function', `admin/auth.${name}`);
  }
  const submit = require('../api/submit');
  for (const name of ['submit', 'waClick']) {
    assert.equal(typeof submit[name], 'function', `submit.${name}`);
  }
});

test('a direct hit on a consolidated landing path is a 404, not a stray handler', async () => {
  function makeRes() {
    return {
      _status: null, _json: null, _headers: {},
      status(c) { this._status = c; return this; },
      json(p) { this._json = p; return this; },
      setHeader(k, v) { this._headers[k] = v; return this; },
      end() { this._ended = true; return this; },
    };
  }
  for (const url of ['/api/calendar-checkin', '/api/admin/checkin', '/api/admin/auth']) {
    const res = makeRes();
    await CONSOLIDATED[url]({ method: 'GET', url, query: {} }, res);
    assert.equal(res._status, 404, `${url} must not fall through to a handler`);
  }
});

test('/api/submit is served directly and is NOT routed through a rewrite', () => {
  // The lead-capture path must gain no routing indirection from this change, so
  // it stays a plain filesystem hit. Only /api/wa-click is rewritten onto it.
  const sources = vercelJson.rewrites.map(
    r => r.source.replace(/:action\(([^)]+)\)/, '$1'));
  assert.equal(sources.includes('/api/submit'), false);
  assert.ok(sources.includes('/api/wa-click'));
});

test('an unrouted request to api/submit runs the submit handler, not wa-click', async () => {
  const submit = require('../api/submit');
  // 'submit' is deliberately absent from its dispatch table: the submit handler
  // is the default, so a direct POST /api/submit behaves exactly as before.
  assert.equal(Object.prototype.hasOwnProperty.call(submit.__routesForTests, 'submit'), false);
  assert.equal(resolveAction({ url: '/api/submit' }, submit.__routesForTests), null);
  assert.equal(resolveAction({ url: '/api/wa-click' }, submit.__routesForTests),
    submit.__routesForTests['wa-click']);
});

test('the OAuth pair was left alone: its locked Google redirect path is still its own file', () => {
  // /api/calendar-oauth-callback is registered as the redirect URI on the Google
  // Cloud OAuth client. It is deliberately NOT consolidated and NOT rewritten,
  // so Google's redirect lands on exactly the file it always did.
  assert.ok(fs.existsSync(path.join(API, 'calendar-oauth-callback.js')));
  assert.ok(fs.existsSync(path.join(API, 'calendar-oauth-start.js')));
  for (const rule of vercelJson.rewrites) {
    assert.equal(rule.source.includes('oauth'), false,
      'the OAuth callback path must never be rewritten');
    assert.equal(rule.destination.includes('oauth'), false);
  }
});
