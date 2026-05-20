import { runRegression } from './regression.js';
import { getHistory } from './priceHistory.js';
import { getFredSeries } from './fredMacro.js';
import { getSheetPortfolio } from './sheetPortfolio.js';

// factorSensitivity.js — the assembled MACRO terminal panel: every
// holding's daily returns regressed on each macro factor over a
// 252-trading-day lookback, then aggregated to a portfolio β per
// factor with the market-value-weighted scheme the design doc locks.
//
// The 5 factors (DGS10 / WTI / USD index / VIX / SPY) live in a small
// static catalog up top. Adding a factor is one row + the right
// `kind` ('delta' for level series like yields & VIX, 'relative' for
// price-style series like oil, USD index, and SPY); everything else
// flows from there. The yield-vs-price kind distinction is the most
// confused methodological choice in the spec and the panel footer
// flags it in plain English — `kind` is the single source of truth.
//
// Sub-project 2's primitive style is the template: pure deterministic
// math wherever possible, deps injection (`getSheetPortfolio`,
// `getHistory`, `getFredSeries`) for the network calls so the suite
// runs offline, never-throws contract so a bad sheet/upstream
// degrades a single cell rather than poisoning the whole panel.

// Static factor catalog — adding a sixth factor in v2 (Brent? IG OAS?
// 2y yield?) is a single row here. The defaultShock + unit drive the
// scenario preview the panel renders ("+50bps → book ~X.X%").
const FACTORS = [
  { id: 'DGS10',      label: '10Y Yield', source: 'fred',  kind: 'delta',    defaultShock: 0.50, unit: 'bps' },
  { id: 'DCOILWTICO', label: 'WTI Oil',   source: 'fred',  kind: 'relative', defaultShock: 0.10, unit: '%' },
  { id: 'DTWEXBGS',   label: 'USD Index', source: 'fred',  kind: 'relative', defaultShock: 0.05, unit: '%' },
  { id: 'VIXCLS',     label: 'VIX',       source: 'fred',  kind: 'delta',    defaultShock: 5.0,  unit: 'pts' },
  { id: 'SPY',        label: 'S&P 500',   source: 'price', kind: 'relative', defaultShock: 0.05, unit: '%' },
];

// Six-hour cache shared at the result level. The 5 factors × the
// per-ticker fetches dominate cost; even a fully warm cache one rung
// down (priceHistory's DB rows, getFredSeries's 6h memo) the
// regression loop is hundreds of multiplications per pair. Re-running
// it on every page refresh is wasteful; the macro view is a slow-
// moving snapshot.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cache = { at: 0, data: null };

// Build the daily-return series for a price-style ticker bar set.
// Returns simple relative returns close[t]/close[t-1] - 1, keyed by
// date so the downstream date intersection is a plain object lookup.
// The first bar has no prior, so it's skipped (no return defined).
function relativeReturnsByDate(bars) {
  const out = {};
  if (!Array.isArray(bars) || bars.length < 2) return out;
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1];
    const b = bars[i];
    if (!a || !b) continue;
    const prev = Number(a.close);
    const cur = Number(b.close);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) continue;
    out[b.date] = cur / prev - 1;
  }
  return out;
}

// Build a daily-return series for a FRED-style observation list with
// the supplied `kind`. delta = daily Δ in level (the right transform
// for yields & VIX where the level is the economic quantity, not the
// price of an asset); relative = daily relative change (the right
// transform for prices in level form: oil, USD index, SPY).
function factorReturnsByDate(observations, kind) {
  const out = {};
  if (!Array.isArray(observations) || observations.length < 2) return out;
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1];
    const b = observations[i];
    if (!a || !b) continue;
    const prev = Number(a.value);
    const cur = Number(b.value);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    if (kind === 'delta') {
      out[b.date] = cur - prev;
    } else if (kind === 'relative') {
      if (prev === 0) continue;
      out[b.date] = cur / prev - 1;
    }
  }
  return out;
}

// Date-aligned join: walk the smaller keyset, emit aligned-by-index
// y/x pairs only where both series have a value on the same date.
// Order is irrelevant for OLS (the regression is symmetric over the
// rows) but we iterate the y key set in insertion order to keep the
// result deterministic for snapshot/inspection.
function alignReturns(yByDate, xByDate) {
  const ys = [];
  const xs = [];
  for (const [date, yv] of Object.entries(yByDate)) {
    const xv = xByDate[date];
    if (xv === undefined) continue;
    ys.push(yv);
    xs.push(xv);
  }
  return { ys, xs };
}

export async function getMacroSensitivity(deps = {}) {
  if (!deps.forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  const fetchPortfolio = deps.getSheetPortfolio || getSheetPortfolio;
  const fetchHistory = deps.getHistory || getHistory;
  const fetchFred = deps.getFredSeries || getFredSeries;

  // Holdings + market values. Cash is excluded (FGTXX/BDADDA are
  // tracked but not regressed — per the user's standing memo, they're
  // the club's cash sleeve, not investments). A sheet failure
  // degrades the whole panel to "no holdings" honestly rather than
  // throwing through.
  let holdings = [];
  let marketValues = {};
  try {
    const portfolio = await fetchPortfolio();
    const arr = Array.isArray(portfolio) ? portfolio : (portfolio?.holdings || []);
    for (const h of arr) {
      if (!h || h.isCash) continue;
      const ticker = String(h.ticker || '').trim().toUpperCase();
      if (!ticker) continue;
      const mv = Number(h.marketValue);
      if (!Number.isFinite(mv) || mv <= 0) continue;
      holdings.push(ticker);
      marketValues[ticker] = mv;
    }
  } catch (err) {
    console.warn('factorSensitivity: portfolio fetch failed:', err.message);
    holdings = [];
    marketValues = {};
  }

  // Per-ticker return maps. Computed once per ticker rather than per
  // (ticker, factor) pair — the regression's regressor changes
  // factor-to-factor but the dependent variable (the holding's daily
  // returns) is the same across all five rows.
  const tickerReturns = {};
  for (const t of holdings) {
    try {
      const bars = await fetchHistory(t, '1y');
      tickerReturns[t] = relativeReturnsByDate(bars);
    } catch (err) {
      console.warn(`factorSensitivity: history fetch failed for ${t}:`, err.message);
      tickerReturns[t] = {};
    }
  }

  // One row per factor, in catalog order. Promise.all over the 5
  // factors so the FRED fetches (the dominant latency in a cold-cache
  // request) overlap; the per-ticker regression loop inside is
  // synchronous and cheap.
  const factors = await Promise.all(
    FACTORS.map(async (cfg) => {
      // Fetch the factor's observation series. 'price' factors ride
      // the same NASDAQ-backed price-bar cache as the holdings; 'fred'
      // factors hit the FRED observation feed (cached 6h).
      let factorByDate = {};
      try {
        if (cfg.source === 'price') {
          const bars = await fetchHistory(cfg.id, '1y');
          factorByDate = factorReturnsByDate(
            (bars || []).map((b) => ({ date: b.date, value: b.close })),
            cfg.kind
          );
        } else {
          // Over-fetch the FRED window (400d) so 252 trading days
          // still land after weekends + FRED reporting gaps.
          const obs = await fetchFred(cfg.id, { days: 400 });
          factorByDate = factorReturnsByDate(obs || [], cfg.kind);
        }
      } catch (err) {
        console.warn(`factorSensitivity: factor ${cfg.id} fetch failed:`, err.message);
        factorByDate = {};
      }

      // Per-ticker regression. Honest zero record for tickers whose
      // own history fetch failed — the row is still present so the
      // panel can show the universe count + which holdings were
      // dropped, never silently omit a ticker.
      const perTicker = holdings.map((t) => {
        const { ys, xs } = alignReturns(tickerReturns[t] || {}, factorByDate);
        const reg = runRegression(ys, xs);
        return {
          ticker: t,
          beta: reg.beta,
          alpha: reg.alpha,
          rSquared: reg.rSquared,
          n: reg.n,
          stdErr: reg.stdErr,
          tStat: reg.tStat,
        };
      });

      // n≥60 filter for the portfolio aggregate. A defensible OLS
      // floor: under 60 paired observations the slope estimate is too
      // noisy to contribute meaningfully, and including it would
      // smear the portfolio-β cue with stochastic shot-noise.
      const surviving = perTicker.filter((p) => p.n >= 60);
      const totalMv = surviving.reduce((s, p) => s + (marketValues[p.ticker] || 0), 0);

      // Renormalized weights over the survivors. If nothing survives,
      // portfolioBeta is 0 honestly (no aggregate to report).
      let portfolioBeta = 0;
      const survWithW = surviving.map((p) => {
        const w = totalMv > 0 ? (marketValues[p.ticker] || 0) / totalMv : 0;
        portfolioBeta += w * p.beta;
        return { ticker: p.ticker, beta: p.beta, weight: w };
      });

      // Top 3 contributors by |β × w|. The attribution cue the panel
      // surfaces — "your book is +0.42 to 10Y, driven mostly by NOC,
      // HD, GD" — lives here.
      const contributors = survWithW
        .map((p) => ({
          ticker: p.ticker,
          beta: p.beta,
          weight: p.weight,
          contribution: p.beta * p.weight,
        }))
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 3);

      // Scenario preview. expectedMove = portfolioBeta × defaultShock,
      // in the factor's native unit. The panel formats the unit
      // (bps for yields, % for prices, pts for VIX) on render.
      const scenario = {
        shock: cfg.defaultShock,
        expectedMove: portfolioBeta * cfg.defaultShock,
      };

      return {
        id: cfg.id,
        label: cfg.label,
        source: cfg.source,
        kind: cfg.kind,
        unit: cfg.unit,
        defaultShock: cfg.defaultShock,
        portfolioBeta,
        scenario,
        perTicker,
        surviving: surviving.map((p) => p.ticker),
        topContributors: contributors,
      };
    })
  );

  const data = {
    asOf: new Date().toISOString(),
    lookbackDays: 252,
    factors,
    holdings,
    marketValues,
  };
  cache = { at: Date.now(), data };
  return data;
}

// Test-only cache bust so the suite can rebuild the matrix without
// waiting six hours. Mirrors fredMacro._resetFredSeriesCache.
export function _resetFactorSensitivityCache() {
  cache = { at: 0, data: null };
}
