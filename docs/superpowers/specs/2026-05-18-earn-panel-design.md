# Terminal — EARN (Earnings Panel)

- **Date:** 2026-05-18
- **Status:** Approved (batch "build everything"; lead-dev autonomy;
  sub-project 2 of 7).
- **Scope:** New `EARN` terminal function: a ticker's **next earnings
  date + estimate** and a **trailing beat/miss history** (EPS estimate
  vs actual, surprise), with an AI read. Reuses the existing Finnhub
  `/calendar/earnings` plumbing in `marketData.js`. Additive; own
  branch + PR.

## Why

`marketData.js` already calls Finnhub `/calendar/earnings`
(`getUpcomingEarnings`, cached, inside the documented 60-rpm budget).
A small extension (widen the window to also pull recent actuals)
turns it into an analyst-grade earnings panel — no new data source.

## Locked decisions

1. Reuse the existing Finnhub `/calendar/earnings` fetch + cache
   pattern in `marketData.js`; add a sibling that returns both the
   next upcoming row and the trailing actuals (one windowed call:
   `from ≈ 13 months ago`, `to ≈ 90 days ahead`). Do NOT add a new
   provider; respect the existing earnings cache + rpm comment.
2. AI BRIEF via `/terminal/annotate` + new `FN_PROMPTS.EARN`
   (earnings-analyst prompt + shared `GROUNDING_RULES`), confab-safe
   (no annotate call when there's no earnings data).
3. Never-throws / never-5xx; honest empty/loading/error; no fabricated
   numbers. `requires:'ticker'`.

## Architecture

### Server
- `server/src/services/marketData.js`: add `export async function
  getEarnings(ticker)` → `{ upcoming: { date, epsEstimate } | null,
  history: [{ period, date, epsEstimate, epsActual, surprisePct }] }`
  using the same Finnhub `/calendar/earnings?from=&to=` call + the
  existing `earningsCache`/timeout/rate conventions (one widened
  window; split rows into the next future row vs past rows with an
  actual; compute `surprisePct` when both est+act present; newest-
  first history, cap ~12). Reuse, don't duplicate, the existing fetch
  helper. Never throws (→ `{ upcoming:null, history:[] }`).
- `server/src/routes/terminal.js`: extracted
  `earningsHandler(req,res,deps={})` (`deps.getEarnings` injectable),
  `GET /terminal/earnings/:ticker` → `{ ticker, upcoming, history }`,
  no per-route mw (inherits `verifyJwt→requireExecutive→aiLimiter`),
  ticker validated/uppercased (existing regex), try/catch → 200
  `{ ticker, upcoming:null, history:[] }` (never 5xx). Add
  `FN_PROMPTS.EARN` (next report; beat/miss streak; surprise trend;
  note if estimates thin/stale) + `GROUNDING_RULES`.

### Client
- `client/src/terminal/functions/Earnings.jsx` (new): mount/ticker-
  change `GET /terminal/earnings/:ticker` via shared `api`. Show the
  **next report** prominently (date + EPS estimate, "in N days"), then
  a `term-table` history: **Period · Reported · EPS Est · EPS Act ·
  Surprise** (beat green / miss red via the existing pos/neg classes).
  `◢ AI BRIEF` block via `/terminal/annotate` with the confab-safe
  guard (no call when upcoming+history both empty → honest message).
  Loading/empty/error states mirroring `Filings.jsx`/`Peers.jsx`.
- `client/src/terminal/registry.js`: `{ id:'EARN', label:'Earnings',
  help:'Next report + trailing EPS beat/miss history.',
  requires:'ticker', component: Earnings }`, near the research panels.

## Data flow

```
open EARN <ticker> → GET /terminal/earnings/:ticker → getEarnings (Finnhub /calendar/earnings, cached)
   → next-report card + beat/miss history table
   → /terminal/annotate (FN_PROMPTS.EARN) → one-line read (only if data present)
```

## Error handling

`getEarnings` never throws (empty on miss); route try/catch → 200
honest-empty, never 5xx; client honest empty/error; AI brief
suppressed when no data. Finnhub-from-Render is the existing proven
path (already used by Peers/holdings); only fully prod-confirmable
there (standing limitation).

## Testing

- Server: `terminal.earnings.test.js` mirroring
  `terminal.filings.test.js` (injected `getEarnings`, no network):
  `{ticker,upcoming,history}` shape; uppercase/validate; never 5xx on
  service reject (→200 honest-empty); structural auth-parity vs
  `/governance`. Full `npm test` green.
- Client: `npm run build` `✓ built`; reasoned walkthrough (no client
  harness): next-report card, history beat/miss coloring, AI brief
  present with data / honest message when none, loading/empty/error,
  ticker-change refetch.

## Build

Branch `feat/earn-panel` off latest main, TDD, subagent-driven, one
PR. Single focused implementer (service + route + prompt + test, then
panel + registry).
