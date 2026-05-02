// Server-side FRED panel for the CPI forecaster.
//
// The dashboard already pulls a tiny snapshot via fredMacro.js. The
// forecaster needs much more: ~15 years of monthly history for CPI plus
// 14 leading-indicator series. We cache the assembled panel for 12h
// because CPI updates once a month — even at 24h cadence the forecaster
// would always see fresh data on the day it runs (cron fires after the
// BLS release, so we'd want to bust the cache then; but a 12h TTL +
// month-of-data input means the forecaster always pulls a fresh fetch
// every time it runs).
//
// Returns the wide panel as JSON shaped for the Python forecaster:
//   {
//     fetchedAt: "2026-04-30T...",
//     monthEnd:  ["2005-01-31", ...],          // ISO date strings
//     series:    { CPIAUCSL: [..], DCOILWTICO: [..], ... }   // aligned arrays
//   }

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const REQUEST_TIMEOUT_MS = 15_000;

let cache = { at: 0, data: null };

// Mirror of the Python fred.py series list — this is the SOURCE OF TRUTH.
// If you change one side you must change the other.
const TARGET_ID = 'CPIAUCSL';
const SERIES = [
  // Headline target
  { id: 'CPIAUCSL',     frequency: 'M' },
  // CPI subcomponents — for hierarchical aggregation.
  { id: 'CPIUFDSL',     frequency: 'M' }, // Food
  { id: 'CPIENGSL',     frequency: 'M' }, // Energy
  { id: 'CPILFESL',     frequency: 'M' }, // Core
  // Original macro features.
  { id: 'DCOILWTICO',   frequency: 'D' },
  { id: 'GASREGW',      frequency: 'D' },
  { id: 'PPIACO',       frequency: 'M' },
  { id: 'PPIFIS',       frequency: 'M' },
  { id: 'CSUSHPISA',    frequency: 'M' },
  { id: 'CUSR0000SAH1', frequency: 'M' },
  { id: 'CES0500000003', frequency: 'M' },
  { id: 'UNRATE',       frequency: 'M' },
  { id: 'M2SL',         frequency: 'M' },
  { id: 'DTWEXBGS',     frequency: 'D' },
  { id: 'DGS10',        frequency: 'D' },
  { id: 'MICH',         frequency: 'M' },
  { id: 'INDPRO',       frequency: 'M' },
  { id: 'RSAFS',        frequency: 'M' },
  // ── NEW DATA (round 5) ─────────────────────────────────────────
  // Market-implied inflation expectations — the most direct signal
  // beyond MICH. Daily updated, immune to survey noise.
  { id: 'T5YIE',        frequency: 'D' }, // 5Y TIPS breakeven
  { id: 'T10YIE',       frequency: 'D' }, // 10Y TIPS breakeven
  { id: 'T5YIFR',       frequency: 'D' }, // 5Y forward 5Y inflation expectations
  // Cleveland Fed alternative inflation measures — these are what the Fed
  // actually watches. Median CPI and trimmed-mean strip out noise.
  { id: 'MEDCPIM158SFRBCLE',     frequency: 'M' }, // Median CPI
  { id: 'TRMMEANCPIM158SFRBCLE', frequency: 'M' }, // 16% trimmed-mean CPI
  // Atlanta Fed sticky CPI — measures inflation in goods/services with
  // infrequent price changes. Strong signal for inflation persistence.
  { id: 'STICKCPIM157SFRBATL',   frequency: 'M' }, // Sticky CPI
  // Yield curve — inflation expectations + policy stance + recession risk.
  { id: 'T10Y2Y',       frequency: 'D' }, // 10y minus 2y
  { id: 'T10Y3M',       frequency: 'D' }, // 10y minus 3m
  { id: 'DGS2',         frequency: 'D' }, // 2y Treasury
  { id: 'FEDFUNDS',     frequency: 'M' }, // Effective fed funds rate
  // Credit spreads — risk pricing leads inflation in stress regimes.
  { id: 'BAMLH0A0HYM2', frequency: 'D' }, // High-yield bond spread
  // Labor market depth — wage pressure source.
  { id: 'ICSA',         frequency: 'W' }, // Initial jobless claims (weekly)
  { id: 'JTSJOL',       frequency: 'M' }, // JOLTS job openings
  { id: 'JTSQUL',       frequency: 'M' }, // JOLTS quits
  // Consumer demand + sentiment.
  { id: 'UMCSENT',      frequency: 'M' }, // U Michigan sentiment
  { id: 'PCEPI',        frequency: 'M' }, // PCE price index (the Fed's preferred)
  { id: 'PCEPILFE',     frequency: 'M' }, // Core PCE
  // Housing — leads shelter inflation.
  { id: 'HOUST',        frequency: 'M' }, // Housing starts
  { id: 'PERMIT',       frequency: 'M' }, // Building permits
  // Capacity / activity.
  { id: 'TCU',          frequency: 'M' }, // Capacity utilization
  // Energy alternatives.
  { id: 'DCOILBRENTEU', frequency: 'D' }, // Brent crude
  { id: 'GASDESW',      frequency: 'W' }, // Diesel retail
  // Commodity sub-indices.
  { id: 'PPIIDC',       frequency: 'M' }, // PPI industrial commodities
];

// Default start: enough history for a 24-month rolling backtest plus
// runway for SARIMA seasonality and feature lags.
const DEFAULT_START = '2005-01-01';

async function fetchSeries(seriesId, start) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY not configured');
  const url =
    `${FRED_BASE}/series/observations?series_id=${seriesId}` +
    `&api_key=${key}&file_type=json&sort_order=asc` +
    `&observation_start=${start}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`FRED ${seriesId} responded ${res.status}`);
    }
    const data = await res.json();
    const obs = Array.isArray(data?.observations) ? data.observations : [];
    // [{ date: 'YYYY-MM-DD', value: '123.45' | '.' }, ...]
    return obs;
  } finally {
    clearTimeout(timer);
  }
}

// Convert a raw FRED series to a Map keyed by ISO month-end date string.
// For monthly series, FRED returns the first-of-month index — shift to
// month-end so all series share one calendar.
// For daily series, average within each calendar month and anchor to
// month-end.
function toMonthEndMap(obs, frequency) {
  const result = new Map();
  if (frequency === 'M') {
    for (const { date, value } of obs) {
      const v = parseFloat(value);
      if (!Number.isFinite(v)) continue;
      // 'YYYY-MM-01' → month-end of that month
      const [y, m] = date.split('-').map(Number);
      const me = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this
      result.set(me.toISOString().slice(0, 10), v);
    }
    return result;
  }
  // Daily — bucket by year-month, average values, output as month-end.
  const buckets = new Map(); // 'YYYY-MM' → { sum, n }
  for (const { date, value } of obs) {
    const v = parseFloat(value);
    if (!Number.isFinite(v)) continue;
    const ym = date.slice(0, 7);
    const b = buckets.get(ym) || { sum: 0, n: 0 };
    b.sum += v;
    b.n += 1;
    buckets.set(ym, b);
  }
  for (const [ym, { sum, n }] of buckets) {
    if (!n) continue;
    const [y, m] = ym.split('-').map(Number);
    const me = new Date(Date.UTC(y, m, 0));
    result.set(me.toISOString().slice(0, 10), sum / n);
  }
  return result;
}

// Build a sorted union of all month-end dates seen across the series.
// Then for each date, emit the value for each series (or null if missing).
function alignPanel(seriesMaps) {
  const allDates = new Set();
  for (const m of Object.values(seriesMaps)) {
    for (const d of m.keys()) allDates.add(d);
  }
  const monthEnd = Array.from(allDates).sort();
  const out = {};
  for (const id of Object.keys(seriesMaps)) {
    const m = seriesMaps[id];
    out[id] = monthEnd.map((d) => (m.has(d) ? m.get(d) : null));
  }
  return { monthEnd, series: out };
}

// Returns { fetchedAt, monthEnd, series } where series is keyed by FRED ID.
// Cached 12h. If FRED_API_KEY is missing on the server, throws — the route
// will surface that as a 503.
export async function getFredPanel({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  const seriesMaps = {};
  // Fetch in parallel — FRED tolerates concurrent requests just fine.
  const results = await Promise.allSettled(
    SERIES.map((s) => fetchSeries(s.id, DEFAULT_START).then((obs) => ({ s, obs })))
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      // One failed series shouldn't sink the whole panel — log and skip.
      // The Python side validates the target is present and bails if not.
      console.warn('FRED panel: series fetch failed:', r.reason?.message);
      continue;
    }
    const { s, obs } = r.value;
    seriesMaps[s.id] = toMonthEndMap(obs, s.frequency);
  }
  if (!seriesMaps[TARGET_ID]) {
    throw new Error('FRED panel: target series CPIAUCSL missing');
  }
  const { monthEnd, series } = alignPanel(seriesMaps);
  const data = {
    fetchedAt: new Date().toISOString(),
    monthEnd,
    series,
  };
  cache = { at: Date.now(), data };
  return data;
}
