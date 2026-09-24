# Bullion Refine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live 3AMAK Trades landing page's current "Gold Ticker" visual system with the approved "Bullion" direction (gold-as-mass, stacked bands), port the real page content into it section by section, apply the six legally-required copy reworks, extend the Arabic translations to match, and fix the bundled technical issues (analytics, SEO, image weight, accessibility) — all in one deploy.

**Architecture:** Single static `index.html` (no framework), matching the existing codebase convention — this refine edits that one file in place rather than introducing a build step. New CSS replaces the current `:root` tokens and section styles; new markup replaces each section's HTML; the existing `t.ar`/`t.en` + `txt()`/`render()` i18n system is kept but its fragile per-element wiring in `render()` is replaced with the generic `[data-key]` sweep pattern the codebase already uses for `#propfirm` (see Task 1) so every later task only needs to add `data-key` attributes, not touch `render()`.

**Tech Stack:** Vanilla HTML/CSS/JS, Vercel static hosting + serverless functions under `/api` (untouched by this plan), Google Fonts (Big Shoulders Display, Changa, Inter, Noto Sans Arabic).

**Spec:** `docs/superpowers/specs/2026-09-24-bullion-refine-design.md` on the `internal-docs` branch (not `main` — check it out to read it: `git show internal-docs:docs/superpowers/specs/2026-09-24-bullion-refine-design.md`). Reference implementation (ground truth for exact markup/CSS/motion): `.superpowers/brainstorm/directions/gold-direction-c-full.html` (gitignored, local-only — open it directly, it's already in the working tree).

## Global Constraints

- **Never imply guaranteed profit/income anywhere.** This drove the six copy changes in Task 8 — don't reintroduce the old wording, and don't write new copy that crosses this line either.
- **Logo used exactly as-is** — no redesign. Keep `/logo.png` with a text-fallback `onerror` where useful, matching the pattern already in the reference mockup.
- **Proof section copy is untouched** — re-skin the container only, per Task 7. Do not edit, "fix", or improve the three claims in it.
- **0 border-radius, no `box-shadow`, no glow anywhere** in the new system — depth comes from tonal steps (`--band`/`--band-2`) and hairline rules only.
- **No eyebrow chips** — no small tracked-uppercase label sitting directly above a headline. Section kickers live inside the heading itself (baseline-mixed lead line) or as a small nav-bar status indicator, per the reference mockup.
- **Every new CSS rule uses logical properties** (`inset-inline`, `border-inline`, `padding-block`, `margin-inline-start`, etc.), never physical `left`/`right`/`top`/`bottom` for layout, so the existing `dir`-toggle keeps mirroring the whole page.
- **Bilingual is two first-class languages** — every new/changed string needs a real, natural Arabic translation (not a transliteration of the English), written in the casual Levantine-leaning voice the rest of `t.ar` already uses. Placeholder or missing Arabic is not acceptable to ship.
- **Real content, not placeholders** — every section task below uses the actual current copy from `t.en`/`t.ar` (only reworded where Task 8 requires it), the real stats/certs/links, not invented filler.

---

## Task 1: i18n infrastructure — generic `[data-key]` sweep

Nearly every section is being rebuilt, so this task replaces `render()`'s fragile per-element `querySelector` wiring with one generic sweep (the pattern the codebase already uses for `#propfirm`) before any section is touched. Every later task then only needs to add `data-key="..."` attributes to its markup — no `render()` edits required.

**Files:**
- Modify: `index.html:1159-1257` (the `render()` function)

**Interfaces:**
- Consumes: `t[lang][key]` (existing, from the `const t = {ar:{...}, en:{...}}` object at `index.html:872`), `txt(key)` (existing, `index.html:1157`)
- Produces: a generic sweep any later task can rely on — any element anywhere in the document with `data-key="foo"` gets `.textContent = t[lang].foo` automatically on every `render()` call. Elements needing HTML (not plain text) use `data-key-html="foo"` instead and get `.innerHTML` set.

- [ ] **Step 1: Replace `render()` with the generic sweep, keeping the few special cases**

Replace the entire function body (`index.html:1159-1257`) with:

```js
function render() {
  document.querySelectorAll('[data-key]').forEach(el => {
    const k = el.dataset.key;
    if (t[lang][k] !== undefined) el.textContent = t[lang][k];
  });
  document.querySelectorAll('[data-key-html]').forEach(el => {
    const k = el.dataset.keyHtml;
    if (t[lang][k] !== undefined) el.innerHTML = t[lang][k];
  });
}
```

- [ ] **Step 2: Add `data-key` to the elements not yet being replaced this pass, so nothing regresses mid-refine**

Nothing else changes yet — the nav lang buttons and `.nav-cta` already work via other means (`setLang` directly, and Task 2 adds `data-key="nav_apply"` to `.nav-cta`). Every other current manual line from the old `render()` (hero, stats, proof, mentor, decide, faq, final-cta, footer) is deleted along with the sections themselves in Tasks 2–11 — this step is a no-op placeholder confirming there's nothing left to preserve. Skip to Step 3.

- [ ] **Step 3: Verify nothing crashes with the old sections still in place**

Run: open `index.html` directly in a browser (or `vercel dev` from the project root, then visit the local URL).
Expected: the page loads without a JS console error. Visible content will look broken/untranslated in spots — that's expected, every section still has its old markup without `data-key` attributes yet (Tasks 2–11 fix this section by section). Confirm specifically: no red error in the browser console, and clicking the "EN"/"عربي" nav buttons doesn't throw.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "refactor: replace per-element render() wiring with a generic [data-key] sweep"
```

---

## Task 2: Global tokens, fonts, and base styles

**Files:**
- Modify: `index.html` — the `<style>` block's `:root` and global rules (find via `grep -n ":root{" index.html`)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html:1-32` (the `:root` token block and base resets) — copy verbatim, these are already final.

**Interfaces:**
- Produces: CSS custom properties every later task's markup depends on: `--void`, `--band`, `--band-2`, `--gold`, `--gold-lo`, `--bone`, `--dim`, `--ink`, `--slab` (exact hex values in the reference file's `:root` block).

- [ ] **Step 1: Replace the old `:root` token block**

Open `.superpowers/brainstorm/directions/gold-direction-c-full.html:19-30` and copy the `:root{...}` block verbatim into `index.html`'s `<style>` section, replacing the old Gold Ticker tokens (`--ticker-gold`, `--session-black`, etc. — find them via `grep -n "\-\-ticker-gold" index.html`).

- [ ] **Step 2: Replace the Google Fonts `<link>`**

Find the existing fonts link (`grep -n "fonts.googleapis.com/css2" index.html`) and replace its `href` with the union of every font family used across the reference mockup's per-section `@import` rules: Big Shoulders Display (weights 500/700/800), Changa (600/800), Inter (400/500/600), Noto Sans Arabic (400/600). One combined link, not four separate `@import`s (matches the live site's existing single-`<link>` convention, better for load performance than four blocking `@import`s):

```html
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@500;700;800&family=Changa:wght@600;800&family=Inter:wght@400;500;600&family=Noto+Sans+Arabic:wght@400;600&display=swap" rel="stylesheet">
```

- [ ] **Step 3: Replace base resets**

Copy `.superpowers/brainstorm/directions/gold-direction-c-full.html:33-40`ish (the `*{box-sizing:border-box}`, `html,body{margin:0;...}` rules) verbatim, replacing the equivalent old rules.

- [ ] **Step 4: Verify tokens resolve**

Run: open `index.html` in a browser, open devtools, run `getComputedStyle(document.documentElement).getPropertyValue('--gold')` in the console.
Expected: returns `#D4AF37` (or whatever exact value the reference file's `:root` uses — confirm it matches, don't eyeball it).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "style: replace Gold Ticker tokens with the Bullion palette"
```

---

## Task 3: Nav + Hero

**Files:**
- Modify: `index.html` — the `<nav>` block and `<section id="hero">` (find via `grep -n '<nav>\|<section id="hero">' index.html`)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html:34-233` (Band 1 nav CSS + candlestick CSS + hero CSS) and `:762-892`ish (the actual markup — confirm exact lines via `grep -n 'class="bl-hero"\|BAND 3' gold-direction-c-full.html`)

**Interfaces:**
- Consumes: Task 1's generic sweep, Task 2's tokens
- Produces: `#hero` section id (kept, so `.bl-status` and other JS/anchors referencing `#hero` still work), `.bl-h1`/`.bl-sub`/`.bl-fine`/`.bl-bar` classes later tasks don't depend on but should not collide with (prefix is already namespaced `bl-`, safe)

- [ ] **Step 1: Replace the nav**

Port the reference file's Band 1 nav markup and CSS (`gold-direction-c-full.html:34-64` for CSS, and its `<header class="bl-b1...">`/`<nav>` markup) into `index.html`'s `<nav>` block, but **keep the real two-button language switcher** — the reference mockup used a single `AR ⇄` toggle button for demo purposes; the live site has two explicit buttons and a real `setLang()` function. Use:

```html
<nav class="bl-b1 bl-pad">
  <div class="bl-mark">
    <img src="/logo.png" alt="3AMAK Trades" class="nav-logo-img" onerror="this.outerHTML='<span class=\'fallback\'>3AMAK TRADES</span>'" />
  </div>
  <div class="bl-nav">
    <a href="#propfirm" data-key="nav_system"></a>
    <a href="#mentor" data-key="nav_mentor"></a>
    <a href="#proof" data-key="nav_proof"></a>
  </div>
  <p class="bl-status"><i></i> <span data-key="nav_status"></span></p>
  <div class="lang-toggle bl-lang">
    <button class="lang-btn active" data-lang="ar" onclick="setLang('ar')">عربي</button>
    <button class="lang-btn" data-lang="en" onclick="setLang('en')">EN</button>
  </div>
  <a href="#apply" class="nav-cta bl-btn-nav" data-key="nav_apply"></a>
</nav>
```

Add three new keys to both `t.ar` and `t.en` (`index.html:872` / `:1007`):

```js
// in t.ar:
nav_system: "النظام",
nav_mentor: "المرشد",
nav_proof: "الإثبات",
nav_status: "التقديم مفتوح",

// in t.en:
nav_system: "System",
nav_mentor: "Mentor",
nav_proof: "Proof",
nav_status: "Applications open",
```

Keep the existing `nav_apply` key (`"Apply Now"` / `"قدّم الآن"`) — already correct, no change needed.

Add the corresponding CSS from `gold-direction-c-full.html:34-58` (`.bl-b1`, `.bl-mark`, `.bl-nav`, `.bl-status`, `.bl-dir`→ delete, not needed, real toggle uses existing `.lang-toggle`/`.lang-btn` CSS already in `index.html`, keep those rules as-is).

- [ ] **Step 2: Replace the hero section**

Delete the old `<section id="hero">...</section>` (`index.html:1276-1305`ish — confirm exact range) and replace with the reference file's full hero markup (candlestick backdrop SVG, `.bl-hero-grid` split, headline, sub, fine print, VSL) from `gold-direction-c-full.html` — copy the whole Band 2 + Band 3 block verbatim (candlestick CSS, hero CSS, gold-bar CSS, and their matching HTML), keeping `id="hero"` on the outer wrapper so `href="#hero"`-style anchors elsewhere keep working.

Replace the hardcoded English headline/sub/fine text with `data-key` spans:

```html
<h1 class="bl-h1">
  <span class="sm" data-key="hero_kicker"></span>
  <span class="lg" data-key="hero_h1_a"></span> <em data-key="hero_h1_em"></em></span>
</h1>
<p class="bl-sub" data-key="hero_sub"></p>
<p class="bl-fine" data-key="hero_fine"></p>
```

Add to `t.en`:

```js
hero_kicker: "Seven funded certificates. One method.",
hero_h1_a: "Trade like it's your job,",
hero_h1_em: "not your luck.",
hero_sub: "Omar Alhalabi is an active funded trader. He teaches the process he runs every session — risk defined before the entry, the plan written before the click, every outcome logged the same way. For beginners, and for anyone who already tried the challenges alone.",
hero_fine: "Eight questions, about four minutes, read by a person before any place is offered. Nothing on this page promises a profit, a return or an income. It is a process and a set of rules, and it can still lose.",
```

Add to `t.ar`:

```js
hero_kicker: "سبع شهادات تمويل. منهج واحد.",
hero_h1_a: "تعلّم التداول وكأنه شغلتك،",
hero_h1_em: "مش حظك.",
hero_sub: "عمر الحلبي متداول مموَّل فعلياً. بيعلّم نفس المنهج يلي بيشتغل فيه كل جلسة — تحديد الريسك قبل الدخول، خطة مكتوبة قبل الضغطة، وكل نتيجة مسجّلة بنفس الطريقة. للمبتدئين، وللي جرّب التحديات لحاله قبل هيك.",
hero_fine: "ثمانية أسئلة، حوالي أربع دقايق، وبيقرأها شخص حقيقي قبل ما يتعرض أي مكان. ولا شي هون بيوعد بربح أو عائد أو دخل — هاد منهج ومجموعة قواعد، وممكن كمان تخسر فيه.",
```

Keep the VSL `.bl-bar` markup and its chamfered-bar SVG exactly as in the reference file (900×500, the `translate(76px,6px)` nudge, the `@media(max-width:1180px)` reset) — no `data-key` needed, it's decorative, no text.

- [ ] **Step 3: Wire the candlestick reduced-motion and stagger CSS**

Confirm the `@keyframes bl-grow`, `.bl-candle`/`.bl-candle-live` rules, and the `@media (prefers-reduced-motion: reduce)` override all came across from the reference file — these live in the same CSS block as the candlestick SVG, verify by diffing: `grep -n "bl-candle" index.html` should show the same rule count as `grep -n "bl-candle" .superpowers/brainstorm/directions/gold-direction-c-full.html`.

- [ ] **Step 4: Verify in browser**

Run: open `index.html`, or `vercel dev`.
Expected: nav shows logo, System/Mentor/Proof links, "Applications open" status, the AR/EN buttons, Apply CTA. Hero shows the candlestick backdrop animating in on load, headline "Trade like it's your job, not your luck." with the emphasized phrase in gold, the 900×500 VSL slab to the right on a wide window. Click "EN"/"عربي" — text swaps, layout mirrors (VSL moves to the left, headline right-aligns), nothing overlaps.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: replace hero and nav with the Bullion design"
```

---

## Task 4: "The Record" (replaces the Stats section)

**Files:**
- Modify: `index.html` — delete `<section id="stats">` (`index.html:1310-1316`ish), add the new ledger section in its place
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search for `BAND 5` / `bl-ledger` for the CSS and markup

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: `id="the-record"` anchor (new — nothing links to `#stats` currently, confirmed via `grep -n '#stats' index.html` returning only the section itself, so the id can change freely)

- [ ] **Step 1: Delete the old Stats section**

Remove `<section id="stats">...</section>` entirely. Delete its six keys — `stat1_n`, `stat1_l`, `stat2_n`, `stat2_l`, `stat3_n`, `stat3_l` — from both `t.ar` and `t.en` (`grep -n "stat1_n\|stat1_l\|stat2_n\|stat2_l\|stat3_n\|stat3_l" index.html` to find all twelve lines). These are independent, separately-named keys from Mentor's `mstat1_n/l`–`mstat3_n/l` (Task 5 keeps those as-is) — there is no shared key to preserve, delete all six cleanly.

- [ ] **Step 2: Add the ledger section**

```html
<section id="the-record" class="bl-sec bl-pad">
  <div class="bl-wrap">
    <h2 class="bl-h2">
      <span class="sm" data-key="record_kicker"></span>
      <span class="lg" data-key="record_h"></span>
    </h2>
    <div class="bl-ledger">
      <div>
        <p class="bl-mono" data-key="record_intro_label"></p>
        <p class="bl-body" data-key="record_intro"></p>
      </div>
      <div class="bl-certs">
        <p class="bl-mono bl-certs-h" data-key="record_certs_h"></p>
        <div class="bl-certs-row">
          <div class="bl-slab bl-cert" role="img" aria-label="TopStep — Certified Funded Trader">
            <span class="bl-slab-t">TopStep</span><code>/certs/topstep.jpg</code>
          </div>
          <div class="bl-slab bl-cert" role="img" aria-label="AquaFutures — Certificate of Funded Trader">
            <span class="bl-slab-t">AquaFutures</span><code>/certs/aquafutures-1.jpg</code>
          </div>
          <div class="bl-slab bl-cert" role="img" aria-label="FundedNext Futures — Rising Trader">
            <span class="bl-slab-t">FundedNext</span><code>/certs/fundednext.jpg</code>
          </div>
          <div class="bl-slab bl-cert" role="img" aria-label="AquaFutures — Certificate of Funded Trader">
            <span class="bl-slab-t">AquaFutures</span><code>/certs/aquafutures-2.jpg</code>
          </div>
          <div class="bl-slab bl-cert" role="img" aria-label="The Trading Pit — Challenge Passed">
            <span class="bl-slab-t">Trading Pit</span><code>/certs/tradingpit.jpg</code>
          </div>
          <div class="bl-slab bl-cert" role="img" aria-label="Funded Futures Family — Certificate of Funding">
            <span class="bl-slab-t">Funded Futures</span><code>/certs/fundedfutures.jpg</code>
          </div>
          <div class="bl-slab bl-cert" role="img" aria-label="My Funded Futures — Builder 50K Passing Certificate">
            <span class="bl-slab-t">My Funded Futures</span><code>/certs/myfundedfutures.jpg</code>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
```

(Certificate firm names and the alt-text titles are proper nouns / real certificate titles — kept in English/Latin script in both language versions, matching the brand-name convention already established for "3AMAK Trades" itself staying Latin in Arabic copy.)

Add to `t.en`:

```js
record_kicker: "07 On the record",
record_h: "Seven certificates. One method.",
record_intro_label: "2+ years trading · futures & forex",
record_intro: "Every certificate below is a real funded-account pass from a named prop firm — not a screenshot of a trade, a screenshot of a rulebook being followed.",
record_certs_h: "Verified Certifications",
```

Add to `t.ar`:

```js
record_kicker: "٠٧ في السجل",
record_h: "سبع شهادات. منهج واحد.",
record_intro_label: "أكثر من سنتين تداول · عقود آجلة وفوركس",
record_intro: "كل شهادة تحت هي اجتياز حقيقي لحساب مموَّل من شركة معروفة باسمها — مش سكرين شوت لصفقة، سكرين شوت لالتزام بقواعد كاملة.",
record_certs_h: "شهادات موثّقة",
```

Port the `.bl-ledger`, `.bl-certs`, `.bl-certs-row`, `.bl-cert`, `.bl-slab` CSS (including the fixed 7/4/2-column responsive breakpoints and the staggered `is-in` reveal animation) verbatim from the reference file.

- [ ] **Step 3: Port the certs reveal JS**

Copy the `IntersectionObserver` block from the reference file's `<script>` (search `grep -n "Certs: staggered reveal" gold-direction-c-full.html`) into `index.html`'s existing `<script>` block, unchanged.

- [ ] **Step 4: Verify**

Run: open in browser, scroll to "The Record" section.
Expected: 7 certs shown as one full-width row on a desktop-width window (no empty trailing cells), each stamping in with a stagger the first time the section scrolls into view. Toggle AR — headline and labels swap, firm names stay in Latin script, grid still fills edge-to-edge (mirrored).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: replace Stats section with The Record ledger of certificates"
```

---

## Task 5: Mentor section

**Files:**
- Modify: `index.html` — `<section id="mentor">` (`index.html:1321-1355`ish)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search `BAND 6` / `bl-bio`

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: none new — leaf section

- [ ] **Step 1: Replace the section markup and CSS**

Port the reference file's Mentor band CSS (`.bl-mentor`, `.bl-bio`, `.bl-mentor-photo` slab, `.bl-mentor-figs`) and structure. Keep every existing `t.ar`/`t.en` key already used for this section (`mentor_label`, `mentor_h`, `mentor_h_g`, `mentor_tag`, `mentor_name`, `mentor_title`, `mstat1_n/l`, `mstat2_n/l`, `mstat3_n/l`, `mentor_bio1/2/3`) — **do not rewrite this copy**, it wasn't flagged for any legal issue in the spec. Just re-skin the container: swap card/shadow markup for the Bullion hairline/slab pattern, and convert every element from the old manual `render()` wiring to `data-key` attributes so Task 1's generic sweep picks it up (e.g. `<h2 class="mentor-name" data-key="mentor_name"></h2>` instead of relying on the deleted `document.querySelector('.mentor-name').textContent = txt('mentor_name')` line).

The mentor photo becomes a placeholder slab (real `/mentor.jpg` asset optimization happens in Task 12):

```html
<div class="bl-slab bl-mentor-photo" role="img" aria-label="Omar Alhalabi">
  <span class="bl-slab-t">Omar Alhalabi</span><code>/mentor.jpg</code>
</div>
```

- [ ] **Step 2: Verify**

Run: open in browser, scroll to Mentor.
Expected: bio text, name, title, and the three mentor stats (years/students/payouts) all render in both languages via the toggle, no console errors about missing keys.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "style: re-skin Mentor section to the Bullion system"
```

---

## Task 6: Prop Firms Explained (static content)

**Files:**
- Modify: `index.html` — `<section id="propfirm">` (`index.html:1360-1392`ish)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search `BAND 7`

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: `#bl-prop` anchor kept as `#propfirm` (existing id, existing nav links elsewhere in the codebase may reference it — confirmed safe to keep via `grep -n '#propfirm' index.html`)

- [ ] **Step 1: Re-skin the prose and the stamped facts strip**

Port `.bl-prose`, `.bl-example`→ **skip this class, it's deleted in Task 7 below**, and the `.bl-gold`/`.bl-stamp` gold-band facts strip CSS/markup. Keep the existing `pf_p1`–`pf_p9`, `pf_subhead`, `pf_fact1_n/l` through `pf_fact3_n/l`, `pf_scaling`, `pf_closing` keys and their `data-key` wiring (`#propfirm [data-key]` already works via Task 1's now-global sweep) — **do not reword any of this prose**, per the spec it was deliberately left alone (already conditional, ends on the client's own disclaimer). Just re-skin the container.

Promote the disclaimer sentence to bold, matching the spec's decision — find `pf_closing`'s markup wrapper (`<p class="pf-closing" data-key="pf_closing">`) and wrap its rendered content in `<strong>` via CSS instead of splitting the key (simplest: `.bl-prose .pf-closing{font-weight:600;color:var(--bone);}` rather than editing the string).

- [ ] **Step 2: Delete the old static worked-example**

Remove the `pf_example_sub`/`pf_example_pitch` keys and their markup (`.pf-example-sub`, `.pf-example-pitch` — `index.html:1381-1382`) — replaced entirely by the interactive calculator in Task 7, not reworded in place.

- [ ] **Step 3: Verify**

Run: open in browser, scroll to Prop Firms Explained.
Expected: all prose renders unchanged (same words as the live site today, just restyled), the three payout facts show in a solid-gold strip, the disclaimer sentence is visually bolder than the surrounding text.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "style: re-skin Prop Firms Explained prose and facts strip"
```

---

## Task 7: Interactive payout calculator

**Files:**
- Modify: `index.html` — insert into `<section id="propfirm">` where the old worked-example sat (Task 6 already removed it)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search `the calculator: walk the math`

**Interfaces:**
- Consumes: Task 1, Task 2, Task 6 (inserts into the same section)
- Produces: `window.blCalcSize(btn)`, `window.blCalcSlide(input)` — global functions referenced by `onclick`/`oninput` in the markup below; nothing later depends on these, this is a self-contained leaf feature.

- [ ] **Step 1: Add the calculator markup**

```html
<div class="bl-calc" id="bl-calc">
  <p class="bl-mono bl-calc-h" data-key="calc_h"></p>
  <p class="bl-calc-sub" data-key="calc_sub"></p>

  <div class="bl-calc-step">
    <span class="bl-calc-letter" aria-hidden="true">A</span>
    <div>
      <p class="bl-calc-q" data-key="calc_a_q"></p>
      <div class="bl-calc-opts" role="radiogroup" aria-label="Account size">
        <button type="button" class="bl-calc-opt" data-size="25000" aria-checked="false" onclick="blCalcSize(this)">$25K</button>
        <button type="button" class="bl-calc-opt" data-size="50000" aria-checked="true" onclick="blCalcSize(this)">$50K</button>
        <button type="button" class="bl-calc-opt" data-size="100000" aria-checked="false" onclick="blCalcSize(this)">$100K</button>
        <button type="button" class="bl-calc-opt" data-size="200000" aria-checked="false" onclick="blCalcSize(this)">$200K</button>
      </div>
      <p class="bl-calc-out"><span data-key="calc_fee_label"></span> <b id="bl-calc-fee">$100</b></p>
    </div>
  </div>

  <div class="bl-calc-step">
    <span class="bl-calc-letter" aria-hidden="true">B</span>
    <div>
      <p class="bl-calc-q" data-key="calc_b_q"></p>
      <p class="bl-calc-out"><span data-key="calc_target_label"></span> <b id="bl-calc-target">$4,000</b></p>
    </div>
  </div>

  <div class="bl-calc-step">
    <span class="bl-calc-letter" aria-hidden="true">C</span>
    <div>
      <p class="bl-calc-q" data-key="calc_c_q"></p>
      <label class="bl-calc-slider-label" for="bl-calc-slider"><span data-key="calc_slider_label"></span> <b id="bl-calc-pct">5%</b>
        <input type="range" min="1" max="15" value="5" step="1" id="bl-calc-slider" class="bl-calc-slider" oninput="blCalcSlide(this)">
      </label>
      <p class="bl-calc-out"><span data-key="calc_profit_label"></span> <b id="bl-calc-profit">$2,500</b></p>
    </div>
  </div>

  <div class="bl-calc-step">
    <span class="bl-calc-letter" aria-hidden="true">D</span>
    <div>
      <p class="bl-calc-q" data-key="calc_d_q"></p>
      <p class="bl-calc-out bl-calc-final"><span data-key="calc_payout_label"></span> <b id="bl-calc-payout">$2,125</b></p>
    </div>
  </div>

  <p class="bl-calc-fine" data-key="calc_fine"></p>
</div>
```

- [ ] **Step 2: Add the calculator copy to both languages**

Add to `t.en`:

```js
calc_h: "Walk the math yourself",
calc_sub: "Pick an account size and a hypothetical monthly result — the numbers below update as you go. Illustrative only, not a projection of what you'll earn.",
calc_a_q: "Pick an account size to evaluate on.",
calc_fee_label: "Typical evaluation fee:",
calc_b_q: "Pass the evaluation — hit an 8% profit target without breaking the risk or drawdown rules.",
calc_target_label: "Profit needed to pass:",
calc_c_q: "You're funded. Simulate one hypothetical month:",
calc_slider_label: "Monthly account profit",
calc_profit_label: "Account profit that month:",
calc_d_q: "After the firm's profit split (85% to you, illustrative mid-point of the 80–90% range above).",
calc_payout_label: "Your payout:",
calc_fine: "Illustrative numbers only. Real fees, profit targets and splits vary by firm and account, and depend on rules being followed exactly. Nothing here is a projection, promise or guarantee of what you'd actually make — it's the arithmetic, not the outcome.",
```

Add to `t.ar`:

```js
calc_h: "جرّب الحساب بنفسك",
calc_sub: "اختار حجم الحساب ونتيجة شهرية افتراضية — الأرقام تحت بتتحدّث معك أول بأول. الأرقام للتوضيح بس، مش توقّع لشو رح تربح.",
calc_a_q: "اختار حجم الحساب يلي بدك تقيّم عليه.",
calc_fee_label: "رسوم التقييم المعتادة:",
calc_b_q: "اجتياز التقييم — تحقيق هدف ربح 8% من دون ما تكسر قواعد الريسك أو الدروداون.",
calc_target_label: "الربح المطلوب لتجتاز:",
calc_c_q: "صرت مموَّل. جرّب شهر افتراضي واحد:",
calc_slider_label: "الربح الشهري للحساب",
calc_profit_label: "ربح الحساب هالشهر:",
calc_d_q: "بعد نسبة تقاسم الأرباح من الشركة (85% إلك، وهي نقطة وسط تقريبية من مدى 80-90% فوق).",
calc_payout_label: "السحب يلي بيوصلك:",
calc_fine: "الأرقام هون للتوضيح بس. الرسوم الحقيقية وأهداف الربح ونسب التقاسم بتختلف من شركة لشركة ومن حساب لحساب، وبتعتمد على الالتزام الكامل بالقواعد. ولا شي هون توقّع أو وعد أو ضمان لشو رح تربح فعلياً — هاد حساب رياضي، مش نتيجة مضمونة.",
```

- [ ] **Step 3: Port the calculator CSS and JS**

Copy the `.bl-calc*` CSS block and the `blCalcFees`/`blCalcRender`/`window.blCalcSize`/`window.blCalcSlide` JS verbatim from the reference file's `<style>` and `<script>` blocks into `index.html`'s equivalents.

- [ ] **Step 4: Verify**

Run: open in browser, scroll to the calculator.
Expected: clicking $25K/$50K/$100K/$200K updates the evaluation fee and profit target; dragging the slider updates the percentage label, account profit, and payout live; numbers are plausible (e.g. $50K + 5% → $2,500 profit → $2,125 payout). Toggle AR — all labels and the fine print translate, numbers stay `direction:ltr` (don't reverse digit order).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add interactive walk-the-math payout calculator"
```

---

## Task 8: Proof section re-skin (copy untouched)

**Files:**
- Modify: `index.html` — `<section id="proof">` (`index.html:1397-1409`ish)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search `BAND 8`

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: none

- [ ] **Step 1: Re-skin only**

Keep every existing key (`proof_label`, `proof_h`, `proof_h_g`, `proof1_tag`/`proof1_title` through `proof3_tag`/`proof3_title`) and their exact current values in both languages **completely unchanged** — this is the one section under a standing instruction not to edit copy. Convert the markup to the Bullion hairline-grid slab pattern (no cards/shadows, `.bl-bar-play` triangle reused from Task 3's hero video) and convert the wiring to `data-key` attributes so Task 1's sweep handles it (delete the old manual `render()` lines if any survived — they shouldn't, Task 1 replaced the whole function).

- [ ] **Step 2: Add the disclaimer chrome line (new framing, not a copy edit)**

```html
<p class="bl-proof-note" data-key="proof_note"></p>
```

Add to `t.en`:
```js
proof_note: "Individual outcomes. They are not typical, not promised, and not an indication of what any other trader will do.",
```

Add to `t.ar`:
```js
proof_note: "نتائج فردية. مش نموذجية، مش موعودة، ومش مؤشر لشو رح يحققه أي متداول ثاني.",
```

- [ ] **Step 3: Verify**

Run: open in browser, scroll to Proof.
Expected: the three "Student Win" claims read word-for-word identical to the current live site (diff against `git show HEAD:index.html` if unsure), just restyled; the new dim disclaimer line sits beneath the grid.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "style: re-skin Proof section, copy untouched, add outcomes disclaimer"
```

---

## Task 9: Apply — 8-step form

This is the largest task. The reference mockup only builds 3 of 8 steps (the three distinct chrome patterns); this task builds all 8 using the live site's real current question copy, in the new chrome.

**Files:**
- Modify: `index.html` — `<section id="apply">` (`index.html:1414-1541`ish) and the step-navigation JS (search `grep -n "function nextStep\|function prevStep\|currentStep" index.html` for the existing step-control functions — keep their names/logic, only restyle what they touch)

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: none — leaf, but must not break the existing `api/submit.js` integration (confirm the form's field names/ids referenced by the submit handler are unchanged — `grep -n "getElementById('f_" index.html` lists them, e.g. `f_name`, `f_phone`, `f_email`, `f_country`; keep every one of these ids exactly as-is, only restyle the elements)

- [ ] **Step 1: Re-skin the form chrome**

Port `.bl-field`, `.bl-input`, `.bl-phone`/`.bl-cc`, `.bl-choices`/`.bl-choice`, `.bl-form-nav` CSS from the reference file. Apply these classes to the existing 8 step `<div>`s (`index.html:1414-1541`) in place of their old classes — **keep every existing `id`, `data-key`, `data-value`, `name` attribute exactly as they are today**, this step only changes CSS classes and removes old card/box wrapper markup, it does not change field ids, question keys, or the step count/order.

- [ ] **Step 2: Re-skin the confirmation screen**

Same treatment for the confirmation state (`#formConfirm` or equivalent — `grep -n "formConfirm" index.html`) using `.bl-btn`-style CTA for the WhatsApp confirmation link, keeping its existing dynamic `waLink`-building JS untouched.

- [ ] **Step 3: Apply the one Task-required copy rework in this section**

Update the Apply section header (`apply_h`/`apply_h_g` — the only copy change scoped to this task per the spec):

In `t.en`, change `apply_h_g` from `"Changing How You Make Money"` to:
```js
apply_h_g: "Changing How You Trade",
```

In `t.ar`, change `apply_h_g` from `"تغيير طريقة كسبك للمال"` to:
```js
apply_h_g: "تغيير طريقة تداولك",
```

(`apply_h`/`apply_label`/`apply_sub` are unchanged — only the emphasized second half of the headline was flagged.)

- [ ] **Step 4: Verify the submit flow still works end to end**

Run: `vercel dev` (needed for `/api/submit` to respond), open the local URL, fill out all 8 steps, submit.
Expected: form submits successfully (check the Network tab for a 200 from `/api/submit`), confirmation screen shows, WhatsApp link is populated with the pre-filled message. Toggle AR mid-form — question text and choice labels translate, RTL layout holds (progress bar direction, choice-key letters, phone input flow all mirror correctly).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "style: re-skin the 8-step application form, apply headline reworded"
```

---

## Task 10: Decide comparison table

**Files:**
- Modify: `index.html` — `<section id="decide">` (`index.html:1546-1587`)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search `BAND: DECIDE` or `bl-cmp`

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: none

- [ ] **Step 1: Re-skin the table**

Port the reference file's comparison-table CSS (plain-rule grid, no boxes; "without" column in `--dim`/`--gold-lo`; "with" column under a solid-gold header with black type; the sub-820px responsive stacking with injected `data-col` labels) onto the existing markup structure (`decide-cols-header`, `decide-rows`, `decide-row` — keep these classes' HTML structure, just restyle). Keep `bad_label`/`bad_title`/`good_label`/`drow1`–`drow3` (all three fields each) completely unchanged in both languages — only `good_title` and `drow4_good` are reworded (next step).

- [ ] **Step 2: Apply the two Task-required copy reworks**

In `t.en`:
```js
good_title: "Rule-Led, Repeatable, In Control",   // was "Confident, Consistent, Free"
// ...
drow4_good: "A skill you own and a process you can repeat",   // was "Consistent income built on real skill"
```

In `t.ar`:
```js
good_title: "منضبط، متكرر، بقرارك",   // was "واثق، ثابت، حر"
// ...
drow4_good: "مهارة تمتلكها ومنهج تقدر تكرره",   // was "دخل ثابت مبني على مهارة حقيقية"
```

`drow4_label` ("The Outcome" / "النتيجة") and `drow4_bad` ("Still dependent on a job you don't control" / "تظل تابعاً لوظيفة لا تتحكم بها") are unchanged.

- [ ] **Step 3: Verify**

Run: open in browser, scroll to Decide, resize the window below 820px.
Expected: desktop shows a two-column comparison with the gold "with" header; below 820px it stacks with "Without"/"With" labels appearing per row. Toggle AR — table mirrors, new wording reads naturally in Arabic (not a literal transliteration).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "style: re-skin Decide table, reword with-column title and outcome row"
```

---

## Task 11: FAQ, Final CTA, Footer

**Files:**
- Modify: `index.html` — `<section id="faq">`, `<section id="final-cta">`, `<footer>` (`index.html:1592-1641`)
- Reference: `.superpowers/brainstorm/directions/gold-direction-c-full.html` — search `BAND: FAQ`, `BAND: FINAL`, `<footer`

**Interfaces:**
- Consumes: Task 1, Task 2
- Produces: none

- [ ] **Step 1: Re-skin FAQ, convert to native `<details>`**

Port the reference file's `.bl-faq` `<details>`/`<summary>` accordion CSS and the `+`/`−` toggle JS (search `grep -n "bl-faq summary" gold-direction-c-full.html`) into `index.html`, replacing whatever accordion mechanism is currently used (confirm via `grep -n '<section id="faq">' -A 30 index.html`). Keep `faq1`–`faq5` `_q`/`_a` keys — only `faq4` is reworded.

- [ ] **Step 2: Apply the FAQ 4 rework (question and answer both change)**

In `t.en`:
```js
faq4_q: "How long before the process feels repeatable?",   // was "How long before I see real results?"
faq4_a: "It depends entirely on the work you put in. Most people need 60–90 days of focused practice before the routine stops feeling like guesswork. No timeline can be promised — some take longer, and some never get there.",
```

In `t.ar`:
```js
faq4_q: "كم من الوقت حتى يصير المنهج مريح وتلقائي؟",   // was "كم من الوقت حتى أرى نتائج؟"
faq4_a: "الأمر يعتمد كلياً على الجهد يلي بتقدّمه. معظم الناس بيحتاجوا 60-90 يوماً من التمرين المركّز لحتى يصير الروتين مو تخمين. ما فيه وقت مضمون — في ناس بتاخد وقت أطول، وفي ناس ما توصل أبداً.",
```

- [ ] **Step 3: Re-skin Final CTA and apply its rework**

Port `.bl-final` gold-band-echo CSS. In `t.en`:
```js
final_p: "The market moves every day. The only question is whether you show up to it with a plan.",   // was "...whether you're on the right side of it."
```

In `t.ar`:
```js
final_p: "السوق يتحرّك كل يوم. السؤال الوحيد: هل رح تدخله بخطة؟",   // was "...هل أنت على الجانب الصحيح منه؟"
```

`final_h`/`final_h_g`/`cta4`/`cta4_sub` unchanged.

- [ ] **Step 4: Re-skin the footer, keep real links verbatim**

Port footer typography/layout CSS only. The real Instagram/TikTok/Facebook/WhatsApp URLs, privacy/terms `href`s, and the `footer_copy` key's HTML (which already includes "Results are not guaranteed · Not financial advice") stay **completely unchanged** — this key already uses `innerHTML` (it has a link inside it), so give it `data-key-html="footer_copy"` (Task 1's sweep handles this attribute) instead of `data-key`.

- [ ] **Step 5: Verify**

Run: open in browser, scroll through FAQ/Final CTA/Footer, click each footer social link (should open the real profiles in a new tab), toggle AR.
Expected: FAQ accordion opens/closes with `+`/`−` swapping correctly in both directions of `dir`; final CTA shows the reworded line; footer links all resolve to the real URLs; copyright/compliance line intact.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "style: re-skin FAQ/Final CTA/Footer, apply FAQ4 and final_p reworks"
```

---

## Task 12: Technical fixes bundled into this refine

**Files:**
- Modify: `index.html` `<head>` (meta tags), the ad-pixel comment block, all `<img>` tags
- Create: WebP versions of `mentor.jpg`, `og-image.png`, and the 7 cert images (tooling: any image conversion tool available in the environment, e.g. `cwebp` if installed, or note in the commit if converted externally and just committed as new files)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent, can be done in parallel with Tasks 3–11 if using subagent-driven-development)
- Produces: none

- [ ] **Step 1: Add canonical and hreflang tags**

In `index.html`'s `<head>`, after the existing Open Graph block, add:

```html
<link rel="canonical" href="https://3amaktrades-landing.vercel.app/" />
<link rel="alternate" hreflang="ar" href="https://3amaktrades-landing.vercel.app/" />
<link rel="alternate" hreflang="en" href="https://3amaktrades-landing.vercel.app/" />
<link rel="alternate" hreflang="x-default" href="https://3amaktrades-landing.vercel.app/" />
```

(Same URL for both — the site is single-URL client-toggled, not per-language routes. This at least tells crawlers both languages exist at this URL, which is strictly better than the current zero signal. **Note for the client:** true per-language indexing would need separate `/en` and `/ar` routes, which is a bigger architectural change than fits this refine — flag this as a follow-up, don't build it here.)

- [ ] **Step 2: Fix the two missing `alt` attributes**

Run: `grep -n '<img' index.html` and check each tag has a non-empty `alt`. The diagnostic found 2 of 13 missing — the cert-lightbox `<img src="" alt="">` (populated dynamically by JS when an image is clicked, leave as-is, it's set at runtime) and the country-flag `<img id="ccFlag">` in the phone input (add `alt=""` explicitly since it's decorative next to visible text, not `alt` missing entirely — an empty `alt` on a confirmed-decorative image is correct, not a bug; only add it if it's currently absent rather than empty).

- [ ] **Step 3: Convert images to WebP with responsive `srcset`**

For `mentor.jpg`, `og-image.png`, and each of the 7 `/certs/*.jpg` files: generate a `.webp` version alongside the original (keep the original as a fallback), then update each `<img>` (now inside Task 4/5's slab placeholders, or wherever the real asset is finally wired in) to:

```html
<picture>
  <source srcset="/mentor.webp" type="image/webp">
  <img src="/mentor.jpg" alt="Omar Alhalabi" loading="lazy" />
</picture>
```

For the 7 cert thumbnails, same `<picture>`/`<source>` pattern, keeping the existing `loading="lazy"` attribute.

- [ ] **Step 4: Leave the ad-pixel block as documented, don't enable it**

No change needed — it's already correctly commented out with clear enable instructions (`index.html:31-52`ish). Confirm it's untouched by this refine; enabling it requires real Pixel IDs from the client, out of scope here.

- [ ] **Step 5: Verify**

Run: `vercel dev`, open devtools Network tab, reload.
Expected: WebP images load (check the `Type` column), total page weight for images is meaningfully lower than the ~830KB baseline (check via Network tab's total transferred size, images filter). View page source, confirm the canonical/hreflang tags are present. Run the project's design-lint hook (`impeccable hooks status` should show no new unaddressed findings) if it fires on this file.

- [ ] **Step 6: Commit**

```bash
git add index.html *.webp certs/*.webp
git commit -m "fix: add canonical/hreflang tags, WebP images with fallback, missing alt text"
```

---

## Task 13: Full-page QA pass and deploy

**Files:** none (verification only)

**Interfaces:**
- Consumes: all previous tasks

- [ ] **Step 1: Full content diff against the pre-refine tag**

Run: `git diff pre-refine-2026-09-24 -- index.html | grep '^-.*data-key\|^-.*<a href' ` (or just eyeball a side-by-side) to confirm every real link (social, privacy, terms, WhatsApp), every real stat, and the Proof section's three claims all survived into the new version unchanged except the documented reworks.
Expected: no accidental content loss — every diff line is either a class/CSS change, a documented copy rework from Task 8/9/10/11, or new content (calculator, ledger) explicitly added by this plan.

- [ ] **Step 2: Bilingual pass**

Run: open the live-reloaded page, click through every section in Arabic (default) first, then English. For each section, confirm: no leftover empty `data-key` elements (would render blank — a missing translation), no visual overlap/clipping, numerals stay LTR-locked where required (stats, calculator, prices).

- [ ] **Step 3: Native Arabic review flag**

This plan's Arabic translations (Tasks 3, 4, 7, 8, 10, 11) were written by an AI, not a native speaker, following the existing `t.ar` voice as a style guide. **Before shipping, have a native Arabic speaker read through every new/changed `t.ar` string** (the exact list: `nav_system`, `nav_mentor`, `nav_proof`, `nav_status`, `hero_kicker`, `hero_h1_a`, `hero_h1_em`, `hero_sub`, `hero_fine`, `record_kicker`, `record_h`, `record_intro_label`, `record_intro`, `record_certs_h`, `calc_h` through `calc_fine` (11 keys), `proof_note`, `apply_h_g`, `good_title`, `drow4_good`, `faq4_q`, `faq4_a`, `final_p`) and flag anything that reads stiff, mistranslated, or inconsistent with the existing casual Levantine voice. This is a real gap in this plan, not a formality — don't skip it.

- [ ] **Step 4: Design-lint pass**

Run: whatever triggers the project's `impeccable` design hook on `index.html` (it fires automatically on Write/Edit in this environment; if running standalone, check `.impeccable/hook.cache.json` after a final edit-and-save cycle, or run the CLI equivalent).
Expected: no unaddressed findings beyond documented, reasoned sanctioned exceptions (none are expected on the real site build — the earlier sanctioned exceptions in this session were all scoped to the throwaway mockup files under `.superpowers/brainstorm/`, not `index.html`).

- [ ] **Step 5: Lighthouse/perf spot-check**

Run: Chrome DevTools Lighthouse (or `npx lighthouse` if available) against the local `vercel dev` URL, both mobile and desktop presets.
Expected: image-weight-related performance score improves versus a baseline run against `pre-refine-2026-09-24` (document both scores in the deploy notes — this is the concrete evidence for the §1 image-optimization fix actually working, not just "should be faster").

- [ ] **Step 6: Deploy and smoke-test**

Run: `git push origin main` (this repo auto-deploys to Vercel on push to `main`).
Poll: check the Vercel deployment status until it reports ready (the project's standing convention — never report done off a bare successful push).
Then: open the live `https://3amaktrades-landing.vercel.app/` URL and re-run Step 2's bilingual click-through against production, not just the local dev server.

- [ ] **Step 7: Final commit (if Step 3's native review produced fixes)**

```bash
git add index.html
git commit -m "fix: apply native-speaker review corrections to new Arabic copy"
git push origin main
```

(Skip this step if Step 3 found nothing to fix.)
