const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function idsIn(source) {
  const out = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

// The one failure mode of a two-form page built by duplicating a one-form page:
// a copied id, which makes document.getElementById silently return the wrong
// field and one form quietly edit the other's values.
test('no id appears twice in admin.html', () => {
  const ids = idsIn(html);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('the existing applicant ids are all still present and unrenamed', () => {
  const required = [
    'gate', 'gateForm', 'passcodeInput', 'gateError', 'app',
    'readinessPanel', 'blobConfigured', 'calendarConnected', 'resendConfigured',
    'redirectUri', 'blockersList',
    'connectPanel', 'connectSuccess', 'connectState', 'connectBtn',
    'availabilityPanel', 'storageMissingNote', 'availabilityForm',
    'daysRows', 'slotMinutes', 'bufferMinutes', 'minNoticeHours',
    'timezoneInput', 'tzList', 'tzNow', 'formErrors', 'formSuccess',
  ];
  const ids = new Set(idsIn(html));
  for (const id of required) {
    assert.ok(ids.has(id), `existing id "${id}" went missing`);
  }
});

test('the tab bar and both panels exist', () => {
  const ids = new Set(idsIn(html));
  for (const id of ['tabBar', 'tabApplicants', 'tabCheckins', 'panelApplicants', 'panelCheckins']) {
    assert.ok(ids.has(id), `missing tab element "${id}"`);
  }
  // The applicant panel must WRAP the existing availability panel, not replace it.
  const wrapStart = html.indexOf('id="panelApplicants"');
  const availAt = html.indexOf('id="availabilityPanel"');
  const checkinsAt = html.indexOf('id="panelCheckins"');
  assert.ok(wrapStart !== -1 && availAt > wrapStart,
    'the existing availability panel must live inside panelApplicants');
  assert.ok(checkinsAt > availAt, 'panelCheckins must come after the applicant panel');
});

test('Readiness and Connect Calendar sit ABOVE the tab bar, not inside a tab', () => {
  const readiness = html.indexOf('id="readinessPanel"');
  const connect = html.indexOf('id="connectPanel"');
  const tabBar = html.indexOf('id="tabBar"');
  assert.ok(readiness !== -1 && connect !== -1 && tabBar !== -1);
  assert.ok(readiness < tabBar, 'readinessPanel must precede the tab bar');
  assert.ok(connect < tabBar, 'connectPanel must precede the tab bar');
});

test('the check-in hours form mirrors the applicant one with a chk- prefix on every field', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'chk-availabilityPanel', 'chk-storageMissingNote', 'chk-availabilityForm',
    'chk-daysRows', 'chk-slotMinutes', 'chk-bufferMinutes', 'chk-minNoticeHours',
    'chk-timezoneInput', 'chk-tzList', 'chk-tzNow', 'chk-formErrors', 'chk-formSuccess',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing check-in hours id "${id}"`);
  }
});

test('the client manager has a table body, an add form, and its message slots', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'clientsPanel', 'clientsTableBody', 'clientsEmpty', 'clientsStorageMissingNote',
    'clientAddForm', 'clientName', 'clientEmail', 'clientPhone',
    'clientErrors', 'clientSuccess',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing client-manager id "${id}"`);
  }
});

// Email is the record key and the only channel notices go through, so the add
// form must not let it be submitted empty.
test('the client email input is required and typed as an email; name and phone are not required', () => {
  const emailInput = html.match(/<input[^>]*id="clientEmail"[^>]*>/);
  assert.ok(emailInput, 'clientEmail input not found');
  assert.match(emailInput[0], /\brequired\b/);
  assert.match(emailInput[0], /type="email"/);

  for (const id of ['clientName', 'clientPhone']) {
    const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(input, `${id} input not found`);
    assert.equal(/\brequired\b/.test(input[0]), false, `${id} must NOT be required`);
  }
});

test('the page talks to all four admin endpoints and to no visitor-facing one', () => {
  for (const url of [
    '/api/admin/status', '/api/admin/login',
    '/api/admin/availability', '/api/admin/checkin-availability',
    '/api/admin/checkin-clients',
  ]) {
    assert.ok(html.includes(url), `admin.html must call ${url}`);
  }
  // The admin page must never drive the visitor endpoints.
  for (const url of ['/api/calendar-checkin-book', '/api/checkin-verify', '/api/calendar-book']) {
    assert.equal(html.includes(url), false, `admin.html must not call ${url}`);
  }
});

test('the DELETE call sends the email in a JSON body', () => {
  // The endpoint accepts a query fallback, but the page uses the body -- the
  // documented path -- so assert that is what ships.
  assert.match(html, /method:\s*'DELETE'/);
  const idx = html.indexOf("method: 'DELETE'");
  const window = html.slice(idx, idx + 400);
  assert.match(window, /JSON\.stringify\(\{\s*email/);
});

test('the tab bar is keyboard-reachable: both tabs are real buttons with aria state', () => {
  for (const id of ['tabApplicants', 'tabCheckins']) {
    const el = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(el, `${id} must be a <button>, not a div`);
    assert.match(el[0], /aria-selected=/, `${id} must carry aria-selected`);
  }
  assert.match(html, /role="tablist"/);
});

// The new rules must reuse the site's tokens rather than inventing colours.
test('the new CSS uses the existing custom properties and introduces no new colour literals', () => {
  for (const token of ['--void', '--band-2', '--gold', '--gold-lo', '--bone', '--dim', '--ink', '--slab']) {
    assert.ok(html.includes(token), `${token} must still be defined/used`);
  }

  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const from = styleBlock.indexOf('/* ══ tab bar ══ */');
  assert.ok(from !== -1, 'expected the tab-bar CSS section');
  const to = styleBlock.indexOf('[hidden]', from);
  assert.ok(to > from, 'the new CSS must sit before the [hidden] rule');
  const newCss = styleBlock.slice(from, to);

  assert.ok(/\.tab-bar\s*\{/.test(newCss) && /\.clients-table\s*\{/.test(newCss),
    'expected tab-bar and clients-table rules in the new section');

  // #241D08 is the hairline colour admin.html already uses for .day-row and
  // ul.plain-list separators. There is no token for it, so reusing that exact
  // literal is correct; anything ELSE hard-coded is a new colour being invented.
  const ALLOWED_LITERALS = new Set(['#241D08']);
  const literals = newCss.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
  const unexpected = literals.filter(l => !ALLOWED_LITERALS.has(l.toUpperCase()));
  assert.deepEqual(unexpected, [],
    `new CSS must use var(--token); found raw colours: ${unexpected.join(', ')}`);

  // Logical properties only -- admin.html is dir="ltr" today, but the codebase
  // rule is logical everywhere, and this section is the newest code in it.
  const physical = newCss.match(/\b(margin|padding|border)-(left|right)\s*:/g) || [];
  assert.deepEqual(physical, [], `physical side properties in new CSS: ${physical.join(', ')}`);
});
