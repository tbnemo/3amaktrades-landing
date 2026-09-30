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

// Every file under api/ that is not `_`-prefixed, at any depth.
//
// Deliberately NOT depth-limited: burying a handler one directory deeper hides
// it from a `-maxdepth 2` count but not from the cap.
//
// Deliberately NOT limited to `.js` either. Vercel builds a function from any
// file under api/ whose extension maps to a supported runtime -- .mjs, .cjs,
// .ts, .py, .go, .rb among them -- so a predicate keyed on `.js` would let a
// future api/foo.ts reproduce this exact incident while the guard stayed green.
// api/ holds nothing but handlers and `_`-prefixed helpers, so "any file that is
// not `_`-prefixed" is the honest predicate. If that ever over-counts (someone
// drops an api/README.md in here), it fails loudly and obviously, which is the
// right direction for this particular guard to err in.
function functionFiles(dir = API, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...functionFiles(path.join(dir, entry.name), rel));
    } else if (!entry.name.startsWith('_')) {
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

// The ONE path allowed to carry its endpoint in the destination query string,
// and the reason it is allowed: /api/wa-click's only caller is
// navigator.sendBeacon('/api/wa-click', <JSON blob>) in index.html, which sends
// NO query string of its own. With nothing of the caller's to merge with or
// replace, a destination query string cannot destroy anything, so that form is
// correct under EVERY reading of Vercel's behaviour rather than only the two the
// path-encoded form relies on -- and it is the form that matters there, because
// /api/submit is not rewritten and the parameter is the only thing separating a
// rewritten wa-click from a direct submit.
//
// Every other endpoint has a caller that DOES send a query string
// (?date=/&days= on check-in availability, ?email= on the admin client DELETE),
// so those rules must stay query-string-free.
const CALLERS_SEND_NO_QUERY = new Set(['/api/wa-click']);

// The literal public path a rule serves, and the endpoint segment it conveys --
// from the source's :action(...) capture, or from the destination's ?action=.
function ruleParts(rule) {
  const literal = rule.source.replace(/:action\(([^)]+)\)/, '$1');
  const fromSource = /:action\(([^)]+)\)/.exec(rule.source);
  const fromDest = /[?&]action=([^&]+)/.exec(rule.destination);
  return {
    literal,
    destinationPath: rule.destination.split('?')[0],
    segment: fromSource ? fromSource[1] : (fromDest ? fromDest[1] : null),
    carriesQuery: rule.destination.includes('?'),
  };
}

test('every rewrite points at a consolidated file whose dispatch table answers its segment', () => {
  assert.ok(Array.isArray(vercelJson.rewrites) && vercelJson.rewrites.length > 0);

  for (const rule of vercelJson.rewrites) {
    const { literal, destinationPath, segment } = ruleParts(rule);

    const mod = CONSOLIDATED[destinationPath];
    assert.ok(mod, `rewrite destination ${destinationPath} is not a known consolidated file`);

    assert.ok(segment, `rewrite source ${rule.source} conveys no endpoint: it must either capture `
      + 'its segment as :action(...) or carry ?action= in its destination, or the request arrives '
      + 'with no way to tell which handler it wanted');

    // The source's literal path must end in the same segment, so BOTH signals
    // (req.url's path and the action parameter) name the same endpoint.
    assert.equal(literal.slice(literal.lastIndexOf('/') + 1), segment,
      `rewrite source ${rule.source} must end in the segment it conveys (${segment})`);

    assert.ok(Object.prototype.hasOwnProperty.call(mod.__routesForTests, segment),
      `nothing in ${destinationPath} answers '${segment}', so the public path ${literal} is dead`);
  }
});

test('only a rewrite whose caller sends no query string may carry one in its destination', () => {
  // Vercel's docs do not state whether a destination's query string MERGES with
  // the request's own or REPLACES it. Where the caller sends a query string of
  // its own, a destination query string could therefore destroy it, so the
  // endpoint goes in the path instead. Where the caller sends none, there is
  // nothing to lose and the parameter is the stronger signal.
  for (const rule of vercelJson.rewrites) {
    const { literal, carriesQuery, segment } = ruleParts(rule);
    if (!carriesQuery) continue;
    assert.ok(CALLERS_SEND_NO_QUERY.has(literal),
      `rewrite to ${rule.destination} adds a query string, but ${literal}'s caller sends its own `
      + 'query string, which the destination could replace. Convey the endpoint in the PATH '
      + 'instead, or add this path to CALLERS_SEND_NO_QUERY only after confirming every caller '
      + 'sends no query string.');
    assert.equal(rule.destination.split('?')[1], `action=${segment}`,
      `${rule.destination} must carry exactly action=<segment> and nothing else`);
  }
});

test('/api/wa-click conveys its endpoint in a way that survives every reading of the docs', () => {
  // The one dispatch that cannot fall back on a 404 if it resolves wrong -- it
  // would fall into submitHandler and post a malformed New Application -- so it
  // is the one that gets the belt-and-braces form.
  const rule = vercelJson.rewrites.find(r => ruleParts(r).literal === '/api/wa-click');
  assert.ok(rule, '/api/wa-click must still have a rewrite');
  assert.equal(rule.source, '/api/wa-click');
  assert.equal(rule.destination, '/api/submit?action=wa-click');

  const submit = require('../api/submit');
  // Reading 1: req.url is the original path (query preserved or not -- the path
  // alone decides).
  assert.equal(resolveAction({ url: '/api/wa-click' }, submit.__routesForTests),
    submit.__routesForTests['wa-click']);
  // Readings 2-4: req.url is the destination path, and because the caller sent
  // no query string, ?action=wa-click is present whether the destination query
  // merged with an empty one or replaced it.
  assert.equal(
    resolveAction({ url: '/api/submit?action=wa-click', query: { action: 'wa-click' } },
      submit.__routesForTests),
    submit.__routesForTests['wa-click']);
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
