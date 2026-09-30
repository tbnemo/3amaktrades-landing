const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'check-in.html'), 'utf8');
// The page's own logic now lives in check-in.js (extracted so its pure
// helpers are unit-testable -- see test/check-in.test.js). Assertions below
// that check JS CONTENT (endpoint strings, error branches, message copy)
// read this instead of check-in.html; assertions checking actual HTML
// markup/CSS keep reading `html`.
const js = fs.readFileSync(path.join(__dirname, '..', 'check-in.js'), 'utf8');

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

test('the page loads its logic from check-in.js, at the same spot the inline script used to sit', () => {
  assert.match(html, /<script src="check-in\.js"><\/script>\s*<\/body>/,
    'check-in.js must be loaded right before </body>, where the inline script used to run');
});

test('check-in.js calls exactly the three check-in endpoints and no applicant one', () => {
  for (const url of ['/api/checkin-verify', '/api/calendar-checkin-availability', '/api/calendar-checkin-book']) {
    assert.ok(js.includes(url), `check-in.js must call ${url}`);
  }
  for (const url of ['/api/calendar-book', '/api/calendar-availability', '/api/admin/']) {
    assert.equal(js.includes(url), false, `check-in.js must not call ${url}`);
  }
  // No shared widget code, per the explicit decision in the spec.
  assert.equal(js.includes('booking-widget.js'), false);
  assert.equal(js.includes('BookingWidget'), false);
  // And check-in.html itself no longer inlines any of this -- it only
  // references the external file.
  assert.equal(html.includes('/api/checkin-verify'), false);
  assert.equal(html.includes('booking-widget.js'), false);
  assert.equal(html.includes('BookingWidget'), false);
});

// The generic message is a decision, not a placeholder: it must not hint at
// whether the identifier was unknown or something else failed.
test('the failed-verification copy is the exact generic message from the spec', () => {
  assert.ok(js.includes("We couldn't verify that email or phone. If you're a current client, contact Omar directly."),
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
  assert.match(js, /409/, 'the confirm handler must branch on 409');
  assert.match(js, /SLOT_TAKEN/);
});

test('an expired verification (403 NOT_VERIFIED) sends the visitor back to the verify step', () => {
  assert.match(js, /NOT_VERIFIED/);
});

// Narrow, explicitly-authorized exception to the check-in.js do-not-touch
// rule: without this, an expired/paused client's verify/book response
// collapses into the same generic message as a total stranger, even though
// verifyHandler and bookHandler (api/calendar-checkin.js) both send back a
// SPECIFIC, safe-to-show ACCESS_INACTIVE message precisely so a real
// client's support follow-up says "my access lapsed," not "my email isn't
// working." Safe to show here for the same reason it's safe server-side:
// reaching either response already required a successful roster/token
// match, so it reveals nothing to someone who hasn't already proven they're
// a real client.
test('a verify response carrying ACCESS_INACTIVE shows its own specific message, not the generic one', () => {
  const idx = js.indexOf("fetch('/api/checkin-verify'");
  assert.ok(idx !== -1, "the verify handler's fetch call was not found");
  const window = js.slice(idx, idx + 2500);

  const accessIdx = window.search(/error\s*===\s*['"]ACCESS_INACTIVE['"]/);
  assert.ok(accessIdx !== -1, 'the verify response handler must branch on error === "ACCESS_INACTIVE"');

  // The branch must come BEFORE the generic fallback -- an earlier return
  // there would shadow it.
  const genericIdx = window.search(/showVerifyError\(GENERIC_FAIL\)/);
  assert.ok(genericIdx !== -1 && accessIdx < genericIdx,
    'the ACCESS_INACTIVE branch must be checked before the generic GENERIC_FAIL fallback');
});

test('a book-time 403 carrying ACCESS_INACTIVE shows its own specific message instead of the generic NOT_VERIFIED handling', () => {
  const idx = js.indexOf("fetch('/api/calendar-checkin-book'");
  assert.ok(idx !== -1, "the book handler's fetch call was not found");
  const window = js.slice(idx, idx + 2500);

  const accessIdx = window.search(/error\s*===\s*['"]ACCESS_INACTIVE['"]/);
  assert.ok(accessIdx !== -1, 'the book response handler must branch on error === "ACCESS_INACTIVE"');

  // Must be checked BEFORE the existing 403/NOT_VERIFIED branch, which
  // matches by STATUS CODE alone (ACCESS_INACTIVE is also a 403) and would
  // otherwise shadow it with the generic "verify again" handling.
  const statusOnlyIdx = window.search(/res\.status\s*===\s*403/);
  assert.ok(statusOnlyIdx !== -1 && accessIdx < statusOnlyIdx,
    'ACCESS_INACTIVE must be checked before the status-code-only 403/NOT_VERIFIED branch');
});

test('the verify token is held in a JS variable, never written to storage', () => {
  assert.equal(/localStorage/.test(js), false, 'a verify token must not be persisted');
  assert.equal(/sessionStorage/.test(js), false);
  assert.equal(/document\.cookie/.test(js), false);
});

test('the booking POST sends the verifyToken, the start instant, the visitor zone and lang', () => {
  const idx = js.indexOf('/api/calendar-checkin-book');
  assert.ok(idx !== -1);
  const window = js.slice(idx, idx + 600);
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

test('a 502 from checkin-verify shows its own message, distinct from the generic non-match copy', () => {
  const idx = js.indexOf("res.status === 502");
  assert.ok(idx !== -1, 'the verify submit handler must branch on 502');
  const window = js.slice(idx, idx + 300);
  assert.match(window, /Something went wrong checking that/,
    'a 502 (infra failure) must not collapse into the generic "could not verify" message');
});

test('the inline error containers announce themselves to screen readers', () => {
  for (const id of ['verifyError', 'pickerError']) {
    const el = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`));
    assert.ok(el, `${id} element not found`);
    assert.match(el[0], /aria-live="polite"/, `#${id} must carry aria-live="polite"`);
  }
});

test('slot times are only ever FORMATTED from the absolute ISO instants the server sends', () => {
  // No manual offset arithmetic on instants: the server sends absolute ISO and
  // Intl does the zone work, which is the site-wide rule.
  assert.match(js, /Intl\.DateTimeFormat/);
  assert.equal(/getTimezoneOffset/.test(js), false,
    'manual offset math on a slot instant is exactly the bug this rule prevents');
});
