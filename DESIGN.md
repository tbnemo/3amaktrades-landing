---
name: 3AMAK Trades
description: Bilingual gold/black VSL landing page for a prop-firm trading mentorship
colors:
  ticker-gold: "#D4AF37"
  ticker-gold-dim: "#B8960C"
  session-black: "#050505"
  paper-white: "#ffffff"
  ticker-gray: "#777777"
  loss-red: "#ef4444"
typography:
  display:
    fontFamily: "Montserrat, sans-serif"
    fontSize: "clamp(36px, 6vw, 68px)"
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "-1px"
  headline:
    fontFamily: "Montserrat, sans-serif"
    fontSize: "clamp(26px, 4vw, 42px)"
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "-1px"
  body-en:
    fontFamily: "Inter, system-ui, sans-serif"
    fontWeight: 400
    lineHeight: 1.6
  body-ar:
    fontFamily: "Cairo, sans-serif"
    fontWeight: 400
    lineHeight: 1.9
  label:
    fontFamily: "inherit"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "1.5px"
rounded:
  sm: "4px"
  md: "6px"
spacing:
  section-y: "100px"
  container-max: "900px"
components:
  button-primary:
    backgroundColor: "{colors.ticker-gold}"
    textColor: "#000000"
    rounded: "{rounded.sm}"
    padding: "16px 44px"
---

# Design System: 3AMAK Trades

## Overview

**Creative North Star: "The Gold Ticker"**

The whole system reads as a live trading terminal at rest: a near-void black session backdrop with one moving, glowing element — gold — that stands in for the market itself. The live candlestick chart behind the hero isn't decoration bolted onto a marketing page; it's the thesis of the design made literal. Everything else (typography, cards, dividers) borrows the same restraint: dark, quiet, and confident, with gold reserved for the things that matter (headlines' second word, CTAs, proof numbers, dividers between sections).

The palette is fixed by brand commitment (see PRODUCT.md) — gold and black are not a starting point to explore away from. Visual work happens *within* this system, not by replacing it. A full palette swap (e.g. to white/blue) was explicitly considered and rejected during this project's life: it read as generic fintech instead of "elite trader," which is the opposite of the point.

**Key Characteristics:**
- Near-void black backdrop (flat and subtly-gradiented variants alternate by section) with a single gold accent used sparingly and purposefully
- Two headline fonts doing two different jobs: Montserrat (uppercase, heavy, English/display) vs. Cairo (Arabic body/display) — never the same font family serving both languages
- A gold divider line with a soft radial glow marks every section boundary, standing in for "shadows" in a system that otherwise has none
- Motion is restrained and purposeful: a CTA shimmer sweep, fade-up reveals on scroll, a live candlestick chart — never decorative animation for its own sake

## Colors

The palette is almost monochrome by design: one accent color carries all of the system's warmth and attention.

### Primary
- **Ticker Gold** (`#D4AF37`): the entire system's accent. Second word of every major headline (via the `.g` class), all primary CTA buttons, section-label eyebrows, stat numbers, dividers, focus glows. Used sparingly — it reads as valuable because it's rare, not because it's everywhere.
- **Ticker Gold Dim** (`#B8960C`): the darker step of the same hue, used for hover/pressed states and gradient endpoints so gold never feels flat.

### Neutral
- **Session Black** (`#050505`): the flat, primary page background and the background for roughly half of all sections (Proof, Mentor, Prop Firm).
- **Session Black Drift** (`linear-gradient(180deg, #0c0c0c 0%, #060606 100%)`): a barely-perceptible vertical gradient used to alternate section backgrounds (Decide, FAQ) so consecutive sections read as distinct without a hard seam or a lighter color.
- **Card Charcoal** (`linear-gradient(155deg, #171717 0%, #0d0d0d 55%, #0a0a0a 100%)`): the surface for every card-like container (mini-stats, testimonial-style chips, FAQ items) — one step up from the page background, never a flat gray.
- **Card Charcoal Bright** (`linear-gradient(155deg, #212121 0%, #161616 55%, #131313 100%)`): a second, brighter charcoal step reserved for hover/active card states.
- **Paper White** (`#ffffff`): primary text color on the dark backdrop.
- **Ticker Gray** (`#777777`): secondary/muted text — subheads, captions, metadata.
- **Loss Red** (`#ef4444`): the system's only non-gold semantic color, reserved for negative/comparison states (the "without this program" column in Decide, "✗" icons). Never used decoratively.

### Named Rules
**The One Accent Rule.** Gold is the only color allowed to draw the eye. If something new needs emphasis, it either becomes gold or it doesn't get emphasis — a second accent color is not the answer.

**The Chart Exception.** The live candlestick chart uses its own literal market green/red (`#15c89a` up, `#ff5364` down) instead of the site's Ticker Gold / Loss Red pair. This is deliberate and scoped only to that one component — real market data reads correctly with real market colors; it does not license a second UI-wide accent pair anywhere else.

## Typography

**Display Font (English):** Montserrat (with system sans-serif fallback)
**Display Font (Arabic):** Cairo (with generic sans-serif fallback)
**Body Font (English):** Inter (with system-ui, sans-serif fallback)
**Body Font (Arabic):** Cairo (with sans-serif fallback)

**Character:** Heavy, uppercase, tightly-tracked Montserrat for English headlines reads as a confident financial-brand voice; Cairo carries the same weight and confidence into Arabic without trying to force a Latin display face onto Arabic script. The two languages are genuinely two typographic systems, not one translated into the other — matching the project's bilingual-as-two-first-class-languages principle.

### Hierarchy
- **Display** (900, `clamp(36px, 6vw, 68px)`, line-height 1.1): hero headline only. English gets uppercase + `1px` letter-spacing via Montserrat; Arabic stays natural case with `0` letter-spacing.
- **Headline** (900, `clamp(26px, 4vw, 42px)`, line-height 1.1): every section's `h2`. Same English/Arabic split as Display.
- **Label** (700, `11px`, `1.5px` letter-spacing, uppercase in English / natural case at `12-13px` in Arabic): section eyebrows, stat labels, mentor tag — small, gold, always uppercase-tracked in English.
- **Body** (400, `14-16px`, line-height 1.6 English / 1.9-2.1 Arabic): paragraph copy. Arabic consistently gets a taller line-height across the whole system — Cairo needs more vertical room to read comfortably than Inter does.

### Named Rules
**The Gold Word Rule.** Nearly every headline is two segments: a plain white/dark phrase, then a `.g`-classed final word in Ticker Gold. This is the system's single most repeated typographic device — new headlines should default to using it, not invent a different emphasis technique.

## Layout

Single-column, center-aligned sections at a `900px` max-width container (`padding: 0 24px`), `100px` vertical padding per section. The hero breaks this pattern deliberately: on desktop (`≥1024px`) it splits into a text column and a video column so the VSL gets real width instead of living inside the narrow reading column; every other section stays in the standard centered container.

Sections alternate between two background treatments (flat Session Black vs. the barely-there Session Black Drift gradient) purely to create a seam between adjacent sections — never a visible color jump. A thin gold divider line with a soft radial glow (`.section-divider`) sits between every section as the primary way this system marks a boundary, doing the job a hard rule or drop shadow would do in a lighter system.

Mobile collapses multi-column grids (stats, proof, decide, mentor) to a single centered column; the hero's split layout also collapses to stacked (video-first, text below).

## Elevation & Depth

This system is flat by design — there is no shadow vocabulary. Depth is conveyed instead through:
1. **Tonal layering** — Card Charcoal sits one step lighter than Session Black, Card Charcoal Bright one step lighter again for hover states, all without a single `box-shadow`.
2. **A soft radial gold glow** (`radial-gradient(ellipse, rgba(212,175,55,0.05-0.4) 0%, transparent 70%)`) placed behind key elements (section dividers, the Apply/Final CTA sections, and — after a later pass — every other section too) stands in for the "lift" a shadow would normally provide, staying entirely in the brand's gold rather than a neutral gray shadow.

### Named Rules
**The No-Shadow Rule.** Never reach for `box-shadow` to create depth in this system. Reach for a tonal step (Session Black → Card Charcoal → Card Charcoal Bright) or a gold radial glow instead.

## Shapes

Corners are consistently small and businesslike: `4px` is the default radius for nearly every rectangular surface (buttons, cards, form fields, certificate thumbnails); `6px` appears only on a couple of larger surfaces (the lightbox image, video container). Nothing in the system uses a pill/fully-rounded shape or a sharp `0px` corner — `4px` reads as "considered" without softening the brand's serious tone into something playful.

## Components

### Buttons
- **Shape:** `4px` radius, `16px 44px` padding.
- **Primary:** solid Ticker Gold background, black text, `800` weight, uppercase with `0.5px` letter-spacing in English (natural case, `16px`, no tracking in Arabic). A diagonal white-highlight gradient overlay plus a continuously-animated diagonal shimmer sweep (`3.2s ease-in-out infinite`) run across every primary CTA — buttons are meant to feel alive even before anyone touches them, per the tactile-and-confident directive.
- **Hover / Focus:** subtle transform/box-shadow transition (`0.15s`) — kept understated since the shimmer already carries most of the button's personality.

### Cards / Stat Boxes (`.mstat`, similar containers)
- **Corner Style:** `4px`.
- **Background:** Card Charcoal, `1px solid #1e1e1e` border.
- **Content:** a bold gold number (Inter, for numeral clarity in both languages) over a small gray/gold label beneath it — the system's standard way to present a proof metric (years, students, payouts, funded capital).

### Section Header
- **Style:** a small gold uppercase Label eyebrow (plain text, no background chip — an earlier pill/chip treatment was deliberately removed), then a two-tone Headline (`plain-word` + `.g gold-word`), centered, `52px` bottom margin before the section body.

### Certificate / Proof Thumbnails
- **Style:** small (`~78-92px` tall) rounded (`4px`) images in a horizontal scroll row with a thin custom gold-tinted scrollbar (never the browser's default scrollbar) — click any one to open a full-size lightbox (`rgba(0,0,0,0.92)` overlay, `6px` radius on the enlarged image).

### Navigation
- Sticky top nav, transparent-to-solid on scroll not currently implemented — stays a simple fixed bar with the language toggle and a single gold CTA button, consistent across the whole page.

## Do's and Don'ts

### Do:
- **Do** keep gold reserved for emphasis — the moment gold appears on more than roughly one accent per view, it's stopped being an accent.
- **Do** write Arabic and English as two independent, natural texts sharing one meaning — never transliterate or code-switch between them in the same string.
- **Do** use the `.g`-word headline pattern (plain phrase + one gold word) as the default emphasis technique for any new headline.
- **Do** use a tonal step or a gold radial glow for depth, matching the No-Shadow Rule.
- **Do** keep radius at `4px` for new rectangular surfaces unless there's a specific reason to match the `6px` large-surface exception.

### Don't:
- **Don't** introduce a second accent color anywhere outside the live chart's literal market green/red.
- **Don't** bring back a background-and-border "chip" treatment on eyebrow labels — that was tried and explicitly removed for looking like generic AI-generated template design.
- **Don't** use `box-shadow` for elevation.
- **Don't** fabricate proof (testimonials, results, names) — every credibility element in this system is real and sourced from PRODUCT.md's Evidence on Hand; a previous fabricated-testimonials section was removed for this reason and must not be reintroduced casually.
