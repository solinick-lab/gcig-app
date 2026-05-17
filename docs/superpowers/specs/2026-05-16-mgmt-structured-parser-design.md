# MGMT — Structure-Aware DEF 14A Parser (rebuild of the parsing layer)

- **Date:** 2026-05-16
- **Status:** Approved design — proceeding to plan (lead-dev autonomy granted; no per-doc review gate)
- **Scope:** Replace MGMT's flatten-then-regex parsing with structure-aware
  HTML parsing. Follow-up to the shipped MGMT feature; the route payload
  and client (`Governance.jsx`) are unchanged.

## Why

Shipped MGMT retrieves the DEF 14A correctly (SEC UA fix landed; tabs
render) but `proxyStatement.js` does `htmlToText()` then `splitSections()`
regex-hunts headings. Real large-cap proxies (AMZN/AAPL/KO, verified
live) have huge tables-of-contents and dozens of cross-references to the
same headings, and the Summary Compensation Table / board roster are
HTML **tables** that get flattened to unparseable text. The final review
empirically proved no positional heuristic recovers them. The root cause
is architectural: parse the HTML **structure** (the tables) before
flattening.

## Locked decisions

1. **Dependency:** add `node-html-parser` to `server/package.json`
   (tiny, zero native deps, fast). Overrides the original MGMT spec's
   "dependency-free htmlToText" constraint — that v1 constraint is
   exactly what blocked the feature; the user explicitly approved the dep.
2. **Scope:** rewrite all four extractors, with **honest confidence
   tiers** stated in code/UI/spec:
   - **Comp (SCT)** — high. The Summary Compensation Table is a real
     `<table>` with a recognizable column-header signature.
   - **Board** — high for structured fields (name/age/since/committees
     via the director table or per-director record blocks); `otherBoards`
     stays prose-heuristic within each director's block (medium).
   - **Network** — high; pure function of Board × holdings (unchanged).
   - **Leadership/exec bios** — best-effort. DOM locates the
     "Executive Officers" block; bio/prior-role extraction stays
     prose-heuristic. Stated honestly.
3. **Approach: signature-based structural detection** (not section
   locating). Find the SCT and the director table by their **column-
   header signature anywhere in the parsed DOM**, regardless of TOC or
   page position. This sidesteps the TOC problem entirely for the
   table-structured tiers — the crux of why structure-aware succeeds
   where flatten-regex failed.
4. **Never-throws / best-effort contract preserved.** Every parser:
   html-string in → structured/nullable out, never throws (same contract
   as `worldIndices.js`/`insiderTx.js`). Missing/unparseable → null/[],
   panel shows honest empty states (already shipped).
5. **Payload & client unchanged.** Route still returns
   `{ ticker, asOf, source, ceo, execs, board, comp, network }`;
   `Governance.jsx` and the route's shape are untouched.

## Architecture

### `server/src/services/proxyStatement.js` (modified)

Keep: `getCikForTicker` → newest `DEF 14A` (`pickLatestDef14A`, raw-URL
strip) → `SEC_UA` fetch → 24h cache; never-throws; cache keyed by
`ticker:cap`.

Remove: `htmlToText`, `splitSections`, `ANCHORS`, the entity map.

Change: `getProxyStatement(ticker)` returns
`{ ticker, filedAt, url, html, _source }` where `html` is the raw DEF
14A HTML string, **size-capped** (e.g. first ~4 MB — real proxies are
0.3–2 MB; cap prevents pathological memory). No flattening, no section
bucketing. Stub `{ html: '', _source: null }` on any failure.

### `server/src/services/governanceParsers.js` (rewritten)

Each `parse*(html)` parses with `node-html-parser` internally
(`import { parse } from 'node-html-parser'`), pure and never-throws:

- **`parseComp(html)`** → `{ rows: [{ name, title, total, salaryPct,
  stockPct, optionPct, otherPct }] }`. Find the `<table>` whose header
  row cells contain the SCT signature (a "Salary" col + a "Total" col +
  ≥2 of Bonus/Stock Awards/Option Awards/Non-Equity). Read named-officer
  rows by header-indexed columns (not positional guesswork). Keep the
  shipped `nums.length`-style guards / null-on-uncertain behavior.
- **`parseBoard(html)`** → `director[] = { name, age, since,
  committees[], otherBoards[] }`. Prefer a `<table>` whose header cells
  include Age and Director-Since (or "Director Since"/"Since"); else
  fall back to per-director record blocks located in the DOM (a node
  subtree containing "<Name>, age NN" + "director since"). `committees`
  from a committee-membership table or the block text; `otherBoards`
  prose-heuristic within the director's block (reuse the shipped
  regex; medium confidence).
- **`parseLeadership(html)`** → `{ ceo, execs[] }`. DOM-locate the
  "Information about (our) Executive Officers" heading; parse its
  following sibling/container (a Name/Age/Position table if present,
  else prose paragraphs per officer — reuse the shipped prose regexes
  for title/age/since/priorRoles). Best-effort tier.
- **`buildNetwork(focusTicker, board, holdings)`** — unchanged.
- Shared DOM helpers (e.g. `findTableBySignature(root, predicate)`,
  `headerIndex(row, label)`, `cellText(node)`) kept small and private.

### `server/src/routes/terminal.js` (minor)

`getProxyStatement` → pass `proxy.html` to `parseLeadership(html)` /
`parseBoard(html)` / `parseComp(html)` → `buildNetwork`. Payload and
auth/limiter unchanged. (Parsers now take `html`, not `sections`.)

### Client

No change. `Governance.jsx` already renders the payload and shows the
shipped honest empty/confab-free states.

## Data flow

```
ticker → getProxyStatement (CIK → DEF 14A → SEC_UA fetch → raw html, 24h cache)
      → parseComp(html) / parseBoard(html) / parseLeadership(html)   [node-html-parser, signature-based]
      → buildNetwork(board, sheetPortfolio holdings)
      → { ceo, execs, board, comp, network } → MGMT panel (unchanged)
```

## Error handling

`node-html-parser` is lenient (won't throw on messy SEC HTML), but every
parser still wraps extraction defensively and returns null/[] on
anything uncertain — never throws. A table not found → that section
null/empty → honest empty state. Size-cap guards memory. `getProxyStatement`
unchanged never-throws + size cap.

## Testing & verification

- **Commit trimmed real DEF 14A HTML fixtures**: AMZN + AAPL + one clean
  small-cap. Trim each to the relevant `<table>`/section subtrees
  (SCT + board table + exec block) to keep repo size sane while
  preserving real structure. `node:test` unit tests assert the
  structure-aware extractors pull the right rows/fields from these
  **real** fixtures (deterministic, no network). This is the real-recall
  proof the old synthetic-string tests lacked.
- `node --check`; full `npm test` green; `node-html-parser` builds.
- Live spine smoke (keyless SEC) for AMZN/AAPL — report raw output
  honestly.
- **Honest caveat (restated):** unit-on-real-fixtures is strong
  evidence; full filer-variety + the Render environment are only truly
  confirmable in prod — I cannot run as Render's IP (same standing
  limitation as WEI/Finnhub/INSDR-SEC). No metric claimed verified
  without evidence; Leadership tier explicitly best-effort.

## Build

New sub-project on branch `feat/mgmt-structured-parser`. TDD,
subagent-driven, slices: (1) add dep + `proxyStatement` raw-html spine
+ tests; (2) `findTableBySignature` + DOM helpers + tests;
(3) `parseComp` structure-aware + real-fixture tests; (4) `parseBoard`
structure-aware + tests; (5) `parseLeadership` DOM-locate + tests;
(6) route rewire (`html` not `sections`) + `buildNetwork` intact;
(7) integration verification (real fixtures + live smoke + honest
report). One consolidated push at the end.

## Open items / risks

- Real proxies vary (some are mostly `<div>`-styled tables, some true
  `<table>`; some put the SCT under "Executive Compensation" with the
  table further down). The signature predicate must match on header
  **cell text content**, not tag shape, and tolerate `<td>`-as-header.
  Fixtures from 3 real, structurally-different filers de-risk this; the
  plan specifies the exact signatures.
- Some small/foreign filers file the proxy as a single image-y PDF/HTML
  with no real tables → those legitimately stay empty (honest tier).
- Leadership prose extraction recall is inherently limited even with
  DOM; spec/UI already say so — not a regression, an honest bound.
- VERIFIED (recall gate, AAPL/AMZN/KO 2026): Comp tab WORKS on real large-caps (SCT parsed — incl. lean-column, $-separator, and split 2-row-header variants found+fixed during build). Board/Network/Leadership return empty for these filers: modern large-cap proxies present directors/officers as bespoke per-director "cards" with labeled fields ("Age: 58", "Director since: July 2021"), which is neither a standard director table nor inline "Name, age NN" prose. A labeled-field director-card extractor is the required follow-up sub-project (its own brainstorm→spec→build); it was deliberately NOT bolted on here as an unscoped in-loop patch.
