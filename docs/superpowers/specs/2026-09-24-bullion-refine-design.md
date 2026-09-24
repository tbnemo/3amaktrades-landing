# 3AMAK Trades — "Bullion" refine (design spec)

Status: **approved**, ready for implementation planning.
Round: website refine (existing site → full creative/technical overhaul), per the
project's standing "Website refine" process.

## 1. Why this refine happened

A diagnostic pass on the live site (single `index.html`, deployed to Vercel from
`main`) found, alongside the visual redesign opportunity, several concrete technical
gaps to fix in the same pass:

- **No analytics** — Meta/TikTok pixels fully commented out with placeholder IDs, no
  GA equivalent. Zero visibility into traffic/conversion beyond what reaches Slack.
- **SEO gap** — no canonical tag, no hreflang; the AR/EN toggle is pure client-side JS
  on one URL, so crawlers only ever see the Arabic default.
- **~830KB of unoptimized images** (mentor photo, logo, 7 certs, OG image) — no WebP,
  no responsive `srcset`.
- **Minor accessibility gaps** — a couple of missing `alt` attributes, borderline
  contrast on muted body text.
- Site only resolves on the `vercel.app` subdomain — no custom domain.

Client decision: fix all of the above **in the same batch** as the visual refine, not
as a separate later pass.

A git tag `pre-refine-2026-09-24` was pushed to `origin` pointing at the live site's
pre-refine commit (`9219fa7`), as a rollback point.

## 2. Creative process and the direction landing on "Bullion"

Per the "Website refine" process, visual exploration started wide open (palette
explicitly *not* treated as a constraint) with three non-gold directions — **Ledger**
(warm paper/oxblood), **Tape** (graphite/ultramarine), **Discipline**
(press-black/vermilion) — each with real hero mockups and reference research (Stripe
Press, Financial Times, Jeton, Tim Grover's site; Topstep and the rest of the
prop-firm category treated as the baseline to avoid).

**Client's call: keep the existing gold/black "Gold Ticker" identity.** This
overrides the design agent's recommendation to retire gold (its case: gold is
category wallpaper for prop-firm sites, and semantically reads as a promise of money,
which fights the no-guaranteed-income rule) — noted for the record, but the client's
decision stands and isn't up for re-litigating.

A second round explored **fresh structure/type/motion within gold+black**, explicitly
not re-skinning the live site's own current execution (candlestick-behind-hero, gold
shimmer CTA, 4px-radius cards) and not re-skinning any of the retired non-gold
directions in gold. Three directions: **Assay** (gold as a struck hallmark, engraved
double-hairline frame), **Vault** (a wall of brass-edged panels, "you don't buy a
seat, you apply for one"), **Bullion** (gold as mass/fill, not shine — stacked bands,
a solid gold bar you read black type off).

**Client's pick: Bullion.**

## 3. The Bullion design system

**Thesis:** gold as mass, not shine. The page is built from stacked bands of unequal
height, like bars racked on a shelf. Gold appears as a solid filled area you read
black type off — the inverse of every gold-accent-on-black trading page, including
the site's own previous execution.

**Palette**
- `--void:#050505` — the client's original near-void, kept
- `--band:#101010` / `--band-2:#181817` — charcoal steps
- `--gold:#D4AF37` — the original gold, used as a **fill**, not just an accent
- `--gold-lo:#7A6218` — shadowed second layer (rules, secondary fills)
- `--bone:#F2EEE4` — reading color
- `--dim:#8B887F` — secondary text
- `--ink:#0A0802` — type color used *on* gold

**Type**
- EN display: Big Shoulders Display (headlines, uppercase, poster-scale)
- AR display: Changa
- EN body: Inter · AR body: Noto Sans Arabic
- Mono/labels: reuse the display family at small sizes with letter-spacing, not a
  separate mono face (see §5 for the caption/label contrast fixes made mid-review)

**Structural rules**
- 0 radius, no shadows, no glow anywhere — depth comes from tonal steps and hairline
  rules only, same discipline as the live site's existing "No-Shadow Rule."
- Hairline gutters (1px, `#241D08`) divide grids instead of card borders.
- The gold fill is deliberately rationed to a handful of moments (hero stat bar,
  prop-firm payout facts strip, a selected form choice, Decide's "with" column
  header + final CTA) so it stays an event, not wallpaper.
- **No eyebrow chips anywhere.** The classic "tiny uppercase label directly above an
  oversized headline" pattern was flagged mid-review as the default AI-SaaS hero
  shape and removed. Section kickers are instead a small lead line baked into the
  `<h2>`/`<h1>` itself (baseline-mixed setting), and the hero's "applications open"
  status moved into the nav bar as a small dot + text indicator.

**Signature elements**
- **Hero: an ambient candlestick backdrop**, added back into Bullion per client
  request after the direction was chosen (the winning pitch had replaced the site's
  candlestick motif with a giant cropped numeral). Implemented as a *quiet* texture —
  muted gold tones, not the live site's literal green/red market chart — 13 candles
  grow in on load, staggered, with the rightmost candle holding a slow live-feeling
  pulse. Respects `prefers-reduced-motion`. Hero-only; never repeated elsewhere on
  the page.
- **Hero VSL, sized deliberately large.** Iterated live with the client using a
  temporary drag/resize tool built into the mockup (removed once the target was
  found). Final: **900×500px** (9:5), right-aligned next to a **hard-pinned 572px**
  text column (that 572px is the original 1.05fr/1.05fr+1fr split's actual rendered
  width at the band's old 1180px cap — preserved exactly, not approximated, after an
  earlier miscalculation regressed it to 460px mid-review). The hero band's own
  container is widened to `min(1536px,100%)` specifically to fit both without either
  column shrinking for the other; the video flexes down gracefully
  (`minmax(260px,900px)`) on narrower desktop widths rather than forcing the text
  column to give up room. Mobile stacks video-first, text below (matches the live
  site's existing convention).
- **The solid gold band (Band 3 of the hero, and reused at section scale in Prop
  Firms Explained and Decide/Final CTA):** `background:var(--gold)` with black
  (`--ink`) type, wiping in from the inline-start on load (`scaleX`, no shimmer/
  gradient sweep). This is the single most distinctive move in the system.
- **Certs: staggered reveal, not a scroller.** Originally a horizontally-scrolling
  row (rejected by the client — "instead of a scroller, animation"). Now a **fixed
  7-column grid** on desktop (not `auto-fit`, which left phantom empty cells since
  7 is an exact, deliberate count) collapsing to 4 then 2 columns on smaller screens;
  each cert slab stamps into place with a staggered grow-in, triggered once via
  `IntersectionObserver` when the row scrolls into view.
- **Prop Firms Explained: an interactive "walk the math" calculator**, added per
  client request, replacing the old static "2.5% worked example." Four lettered
  steps (A–D): pick an account size ($25K/$50K/$100K/$200K) → see the illustrative
  evaluation fee; see the profit target (8%) needed to pass; a slider for a
  hypothetical monthly profit % → live account-profit figure; the resulting payout
  after an illustrative 85% split. Every number is explicitly labeled illustrative,
  and the block closes with "this is arithmetic, not a promise" framing to stay
  clear of the no-guaranteed-income rule.

## 4. Section-by-section mapping (real copy, not placeholder)

Built from the live site's actual `t.en` copy object and section HTML
(`hero`/`stats`/`mentor`/`propfirm`/`proof`/`apply`/`decide`/`faq`/`final-cta`/
`footer`), not invented content, except where explicitly noted below.

1. **Hero** — as described in §3.
2. **"The Record" (replaces the standalone Stats section).** The hero's gold bar
   already carries `7 Certificates · $500K+ Funded · 20+ Trained · $100K+ Paid out`;
   the live site's separate Stats section (`2+ Years · 20+ Students · $100K+
   Payouts`) would have repeated two of those three numbers one screen later,
   weakening the bar. **Decision: replaced with an itemized ledger of the 7
   certificates by issuing firm** (TopStep, AquaFutures ×2, FundedNext Futures, The
   Trading Pit, Funded Futures Family, My Funded Futures — real names, real
   certificate titles from the live site's `alt` text), giving the "7" in the gold
   bar a genuine second proof point instead of a restatement. The orphaned "2+ years
   experience" figure survives as a micro-label in this band and in the Mentor
   section's own figures. **Approved; reversible** if the client later wants the
   original 3-stat block back (swap the ledger rows for the existing `.bl-stamp`
   gold-strip pattern, already used twice elsewhere).
3. **Mentor** — Omar's bio and credentials, real copy from the live site. Photo is a
   placeholder slab (`/mentor.jpg` convention, same as the hero logo's fallback
   pattern) pending the real asset.
4. **Prop Firms Explained** — real explanatory copy, plus the interactive calculator
   (§3) replacing the old static example, plus the three payout facts stamped into a
   gold strip.
5. **Proof — copy untouched, per standing instruction.** Visual container re-skinned
   to Bullion's system (no cards/shadows, hairline grid, same media-slab treatment as
   the hero). **Flagged, not fixed:** now the largest compliance exposure on the page
   since every other section's wording was brought into line with the
   no-guaranteed-income rule around it (see §5) — these three lines are specific
   dollar-and-timeline claims with no footage behind them yet. **One new line of
   chrome was added** beneath the grid — *"Individual outcomes. They are not
   typical, not promised, and not an indication of what any other trader will do."*
   — new framing, not an edit to the copy itself. **Approved to keep** until real
   testimonials replace the section.
6. **Apply — the 8-step form.** Three of eight steps built (plain text input, phone
   + country-code picker, choice radiogroup) — the three distinct chrome patterns;
   steps 4–8 reuse patterns 1 and 3. Progress bar/counter hard-wired to "of 8" so the
   real implementation drops its own step content in without touching the chrome.
   Flat underline inputs (no boxes), gold focus state, solid-gold Next button, quiet
   mono Back button, selected choice flips to solid gold/black type.
7. **Decide — comparison table.** No red available in this system; "without" column
   uses `--dim`/`--gold-lo`, "with" column uses a solid-gold header with black type.
   Responsive: header row hides below 820px, rows stack with injected column labels.
8. **FAQ** — real questions, native `<details>` accordion, `+`/`−` toggle.
9. **Final CTA** — echoes the gold-band motif.
10. **Footer** — real Instagram/TikTok/Facebook/WhatsApp links, real privacy/terms
    paths, live copyright line (already includes "Results are not guaranteed · Not
    financial advice") reproduced verbatim.

## 5. Copy changes requiring sign-off (approved)

Six wording changes, all preserving the same facts/meaning, made specifically to
clear the no-guaranteed-income constraint — **all approved as part of "lets gooo."**
Full before/after with reasoning is preserved in
`.superpowers/brainstorm/directions/gold-direction-c-full-notes.md` (local,
gitignored — copy the relevant section into the implementation PR description so the
reasoning isn't lost):

1. Decide "with" column title: *"Confident, Consistent, Free"* → *"Rule-Led,
   Repeatable, In Control"*
2. Decide row 4 ("The Outcome"): *"Consistent income built on real skill"* →
   *"A skill you own and a process you can repeat"*
3. Apply headline: *"…changing how you make money"* → *"…changing how you trade"*
4. FAQ 4, question and answer: removed *"some students see profitable weeks within
   30 days"*; kept the real 60–90 day expectation, added explicit downside language.
5. Prop Firm Explained worked example: *"…lands directly in your pocket… enough to
   walk away with a real payout"* → *"…would be eligible for withdrawal… the math
   only ever asks for one small, controlled move, correctly executed."*
6. Final CTA: *"…whether you're on the right side of it"* → *"…whether you show up to
   it with a plan."*

Everything else in the prop-firm prose was **deliberately left alone** (already
conditional, ends on the client's own "never guaranteed" disclaimer — promoted to
bold rather than rewritten).

## 6. Bilingual requirement

Every new rule uses logical properties (`inset-inline`, `border-inline`,
`padding-block`, `margin-inline-start`, etc.) so the existing single-`dir`-toggle
translation system continues to mirror the whole page with no second stylesheet —
verified throughout via the hero's `AR` toggle button on each mockup. Arabic
translations of any new/changed copy (§5, the calculator's UI strings, the ledger's
firm names, footer) still need to be written — this spec covers structure and
English copy; the implementation plan should account for extending `t.ar` to match.

## 7. Hard constraints carried through unchanged

- Logo used exactly as-is everywhere (no redesign); `/logo.png` with the existing
  text-fallback `onerror` pattern where the asset isn't available yet.
- Never imply guaranteed profit/income anywhere (drove §5).
- No fabricated evidence beyond what's already real (certs, stats, mentor bio) —
  Proof section is the one standing, flagged exception, untouched per instruction.
- Oxify/other-client rules are not applicable here; this project has no equivalent
  standing exceptions beyond the ones listed above.

## 8. Reference implementation (ground truth for the build)

The approved full-page mockup, with every decision in this spec actually built out
(not just described), lives at:

```
.superpowers/brainstorm/directions/gold-direction-c-full.html
```

(gitignored, local-only — the implementation plan should treat this file as the
source of truth for markup/CSS/motion to port into the real `index.html`, not
re-derive the design from this written spec alone). Companion notes:
`.superpowers/brainstorm/directions/gold-direction-c-full-notes.md`.

## 9. What implementation covers (for the next step — writing-plans)

- Port the Bullion system (tokens, type, the section-by-section mapping in §4) from
  the mockup into the real `index.html`, replacing the current "Gold Ticker"
  execution.
- Apply the six copy changes in §5, and extend `t.ar` for all new/changed strings.
- Build out the real 8-step form (the mockup only specifies the chrome/3
  representative steps).
- Wire the real assets (mentor photo, cert images) in place of the placeholder
  slabs, with the image-optimization fixes from §1 (WebP, responsive `srcset`)
  applied at the same time rather than ported as-is.
- Fix the §1 technical items: analytics wiring (real pixel IDs when the client has
  them, or leave the existing commented-out/documented pattern), canonical +
  hreflang tags, and the remaining accessibility gaps.
- Regenerate `DESIGN.md`/`PRODUCT.md` (on `internal-docs`, per this repo's standing
  convention of keeping those private) from the *shipped* result once implementation
  is done, rather than hand-writing them now — matches how those docs were built the
  first time.
