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

// The check-in minimum-notice field needs a plain, non-blocking warning when
// the value is too low for the reminder-delivery guarantee to hold -- NOT a
// validation error, and NOT present on the applicant form (which has no such
// element at all).
test('the check-in minNoticeHours warning element exists, is hidden by default, and is check-in only', () => {
  const ids = new Set(idsIn(html));
  assert.ok(ids.has('chk-minNoticeWarning'), 'missing chk-minNoticeWarning element');
  assert.equal(ids.has('minNoticeWarning'), false,
    'the reminder-delivery warning is scoped to check-ins only, per the spec');

  const el = html.match(/<p[^>]*id="chk-minNoticeWarning"[^>]*>/);
  assert.ok(el, 'chk-minNoticeWarning must be a <p>');
  assert.match(el[0], /\bhidden\b/, 'the warning must start hidden');

  // It must sit right after the chk-minNoticeHours input, inside the same field.
  const inputAt = html.indexOf('id="chk-minNoticeHours"');
  const warnAt = html.indexOf('id="chk-minNoticeWarning"');
  assert.ok(inputAt !== -1 && warnAt > inputAt && warnAt - inputAt < 200,
    'the warning must sit immediately after the chk-minNoticeHours input');
});

// The threshold must be the SAME default calendar-reminders.js's leadHours()
// falls back to, not an invented number -- this is a client-side echo of a
// server-side constant, and the two must never drift apart.
test('the minNoticeHours warning uses REMINDER_LEAD_HOURS\'s documented default of 24, not an invented number', () => {
  assert.match(html, /REMINDER_LEAD_HOURS_DEFAULT\s*=\s*24\b/,
    'the warning threshold must be the documented REMINDER_LEAD_HOURS default (24)');
  assert.match(html, /won't receive a reminder email/i);
});

// Recomputed live as the admin types, on the same input/change pattern the
// time-zone field already uses -- not only checked on save.
test('the minNoticeHours warning is wired to the chk-minNoticeHours field\'s own input/change events', () => {
  const idx = html.indexOf("$('chk-minNoticeHours').addEventListener");
  assert.ok(idx !== -1, 'chk-minNoticeHours must be wired directly, not only read on submit');
  const window = html.slice(idx, idx + 400);
  assert.match(window, /addEventListener\('input',\s*updateMinNoticeWarning\)/);
  assert.match(window, /addEventListener\('change',\s*updateMinNoticeWarning\)/);
});

test('saving the check-in hours form does not reject a low minNoticeHours (warning only, never a hard floor)', () => {
  // The save handler's only rejection path is a non-200/non-ok response from
  // the server; nothing client-side must short-circuit the submit based on
  // minNoticeHours. Assert there is no early-return/validation gate keyed on
  // minNoticeHours inside the submit handler.
  const submitIdx = html.indexOf('addEventListener(\'submit\'');
  assert.ok(submitIdx !== -1);
  const handlerWindow = html.slice(submitIdx, submitIdx + 1500);
  assert.equal(/minNoticeHours/.test(handlerWindow), false,
    'the submit handler must not gate on minNoticeHours -- the warning must never block a save');
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

// The Check-Ins tab used to combine the hours form AND the client roster in
// one panel. It now splits into "Check-In Hours" (hours only) and a third
// "Clients" tab holding the (now-enhanced) client manager.
test('the Check-Ins tab split into Check-In Hours and a third Clients tab', () => {
  const ids = new Set(idsIn(html));
  for (const id of ['tabClients', 'panelClients']) {
    assert.ok(ids.has(id), `missing tab element "${id}"`);
  }
  // clientsPanel must now live inside panelClients, not panelCheckins.
  const panelCheckinsAt = html.indexOf('id="panelCheckins"');
  const panelClientsAt = html.indexOf('id="panelClients"');
  const clientsPanelAt = html.indexOf('id="clientsPanel"');
  assert.ok(panelCheckinsAt !== -1 && panelClientsAt !== -1 && clientsPanelAt !== -1);
  assert.ok(panelClientsAt > panelCheckinsAt, 'panelClients must come after panelCheckins');
  assert.ok(clientsPanelAt > panelClientsAt, 'clientsPanel must live inside panelClients');

  // chk-availabilityPanel (the hours form) must still be inside panelCheckins,
  // and panelCheckins must no longer also contain the client table.
  const chkAvailAt = html.indexOf('id="chk-availabilityPanel"');
  assert.ok(chkAvailAt > panelCheckinsAt && chkAvailAt < panelClientsAt,
    'chk-availabilityPanel must stay inside panelCheckins');
});

test('the Check-In Hours tab button is relabeled and the new Clients tab is a real, keyboard-reachable tab', () => {
  const chkBtn = html.match(/<button[^>]*id="tabCheckins"[^>]*>([^<]*)</);
  assert.ok(chkBtn, 'tabCheckins button not found');
  assert.match(chkBtn[1], /Check-In Hours/);

  const clientsBtn = html.match(/<button[^>]*id="tabClients"[^>]*>/);
  assert.ok(clientsBtn, 'tabClients must be a <button>, not a div');
  assert.match(clientsBtn[0], /aria-selected=/, 'tabClients must carry aria-selected');
  assert.match(clientsBtn[0], /role="tab"/);
});

// startDate + durationMonths are now required on every add/edit, matching the
// extended api/_checkin-clients.js validateClient.
//
// UI-polish update: startDate and durationMonths are no longer a native
// <input type="date"> / <input type="number"> -- the native date popup has
// no CSS hooks and clashed with the site's black/gold identity, and the
// number spinner became a themed preset dropdown. #clientStartDate is now a
// hidden input (still holding the same "YYYY-MM-DD" string every read/write
// site addresses) driven by a custom trigger+panel widget;
// #clientDurationMonths is now a <select> of preset month values. The ids
// and required-ness are unchanged -- only the underlying element types are,
// deliberately, since that IS the presentation this task replaced.
test('the add-client form gains required startDate and durationMonths inputs', () => {
  const ids = new Set(idsIn(html));
  for (const id of ['clientStartDate', 'clientDurationMonths']) {
    assert.ok(ids.has(id), `missing client-manager id "${id}"`);
  }
  const startInput = html.match(/<input[^>]*id="clientStartDate"[^>]*>/);
  assert.ok(startInput, 'clientStartDate input not found');
  assert.match(startInput[0], /type="hidden"/,
    'clientStartDate is the hidden value-holding element behind the custom date-picker widget');
  assert.match(startInput[0], /\brequired\b/);

  const durationInput = html.match(/<select[^>]*id="clientDurationMonths"[^>]*>/);
  assert.ok(durationInput, 'clientDurationMonths select not found');
  assert.match(durationInput[0], /\brequired\b/);
});

test('the clients table header gains Status and Expires columns', () => {
  const tbodyAt = html.indexOf('id="clientsTableBody"');
  const headerWindow = html.slice(Math.max(0, tbodyAt - 400), tbodyAt);
  assert.match(headerWindow, /<th>Status<\/th>/);
  assert.match(headerWindow, /<th>Expires<\/th>/);
});

// Status is computed CLIENT-SIDE from pausedAt/expiresAt, never trusted as a
// server-sent field -- mirrors isAccessActive's own precedence (paused wins,
// then expiry, then a null expiresAt defaults to active/legacy).
test('renderClients computes Status from pausedAt/expiresAt and renders Edit, Pause/Resume and Renew actions', () => {
  // The status computation (computeClientStatus) sits just above renderClients
  // in the same "client manager" section -- widen the window to cover both.
  const sectionAt = html.indexOf('// ── client manager');
  assert.ok(sectionAt !== -1, 'client manager section not found');
  const renderAt = html.indexOf('function renderClients');
  assert.ok(renderAt !== -1 && renderAt > sectionAt, 'renderClients not found');
  const sectionWindow = html.slice(sectionAt, renderAt + 4500);
  assert.match(sectionWindow, /pausedAt/);
  assert.match(sectionWindow, /expiresAt/);
  assert.match(sectionWindow, /client-edit/);
  assert.match(sectionWindow, /client-pause-resume/);
  assert.match(sectionWindow, /client-renew/);
});

// Bug fix: the add-form only carries name/email/phone/startDate/durationMonths
// as VISIBLE fields, and normalizeEntry() (api/_checkin-clients.js) recomputes
// expiresAt fresh from startDate+durationMonths whenever the posted body has
// no finite expiresAt of its own. Without stashing the row's current
// expiresAt/pausedAt and carrying them through resubmission, fixing a typo'd
// phone number via Edit would silently reset a client's package to "started
// fresh," discarding any prior Renew extension or Pause/Resume adjustment.
test('Edit stashes the row\'s current expiresAt/pausedAt, and the submit handler carries them through unchanged for that same email', () => {
  const clickIdx = html.indexOf("clientsTableBody').addEventListener('click'");
  assert.ok(clickIdx !== -1, 'the delegated clientsTableBody click handler was not found');
  const clickWindow = html.slice(clickIdx, clickIdx + 4000);
  const editBranch = clickWindow.slice(clickWindow.indexOf('client-edit'));

  // The Edit branch must capture a snapshot of the row's CURRENT
  // expiresAt/pausedAt -- not just the four fields that land in the visible
  // form -- keyed to the email it was captured for.
  assert.match(editBranch, /editingSnapshot\s*=\s*\{[^}]*email[^}]*\}/s,
    'Edit must stash a snapshot object keyed by email');
  assert.match(editBranch, /expiresAt/,
    'the Edit handler must stash the row\'s current expiresAt');
  assert.match(editBranch, /pausedAt/,
    'the Edit handler must stash the row\'s current pausedAt');

  // The add-form submit handler must fold that stashed state back into the
  // posted client object, gated on the email still matching what the
  // snapshot was captured for -- so a brand-new Add Client (no snapshot) is
  // unaffected, and an edit whose email was changed to a different address
  // does not inherit someone else's package state.
  const submitIdx = html.indexOf("clientAddForm').addEventListener('submit'");
  assert.ok(submitIdx !== -1, 'the clientAddForm submit handler was not found');
  const submitWindow = html.slice(submitIdx, submitIdx + 3000);

  assert.match(submitWindow, /editingSnapshot\s*&&/,
    'the submit handler must check editingSnapshot before trusting it');
  assert.match(submitWindow, /client\.expiresAt\s*=\s*editingSnapshot\.expiresAt/,
    'the submit handler must carry the stashed expiresAt through unchanged');
  assert.match(submitWindow, /client\.pausedAt\s*=\s*editingSnapshot\.pausedAt/,
    'the submit handler must carry the stashed pausedAt through unchanged');

  // The email-match guard must run BEFORE the fetch, not after -- otherwise
  // the wrong (or no) expiresAt/pausedAt would already be in the posted body.
  const guardAt = submitWindow.search(/editingSnapshot\s*&&/);
  const fetchAt = submitWindow.indexOf("fetch('/api/admin/checkin-clients'");
  assert.ok(guardAt !== -1 && fetchAt !== -1 && guardAt < fetchAt,
    'the editingSnapshot guard must run before the client object is POSTed');
});

// CRITICAL regression check: editingSnapshot as first shipped was cleared
// ONLY on a successful form save, so a Renew/Pause/Resume/Remove that
// happened while an Edit was still open left it frozen at pre-change values.
// Resubmitting that stale edit would then silently revert a Renew or
// un-pause a client -- the exact bug the snapshot exists to prevent, reached
// by a different trigger. renderClients() is where every one of those
// actions ends up (each calls it on success), so it is the one place that
// can catch all of them.
test('renderClients invalidates a stale editingSnapshot on every re-render, and rebuilds it fresh if that client survives', () => {
  const idx = html.indexOf('function renderClients');
  assert.ok(idx !== -1, 'renderClients not found');
  const fnWindow = html.slice(idx, idx + 2500);

  // The clearing site itself.
  assert.match(fnWindow, /editingSnapshot\s*=\s*null/,
    'renderClients must clear editingSnapshot -- every lifecycle action ' +
    '(Renew, Pause, Resume, Remove) ends in exactly this render');

  // It must run near the top, before the per-client render loop -- not as
  // an afterthought once the (now-stale) rows are already drawn.
  const clearAt = fnWindow.search(/editingSnapshot\s*=\s*null/);
  const loopAt = fnWindow.indexOf('for (');
  assert.ok(clearAt !== -1 && loopAt !== -1 && clearAt < loopAt,
    'editingSnapshot must be cleared before the per-client render loop');

  // A bare clear alone is not enough: it would fix the "Remove" sequence but
  // leave the "Renew/Pause/Resume while still editing" sequences resubmitting
  // with NO expiresAt/pausedAt at all -- which normalizeEntry defaults the
  // same wrong way (recompute expiresAt from scratch; pausedAt -> null) as
  // applying a stale value would. renderClients must therefore REBUILD the
  // snapshot from the freshly-rendered record for that same email, inside
  // the loop, whenever it is still present.
  assert.match(fnWindow, /editingSnapshot\s*=\s*\{/,
    'renderClients must rebuild editingSnapshot from the live record when ' +
    'the client being edited is still in the newly-rendered list');
  const rebuildAt = fnWindow.search(/editingSnapshot\s*=\s*\{/);
  assert.ok(rebuildAt !== -1 && rebuildAt > clearAt && rebuildAt < loopAt + 500,
    'the rebuild must happen inside/around the per-client loop, after the clear');
});

// Fix: Edit ALWAYS preserving expiresAt/pausedAt meant correcting a wrong
// startDate/durationMonths via Edit had zero effect on the actual expiry.
// The submit handler must only carry expiresAt through when the form's
// CURRENT startDate/durationMonths still match what editingSnapshot captured
// -- if the admin changed either, expiresAt must recompute fresh from the
// new values (same as a brand-new Add). pausedAt is carried through either
// way -- fixing a date typo must not also silently toggle pause state.
test('the submit handler only preserves expiresAt when startDate/durationMonths are unchanged from the snapshot; pausedAt always carries through', () => {
  const submitIdx = html.indexOf("clientAddForm').addEventListener('submit'");
  assert.ok(submitIdx !== -1, 'the clientAddForm submit handler was not found');
  const submitWindow = html.slice(submitIdx, submitIdx + 3000);

  assert.match(submitWindow, /client\.startDate\s*===\s*editingSnapshot\.startDate/,
    'the submit handler must compare the form\'s current startDate against the snapshot');
  assert.match(submitWindow, /client\.durationMonths\s*===\s*editingSnapshot\.durationMonths/,
    'the submit handler must compare the form\'s current durationMonths against the snapshot');

  // client.expiresAt may only be assigned AFTER that comparison -- i.e.
  // inside its true branch, not unconditionally.
  const cmpAt = submitWindow.search(/client\.startDate\s*===\s*editingSnapshot\.startDate/);
  const expiresAssignAt = submitWindow.indexOf('client.expiresAt = editingSnapshot.expiresAt');
  assert.ok(cmpAt !== -1 && expiresAssignAt !== -1 && cmpAt < expiresAssignAt,
    'client.expiresAt must only be carried through AFTER the dates-unchanged comparison');

  // client.pausedAt must be assigned OUTSIDE (after) that comparison's own
  // block closes -- i.e. unconditionally once we know this is the same
  // client being edited, regardless of whether the dates changed.
  const innerIfAt = submitWindow.indexOf('if (datesUnchanged)');
  assert.ok(innerIfAt !== -1, 'expected an explicit datesUnchanged check');
  const innerCloseAt = submitWindow.indexOf('}', expiresAssignAt);
  const pausedAssignAt = submitWindow.indexOf('client.pausedAt = editingSnapshot.pausedAt');
  assert.ok(innerCloseAt !== -1 && pausedAssignAt !== -1 && pausedAssignAt > innerCloseAt,
    'client.pausedAt must be assigned after the datesUnchanged block closes, ' +
    'so it carries through regardless of whether dates changed');
});

test('the delegated table click handler wires Edit (repopulates the form) and Pause/Resume/Renew (posts a command)', () => {
  const idx = html.indexOf("clientsTableBody').addEventListener('click'");
  assert.ok(idx !== -1, 'the delegated clientsTableBody click handler was not found');
  const fnWindow = html.slice(idx, idx + 4000);

  // Edit repopulates the add-form, including the two new package fields.
  assert.match(fnWindow, /client-edit/);
  assert.match(fnWindow, /clientStartDate/);
  assert.match(fnWindow, /clientDurationMonths/);

  // Pause/Resume/Renew POST a `command` to the same endpoint used for adds.
  assert.match(fnWindow, /client-pause-resume/);
  assert.match(fnWindow, /client-renew/);
  assert.match(fnWindow, /command/);
  assert.match(fnWindow, /\/api\/admin\/checkin-clients/);
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

// Backend fix: a GET on /api/admin/availability or checkin-availability now
// returns {ok:false, ...} (502) for a genuine read failure, rather than
// silently disguising it as a successful 200 with fabricated defaults (see
// api/admin/availability.js and api/admin/checkin-availability.js). The
// frontend has no jsdom/behavioral test harness in this repo (admin.html's
// JS is only ever asserted against statically, as the rest of this file
// does), so this is a structural check that the relevant guard code exists,
// not a simulated fetch/render test.
test('loadAvailabilityInto only renders a template when the response is ok:true, not merely when a template key is present', () => {
  const idx = html.indexOf('async function loadAvailabilityInto');
  assert.ok(idx !== -1, 'loadAvailabilityInto not found');
  const fnWindow = html.slice(idx, idx + 2000);
  assert.match(fnWindow, /data\s*&&\s*data\.ok\s*&&\s*data\.template/,
    'loadAvailabilityInto must require data.ok, not just data.template, before populating the form -- ' +
    'a 502 failure response has no template at all, but a shape check alone must not treat any ' +
    'template-shaped payload as a successful load');
});

// The whole point of the backend fix is worthless if the admin page still
// quietly renders nothing-in-particular on a load failure and lets Save
// proceed as if the form held real data.
test('loadAvailabilityInto shows a load-error message and disables Save when the GET does not come back ok:true', () => {
  const idx = html.indexOf('async function loadAvailabilityInto');
  const fnWindow = html.slice(idx, idx + 2000);
  assert.match(fnWindow, /submitBtn\.disabled\s*=\s*true/,
    'a failed load must disable the Save button for that tab');
  assert.match(fnWindow, /noteEl\.hidden\s*=\s*false/,
    'a failed load must surface a visible note, not fail silently');
});

// Disabling the button alone is not a reliable submit guard (Enter-key
// submits do not consistently respect a disabled submit control across
// browsers), so the submit handler itself must also refuse to proceed.
test('the availability form submit handler refuses to submit when its tab never loaded a real template', () => {
  const idx = html.indexOf('function wireAvailabilityForm');
  assert.ok(idx !== -1, 'wireAvailabilityForm not found');
  const fnWindow = html.slice(idx, idx + 1500);
  assert.match(fnWindow, /loadFailed\[prefix\]/,
    'the submit handler must check the load-failure flag for its own prefix before collecting/sending the form');
  // And that check must come before the template is collected/sent.
  const guardAt = fnWindow.search(/loadFailed\[prefix\]/);
  const collectAt = fnWindow.indexOf('collectTemplate(prefix)');
  assert.ok(guardAt !== -1 && collectAt !== -1 && guardAt < collectAt,
    'the loadFailed guard must run before collectTemplate/submit, not after');
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

// ══ Clients-tab form-field polish: custom date picker, package dropdown,
// ══ and the horizontal-overflow fix. ══════════════════════════════════════

// The native <input type="date">'s calendar popup has essentially no CSS
// hooks, so a fully custom trigger+panel widget replaces it -- mirroring
// check-in.html's own hand-built day-picker (a different shape: a 14-day
// strip there, vs. a full month grid here, since a client's start date can
// be any past or future date).
test('a custom date-picker trigger and dropdown panel exist for the Start Date field', () => {
  const ids = new Set(idsIn(html));
  const required = [
    'clientStartDateTrigger', 'clientStartDateDisplay', 'clientStartDatePanel',
    'clientStartDatePrevMonth', 'clientStartDateMonthLabel', 'clientStartDateNextMonth',
    'clientStartDateGrid', 'clientStartDateTodayBtn', 'clientStartDateClearBtn',
  ];
  for (const id of required) {
    assert.ok(ids.has(id), `missing date-picker element "${id}"`);
  }

  // The trigger is a real <button>, not a div -- keyboard-reachable like
  // every other interactive control on this page.
  const trigger = html.match(/<button[^>]*id="clientStartDateTrigger"[^>]*>/);
  assert.ok(trigger, 'clientStartDateTrigger must be a <button>');
  assert.match(trigger[0], /aria-haspopup=/);
  assert.match(trigger[0], /aria-expanded="false"/);

  // The dropdown panel starts hidden.
  const panel = html.match(/<div[^>]*id="clientStartDatePanel"[^>]*>/);
  assert.ok(panel, 'clientStartDatePanel not found');
  assert.match(panel[0], /\bhidden\b/, 'the date-picker panel must start hidden');

  // Weekday headers, per the spec ("Mo/Tu/We/Th/Fr/Sa/Su or similar").
  const panelAt = html.indexOf('id="clientStartDatePanel"');
  const gridAt = html.indexOf('id="clientStartDateGrid"');
  const weekdaysWindow = html.slice(panelAt, gridAt);
  for (const wd of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
    assert.ok(weekdaysWindow.includes(`>${wd}<`), `missing weekday header "${wd}"`);
  }
});

// #clientStartDate itself must remain the real value-holding element every
// existing read/write site (submit handler, post-submit reset, Edit-populate)
// already addresses by that exact id -- only its element type changes (a
// hidden input instead of a visible native date input), so none of those
// call sites needed their value contract rewritten.
test('#clientStartDate stays the hidden value-holding input behind the custom widget, still carrying a "YYYY-MM-DD" string', () => {
  const startInput = html.match(/<input[^>]*id="clientStartDate"[^>]*>/);
  assert.ok(startInput, 'clientStartDate input not found');
  assert.match(startInput[0], /type="hidden"/);

  // The submit handler still reads it by the same id/contract.
  const submitIdx = html.indexOf("clientAddForm').addEventListener('submit'");
  const submitWindow = html.slice(submitIdx, submitIdx + 4000);
  assert.match(submitWindow, /startDate:\s*\$\('clientStartDate'\)\.value\.trim\(\)/,
    'the submit handler must still read #clientStartDate.value as a plain string');

  // The post-submit reset still clears it by the same id, and must also
  // refresh the trigger's displayed text -- setting .value directly on a
  // hidden input fires no event the widget could otherwise react to.
  const resetAt = submitWindow.indexOf("$('clientStartDate').value = '';");
  assert.ok(resetAt !== -1, 'the post-submit reset must still clear #clientStartDate.value');
  const afterReset = submitWindow.slice(resetAt, resetAt + 120);
  assert.match(afterReset, /clientStartDatePicker\.refresh\(\)/,
    'the post-submit reset must refresh the date-picker trigger display after clearing the hidden value');

  // Edit-populate still writes #clientStartDate.value from the row's stored
  // startDate, and must likewise refresh the trigger display.
  const clickIdx = html.indexOf("clientsTableBody').addEventListener('click'");
  const clickWindow = html.slice(clickIdx, clickIdx + 2000);
  const editAt = clickWindow.indexOf("$('clientStartDate').value = c.startDate || '';");
  assert.ok(editAt !== -1, 'Edit must still populate #clientStartDate.value from the stored startDate');
  const afterEdit = clickWindow.slice(editAt, editAt + 120);
  assert.match(afterEdit, /clientStartDatePicker\.refresh\(\)/,
    'Edit-populate must refresh the date-picker trigger display after setting the hidden value');
});

// Month navigation and day-selection logic must exist, and a selected day's
// cell must actually write back into the hidden #clientStartDate value.
test('the date picker implements month navigation and day selection, writing the chosen date back into #clientStartDate', () => {
  const idx = html.indexOf('function initDatePicker');
  assert.ok(idx !== -1, 'initDatePicker not found');
  const fnWindow = html.slice(idx, idx + 6000);

  assert.match(fnWindow, /viewMonth\s*-=\s*1/, 'previous-month navigation not found');
  assert.match(fnWindow, /viewMonth\s*\+=\s*1/, 'next-month navigation not found');
  assert.match(fnWindow, /function\s+selectDay/, 'day-selection logic not found');
  assert.match(fnWindow, /valueInput\.value\s*=\s*dpFormatISO\(/,
    'selecting a day must write the chosen date back into the hidden value input');

  // Clicking outside the panel or pressing Escape closes it without
  // changing the selection (no valueInput.value assignment near either).
  assert.match(fnWindow, /function\s+onOutsideClick/);
  assert.match(fnWindow, /function\s+onKeydown/);
  assert.match(fnWindow, /e\.key\s*===\s*'Escape'/);
});

// The dimmed adjacent-month filler days (visible in the native picker's
// screenshot too) must be genuinely unclickable, not merely styled dim.
test('adjacent-month filler days in the date-picker grid are disabled, not just visually dimmed', () => {
  const idx = html.indexOf('function makeCell');
  assert.ok(idx !== -1, 'makeCell not found');
  const fnWindow = html.slice(idx, idx + 800);
  assert.match(fnWindow, /isOutside/);
  assert.match(fnWindow, /cell\.disabled\s*=\s*true/);
});

// Today/Clear text actions, per the spec.
test('the date-picker panel has Today and Clear actions that write/clear the hidden value', () => {
  const todayBtn = html.match(/<button[^>]*id="clientStartDateTodayBtn"[^>]*>([^<]*)</);
  assert.ok(todayBtn, 'clientStartDateTodayBtn not found');
  assert.match(todayBtn[1], /Today/i);
  const clearBtn = html.match(/<button[^>]*id="clientStartDateClearBtn"[^>]*>([^<]*)</);
  assert.ok(clearBtn, 'clientStartDateClearBtn not found');
  assert.match(clearBtn[1], /Clear/i);

  const idx = html.indexOf('function initDatePicker');
  const fnWindow = html.slice(idx, idx + 6000);
  assert.match(fnWindow, /clearBtn\.addEventListener\('click',[^]*?valueInput\.value\s*=\s*'';/,
    'Clear must blank the hidden value');
  assert.match(fnWindow, /todayBtn\.addEventListener\('click',[^]*?valueInput\.value\s*=\s*dpFormatISO\(/,
    'Today must set the hidden value to today\'s date');
});

// Package Length is now a themed dropdown of preset month values instead of
// a free-typed number spinner.
test('Package Length is a <select> offering the 1/2/3/6/9/12-month presets, and keeps durationMonths\' value contract', () => {
  const durationInput = html.match(/<select[^>]*id="clientDurationMonths"[^>]*>/);
  assert.ok(durationInput, 'clientDurationMonths select not found');
  assert.match(durationInput[0], /\brequired\b/);
  assert.match(durationInput[0], /class="input"/, 'must reuse the shared .input theming class');

  const idx = html.indexOf('id="clientDurationMonths"');
  const optionsWindow = html.slice(idx, html.indexOf('</select>', idx));
  for (const months of [1, 2, 3, 6, 9, 12]) {
    assert.match(optionsWindow, new RegExp(`<option value="${months}">`),
      `missing the ${months}-month preset option`);
  }

  // The submit handler still reads it the same way (Number(...) of .value),
  // and the reset/Edit-populate call sites are untouched in shape.
  const submitIdx = html.indexOf("clientAddForm').addEventListener('submit'");
  const submitWindow = html.slice(submitIdx, submitIdx + 1200);
  assert.match(submitWindow, /durationMonths:\s*Number\(\$\('clientDurationMonths'\)\.value\)/);
});

// The classic flexbox min-width:auto gotcha: a flex item's content (a long
// typed name/email) was preventing it from shrinking, pushing the row (and
// the page) into horizontal scroll instead of the input containing its own
// text like a normal text field.
test('the clients-add-row overflow fix (min-width:0) is present, scoped to the Clients add-row only', () => {
  const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(styleBlock, /\.clients-add-row\s+\.field\s*\{[^}]*min-width\s*:\s*0\b/,
    '.clients-add-row .field must set min-width:0 so it can shrink below its content\'s intrinsic width');

  // Scoped -- must not appear as a bare, page-wide rule on .field or .input
  // that would also affect the New Applicants / Check-In Hours forms.
  const bareFieldRule = styleBlock.match(/(?<!clients-add-row\s)\.field\s*\{[^}]*\}/);
  assert.ok(bareFieldRule, 'expected the base .field rule to still exist');
  assert.equal(/min-width\s*:\s*0/.test(bareFieldRule[0]), false,
    'the overflow fix must be scoped to .clients-add-row .field, not the shared base .field rule');
});
