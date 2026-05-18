# MGMT — Clickable Person Profiles (director & executive bios)

- **Date:** 2026-05-17
- **Status:** Approved design (scope, UX, data sources, single-release build
  order confirmed by user; lead-dev autonomy — no per-doc review gate).
- **Scope:** Make every person in the MGMT Board/Leadership tabs clickable;
  a modal overlay shows a real bio. Directors' bios come from the DEF 14A we
  already fetch; executives' bios come from the company's 10-K. Shipped as
  one release.

## Why

MGMT now lists directors (bio-card + conventional proxies) and an exec
roster (from the SCT). Users want to click a person and read about them
"for every company". The director bio prose is **already inside the DEF
14A cards we parse and currently discard**. Executive bios are **not in
the proxy** (AMZN/KO confirmed — that data lives in the 10-K), so execs
need a second free SEC source. The route payload gains optional fields;
no existing behavior regresses.

## Locked decisions

1. **Director bios: from the proxy we already fetch.** No new network
   call. `parseBoard` already traverses each director's card/row; it
   additionally captures a best-effort `bio` string from that same
   subtree (AMZN: role + qualifications prose; KO: Career Highlights /
   Key Qualifications / Public Board Memberships; AAPL/MLAB: the
   occupation/position line, the only bio text those conventional
   tables carry). `bio` is nullable; missing → `null` (honest empty,
   never fabricated).
2. **Executive bios: from the latest 10-K.** New service
   `executiveBios.js`, same SEC plumbing as `secFilings.js`/
   `proxyStatement.js` (keyless, declarative `SEC_UA`, 24h cache,
   size-capped, never-throws). It locates the 10-K "Information about
   our Executive Officers" / "Executive Officers of the Registrant"
   section and splits it into per-officer `{ name, bio }`. Bespoke-
   document variance is the same honest class as the proxy parser:
   works where the section parses; structured fallback otherwise.
3. **Exec bios are lazy.** Director `bio` rides the existing
   `GET /terminal/governance/:ticker` payload (free — same document).
   Exec bios are fetched on demand via a new
   `GET /terminal/governance/:ticker/exec-bios` (10-K fetched once,
   cached), so the main panel stays fast and a 10-K is never fetched
   unless a user opens the Leadership detail.
4. **Modal overlay UX.** A reusable, terminal-styled modal: Esc and
   click-outside close it; focus-trapped; scrollable for long bios.
   Board/Leadership rows become buttons. No mosaic-pane rewiring.
5. **No fabrication.** If no bio parses, the modal shows the structured
   facts we already have (title, age/since, total comp, pay mix for
   execs) plus an explicit "No bio disclosed in the filing" line. The
   LLM is never asked to invent a biography.
6. **Payload back-compatible.** New fields are additive and optional;
   `Governance.jsx`'s existing render paths keep working. The stale
   footer caveat (claims card layouts are unsupported — they are now
   supported and populated) is corrected as part of this work.

## Architecture

### `server/src/services/governanceParsers.js` (modified)
`parseBoard` adds `bio` to each director object. In the card path
(AMZN/KO), capture the prose nodes already adjacent in the matched
card table (AMZN: the title div + the qualifications paragraph; KO:
the text under `CAREER HIGHLIGHTS` and `KEY QUALIFICATIONS AND
EXPERIENCES`, plus `Current Public Company Boards:`). In the
conventional path (AAPL/MLAB), `bio` = the occupation/position cell
text. Pure, never-throws, `bio` nullable. Schema otherwise unchanged.

### `server/src/services/executiveBios.js` (new)
`getExecutiveBios(ticker) -> { ticker, source, asOf, officers: [{ name,
bio }] }`. Reuses `getRecentFilings`/`SEC_UA`; picks the latest `10-K`
(raw-URL strip like `pickLatestDef14A`); fetches with `SEC_UA`; 24h
cache keyed by ticker; size-cap (10-Ks are large — cap at 12 MB and
locate the exec-officers section by heading signature near the cap
front, mirroring `proxyStatement` discipline). Section locate +
per-officer split via `node-html-parser` structure where present,
prose fallback otherwise. Never-throws; any failure → `{ officers: [],
source: null }`.

### `server/src/routes/terminal.js` (modified)
- `GET /governance/:ticker` unchanged in shape; `board[].bio` now
  populated by the updated parser. (`ceo`/`execs` keep coming from the
  SCT fallback; no `bio` here — that is the lazy call.)
- New `GET /governance/:ticker/exec-bios` — same auth/limiter as the
  other terminal routes; returns `{ ticker, source, officers: [{ name,
  bio }] }` from `getExecutiveBios`; never 5xx on parse miss (returns
  empty officers, honest).

### Client
- New `client/src/terminal/components/PersonModal.jsx` — reusable
  overlay (props: person, bio, loading, onClose). Accessible: Esc,
  click-outside, focus trap, scroll. Terminal-styled.
- `Governance.jsx`: Board and Leadership rows become clickable buttons
  opening `PersonModal`. Director click → uses `bio` already in the
  payload. Exec click → lazily `GET …/exec-bios` (once per ticker,
  cached in component state), matches the officer by name, shows
  loading then bio; on miss shows structured facts + honest no-bio
  line. Remove/replace the now-false footer caveat with an accurate
  one.

## Data flow

```
Board tab:   /governance/:ticker  → board[{…, bio}]         → click → PersonModal (bio in hand)
Leadership:  /governance/:ticker  → ceo/execs (SCT)         → click → lazy GET /governance/:ticker/exec-bios
                                   → executiveBios.js (10-K, cached) → match by name → PersonModal
no bio parsed → modal shows title/age/since/comp + "No bio disclosed"
```

## Error handling

Every parser/service never throws (same contract as `worldIndices.js`/
`proxyStatement.js`): miss → `null`/`[]`/empty officers → honest modal
state. 10-K fetch from Render's datacenter IP is only confirmable in
prod (same standing limitation as proxy/Finnhub/GSAM — stated, not
overclaimed). Size caps guard memory. Lazy exec-bios endpoint failure
degrades the modal to the structured fallback, never blocks the panel.

## Testing & verification

- **Director bios:** extend the real-fixture recall gate
  (`governanceParsers.realfixture.test.js`) — assert `bio` is a
  non-empty string for AMZN, KO, and AAPL directors (a known director
  each, with a substring that must appear), and that MLAB/AAPL board
  counts and all comp output stay byte-identical (no regression).
- **Exec bios:** commit **real, trimmed** 10-K fixtures (AMZN, KO, and
  one conventional filer) — trimmed to the real exec-officers section
  subtree + structure to keep repo size sane (10-Ks are too large to
  commit whole; mirror the proxy-fixture trimming rationale). New
  `executiveBios.test.js` asserts named officers + bio substrings from
  these real fixtures, plus never-throws on junk/empty.
- Full `npm test` green; `node --check`; client `npm run build`
  (`✓ built`). Honest caveat restated: fixture-level proof is strong;
  full filer variety + the Render environment are prod-only — no metric
  claimed verified without evidence.

## Build

One release on branch `feat/person-profiles`, TDD, subagent-driven.
Internal task order (each task TDD + reviewed):
1. `parseBoard` captures director `bio` (+ recall-gate assertions).
2. `executiveBios.js` 10-K service + real trimmed 10-K fixtures +
   `executiveBios.test.js`.
3. `terminal.js` lazy `/exec-bios` route (never-5xx) + test.
4. `PersonModal.jsx` reusable accessible overlay.
5. `Governance.jsx` clickable rows, modal wiring, lazy exec-bio fetch,
   structured no-bio fallback, corrected footer caveat.
6. Whole-feature review + finishing-a-development-branch (one merge).

## Open items / risks

- 10-K exec-officers disclosure varies; some filers incorporate it by
  reference to the proxy (and the proxy lacks it — see AMZN/KO) → those
  legitimately fall back to the structured no-bio modal. Honest tier,
  not a bug. Three structurally-different real 10-K fixtures de-risk
  the common shapes.
- 10-K size: fixtures are trimmed-but-real (full 10-Ks are tens of MB);
  the live service caps and locates by signature, so prod is unaffected
  by the trimming choice.
- Director `bio` for conventional-table filers (AAPL/MLAB) is only the
  occupation line — that is all the document carries; not a regression,
  an honest bound stated in the modal.
