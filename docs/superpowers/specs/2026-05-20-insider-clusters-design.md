# Insider Cluster Scanner (Analytics Sub-Project 1)

- **Date:** 2026-05-20
- **Status:** Approved (user "build everything" — 3-feature analytics
  program, this is #1 of 3; lead-dev autonomy on the methodology
  details below, each open to veto). First feature in the new
  *analytics not retrieval* arc — output is a **screen / pattern
  surface**, not a backtested forward signal.
- **Scope:** New `ICLUSTER` terminal function. Across a small universe
  (v1: the fund's holdings), surface tickers where **≥3 distinct
  insiders made open-market purchases within the last 60 days**,
  weighted by insider role and dollar size, with an optional
  "buying into weakness" flag. Ranked candidate list, click → DES,
  AI brief, honest methodology footer.

## Why

The terminal currently *retrieves* insider transactions (INSDR shows
Form 4 markers on the chart for one ticker at a time). Anyone with
Finnhub or EDGAR has that. The differentiated layer is the **cluster
analytic across a universe**: multi-insider purchase windows are a
documented stronger signal than individual buys (academic insider-
trading literature: Cohen-Malloy-Pomorski; Jeng-Metrick-Zeckhauser).
Computing that across the book and ranking it produces a *signal
surface* — investment-finding for names you already watch, not
fact-retrieval. This also builds the reusable **event-detection-
with-significance primitive** sub-projects #2 (weather → impact)
and #3 (macro factor sensitivity) will inherit the methodology
discipline from.

## Locked methodology decisions

Every signal panel ships with these documented in-UI (footer/AI
brief context) so the surface is defensible, not vibes:

1. **Cluster window:** 60 days. Standard event-study window for
   insider clustering; long enough to catch a thesis-driven multi-
   insider buy program, short enough to keep the signal current.
2. **Cluster threshold:** **≥3 distinct insiders** (unique by name)
   with at least one open-market purchase in the window. Excludes
   single-insider routine purchases; aligns with the cluster
   definition in the literature.
3. **Transaction filter:** open-market purchases only — Form 4
   transaction code `P`. Reuse `classifyCode` in `insiderTx.js`.
   Explicitly EXCLUDED: option exercises (`M`), gifts (`G`),
   pre-arranged 10b5-1 sales, automatic-plan trades, any non-P
   code. Including exercises destroys signal quality.
4. **Insider role weighting** (HONEST constraint: Form 4 exposes
   role *buckets*, not titles like CEO/CFO — `roleFromRelationship`
   returns `Officer | Director | 10% Owner`. No further granularity
   possible from the data we pull, so weighting is at the bucket
   level):
   - `Officer` = 1.0
   - `Director` = 0.6
   - `10% Owner` = 0.3
   - unknown/none = 0.2
5. **Composite score per ticker:**
   `score = Σ (roleWeight × dollarValue)` summed across all
   qualifying open-market purchases in the window. Dollar value =
   `shares × pricePerShare` per transaction.
6. **"Buying into weakness" flag:** the most recent qualifying buy's
   price ≤ (90-day intraday high × 0.90) — i.e. stock down ≥10%
   from its recent high at the time the insider bought. Reuses the
   existing Postgres `PriceBar` cache via `priceHistory.js`. The
   flag is an *informational chip*, NOT a filter — surface every
   qualifying cluster, mark which were into-weakness. Default sort
   = score desc; secondary sort = into-weakness first within ties.
7. **Universe v1:** the fund's holdings from `sheetPortfolio.js`
   (cash excluded). Roughly ~10–25 tickers. Watchlist tickers
   (PR #32) are added automatically *only if* the watchlist route is
   present at runtime (loose coupling — works in either merge
   order). A `?tickers=A,B,C` query override supports ad-hoc scans
   without changing the default universe.
8. **Refresh model:** **on-demand from the panel**, 6h per-ticker
   cache on the cluster computation (Form 4 filings don't change
   sub-daily; this matches the existing `secFilings.js` 6h cache
   convention). No new cron in v1 — adding one is a trivial
   follow-up if the panel feels cold.
9. **Honesty framing (mandatory in UI):** the panel footer + the AI
   brief context explicitly state this is a **screen, not a
   backtested forward signal**. We surface a pattern the literature
   associates with stronger performance, but no forward t-test is
   computed in v1 — that's a deliberate research follow-up. Disclose
   `n` (universe size), the 60d window, source (SEC Form 4 via the
   existing dual Finnhub-primary / SEC-fallback fetcher).

## Architecture

### `server/src/services/insiderClusters.js` (new)
- `getTickerCluster(ticker, deps)` → `{ ticker, insiderCount,
  totalDollars, score, intoWeakness, periodDays, latestBuyAt,
  topInsider } | null`. Reuses `insiderTx.js`'s existing Form 4
  fetcher (don't duplicate the dual-source plumbing). Filters
  transactions: code `P` only, within 60d. Groups by insider name,
  counts distinct. If <3 distinct → returns null. Otherwise computes
  the score per the weighting above, looks up the 90d high via the
  existing `priceHistory.js` cache + the most-recent qualifying
  price to set `intoWeakness`. Never-throws (null on any failure).
  Per-ticker `Map` cache, 6h TTL, deps-injectable for tests.
- `scanUniverse(tickers, deps)` → ranked `[{ticker,...}]` (descending
  score). `Promise.allSettled` with a small concurrency cap (≤6) so
  we don't spike Finnhub. Filters out nulls. Never-throws.

### `server/src/routes/terminal.js` (modified)
- Extracted `insiderClustersHandler(req, res, deps={})` with
  injectable `deps.scanUniverse` / `deps.getSheetPortfolio` /
  `deps.getWatchlist`. Builds the universe = holdings (always) +
  watchlist (if the optional watchlist service is importable —
  swallow `ERR_MODULE_NOT_FOUND` so this route doesn't break
  pre-merge of #32). Accepts `?tickers=A,B,C` to override. Caps at
  ~50 tickers (universe bound). Returns
  `{ asOf, universe, results: [...] }`. Inherits the standard
  `verifyJwt → requireExecutive → aiLimiter` chain. try/catch →
  200 honest empty on any failure (never 5xx).
- `FN_PROMPTS.ICLUSTER`: a forensic-analyst prompt (per CLAUDE.md
  voice). Flag the top scoring names, note role composition and
  total dollars, distinguish into-weakness vs into-strength clusters,
  and explicitly frame as "screen, not standalone signal" + the
  shared `GROUNDING_RULES`.

### Client — `client/src/terminal/functions/InsiderClusters.jsx` (new) + registry
- Registry: `{ id:'ICLUSTER', label:'Insider Clusters',
  help:'Multi-insider buy clusters across your book (last 60d).',
  requires:null, component: InsiderClusters }`.
- On mount `GET /terminal/insider-clusters`. Render `term-panel`
  + `term-table`: **Ticker · #Insiders · Total $ · Score ·
  Latest Buy · Into Weakness?**, sorted by score desc. Each row
  clickable → `onOpen({ticker, fn:'DES'})` (the established
  click-to-DES pattern). `◢ AI BRIEF` via `/terminal/annotate`
  (confab-safe: no annotate call on empty results → honest "No
  qualifying clusters in the current universe over the last 60d"
  message). Loading/empty/error states mirror the just-shipped
  panel conventions (Earnings/Filings/Consensus).
- **Methodology footer** (always visible, muted): "Universe: your
  holdings (N=…). Window: 60d. Threshold: ≥3 distinct insider
  open-market purchases (Form 4 code P, exercises excluded).
  Weights: Officer 1.0 · Director 0.6 · 10%-Owner 0.3. Source:
  SEC Form 4. **Screen, not a backtested signal — use as
  evidence within a fundamentals thesis, not a standalone trade
  trigger.**"

## Data flow

```
panel mount → GET /terminal/insider-clusters
  → build universe (holdings + optional watchlist + optional ?tickers=)
  → scanUniverse → for each ticker → getTickerCluster
       → insiderTx.fetcher (existing Finnhub/SEC dual)
       → filter code P + 60d window
       → group by distinct insider, count, sum role-weighted $
       → if cluster: 90d high via priceHistory cache → intoWeakness
  → rank by score desc → 200 { asOf, universe, results }
  → table + AI brief (confab-safe) + methodology footer
```

## Error handling

`getTickerCluster` / `scanUniverse` never throw (null per ticker on
failure; route degrades to 200 honest-empty). A failed Finnhub for
one ticker doesn't break the scan. The route never 5xx. Client
keeps last-good results across re-fetches. SEC/Finnhub from Render
is the proven path (INSDR already uses it). Live confirmability is
prod-only (standing limitation).

## Testing

- `insiderClusters.test.js`: inject fake Form-4 rows; assert:
  - cluster threshold (3 distinct insiders required; 2 → null);
  - code-P filter (S/M/G/A all excluded);
  - 60d window cutoff;
  - role weighting matches the locked weights;
  - score = Σ(weight × $);
  - intoWeakness flag computed correctly given an injected 90d high;
  - never-throws on injected throw / empty / junk.
- `terminal.insiderClusters.test.js`: route returns `{asOf,
  universe, results}`; inherits structural auth-parity vs
  `/governance` (the precedent technique); never 5xx on service
  reject; `?tickers=` override; missing watchlist module is
  honestly degraded (no crash).
- Full `npm test` green; client `npm run build` `✓ built`.

## Build

Branch `feat/insider-clusters` off latest main (a7e4cc2). TDD,
subagent-driven. Single focused implementer (service + scanner +
route + prompt + tests + panel + registry). One PR.

## Open items / honest risks

- **No CEO/CFO title distinction in the source** (role bucket only).
  We weight Officer = 1.0 uniformly. Adding a title layer would
  require enriching from `/stock/profile2` per insider name (extra
  API cost) and isn't reliable — out of scope; documented.
- **No forward-return validation in v1** (no t-statistic on
  historical clusters producing alpha). The literature supports the
  pattern; we surface the pattern. A proper backtest (computing
  forward 60d/120d returns on historical clusters across the
  universe) is the natural sub-project follow-up once the event-
  study primitive matures with #2 (weather). Footer states this
  honestly.
- **Universe is intentionally small** (holdings + watchlist). A
  broader-universe scanner (S&P 500) is a clean extension once the
  per-ticker compute proves out — no architecture change, just
  bigger input.
