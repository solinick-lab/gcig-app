# INSDR — Insider Activity (Form 4 timeline)

- **Date:** 2026-05-16
- **Status:** Approved design — pending spec review, then implementation plan
- **Scope:** Sub-project #1 of the `MGMT` governance umbrella (see Roadmap)

## Context

The terminal needs company-governance data. The full request — CEO bio,
board roster, insider activity, compensation structure, and a board
"connections" graph — is five subsystems of very different feasibility
on the free-tier-only constraint, so it is decomposed into an umbrella
(`MGMT`) of five sequential sub-projects, each its own spec → plan →
build. This spec covers **#1, Insider Activity**, chosen to go first
because Form 4 data is structured, highest-feasibility, and independent
of the others (it uses SEC ownership filings / Finnhub, not the DEF 14A
spine the later sub-projects share).

## Goal

A standalone terminal function, `INSDR` (requires a ticker), that plots
insider open-market buys and sells as markers on the company's price
chart, with a transaction table beneath and an AI brief — so a user can
read at a glance whether insiders were buying into weakness.

## Non-goals (YAGNI for v1)

- No chart range selector — fixed 1y chart, ~24mo data window.
- No marker clustering/aggregation — overlapping dots stack; acceptable.
- No CEO / board / compensation data — those are sub-projects #2–#4.
- No combined `MGMT` shell yet — `INSDR` ships independent; the umbrella
  links siblings later.

## Locked decisions

1. **Primary view:** Form 4 markers overlaid on the price chart, with
   hover detail and a transaction table below. (Chosen over a net-activity
   bar timeline and a plain table.)
2. **Signal scope:** Only open-market **P** (purchase) and **S** (sale)
   transactions become chart markers. Routine codes — option exercises
   (M), grants (A), tax withholding (F), gifts (G) — are fetched and
   shown in the table behind a toggle, but never plotted.
3. **Data source:** Finnhub primary, SEC EDGAR Form 4 fallback
   (approach A). Matches the codebase's existing Finnhub-primary /
   fallback layering (`holdings.js`).

## Architecture

### Server — `services/insiderTx.js` (new)

Resilience pattern mirrors `services/worldIndices.js` and
`services/quotes.js`: best-effort, never throws, stubs on failure.

- `getInsiderTransactions(ticker)` → normalized array, date-descending:
  ```
  { date: ISO string,
    name: string,           // reporting owner
    role: string|null,      // "CEO", "Director", "10% Owner", …
    code: string,           // raw Form 4 transaction code
    isBuy:  boolean,        // code === 'P'
    isSell: boolean,        // code === 'S'
    shares: number|null,
    price:  number|null,    // per-share transaction price
    value:  number|null }   // shares * price
  ```
- **Primary — Finnhub:** `GET /stock/insider-transactions?symbol=&from=&to=`
  over a ~24-month window using `FINNHUB_API_KEY`. Map `transactionCode`
  → `isBuy`/`isSell`; `value = shares * price`. `role` from Finnhub when
  present.
- **Fallback — SEC EDGAR:** when Finnhub returns empty or errors, use the
  existing `getCikForTicker` (services/secFilings.js) → submissions feed
  → filter `form === '4'` → fetch and parse the ≤40 most recent Form 4
  ownership XML documents: `transactionCoding` (code), `transactionAmounts`
  (shares, pricePerShare), `transactionDate`, and the reporting-owner
  relationship block for `role` (isDirector / officerTitle /
  isTenPercentOwner). The 40-cap bounds fetch cost.
- 20-minute in-process cache keyed by ticker (insider data is not
  intraday-sensitive).

### Server — route (in `routes/terminal.js`)

- `GET /api/terminal/insiders/:ticker` — same `verifyJwt` +
  `requireExecutive` + rate limiter + ticker regex as `/chart/:ticker`.
- Response: `{ ticker, transactions: [...], _source: 'finnhub'|'sec'|null }`.
- `200` with `transactions: []` when there is genuinely no data; `502`
  only on hard failure (consistent with `/indices`).
- Add `INSDR` to `KNOWN_FUNCTIONS` so the command parser and `/annotate`
  recognize it.

### Client — `functions/InsiderActivity.jsx` (new)

- On ticker change, fetch in parallel: existing
  `/terminal/chart/:ticker?range=1y&interval=1d` and new
  `/terminal/insiders/:ticker`.
- Render with Recharts `ComposedChart` (Recharts is already the chart
  dependency — see `Chart.jsx`):
  - price `Line` (same styling as `Chart.jsx`),
  - `Scatter` series for buys (green ▲) and sells (red ▼),
  - marker **x** = transaction date as epoch ms on the same numeric time
    axis `Chart.jsx` uses,
  - marker **y** = that date's close from the price series (so markers
    sit on the line); the raw transaction price is shown in the tooltip,
  - marker size ∝ transaction `value`, bucketed and clamped.
- Only P/S plotted. Below the chart: a transaction table (date, insider,
  role, TX, shares, price, value), color-coded, with an **Open-market
  only ↔ All codes** toggle (default: open-market). All codes appear in
  the table; only P/S ever appear on the chart.
- AI brief block: `POST /terminal/annotate` with `function: 'INSDR'` and
  a short summarized-activity context — consistent with DES/CN/WEI.
- Loading / error / empty / no-ticker states reuse `term-loading` /
  `term-error`. Register `INSDR` in `client/src/terminal/registry.js`
  (`requires: 'ticker'`). Any new styling scoped under
  `[data-theme='terminal']`.

## Data flow

```
ticker
  ├─ GET /terminal/chart/:ticker?range=1y   → price points [{t, close}]
  └─ GET /terminal/insiders/:ticker         → normalized transactions
        client aligns each tx onto the price series by date
        → price Line + buy/sell Scatter markers + transaction table
        → POST /terminal/annotate → AI brief
```

## Error handling

- Finnhub fails or empty → SEC EDGAR fallback.
- Both fail → `200` with `[]` → panel shows
  "No Form 4 activity in the last 24 months."
- Chart fails but transactions load → render the table only (graceful
  degrade); show a chart-unavailable note.
- Every external call wrapped per-source; the service never throws out
  (same contract as `worldIndices.js`).

## Testing & verification

- Server: `node --check` on the new service and route.
- SEC fallback path is verifiable locally (no key required) against a
  ticker with recent Form 4s.
- **Honest limitation:** the Finnhub primary path needs
  `FINNHUB_API_KEY`, which is not in the local shell — it is only
  end-to-end verifiable on Render (same situation as the WEI work). This
  will be stated plainly, not glossed.
- Form 4 XML parsing gets fixture-based checks for code classification
  (P/S vs M/A/F/G) and field extraction.
- Client: vite production build for JSX correctness; manual check of
  marker-to-price alignment.

## Roadmap (umbrella context, not in scope here)

`MGMT` umbrella, build order 1 → 5, each its own spec → plan → build:

1. **Insider Activity (this spec).** SEC/Finnhub Form 4.
2. Exec profile (CEO bio, tenure, prior roles).
3. Board roster (directors, ages, committees, other public boards).
4. Compensation structure (% salary / stock / options).
5. Board connections graph (interlocking directorates), scoped to the
   fund's ~25 holdings to be feasible free.

**Shared spine for #2–#5:** the DEF 14A proxy statement is the canonical
source — one filing carries exec bios, the board roster with ages and
tenure, *other public directorships* (the edge data that makes #5
feasible with no scraping), and the compensation tables. #2–#5 will
share a single DEF 14A fetch + parse layer. #1 deliberately does not
touch it (different source), which is why it is cleanly independent.

## Open items

- Exact Finnhub free-tier history depth for insider-transactions is
  unverified locally; the SEC fallback covers any shortfall.
- Marker y-position uses the day's close; if a transaction date has no
  matching trading-day point (holiday/weekend filing of an earlier
  trade), snap to the nearest prior trading day. To confirm in the plan.
