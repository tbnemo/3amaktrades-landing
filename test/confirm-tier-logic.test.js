const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------
// The confirm-screen tier logic lives inline inside submitForm() in
// index.html, operating directly on document.getElementById(...) rather
// than being an exportable pure function. To exercise the *actual* source
// condition (not a re-typed copy that could silently drift from it), this
// test extracts the exact boolean expressions from index.html via regex
// and evaluates them for each of the four budgetCode values.
//
// Tier contract (see task-12-brief.md):
//   '<500'    -> WhatsApp/Instagram row hidden, Discord shown, no booking
//   '500-1k'  -> WhatsApp/Instagram row shown,  Discord shown, no booking
//   '1k-3k'   -> WhatsApp/Instagram row shown,  Discord shown, booking shown
//   '3k+'     -> WhatsApp/Instagram row shown,  Discord shown, booking shown
// ---------------------------------------------------------------------

const indexPath = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(indexPath, 'utf8');

const isLowBudgetMatch = src.match(/const isLowBudget = (payload\.budgetCode[^;]+);/);
const canBookMatch = src.match(/const canBook = (payload\.budgetCode[^;]+);/);

assert.ok(isLowBudgetMatch, 'Could not find the isLowBudget tier condition in index.html -- source may have moved/changed.');
assert.ok(canBookMatch, 'Could not find the canBook tier condition in index.html -- source may have moved/changed.');

const isLowBudgetExpr = isLowBudgetMatch[1];
const canBookExpr = canBookMatch[1];

// Builds the tier decision for a given budgetCode by evaluating the exact
// expressions pulled from index.html (direct eval -- reads `payload` from
// this function's own scope).
function tierFor(budgetCode) {
  const payload = { budgetCode };
  const isLowBudget = eval(isLowBudgetExpr);
  const canBook = eval(canBookExpr);
  return {
    // Discord is unconditional in the markup -- there is no display-toggle
    // for it anywhere in submitForm(), for any tier.
    discordShown: true,
    waInstagramShown: !isLowBudget,
    bookShown: canBook,
  };
}

test('tier <500: Discord only -- WhatsApp/Instagram and booking both hidden', () => {
  const t = tierFor('<500');
  assert.equal(t.waInstagramShown, false);
  assert.equal(t.discordShown, true);
  assert.equal(t.bookShown, false);
});

test('tier 500-1k: WhatsApp/Instagram + Discord -- NO booking option', () => {
  const t = tierFor('500-1k');
  assert.equal(t.waInstagramShown, true);
  assert.equal(t.discordShown, true);
  assert.equal(t.bookShown, false, '500-1k must NOT get the booking option');
});

test('tier 1k-3k: WhatsApp/Instagram + Discord + Book a Call', () => {
  const t = tierFor('1k-3k');
  assert.equal(t.waInstagramShown, true);
  assert.equal(t.discordShown, true);
  assert.equal(t.bookShown, true, '1k-3k must get the booking option');
});

test('tier 3k+: WhatsApp/Instagram + Discord + Book a Call', () => {
  const t = tierFor('3k+');
  assert.equal(t.waInstagramShown, true);
  assert.equal(t.discordShown, true);
  assert.equal(t.bookShown, true, '3k+ must get the booking option');
});

test('booking is exclusive to the two upper tiers, unknown/empty codes do not book', () => {
  assert.equal(tierFor('').bookShown, false);
  assert.equal(tierFor(undefined).bookShown, false);
});

// ---------------------------------------------------------------------
// Fix round 1: `{ once: true }` on the bookCallBtn click listener consumed
// the listener the instant it fired, regardless of what happened inside the
// handler. If /booking-widget.js failed to load (network blip, ad-blocker,
// etc.), the script's onerror re-enabled the button visually but no click
// listener remained attached -- a silent dead end for the highest-intent
// ($1k+) leads on the site. The fix removes { once: true } (the
// bookingWidgetLoading guard already prevents a double-mount, and success
// hides the button) and makes onerror restore the WhatsApp/Instagram DM
// fallback so a visitor is never left with a live-looking but dead button.
// These two assertions read the actual source text so they fail if either
// property regresses.
// ---------------------------------------------------------------------

const bookBtnListenerMatch = src.match(/bookBtn\.addEventListener\([^;]+\);/);
assert.ok(bookBtnListenerMatch, 'Could not find the bookCallBtn click listener registration in index.html -- source may have moved/changed.');
const bookBtnListenerSrc = bookBtnListenerMatch[0];

const onErrorMatch = src.match(/s\.onerror = \(\) => \{([\s\S]*?)\n\s*\};/);
assert.ok(onErrorMatch, 'Could not find the booking-widget script s.onerror handler in index.html -- source may have moved/changed.');
const onErrorBody = onErrorMatch[1];

test('bookCallBtn click listener registration does NOT use { once: true }', () => {
  assert.doesNotMatch(
    bookBtnListenerSrc,
    /\{\s*once\s*:\s*true\s*\}/,
    'bookCallBtn listener must not consume itself on first click -- a failed ' +
    'script load would then leave a visually-enabled but dead button.'
  );
});

test('script s.onerror handler restores the WhatsApp/Instagram DM fallback', () => {
  assert.match(onErrorBody, /confirmWaLabel/, 'onerror handler must re-show confirmWaLabel on a failed script load');
  assert.match(onErrorBody, /confirmTalkRow/, 'onerror handler must re-show confirmTalkRow on a failed script load');
});
