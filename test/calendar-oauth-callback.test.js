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
