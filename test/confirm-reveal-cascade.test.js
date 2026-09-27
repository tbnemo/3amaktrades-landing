const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------
// The confirm screen reveals elements by writing to `element.style.display`.
// Setting it to '' REMOVES the inline declaration, which is only a reveal when
// nothing in the stylesheet also hides that element. `#bookingWidgetHost` is
// hidden BOTH inline and by a `#bookingWidgetHost { display: none }` rule, so
// `= ''` left the booking widget mounted inside a permanently invisible
// container -- the $1k+ booking flow looked like it simply did nothing.
//
// Nothing in the suite could catch that: every other confirm-screen test reads
// JS source or evaluates tier booleans, and none of them model the CSS cascade.
// This test does, statically: any id hidden by an id-selector rule in the
// stylesheet must be revealed with an explicit display value, never with ''.
//
// Limitation (deliberate): only `#id { ... }` rules are parsed, not compound or
// class selectors. That is exactly the shape of the rule that caused the bug and
// the shape most likely to be added next to it.
// ---------------------------------------------------------------------

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function stylesheetText() {
  let css = '';
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(src)) !== null) css += m[1] + '\n';
  return css;
}

// ids hidden by an id-selector rule, e.g. `#bookingWidgetHost { display: none; }`
function idsHiddenByStylesheet() {
  const hidden = new Set();
  const re = /#([A-Za-z][\w-]*)\s*\{([^}]*)\}/g;
  let m;
  const css = stylesheetText();
  while ((m = re.exec(css)) !== null) {
    if (/display\s*:\s*none/i.test(m[2])) hidden.add(m[1]);
  }
  return hidden;
}

// `const host = document.getElementById('bookingWidgetHost')` -> host: bookingWidgetHost
function aliasToId() {
  const map = new Map();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) map.set(m[1], m[2]);
  return map;
}

// Every `<target>.style.display = '<value>'`, with <target> resolved to an id.
function displayWrites() {
  const out = [];
  const aliases = aliasToId();

  const direct = /document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)\.style\.display\s*=\s*(['"])([^'"]*)\2/g;
  let m;
  while ((m = direct.exec(src)) !== null) out.push({ id: m[1], value: m[3] });

  const viaAlias = /\b([A-Za-z_$][\w$]*)\.style\.display\s*=\s*(['"])([^'"]*)\2/g;
  while ((m = viaAlias.exec(src)) !== null) {
    const id = aliases.get(m[1]);
    if (id) out.push({ id, value: m[3] });
  }
  return out;
}

test('the stylesheet-hidden + inline-hidden pattern is actually present (guards this test against silently passing)', () => {
  const hidden = idsHiddenByStylesheet();
  assert.ok(
    hidden.has('bookingWidgetHost'),
    'Expected `#bookingWidgetHost { display: none }` in index.html\'s stylesheet. If that rule was ' +
    'intentionally removed, delete this assertion -- but do not let the test pass vacuously.'
  );
  const writes = displayWrites();
  assert.ok(
    writes.some(w => w.id === 'bookingWidgetHost'),
    'Expected index.html to write #bookingWidgetHost\'s style.display somewhere -- the extraction ' +
    'regexes above have gone stale.'
  );
});

test('no element hidden by a stylesheet rule is "revealed" by clearing its inline display', () => {
  const hidden = idsHiddenByStylesheet();
  const offenders = displayWrites().filter(
    w => w.value.trim() === '' && hidden.has(w.id)
  );
  assert.deepEqual(
    offenders, [],
    'These ids are hidden by an id-selector `display:none` rule, so setting style.display = "" ' +
    'falls back to that rule and hides them instead of showing them. Use an explicit value ' +
    '(e.g. "block"): ' + offenders.map(o => '#' + o.id).join(', ')
  );
});

test('#bookingWidgetHost is revealed with an explicit, visible display value', () => {
  const writes = displayWrites().filter(w => w.id === 'bookingWidgetHost');
  const reveals = writes.filter(w => w.value !== 'none');
  assert.ok(reveals.length > 0, 'index.html never reveals #bookingWidgetHost at all.');
  for (const w of reveals) {
    assert.notEqual(w.value.trim(), '',
      '#bookingWidgetHost must be revealed with an explicit display value, not "".');
    assert.match(w.value.trim(), /^(block|flex|grid|inline-block|contents)$/,
      'Unexpected display value for #bookingWidgetHost: ' + JSON.stringify(w.value));
  }
});

// ---------------------------------------------------------------------
// The calendar glyph on #bookCallBtn is an outline icon, unlike the solid
// WhatsApp/Discord paths sharing the .cta-btn-wa class. SVG presentation
// attributes lose to every CSS rule, so `.form-confirm .cta-btn-wa svg
// { fill: currentColor }` filled the calendar body solid gold. main hit the
// identical bug on the Instagram glyph (651a74c) and fixed it with a `.ig-icon`
// override; the calendar icon follows that convention with `.cal-icon`.
// ---------------------------------------------------------------------

test('the outline calendar icon is not filled by the shared .cta-btn-wa svg rule', () => {
  const css = stylesheetText();
  assert.match(css, /\.form-confirm\s+\.cta-btn-wa\s+svg\s*\{[^}]*fill\s*:\s*currentColor/i,
    'Expected the shared `.form-confirm .cta-btn-wa svg { fill: currentColor }` rule. If it is gone, ' +
    'this test no longer guards anything -- re-check whether the calendar icon still needs an override.');
  assert.match(css, /\.cta-btn-wa\s+svg\.cal-icon\s*\{[^}]*fill\s*:\s*none/i,
    'The outline calendar icon needs a `svg.cal-icon { fill: none }` override to beat the shared ' +
    'rule -- its own fill="none" attribute cannot. (Same fix shape as .ig-icon.)');
  assert.match(src, /<svg class="cal-icon"/,
    'The calendar <svg> must carry class="cal-icon" or the override rule matches nothing.');
});
