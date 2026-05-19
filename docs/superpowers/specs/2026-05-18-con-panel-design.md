# Terminal — CON (Analyst Consensus Panel)

- **Date:** 2026-05-18
- **Status:** Approved (batch "build everything"; lead-dev autonomy;
  sub-project 3 of 7; built on the cumulative `feat/fil-panel`
  panels branch alongside FIL + EARN).
- **Scope:** New `CON` terminal function: a ticker's analyst
  buy/hold/sell **breakdown + trend** over recent months, with an AI
  read. Reuses the existing Finnhub `/stock/recommendation` plumbing
  in `marketData.js` (the same data Peers already uses for its
  consensus ratio). Additive.

## Why

`marketData.js` already fetches `/stock/recommendation` (rows
`{ period, strongBuy, buy, hold, sell, strongSell }`, cached, inside
the 60-rpm budget) — Peers only consumes a single derived ratio. A
dedicated panel surfaces the full distribution + whether sentiment is
improving or deteriorating. No new data source.

## Locked decisions

1. Reuse the existing recommendation fetch + cache in `marketData.js`
   (do not add a new Finnhub client). Expose the recent trend rows
   (latest + a short history) rather than only Peers' single ratio.
2. AI BRIEF via `/terminal/annotate` + new `FN_PROMPTS.CON`
   (consensus-analyst prompt + shared `GROUNDING_RULES`), confab-safe.
3. Never-throws/never-5xx; honest empty/loading/error; no fabricated
   numbers. `requires:'ticker'`.

## Architecture

### Server
- `server/src/services/marketData.js`: reuse the existing
  `/stock/recommendation` fetch/cache. If the current export only
  returns Peers' derived ratio/latest, add (or widen) a sibling
  `export async function getConsensus(ticker)` →
  `{ latest: { period, strongBuy, buy, hold, sell, strongSell } | null,
  trend: [ same shape, newest-first, cap ~6 ] }` using the SAME
  fetch helper + recommendation cache conventions (mirror, don't
  duplicate the HTTP/key logic; namespace its cache key if the shape
  differs from an existing cached value, exactly as EARN's
  `getEarnings` namespaced its key). Never throws → `{ latest:null,
  trend:[] }`.
- `server/src/routes/terminal.js`: extracted
  `consensusHandler(req,res,deps={})` (`deps.getConsensus`
  injectable), `GET /terminal/consensus/:ticker` →
  `{ ticker, latest, trend }`, no per-route mw (inherits
  `verifyJwt→requireExecutive→aiLimiter`), ticker validated/
  uppercased (existing regex), try/catch → 200
  `{ ticker, latest:null, trend:[] }` (never 5xx). Add
  `FN_PROMPTS.CON` (latest skew buy-vs-sell; is the trend improving/
  deteriorating; note thin coverage) + `GROUNDING_RULES`.

### Client
- `client/src/terminal/functions/Consensus.jsx` (new): mount/ticker-
  change `GET /terminal/consensus/:ticker` via shared `api`. Render
  `term-panel`: a **latest breakdown** (counts for strong buy / buy /
  hold / sell / strong sell, plus a simple proportion bar or %s),
  then a compact `term-table` **trend** (Period · Buy · Hold · Sell …
  newest-first) so the user sees direction. `◢ AI BRIEF` via
  `/terminal/annotate` with the confab-safe guard (no call when
  `!latest && trend.length===0` → honest "No analyst coverage for
  <ticker>."). Loading/empty/error states mirroring the sibling
  `Earnings.jsx`/`Filings.jsx` on this branch.
- `client/src/terminal/registry.js`: `{ id:'CON',
  label:'Analyst Consensus', help:'Buy/hold/sell breakdown & trend.',
  requires:'ticker', component: Consensus }`, near the research
  panels (by FIL/EARN/INSDR).

## Data flow

```
open CON <ticker> → GET /terminal/consensus/:ticker → getConsensus (Finnhub /stock/recommendation, cached)
   → latest breakdown + trend table
   → /terminal/annotate (FN_PROMPTS.CON) → one-line read (only if data)
```

## Error handling

`getConsensus` never throws (empty on miss); route try/catch → 200
honest-empty, never 5xx; client honest empty/error; AI brief
suppressed when no data. Finnhub-from-Render is the existing proven
path (Peers already uses this exact endpoint); only fully prod-
confirmable there (standing limitation).

## Testing

- Server: `terminal.consensus.test.js` mirroring the sibling
  `terminal.earnings.test.js` (injected `getConsensus`, no network):
  `{ticker,latest,trend}` shape; uppercase/validate; never 5xx on
  service reject (→200 honest-empty); structural auth-parity vs
  `/governance`. Full `npm test` green (was 113 on this branch → +N).
- Client: `npm run build` `✓ built`; reasoned walkthrough (no client
  harness): latest breakdown + trend render, AI brief present with
  data / honest msg when none, loading/empty/error, ticker-change
  refetch.

## Build

Continues on `feat/fil-panel` (the cumulative panels branch) — TDD,
subagent-driven, accretes cleanly after FIL+EARN. Single focused
implementer (service accessor + route + prompt + test, then panel +
registry).
