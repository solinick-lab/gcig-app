# In-App PDF Modal (Pitch Decks v1)

- **Date:** 2026-05-19
- **Status:** Approved (Option A: lean iframe modal, no new client
  dependency; v1 scope = pitch decks, the reusable modal makes
  reports/FIL extensions easy follow-ups). Lead-dev autonomy.
- **Scope:** Click a pitch deck → it opens in an in-app modal
  (`<iframe>` using the browser's native PDF viewer), not a new tab.
  Reusable component; same overlay/a11y pattern as `PersonModal`.

## Why

Today pitch deck links open in a new browser tab — friction that
breaks flow during pitch review. Browsers already render PDFs
natively in an `<iframe>` when served `Content-Disposition: inline`,
so the lean win is just a reusable modal + a tiny server tweak. Zero
new client deps; PDF.js stays a future-only option if v1 hits limits.

## Locked decisions

1. **One reusable `PDFModal`**, mirroring `PersonModal` (backdrop +
   Esc + click-outside + focus trap + × close). Body = `<iframe>`
   pointed at a viewer-friendly URL; header carries the title +
   an "Open in new tab" fallback link. No new client dep.
2. **Inline-disposition for our PDFs.** OneDrive-stored files served
   via our API support an `inline` mode (a `?inline=1` query, or
   auto-set for `application/pdf` content type) so the browser
   previews instead of downloading. One small server tweak.
3. **URL transforms for known external sources** (so common shared
   links embed cleanly): `drive.google.com/file/d/<id>/view…` →
   `/preview`; `docs.google.com/presentation/d/<id>/edit…` →
   `/preview`. Plain `http(s)` PDF URLs pass through.
4. **Honest fallback** when embedding isn't possible: PPTX, or a
   source that blocks framing (X-Frame-Options/CSP), or an
   unrecognized non-PDF URL → the modal shows a plain
   "This file can't preview inline — open in new tab" line with
   the always-present new-tab button. Never silently breaks.
5. **v1 wiring scope = pitch decks only** — `PitchRequests.jsx`
   (`row.deckRef`) and `Votes.jsx` (`session.pitch.slideshowUrl`).
   Reports/FIL/etc. are clean follow-ups using the same modal.

## Architecture

### `client/src/components/PDFModal.jsx` (new)
`export default function PDFModal({ url, title, mime, onClose })`.
- Renders nothing if `url` is falsy (parent can always-mount).
- Computes `embedUrl(url, mime)` via small pure helpers:
  - `onedrive:<itemId>` → `/api/files/<itemId>?inline=1` (the
    server-served inline-disposition URL — needs an authed `<iframe>`;
    note auth: the shared `api` axios attaches JWT to XHR/fetch, but
    an `<iframe src=…>` is a top-level GET that doesn't carry the
    Bearer token. If the existing file-download route accepts a
    short-lived signed token in the query, use that; otherwise the
    implementer must verify the route's auth shape and either: (a)
    use a cookie-based or query-token-based auth path the existing
    code provides, or (b) document the gap and fall back to new-tab
    until a signed-URL endpoint exists. Read `routes/files.js` to
    determine which.).
  - Google Drive `view` URLs → `/preview` form.
  - Google Slides `edit` URLs → `/preview` form.
  - Other http(s) → pass through.
- `embeddable(url, mime)`: heuristic — true for our `/api/files/...?inline=1`
  PDFs, Drive/Slides preview URLs, and `.pdf` URLs. False for PPTX,
  unrecognized non-PDF types → renders the honest fallback panel.
- A11y: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` to
  the title; focus the × on open; restore focus on close; Esc /
  backdrop-mousedown close; clicks inside the dialog don't close;
  `prefers-reduced-motion` honored. Mirror the `PersonModal`
  patterns 1:1 (it already solved all of this).
- Renders within the existing themed subtree (no portal, same
  rationale as `PersonModal`).

### `client/src/pages/PitchRequests.jsx` + `client/src/pages/Votes.jsx` (wired)
Replace the existing "open in new tab" action on the deck/slideshow
link with `setSelectedPdf({ url, title })` opening `PDFModal`. Keep
the new-tab as the modal's fallback button (no behavior loss). State
+ modal mount once per page.

### `server/src/routes/files.js` (and/or `server/src/services/oneDriveStorage.js`)
Tweak the OneDrive file-download route to honor `?inline=1`: when set
(and the content type is `application/pdf`), override
`Content-Disposition` to `inline; filename="…"` instead of
`attachment`. Keep default behavior (download/attachment) untouched.
If the route currently requires only the standard JWT header (no
query auth), implementer notes whether an iframe can authenticate
(see above); if not, add a small "view-token" mechanism mirroring any
existing signed-URL pattern in the codebase, OR document the
honest gap and degrade pitch decks served from OneDrive to new-tab
until that's added (v1 still works for external/Google-Drive/Slides
URLs and any future fully-public PDF — and the modal is in place
for instant promotion once the auth piece lands).

## Data flow

```
click deck/slideshow → setSelectedPdf({url,title}) → <PDFModal>
   embedUrl(url) → <iframe>  → browser native PDF viewer (inline)
non-embeddable → "open in new tab" fallback link
```

## Error handling

`PDFModal` never blocks the parent — failures (iframe blocked,
unsupported type) degrade to the honest fallback panel with the
new-tab button. No fabricated UI. Server inline-disposition change
is additive and back-compatible (default `attachment` preserved).

## Testing

- Server: a tiny route test for the inline-disposition tweak
  (mirror the existing route-test injected-deps style — e.g.
  `terminal.quotes.test.js`/`watchlist.test.js`): `?inline=1` +
  PDF content-type → `Content-Disposition: inline; …`; absent or
  non-PDF → unchanged (attachment) behavior. Never 5xx.
- Client: `npm run build` `✓ built`; reasoned walkthrough (no client
  test harness): click a deck → modal opens, iframe renders or
  fallback message shown, Esc/backdrop/× close, focus restore;
  state reset on close; new-tab fallback is always reachable;
  reduced-motion suppresses any flourish; `PersonModal` & all other
  panels unchanged.

## Build

Branch `feat/pdf-modal` off latest main, TDD, subagent-driven, one
PR. Single focused implementer: PDFModal component + URL transforms
+ the small server inline-disposition route tweak + tests + the
two-site client wiring.

## Open items / risks (honest)

- iframe auth for our OneDrive-served PDFs is the one real wrinkle
  (Bearer-in-Authorization-header can't be sent on an `<iframe src=`
  top-level navigation). If the existing files route doesn't already
  accept a query-token or cookie auth path, v1 ships with external
  (Drive/Slides/plain-PDF) URLs fully working inline and OneDrive
  PDFs gracefully falling back to new-tab until a signed-URL
  endpoint is added (≤30 min follow-up). The modal is the modal
  either way; the gap is only the auth pipe for self-hosted files.
- External sources that explicitly disable framing
  (X-Frame-Options/CSP) → modal shows the honest fallback. Common,
  expected, not a bug.
- PPTX can't preview inline (no browser PDF.js-equivalent for
  PowerPoint) → fallback message. Honest.

## v1.1 — extended to FIL terminal panel

- Scope: clicking a filing row in `Filings.jsx` opens the SEC document
  in the same `PDFModal`. Cmd/ctrl/shift/alt-click and middle-click
  still fall through to the native `target="_blank"` new-tab path so
  power users keep that escape unchanged.
- `embeddable(url, mime)` widened: any http(s) URL is now considered
  embeddable, *unless* its pathname ends in a known non-embeddable
  binary extension (`.pptx`, `.docx`, `.xlsx`, `.zip`, `.rar`, `.7z`,
  `.tar`, `.gz`). SEC EDGAR archive URLs are plain HTML, not PDF, so
  the old PDF-only heuristic would have routed every filing to the
  fallback panel. PDF/Drive/Slides cases are untouched.
- Honest caveat: SEC servers can still send `X-Frame-Options` or
  `Content-Security-Policy: frame-ancestors` that bar embedding. When
  that happens the iframe paints blank, and the modal header's
  always-visible "Open in new tab" link is the user's escape — same
  no-silent-break posture as v1.
- Modal title format: `${TICKER} ${FORM} · ${MM/DD/YY}` so the user
  knows what they're looking at without reading the URL bar.
