# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Mixed primary audience, no single persona: complete beginners with zero trading experience, and people who already tried trading or prop firm challenges on their own (often blew accounts) and now want real structure and mentorship instead of guessing. Primarily Arabic-speaking (site defaults to Arabic, colloquial Levantine/Gulf-leaning copy) with a full English translation available via toggle.

## Product Purpose

Bilingual (Arabic default / English toggle) VSL-driven landing page for 3AMAK Trades, a prop-firm trading education and mentorship business run by mentor Omar (Omar Alhalabi). The page's job is to convert visitors into one of two funnels: (1) a free/VIP Discord community application, or (2) a Group Coaching / 1-on-1 Mentorship application (delivered on Skool). Success is a qualified application routed to Slack, or a paid VIP Discord membership via Stripe.

## Positioning

The pitch is a real, currently-active trader's lived system, not recycled "guru" content. Proof is mechanical, not testimonial: the mentor's own verifiable credentials (7 real funded-trader certificates from named prop firms, $500K+ in funded capital, 20+ students trained, $100K+ in verified student payouts) carry the credibility, not claimed success stories. The teaching angle is explicitly risk management, psychology, and a repeatable system — not "find the perfect strategy."

## Operating Context

Visitor flow: Hero (VSL video + live animated candlestick chart backdrop) → Stats → Mentor bio + real certifications → "Prop Firm Explained" (demystifies prop-firm mechanics for beginners: evaluation fees, funded accounts, payout math, profit split) → Proof → 8-step application form → Decide (comparison table) → FAQ → Final CTA.

Backend: Vercel serverless functions route form submissions into Slack with dedup, a honeypot, and priority tagging by budget — #1-new-applications (completed), #2-incomplete-leads (abandoned mid-form), #2-warm-leads (clicked WhatsApp on the confirmation screen).

Community structure: a Discord server (bilingual Arabic/English channel names) with a public Free Community tier and a paid VIP tier ($99/month, Stripe-gated role). Group Coaching and 1-on-1 Mentorship are deliberately NOT sold through Discord automation — they live on Skool instead, reached via a Discord "apply-coaching" channel that funnels back to the site's application form, because that offer needs human vetting rather than instant self-serve checkout.

Stripe: the VIP product and $99/month price already exist live in Stripe. The payment link itself is blocked until the client activates payment methods (e.g. Cards) in their Stripe Dashboard — a client-side account setting, not something fixable via API.

## Capabilities and Constraints

- Single static `index.html` (no framework), plus a few Vercel serverless functions under `/api`. Deployed via Vercel, auto-deploying from the `main` branch on GitHub.
- Bilingual toggle (Arabic default, English) driven by one JS translation object holding every string. Every piece of on-page copy must exist as a fully separate, natural translation in each language — mixing English trading jargon into Arabic sentences (code-switching) is a defect, not a style choice, even though the source material this business speaks/writes in casually mixes languages.
- Legal/compliance constraint: must never imply guaranteed profit or guaranteed income anywhere on the site — only ever teach a process/system.
- No fabricated evidence: names, results, and testimonials must be real or explicitly absent. A placeholder testimonials section (invented names/results) was found and removed for this reason.

## Brand Commitments

- Name: 3AMAK Trades (brand name stays in Latin script even in Arabic copy). Mentor: Omar (Omar Alhalabi).
- Palette: gold (~#D4AF37) and black. This is a deliberate, fixed identity decision — a full palette swap (e.g. to white/blue) was explicitly considered and rejected to preserve brand identity; visual exploration should happen within gold/black, not by replacing it.
- Visual and motion language was benchmarked against salesfirstclass.com (a reference site) for layout/motion inspiration only — never copy its content or claims.
- Voice: casual, warm colloquial Arabic (Levantine-leaning, not stiff MSA) with clean grammar; the English version is a full independent rewrite matching the same meaning, never a transliteration of the Arabic.

## Evidence on Hand

- Real VSL video (YouTube, unlisted): the hero's click-to-play video.
- Real mentor photo at `/mentor.jpg` (background-cleaned via inpainting from a raw source photo).
- 7 real funded-trader certificates in `/certs/` from TopStep, AquaFutures (x2), FundedNext, The Trading Pit, Funded Futures Family, and My Funded Futures.
- Real, current stats: 2+ years experience, 20+ students trained, $100K+ in student payouts, $500K+ in funded trading capital.
- No case studies, press, or testimonials beyond the above — future work must not reintroduce a testimonials section without real, verifiable ones.

## Product Principles

1. Proof over claims — every credibility signal (certificates, stats, bio facts) must be real and verifiable, never invented.
2. Bilingual as two first-class languages — Arabic and English copy are each written to read naturally on their own; never code-switched or transliterated from one into the other.
3. Educate before you sell — jargon (prop firm, funded account, payout, drawdown) gets explained in plain terms before it's used to build trust, especially for the beginner half of the audience.
4. Route by intent, not by tier — VIP is self-serve and automated (Stripe), while Group/1-on-1 coaching is human-vetted (apply, don't just checkout), because a high-touch offer shouldn't be sold like a vending machine.
5. Gold/black premium identity is fixed — it signals "elite trader," not generic fintech; exploration happens inside that palette.
