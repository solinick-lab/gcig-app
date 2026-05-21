# Macro Factor Sensitivity (Analytics Sub-Project 3)

- **Date:** 2026-05-20
- **Status:** Approved (user "build everything"; #3 of 3; lead-dev
  autonomy on methodology, each decision open to veto).
- **Scope:** New `MACRO` terminal function. Regress every holding's
  daily returns on macro factors (10Y yield, WTI oil, USD index,
  VIX, SPY) over a 252-trading-day lookback. Aggregate to portfolio
  beta per factor + market-value-weighted, with R² + n + scenario
  preview ("if 10Y +50bps → book ~Z%"). Bloomberg PORT/BETA flavor
  on data we already pull.

## Why

Sub-project 2 shipped event-studies (discrete events × baskets).
Sub-project 3 ships the complementary primitive — **continuous factor
regression** — over the same price-bar cache + FRED data we already
fetch. Together these are the two foundational analytics tools
(events + regressions) that any future signal panel (rolling beta,
factor attribution, sector exposure decomposition) inherits from.
The output ("if 10Y moves 50bps, your book takes ~−2.1%") is pure
*track-what-you-have* — squarely in the user's mandate ("data for
finding investments and tracking them").

## Locked methodology decisions

1. **Lookback window:** 252 trading days (≈ 1 year). Standard. Stable
   enough for OLS, recent enough to reflect current sensitivity.
   Documented; tunable later.
2. **Factors v1** (all FRED, already plumbed; SPY via price-bar
   cache):
   - **DGS10** — 10-Year Treasury constant-maturity yield (%). Factor
     "return" = **daily Δ in percentage points** (NOT a relative
     return — yields are levels, not prices). A 50bps move = 0.50.
   - **DCOILWTICO** — WTI oil ($/bbl). Factor return = **daily
     relative return** (level-to-level price-style).
   - **DTWEXBGS** — USD broad trade-weighted index (level). Factor
     return = **daily relative return** (level-to-level).
   - **VIXCLS** — VIX (volatility level, %). Factor return =
     **daily Δ in points** (level change, not relative — VIX is a
     volatility level, not a price; relative returns of VIX are
     statistically pathological because of mean-reverting low
     levels).
   - **SPY** — daily relative return from the price-bar cache.
     Market beta is the standard reference and a sanity check.
3. **Regression:** simple OLS (ordinary least squares) of ticker
   daily simple returns on the factor's daily "return" (Δ for
   level factors, relative for price factors). Output per (ticker,
   factor): **β** (slope), **α** (intercept), **R²**, **n**
   (observations), **stdErr(β)**, **tStat(β) = β / stdErr(β)**.
   Pure math, hand-computable.
4. **Date alignment:** factor and ticker daily series have different
   non-trading days. Use the **intersection of dates** with both
   values present; that's `n`. Drop observations where either side
   is null/NaN. Honest: this can produce n < 252 for factors with
   thinner reporting (DTWEXBGS is daily M-F like markets; FRED
   yields/VIX are daily but with occasional gaps).
5. **Portfolio aggregation:** `portfolioBeta(factor) = Σ wᵢ × βᵢ`
   where `wᵢ = marketValueᵢ / Σ marketValueⱼ` from `sheetPortfolio`
   (cash excluded). Tickers without sufficient `n` (< 60
   observations — a defensible floor for OLS stability) are EXCLUDED
   from the portfolio aggregate (their weight is redistributed
   proportionally across the remaining). Honest about which holdings
   contributed to each factor's portfolio beta.
6. **Scenario preview:** `expectedBookMove(factor, shock) =
   portfolioBeta(factor) × shock`, where `shock` is in the factor's
   native unit (50bps Δ in 10Y → shock = 0.50; +10% in oil →
   shock = 0.10; +5pts in VIX → shock = 5.0). UI shows a sensible
   default shock per factor with an editable input.
7. **Top contributors:** for each factor, surface the **top 3
   holdings** by `|βᵢ × wᵢ|` (their contribution to the portfolio
   beta), with their individual β + R² + n. That's where the
   *attribution* lives — "your book is +0.42 to 10Y, driven mostly
   by NOC, HD, and GD."
8. **Honest framing (mandatory UI footer):** lookback (252 td),
   factor units (Δ for yields/VIX, relative for oil/USD/SPY),
   regression type (simple OLS, no Newey-West or HAC standard
   errors), R² and n disclosed per row, "rolling betas drift —
   refresh and re-read after major regime changes," and "this is
   sensitivity to past movements, not a forecast of future
   movements."

## Architecture

### `server/src/services/regression.js` (NEW, reusable analytics primitive)
`export function runRegression(yReturns, xReturns) → { beta, alpha,
rSquared, n, stdErr, tStat }`. Both inputs are aligned-by-index
arrays of numbers (the caller does date intersection upstream).
- Defensive: filter pairs where either is null/NaN. If n < 2 →
  return `{ beta:0, alpha:0, rSquared:0, n, stdErr:0, tStat:0 }`
  honestly (no fake numbers).
- Compute means, β = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²), α = ȳ - β·x̄,
  fitted = α + β·x, residuals = y - fitted, SSres = Σ(residuals²),
  SStot = Σ((y-ȳ)²), R² = 1 - SSres/SStot (or 0 if SStot=0),
  stdErr(β) = sqrt(SSres / (n-2)) / sqrt(Σ((x-x̄)²)) if n≥3 else 0,
  tStat = β / stdErr if stdErr>0 else 0.
- Pure deterministic math. Never throws. Tests against hand-computed
  inputs (small arrays where every value is verifiable).

### `server/src/services/fredMacro.js` (modified)
Add `export async function getFredSeries(seriesId, { days = 365 })` →
`[{ date: 'YYYY-MM-DD', value: number }, …]` (most recent → oldest
or oldest → most recent; pick one and document — `oldest first` is
the convention that lines up with how the price-bar cache returns
bars). Reuses the existing FRED HTTP helper + API key handling.
Returns `[]` when no FRED_API_KEY (preserves the existing
"hidden when unset" pattern). Never throws. 6h in-memory cache per
seriesId (mirror existing).

### `server/src/services/factorSensitivity.js` (NEW)
`getMacroSensitivity(deps={}) → { asOf, lookbackDays, factors, holdings, marketValues }`:
- Holdings + market values from `sheetPortfolio.js` (cash excluded).
- Factors: predefined list with metadata (id, label, source, kind=
  'delta'|'relative', defaultShock, displayUnit).
- For each ticker × factor:
  - Fetch ticker daily bars via `priceHistory.getHistory(t, '1y')`.
  - Fetch factor series via `getFredSeries(id, { days: 400 })`
    (over-fetch a bit to ensure 252 td after intersection) or SPY
    via `getHistory('SPY', '1y')`.
  - Compute daily ticker returns (relative).
  - Compute factor "returns" by kind (delta for DGS10/VIXCLS,
    relative for DCOILWTICO/DTWEXBGS/SPY).
  - Intersect by date.
  - `runRegression(tickerRets, factorRets)` → per-pair beta record.
- Aggregate:
  - Per factor: filter (ticker,factor) pairs with n ≥ 60. Recompute
    weights `wᵢ` over the surviving subset. `portfolioBeta(factor) =
    Σ wᵢ × βᵢ`. Surviving-tickers list documented per factor.
  - Per-factor top 3 by `|βᵢ × wᵢ|` (contribution).
  - Per-factor `scenario = { shock: defaultShock, expectedMove:
    portfolioBeta × defaultShock }`.
- Returns the shape above. 6h cache shared (deterministic per
  factor+universe+market-data state).
- Never throws.

### `server/src/routes/terminal.js` (modified)
- Extracted `macroSensitivityHandler(req,res,deps={})` (`deps.getMacroSensitivity` injectable). Route `GET /terminal/macro-sensitivity`. Inherits the standard auth chain. try/catch → 200 honest empty (never 5xx).
- Add `FN_PROMPTS.MACRO`: macro analyst voice — cite portfolio β per factor, the dominant contributors (top 3 holdings + their β), the scenario for the default shock, flag R² so the user knows how predictive the relationship has been; explicitly frame as "past sensitivity, not future forecast." + `GROUNDING_RULES`.
- Add `KNOWN_FUNCTIONS` MACRO entry (label "Macro Sensitivity").

### Client — `client/src/terminal/functions/MacroSensitivity.jsx` (NEW) + registry
- Registry: `{ id:'MACRO', label:'Macro Sensitivity', help:'Portfolio sensitivity to 10Y, oil, USD, VIX, SPY (1y OLS).', requires:null, component: MacroSensitivity }`.
- On mount `GET /terminal/macro-sensitivity`.
- Per factor card: factor label · portfolio β (signed, colored), default scenario ("+50bps → book ~−2.1%"), n, R² in muted text, **top 3 contributors** with their individual β + R² + n, each ticker chip clickable → `onOpen({ticker,fn:'DES'})`.
- AI BRIEF (confab-safe — no annotate call when all factors have n<60).
- Methodology footer (always visible, muted): "Lookback: 252 trading days. Factors: 10Y/VIX/USD/oil/SPY via FRED+price-bar cache. Returns: daily Δ in pp for yields & VIX (levels, not prices); daily relative for oil/USD/SPY. Regression: simple OLS; standard errors are unadjusted. Portfolio β = Σ weight × β over tickers with n ≥ 60. **Past sensitivity, not forecast. Rolling betas drift across regimes — refresh and re-read.**"

## Data flow

```
panel mount → GET /terminal/macro-sensitivity
  → getMacroSensitivity:
       holdings + MV from sheetPortfolio
     + for each factor (DGS10/DCOILWTICO/DTWEXBGS/VIXCLS/SPY): fetch series (FRED or price-bar)
     + for each ticker × factor: align dates, compute returns (delta vs relative per factor.kind),
       runRegression → { β, α, R², n, stdErr, tStat }
     + aggregate to portfolioβ (n ≥ 60 filter, weight redistribution) + top-3 contributors + scenario
  → panel: factor cards + top contributors + scenario + AI brief + methodology footer
```

## Error handling

`runRegression` never throws (insufficient n → zeros honestly).
`getFredSeries` returns [] on missing key / fetch failure → the
factor surfaces with n=0 in the panel (honest, no fake β). Route
try/catch → 200 honest empty. Live FRED-from-Render is the proven
path (the macro snapshot already runs there).

## Testing

- `regression.test.js`: hand-computed inputs.
  - Perfectly correlated: x = [1,2,3,4,5], y = [3,5,7,9,11]
    (y = 1 + 2x). Assert β=2, α=1, R²=1, n=5, residuals=0.
  - Zero correlation: x = [1,2,3,4], y = [4,3,4,3]; assert β
    (compute by hand), R² < 1.
  - n < 2 → all zeros, no throw.
  - With null/NaN entries → filter pairs, recompute on the clean
    subset.
- `factorSensitivity.test.js`: inject deps for `getHistory` /
  `getFredSeries` / `getSheetPortfolio`; assert the shape,
  delta-vs-relative-return correctness per factor, n ≥ 60 filter,
  weight redistribution, top-3 ranking by |β × w|.
- `terminal.macroSensitivity.test.js`: route returns the shape;
  never 5xx; structural auth-parity vs `/governance`.
- Full `npm test` green; client `npm run build` `✓ built`.

## Build

Branch `feat/macro-sensitivity` off latest main. TDD, subagent-
driven. Single focused implementer (regression primitive + tests +
fredMacro extension + sensitivity service + tests + route + prompt
+ panel + tests).

## Open items / honest risks

- **R² will be low for most pairs** — single-factor regressions on
  individual stocks typically yield R² in 0.05–0.30 range; that's
  honest, not a bug. The panel surfaces R² explicitly so users see
  the noise level.
- **No HAC/Newey-West standard errors** in v1 (no correction for
  autocorrelation / heteroskedasticity). The tStat is the naïve
  one; that's a research follow-up, not v1 scope. Footer states
  this.
- **Yield-as-Δ-pp vs price-as-relative** is the most-confused
  methodological choice — disclosed in the footer in plain English
  so the reader knows the scenario "10Y +50bps → book ~Z%" math is
  `β × 0.50` not `β × 0.005`.
- **FRED_API_KEY required**; absent → factors return n=0 honestly.
- **252-day lookback** is short for stable β — disclosed.
- **No factor model (Fama-French, etc.)** in v1 — single-factor
  univariate regressions. Multi-factor models are a clean follow-up
  on top of the same `runRegression` primitive (one regressor per
  call; can be extended to multivariate later).
