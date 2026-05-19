# Terminal — CMP (Compare 2–4 Tickers Panel)

- **Date:** 2026-05-18
- **Status:** Approved (batch "build everything"; lead-dev autonomy;
  sub-project 4 of 7; on the cumulative `feat/fil-panel` panels
  branch alongside FIL + EARN + CON).
- **Scope:** New `CMP` terminal function: put 2–4 tickers side by side
  — live price (flashing) + day %, plus key fundamentals (mkt cap,
  P/E, fwd P/E, div, beta), with an AI comparison read. Pure
  composition of existing infra; additive.

## Why

`marketData.js` `getPeerSnapshot(ticker)` already returns the
normalized fundamentals bundle (name, P/E, fwd P/E, mkt cap, div,
beta) Peers uses; `/terminal/quotes` + `useLiveRefresh` +
`FlashPrice` already deliver live, tick-flashing prices. A compare
panel is just composing these for an arbitrary 2–4 ticker set — no
new data source.

## Locked decisions

1. Fundamentals via the existing `getPeerSnapshot` (reuse; do not add
   a new Finnhub client). Live price via the existing
   `/terminal/quotes` + `useLiveRefresh` + `FlashPrice` (the exact
   Movers/Peers live-overlay pattern).
2. The panel owns its ticker set (an input, 2–4, deduped/uppercased,
   cap 4); seed slot 1 from the workspace ticker if present.
   `requires:null`.
3. AI BRIEF via `/terminal/annotate` + new `FN_PROMPTS.CMP`
   (relative-value comparison + shared `GROUNDING_RULES`),
   confab-safe (no call with <2 resolvable tickers).
4. Never-throws/never-5xx; honest empty/loading/error; no fabricated
   numbers.

## Architecture

### Server — `server/src/routes/terminal.js` (modified)
- Extracted `compareHandler(req,res,deps={})` (`deps.getPeerSnapshot`
  injectable). `GET /terminal/compare?tickers=A,B,C,D` → parse the
  comma list, uppercase/trim/dedupe/drop-empty, **cap 4**, then
  `Promise.all` `getPeerSnapshot` per ticker → `{ tickers:[…],
  rows: [ { ticker, name, marketCap, peRatio, forwardPE,
  dividendYield, beta } | null-fields ] }` (one row per requested
  ticker, missing fields null). No per-route mw (inherits the chain);
  try/catch → 200 `{ rows: [] }` (never 5xx). Reuse the established
  list-param normalization from `quotesHandler`.
- Add `FN_PROMPTS.CMP`: a relative-value analyst prompt (which looks
  rich/cheap on P/E vs the group, growth/yield/beta contrasts, the
  outlier) + `GROUNDING_RULES`. Add a `KNOWN_FUNCTIONS` CMP entry
  (label "Compare") consistent with how CON was wired.

### Client — `client/src/terminal/functions/Compare.jsx` (new) + registry
- Registry: `{ id:'CMP', label:'Compare', help:'2–4 tickers side by
  side: live price, day %, valuation.', requires:null,
  component: Compare }` (import top, near the research panels; do NOT
  disturb FIL/EARN/CON entries).
- Ticker set state (default `[workspaceTicker]` if a `ticker` prop is
  present, else empty); an input + add/remove chips, cap 4, min 1 to
  fetch, AI brief needs ≥2. `GET /terminal/compare?tickers=` for the
  fundamentals snapshot. Live price overlay via `useLiveRefresh(() =>
  api.get('/terminal/quotes',{params:{tickers}}), { enabled:
  tickers.length>0 })` exactly like Movers/Peers; render the price
  cell through `FlashPrice` (per-ticker, the established per-cell
  subcomponent pattern). Layout: a column (or row) per ticker —
  Price (flash) · Day % · Mkt Cap · P/E · Fwd P/E · Div · Beta.
  Each ticker header click → `onOpen({ticker, fn:'DES'})` (the
  established row→DES pattern). `◢ AI BRIEF` via `/terminal/annotate`
  with the confab-safe guard (skip when <2 tickers/rows). Loading/
  empty/error states mirroring `Peers.jsx`/`Earnings.jsx` on this
  branch.

## Data flow

```
CMP: user picks 2–4 tickers (or seeded from workspace)
  → GET /terminal/compare?tickers=  → getPeerSnapshot ×N (fundamentals snapshot)
  → useLiveRefresh → /terminal/quotes (live price+%) → FlashPrice cells
  → /terminal/annotate (FN_PROMPTS.CMP) → relative-value read (≥2 tickers)
```

## Error handling

`getPeerSnapshot` already catches and degrades (null fields);
`compareHandler` try/catch → 200 honest-empty, never 5xx; a missing
fundamental renders "—"; live-quote failure keeps last-good (the hook
already does); AI brief suppressed with <2 tickers. Finnhub-from-
Render is the existing proven path (Peers uses these endpoints);
prod-confirmable there (standing limitation).

## Testing

- Server: `terminal.compare.test.js` mirroring the sibling
  `terminal.consensus.test.js` (injected `getPeerSnapshot`, no
  network): `{tickers,rows}` shape; uppercase/dedupe/cap-4; never 5xx
  on service reject (→200 `{rows:[]}`); structural auth-parity vs
  `/governance`. Full `npm test` green (was 118 on this branch → +N).
- Client: `npm run build` `✓ built`; reasoned walkthrough (no client
  harness): add/remove tickers (cap 4), fundamentals render, live
  price flashes per the existing pattern, header→DES, AI brief with
  ≥2 / suppressed <2, loading/empty/error, ticker-set change refetch
  (the live hook only ever sees the current set).

## Build

Continues on `feat/fil-panel` (cumulative panels branch) — TDD,
subagent-driven, accretes cleanly after FIL+EARN+CON. Single focused
implementer (route + prompt + test, then panel + registry).
