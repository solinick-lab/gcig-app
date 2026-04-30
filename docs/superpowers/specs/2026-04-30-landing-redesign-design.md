# Landing Page Redesign — "The Vault, Bright"

**Date:** 2026-04-30
**Owner:** Thomas Seirer
**Status:** Approved (verbal), pending build

## Goal

Redesign the public landing page (`landing.html`) for non-members. The current page is a refined editorial design (deep navy + warm cream, IBM Plex + Instrument Serif). It is good but quiet — the user wants it to feel **more cinematic and impressive**, while keeping the editorial DNA.

The redesign mixes two aesthetics:
- **A — real-fund cinema** (Citadel/Two Sigma pacing, hushed bands, big imagery, Apple-product-page rhythm)
- **B — confident editorial scaled up** (today's design, but louder)

Color is **bright, not dark** ("Modern Light Premium" — off-white base + muted sky blue + soft sage as cinematic accents).

## Scope (in)

- Replace `landing.html` with a redesigned single-file HTML page (no framework changes).
- Bring real leadership photos in from `Club Leadership Phtoos/` to a self-contained `landing-assets/` folder.
- Build `landing-v2.html` first; do not overwrite `landing.html` until user approves the visual via local preview.

## Scope (out)

- No invented data (no fabricated AUM, returns, performance numbers).
- No changes to the React app (`client/`), the API (`server/`), or auth.
- No new dependencies. Single file, system fonts + Google Fonts (already used today).

## Palette

| Role | Hex | Use |
|---|---|---|
| Paper | `#FBFAF7` | Page base |
| Ivory | `#F2EFE8` | Subtle alternation between paper sections |
| Ink | `#1A1D24` | Primary text |
| Ink-soft | `#3F434D` | Body |
| Ink-mute | `#73767E` | Eyebrows / meta |
| Sky | `#A6C4DC` | First cinematic interstitial; leadership photo duotone |
| Sage | `#BCCFB7` | Second cinematic interstitial |
| Deep sky | `#3E6A92` | CTA full-bleed; concentrated accent for links |
| Brand gold | `#C9A84C` | Tiny detail only — chapter numerals, hairlines |
| Rule | `rgba(26,29,36,0.10)` | Hairlines |

Page rhythm: paper · paper · **sky-flood** · paper · **sage-flood** · paper · **deep-sky CTA**. Brights only at chapter breaks.

## Typography

Unchanged from today:
- IBM Plex Sans 300/400/500/600 — workhorse
- Instrument Serif italic — accents only

## Section structure

1. **Nav** — slim, transparent over hero, paper+blur on scroll. Existing logo mark, three text links, sign-in button. No structural change.
2. **Hero** (paper, 100vh+) — massive headline (~120–160px desktop, Plex Light + one Instrument Serif accent word), one-line subhead, a hairline meta row at the bottom. Quarter-circle arc in sky in lower-right, draws in on load.
3. **Chapter break I** — full-width hairline + giant `I` numeral (Instrument Serif italic, gold-tinted, ~200px) + eyebrow `§ I — The Approach`.
4. **Approach** — two-column intro (kept from today) + three pillars stacked **full-width vertically**, each with its own arc behind. Generous space between.
5. **Sky interstitial** — full-bleed `#A6C4DC`. One serif italic sentence, ink, centered, slow fade. Small caps attribution underneath.
6. **Chapter break II** — `§ II — The Structure`, same template as I.
7. **Structure (sticky-pinned)** — section title pins on the left (CSS `position: sticky`), five items (Portfolio · Voting · Coverage · Risk · Attendance) reveal on the right via IntersectionObserver. Apple-page pacing. Non-pinned fallback for short viewports.
8. **Chapter break III → Leadership** — new section. Six photos in an asymmetric grid (Eric Winter as larger feature, others smaller). Each photo as **sky-tinted duotone** to mask resolution differences and unify visually. Names in IBM Plex caps, role in Instrument Serif italic.
9. **Sage interstitial** — full-bleed `#BCCFB7`. Quieter than the sky one. Single sentence on governance/accountability.
10. **Governance** — keep today's two-column essay with serif drop cap. Drop cap in **deep sky** instead of navy. Same copy.
11. **CTA** — full-bleed deep sky (`#3E6A92`), paper text. Single CTA, hushed pacing. Concentric circle motifs faintly visible (kept from today).
12. **Footer** — paper, restrained. Keep today's structure.

## Motion

- All scroll reveals: `cubic-bezier(0.23, 1, 0.32, 1)`, 600–800ms, opacity + `translateY(8px)` only.
- Hero load: arc draws in via `clip-path` over ~1.4s; headline rises 0.9s ease-out, words staggered 60ms.
- Sticky-pinned Structure: pure CSS `position: sticky` + IntersectionObserver — no GSAP, no pinning libraries.
- Nav button `:active { transform: scale(0.97) }`.
- Never `transition: all`. Always specify properties.
- `prefers-reduced-motion`: kill movement, keep fades.
- Duration budget: nothing over 900ms on scroll; UI elements (nav, button) under 250ms.

## Build & preview plan

1. Copy six leadership photos to `landing-assets/` (self-contained).
2. Build `landing-v2.html` alongside the existing `landing.html`.
3. Serve via `python3 -m http.server 8000` from the project root.
4. User reviews `http://localhost:8000/landing-v2.html`.
5. After approval, replace `landing.html` with the new file. Until then, neither file is committed or pushed.

## Risks

- **Sticky-pinned Structure section** is the only non-trivial CSS. Fallback: viewports under 700px tall or under 900px wide drop the sticky behavior and stack the section title above the list (single column, no pin). Reveal animation still runs.
- **Photo resolution** — 5 of 6 photos are tiny files (3–11 KB). Sky duotone treatment + modest sizes mitigate this. Eric Winter's photo (134 KB) is the only one suitable for a feature-size crop.

## Out of scope (reaffirmed)

- No fabricated data of any kind.
- No changes outside the landing page file and its assets folder.
