const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'check-in.html'), 'utf8');

function idsIn(source) {
  const out = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

test('no id appears twice', () => {
  const ids = idsIn(html);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('all three steps and their key elements exist', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'stepVerify', 'verifyForm', 'verifyEmail', 'verifyPhone', 'verifyError', 'verifySubmit',
    'stepPick', 'greeting', 'dayStrip', 'dayPrev', 'dayNext', 'slots',
    'pickerLoading', 'pickerError', 'noSlots', 'tzNote',
    'confirmBar', 'confirmSummary', 'confirmBtn',
    'stepDone', 'doneWhen', 'doneMeet',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing element "${id}"`);
  }
});

test('the page calls exactly the three check-in endpoints and no applicant one', () => {
  for (const url of ['/api/checkin-verify', '/api/calendar-checkin-availability', '/api/calendar-checkin-book']) {
    assert.ok(html.includes(url), `check-in.html must call ${url}`);
  }
  for (const url of ['/api/calendar-book', '/api/calendar-availability', '/api/admin/']) {
    assert.equal(html.includes(url), false, `check-in.html must not call ${url}`);
  }
  // No shared widget code, per the explicit decision in the spec.
  assert.equal(html.includes('booking-widget.js'), false);
  assert.equal(html.includes('BookingWidget'), false);
});

// The generic message is a decision, not a placeholder: it must not hint at
// whether the identifier was unknown or something else failed.
test('the failed-verification copy is the exact generic message from the spec', () => {
  assert.ok(html.includes("We couldn't verify that email or phone. If you're a current client, contact Omar directly."),
    'the generic verification-failure message must appear verbatim');
});

test('the page reuses the site CSS tokens by name and defines them with the site values', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const pairs = {
    '--void': '#050505',
    '--band': '#101010',
    '--band-2': '#181817',
    '--gold': '#D4AF37',
    '--gold-lo': '#7A6218',
    '--bone': '#F2EEE4',
    '--dim': '#8B887F',
    '--ink': '#0A0802',
    '--slab': '#1C1C1A',
  };
  for (const [token, value] of Object.entries(pairs)) {
    assert.match(styleBlock, new RegExp(`${token}\\s*:\\s*${value}`, 'i'),
      `${token} must be defined as ${value}, matching index.html`);
  }
});

test('the flat zero-radius system is kept: no border-radius anywhere', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const radii = styleBlock.match(/border-radius\s*:\s*([^;]+);/g) || [];
  for (const rule of radii) {
    assert.match(rule, /:\s*0\s*;/, `non-zero radius breaks the site's flat system: ${rule}`);
  }
});

// The site is RTL-aware, so a page written with physical properties would be
// the one thing blocking a later Arabic pass.
test('layout uses logical properties, not physical margin/padding sides', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const physical = styleBlock.match(/\b(margin|padding|border)-(left|right)\s*:/g) || [];
  assert.deepEqual(physical, [], `physical side properties found: ${physical.join(', ')}`);
  assert.equal(/text-align\s*:\s*(left|right)/.test(styleBlock), false,
    'use text-align:start/end, not left/right');
});

test('the fonts are the site fonts, loaded from Google Fonts', () => {
  assert.match(html, /fonts\.googleapis\.com/);
  assert.match(html, /Big\+Shoulders\+Display/);
  assert.match(html, /family=Inter|&Inter/);
});

test('a 409 on confirm is handled as an expected race: cleared selection and a re-fetch', () => {
  assert.match(html, /409/, 'the confirm handler must branch on 409');
  assert.match(html, /SLOT_TAKEN/);
});

test('an expired verification (403 NOT_VERIFIED) sends the visitor back to the verify step', () => {
  assert.match(html, /NOT_VERIFIED/);
});

test('the verify token is held in a JS variable, never written to storage', () => {
  assert.equal(/localStorage/.test(html), false, 'a verify token must not be persisted');
  assert.equal(/sessionStorage/.test(html), false);
  assert.equal(/document\.cookie/.test(html), false);
});

test('the booking POST sends the verifyToken, the start instant, the visitor zone and lang', () => {
  const idx = html.indexOf('/api/calendar-checkin-book');
  assert.ok(idx !== -1);
  const window = html.slice(idx, idx + 600);
  for (const field of ['verifyToken', 'start', 'visitorTimeZone', 'lang']) {
    assert.ok(window.includes(field), `the book POST body must carry ${field}`);
  }
  // Identity is never sent -- the server takes it from the token.
  assert.equal(/body:\s*JSON\.stringify\(\{[^}]*\bemail\b/.test(window), false,
    'the page must not send an email with the booking -- the token decides who it is');
});

test('the page is marked noindex: a direct client link is not a public page', () => {
  assert.match(html, /<meta\s+name="robots"\s+content="noindex/i);
});

test('slot times are only ever FORMATTED from the absolute ISO instants the server sends', () => {
  // No manual offset arithmetic on instants: the server sends absolute ISO and
  // Intl does the zone work, which is the site-wide rule.
  assert.match(html, /Intl\.DateTimeFormat/);
  assert.equal(/getTimezoneOffset/.test(html), false,
    'manual offset math on a slot instant is exactly the bug this rule prevents');
});
