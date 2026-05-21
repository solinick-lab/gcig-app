# Weather → Portfolio Impact Engine (Analytics Sub-Project 2)

- **Date:** 2026-05-20
- **Status:** Approved (user "build everything" — 3-feature analytics
  program, this is #2 of 3; lead-dev autonomy on methodology, each
  open to veto).
- **Scope (v1):** New `WX` terminal function. Maps **named-storm
  US-landfall events** to **exposed-basket tickers** (Gulf O&G,
  P&C insurers), computes the **historical forward-return
  event-study** against the price-bar cache (5y window → ~15–20
  events), surfaces the user's holdings overlap, and (where the live
  NHC feed is reachable from Render) lists current active named
  storms. Output is a **historical playbook**, not a forecast.

## Why

Weather is a textbook driver of certain market exposures (hurricanes
→ Gulf refining + P&C insurers; HDD/CDD → nat gas + utilities;
drought → ag). The lean v1 picks the **single cleanest event type**
(named-storm landfall) with the cleanest free archive (NHC HURDAT2)
and the most-discrete affected baskets. It demonstrates the pattern
and forces us to build the reusable **event-study primitive** that
sub-project 3 (macro factor sensitivity) and any future event-study
panel (8-K material events, FDA approvals, etc.) will inherit.

## Locked methodology decisions

1. **Event type v1:** US-landfall named storms (hurricanes + tropical
   storms reaching shore). HDD/CDD, drought, freeze, etc. are
   acknowledged future event types — explicitly out of v1 scope.
2. **Historical archive:** commit a small curated JSON fixture
   `server/src/services/__fixtures__/hurdat2-us-landfalls.json` —
   2020–present US-landfall named storms with `{ name, date,
   category, states }`. Source: NHC HURDAT2 / NHC public archive.
   Document the source URL in the fixture comment and in a small
   `scripts/build-hurdat2-fixture.mjs` (parser/writer; rerun to
   refresh future years). The fixture is small (<20KB), authoritative
   for the in-cache window, and avoids runtime parsing of HURDAT2.
3. **Live feed (best-effort):** NHC active-advisories feed
   (`https://www.nhc.noaa.gov/CurrentStorms.json` — free, no key).
   Fetch via `SEC_UA`-equivalent honest UA string, 1h cache, never-
   throws. If unreachable from Render → degrade honestly to "no live
   feed" — historical playbook still works.
4. **Exposure baskets (v1, curated, in-repo config):**
   - `gulf_oil_gas` → `['XOM','OXY','MRO','ET','EPD','KMI','CTRA']`
     (Gulf of Mexico producers + pipelines).
   - `pc_insurers` → `['HIG','TRV','ALL','PGR','CB']`
     (Hurricane-exposed P&C insurers).
   Both rationales are editorial, transparent, listed in the
   methodology footer. Baskets are config — a follow-up sub-project
   can add `nat_gas` / `utilities` / `ag` once HDD/drought event
   types are added.
5. **Event-study primitive (REUSABLE — sub-project 3 inherits):**
   `runEventStudy(events, basket, deps) → { perWindow: { '1d':
   {mean,median,std,n,tStat}, '5d': {...}, '20d': {...} },
   perEvent: [{event,window,ret,benchRet,abnormal}] }`.
   - **Returns:** simple price-change (close-to-close) over each
     window from `event.date` to `event.date + windowDays` (next
     trading day basis — skip non-trading days).
   - **Abnormal return:** ticker forward N-day return MINUS SPY
     forward N-day return over the same window (SPY-relative;
     keeps the signal sector-neutral against the market move).
   - **Aggregation:** equal-weighted across basket tickers
     per event, then averaged across events. Report mean +
     median + std + n + simple two-sided t-stat
     `t = mean / (std / sqrt(n))`. n = events × basket-tickers
     with valid price data on both endpoints.
   - **Pure, deterministic, testable.** Hand-computable on small
     fixture data → real tests.
6. **Price source:** `priceHistory.js` `getHistory(ticker, '5y')`.
   That bounds the window to 2020-present (~15–20 events). Honest
   `n=…` in the UI; smaller-than-academic but real signal surface.
7. **Honest framing (mandatory UI):** Footer + AI brief disclose:
   the event archive scope, the basket definitions + rationale,
   the SPY-relative methodology, the n, the 5y window limit,
   "historical playbook, not a forecast." No forward-looking claim.

## Architecture

### `server/src/services/eventStudy.js` (NEW, reusable)
Pure function `runEventStudy(events, basket, deps)`:
- `events`: `[{ date: 'YYYY-MM-DD', label, ...meta }]`
- `basket`: `['XOM', ...]`
- `deps.getHistory(ticker, range='5y')` → `{ bars: [{date,close,high,low,...}, …] }` (default = real `priceHistory.getHistory`)
- Computes, for each (event × ticker) and each window in `{1, 5, 20}`:
  - Find the first trading day ≥ `event.date` (the "T0" close).
  - Find the close `windowDays` trading sessions later.
  - Forward return = (closeT+N / closeT0) − 1.
  - SPY forward return over the same actual calendar window → abnormal = ticker − SPY.
- Aggregates per window: mean, median, std, n (events × tickers with valid data), t-stat.
- Never throws (missing bars → that observation is skipped, contributes nothing to n).
- Tests against hand-computed fixtures.

### `server/src/services/weatherExposure.js` (NEW)
Exports the curated basket config:
```js
export const EXPOSURES = [
  { id:'gulf_oil_gas', label:'Gulf O&G', tickers:[…],
    rationale:'…', eventTypes:['us_landfall_named_storm'] },
  { id:'pc_insurers', label:'P&C Insurers (hurricane-exposed)',
    tickers:[…], rationale:'…', eventTypes:['us_landfall_named_storm'] },
];
```
Plain data. No logic.

### `server/src/services/weatherSignals.js` (NEW)
- Imports the HURDAT2 landfalls fixture, the exposure config, the event-study primitive, and (best-effort) fetches NHC active storms.
- `getWeatherImpact(holdings, deps)` → `{ asOf, activeStorms, exposures: [{ exposure, holdingsOverlap, study }] }`.
  - For each exposure: `runEventStudy(landfalls, exposure.tickers)` (cached 6h shared across requests — the math is deterministic per fixture+price data).
  - `holdingsOverlap` = intersection of `holdings` with each basket — *your* held names in this exposure. Empty array if you don't hold any → still surfaced (informational).
  - `activeStorms` from NHC live feed; `[]` if unreachable.
- Never throws.

### `server/src/routes/terminal.js` (modified)
- Extracted `weatherImpactHandler(req,res,deps={})` (`deps.getWeatherImpact` injectable, plus `deps.getSheetPortfolio` for the holdings). Inherits the standard auth chain. try/catch → 200 honest empty.
- Register `router.get('/weather-impact', …)` no per-route mw.
- Add `FN_PROMPTS.WX` (climate/event-study analyst voice; flag active storms if any; cite the historical mean abnormal return per basket; explicitly frame as "historical playbook, not a forecast"; show overlap with the user's book) + `GROUNDING_RULES`.
- Add `KNOWN_FUNCTIONS` WX entry (label "Weather Impact") matching the established pattern.

### Client — `client/src/terminal/functions/WeatherImpact.jsx` (NEW) + `registry.js`
- Registry: `{ id:'WX', label:'Weather Impact', help:'Named-storm event impact on your Gulf O&G + insurer exposure.', requires:null, component:WeatherImpact }`.
- On mount `GET /terminal/weather-impact`.
- **Section 1 — Active storms** (if any): name, category, public-advisory time, brief track/landfall outlook from the NHC feed. (Empty/no-active state is the common case — render an honest "No active US-landfall threats in the NHC feed right now" line.)
- **Section 2 — Historical playbook** per exposure: a card per basket showing
  `[basket label] · n=… events · 5d abnormal mean=X% (median=Y%, t=Z)` and
  the user's holdings overlap (chips). Clickable ticker chips → DES.
- **AI BRIEF** via `/terminal/annotate` (confab-safe — no annotate call if both activeStorms and historical n are empty).
- **Methodology footer (always visible):** "Archive: NHC HURDAT2 US-landfall named storms (2020-present, n=N). Baskets curated in-repo (Gulf O&G: XOM/OXY/…; P&C: HIG/TRV/…). Forward returns are SPY-relative (sector-neutral). Window bounded by 5y price-bar cache. **Historical playbook, not a forecast. Use as evidence within a thesis, not a standalone trade trigger.**"

## Data flow

```
panel mount → GET /terminal/weather-impact
  → getWeatherImpact:
       fixture HURDAT2 landfalls
     + curated exposure baskets
     + runEventStudy(events, basket.tickers) using priceHistory.getHistory(_, '5y') + SPY
     + best-effort NHC active-storm fetch
     + holdings overlap (sheetPortfolio)
  → ranked exposure cards + active storms + AI brief + footer
```

## Error handling

`getWeatherImpact` never throws — missing price data per ticker reduces n but doesn't crash; NHC live fetch failure → empty `activeStorms`; route try/catch → 200 honest empty. SEC/Finnhub/NHC from Render is the proven path class.

## Testing

- `eventStudy.test.js` (the math — hand-computed):
  - Single event, single ticker, known prices: mean=expected, std=expected, n=1.
  - 3 events × 2 tickers (6 observations), some missing → n=4 (skip missings).
  - SPY-relative subtraction correct against injected SPY bars.
  - Multiple windows (1d/5d/20d) computed independently.
  - Never throws on empty events / empty basket / missing bars / non-monotonic dates.
- `weatherSignals.test.js`: with injected events fixture + injected price+exposure + stubbed NHC → assert the assembled shape, holdings overlap correctness, NHC failure → empty `activeStorms`.
- `terminal.weatherImpact.test.js`: route returns `{asOf, activeStorms, exposures}`; never 5xx; structural auth-parity vs `/governance`.
- Full `npm test` green; `node --check`; client `npm run build` `✓ built`.

## Build

Branch `feat/weather-impact` off latest main. TDD, subagent-driven. One PR. Single focused implementer (event-study primitive + fixture + exposure config + signals service + route + prompt + panel + tests). The implementer will populate the HURDAT2 fixture from the documented authoritative source (NHC archive) and commit the small parser/writer script for reproducibility.

## Open items / honest risks

- **Small n** (5y price data × ~3 US-landfalls/year ≈ 15 events × 5-7 tickers per basket ≈ 75-100 obs/window). Useful, but the t-statistic confidence intervals will be wide. Disclose honestly in the UI.
- **Curated baskets** are editorial — Gulf O&G + P&C insurers are uncontroversial choices, but the choice is human judgment, transparent in code, not derived from data. Documented as such.
- **NHC live feed from Render** is unconfirmed (proxy/GSAM-class limitation). If blocked, panel works without the active-storm section.
- **Bigger event types deferred** (HDD/CDD, drought, ag, freeze) — explicit follow-up sub-projects once the v1 pattern is validated.
