const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml } = require('../api/_html');
const callback = require('../api/calendar-oauth-callback');

function makeRes() {
  return {
    _status: null, _body: null, _headers: {},
    status(c) { this._status = c; return this; },
    send(b) { this._body = b; return this; },
    json(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    end() { return this; },
    writeHead(c, h) { this._status = c; Object.assign(this._headers, h); return this; },
  };
}

test('escapeHtml neutralizes angle brackets', () => {
  const out = escapeHtml('<script>alert(1)</script>');
  assert.equal(out.includes('<'), false);
  assert.equal(out.includes('>'), false);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&lt;\/script&gt;/);
});

test('escapeHtml handles null, undefined, numbers, and &/"/\' characters', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(`&"'`), '&amp;&quot;&#39;');
});

// This is the test that actually proves the reflected-XSS finding is closed:
// a bare unauthenticated GET with a hostile `error` value must not come back
// with that value reflected into the page, either raw or through the tag.
test('callback does not reflect a hostile error value into the rendered page', async () => {
  const res = makeRes();
  await callback(
    { method: 'GET', query: { error: '<script>alert(1)</script>' }, headers: {} },
    res,
  );
  assert.equal(res._status, 400);
  assert.equal(typeof res._body, 'string');
  assert.equal(res._body.includes('<script'), false);
  assert.equal(res._body.includes('alert(1)'), false);
  assert.equal(res._body.includes('</script>'), false);
});

// All five callers currently pass hardcoded literal titles, so this is
// behaviour-neutral today. It is asserted anyway because this is the exact file
// where a reflected-XSS was already found and fixed once: escaping inside the
// renderer makes the guarantee structural instead of depending on every future
// caller remembering. The title also lands in <title>, where a raw `</title>` would
// close the element early and let markup out.
test('page() cannot emit raw markup from a hostile title', () => {
  const page = callback.__pageForTests;
  assert.equal(typeof page, 'function', 'the renderer must be reachable for this test');

  const out = page('</title><script>alert(1)</script>', '<p>body</p>');
  assert.equal(out.includes('<script>'), false);
  assert.equal(out.includes('</script>'), false);
  assert.equal(out.includes('</title><'), false);
  assert.match(out, /&lt;script&gt;/);
  // The body is markup by contract and must still pass through untouched.
  assert.match(out, /<p>body<\/p>/);

  const quoted = page('" onload="alert(1)', '');
  assert.equal(quoted.includes('onload="alert(1)'), false);
  assert.match(quoted, /&quot;/);
});
