// Macro snapshot from the St. Louis Fed's FRED API. Free, unlimited,
// requires only a one-click API key signup. We pull a small set of
// market-relevant series + a CPI YoY computed from the last 13 months.
//
// Used by:
//   - Dashboard MacroStrip (small horizontal bar above the DIR card)
//   - clubBrief.js so the AI Assistant can answer "what's the macro
//     backdrop?" questions with real numbers
//
// One-hour cache — these series update at most daily (CPI is monthly).
// If FRED_API_KEY is unset, returns { configured: false } and every
// caller renders a graceful fallback.

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
let cache = { at: 0, data: null };

// Historical observation series live on a separate 6h cache: factor
// sensitivity regresses on a 252-trading-day window, so daily refresh
// is unnecessary and over-fetching the long observation feed every
// request would burn the FRED rate budget. Keyed by `${seriesId}:${days}`
// so a callsite asking for 400 days doesn't poison a 365-day lookup.
const SERIES_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const seriesCache = new Map();

// Daily-updating series. `precision` = decimals to render. `unit` is
// purely cosmetic — '%' renders as a suffix, '$' as a prefix, '' as
// a bare number.
const DAILY_SERIES = [
  { id: 'DGS10', label: '10Y Yield', unit: '%', precision: 2 },
  { id: 'VIXCLS', label: 'VIX', unit: '', precision: 2 },
  { id: 'DTWEXBGS', label: 'USD Index', unit: '', precision: 2 },
  { id: 'DCOILWTICO', label: 'WTI Oil', unit: '$', precision: 2 },
];

async function fetchSeries(seriesId, limit = 2) {
  const key = process.env.FRED_API_KEY;
  if (!key) return [];
  const url =
    `${FRED_BASE}/series/observations?series_id=${seriesId}` +
    `&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`FRED ${seriesId} responded ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data?.observations) ? data.observations : [];
  } catch (err) {
    console.warn(`FRED ${seriesId} fetch failed:`, err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// CPI is published monthly. Pull 13 months descending so we have the
// latest reading + a 12-month-prior reading to compute YoY. CPIAUCNS
// (Not Seasonally Adjusted) is the series BLS headlines in the press
// release, so the dashboard number matches whatever members see on
// CNBC the morning of release.
async function buildCpiYoY() {
  const obs = await fetchSeries('CPIAUCNS', 13);
  if (obs.length < 13) return null;
  // Some recent observations come back with value '.', meaning "not
  // yet published". Skip past those to find the latest real value.
  let latest = null;
  let latestIdx = -1;
  for (let i = 0; i < obs.length; i++) {
    const v = parseFloat(obs[i].value);
    if (Number.isFinite(v)) {
      latest = obs[i];
      latestIdx = i;
      break;
    }
  }
  if (!latest) return null;
  // YoY = (latest - same month a year ago) / same month a year ago
  const yearAgoIdx = latestIdx + 12;
  if (yearAgoIdx >= obs.length) return null;
  const yearAgo = obs[yearAgoIdx];
  const latestVal = parseFloat(latest.value);
  const yearAgoVal = parseFloat(yearAgo.value);
  if (!Number.isFinite(latestVal) || !Number.isFinite(yearAgoVal)) return null;
  const yoy = ((latestVal - yearAgoVal) / yearAgoVal) * 100;
  return {
    id: 'CPIAUCNS',
    label: 'CPI YoY',
    unit: '%',
    value: yoy.toFixed(2),
    change: null, // monthly series — daily change isn't meaningful
    asOf: latest.date,
  };
}

// Returns { configured: bool, indicators: [...], fetchedAt }. Each
// indicator has { id, label, unit, value, change, asOf } where
// `change` is the raw numeric difference between the latest two
// observations (null when not enough history).
export async function getMacroSnapshot({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }
  if (!process.env.FRED_API_KEY) {
    const out = { configured: false, indicators: [], fetchedAt: null };
    cache = { at: Date.now(), data: out };
    return out;
  }
  const dailyResults = await Promise.all(
    DAILY_SERIES.map((s) => fetchSeries(s.id, 2).then((obs) => ({ s, obs })))
  );
  const indicators = [];
  for (const { s, obs } of dailyResults) {
    const latest = obs[0];
    const prior = obs[1];
    if (!latest) continue;
    const latestVal = parseFloat(latest.value);
    const priorVal = prior ? parseFloat(prior.value) : null;
    if (!Number.isFinite(latestVal)) continue;
    indicators.push({
      id: s.id,
      label: s.label,
      unit: s.unit,
      value: latestVal.toFixed(s.precision),
      change:
        priorVal != null && Number.isFinite(priorVal)
          ? Number((latestVal - priorVal).toFixed(s.precision))
          : null,
      asOf: latest.date,
    });
  }
  const cpi = await buildCpiYoY();
  if (cpi) indicators.push(cpi);

  const out = {
    configured: true,
    indicators,
    fetchedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data: out };
  return out;
}

// Historical observation feed for a single FRED series. Returns
// [{ date: 'YYYY-MM-DD', value: number }, …] oldest-first to match
// the convention priceHistory.getHistory returns its bars in — the
// two arrays are routinely intersected by date downstream and they
// only line up cleanly if both walk forward in time. Missing values
// (FRED encodes them as ".") are dropped, not zero-filled, so the
// regression's joint NaN filter never sees them.
//
// Returns [] honestly when FRED_API_KEY is unset — mirrors the
// macro-snapshot's "hidden when unset" pattern; the factor surface
// in the panel just shows n=0 for that row rather than a fake series.
// Per-seriesId 6h cache keyed by `${id}:${days}` so a 400-day caller
// and a 365-day caller don't share a (potentially too-short) result.
export async function getFredSeries(seriesId, { days = 365 } = {}) {
  const id = String(seriesId || '').trim();
  if (!id) return [];
  if (!process.env.FRED_API_KEY) return [];

  const cacheKey = `${id}:${days}`;
  const hit = seriesCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SERIES_CACHE_TTL_MS) return hit.data;

  // observation_start is the oldest date we want back; over-fetch a
  // touch beyond the trading-day target so weekends, holidays, and
  // FRED reporting gaps still leave us 252 td after intersection.
  const startMs = Date.now() - days * 86_400_000;
  const start = new Date(startMs).toISOString().slice(0, 10);
  const url =
    `${FRED_BASE}/series/observations?series_id=${encodeURIComponent(id)}` +
    `&api_key=${process.env.FRED_API_KEY}&file_type=json` +
    `&observation_start=${start}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`FRED series ${id} responded ${res.status}`);
      seriesCache.set(cacheKey, { at: Date.now(), data: [] });
      return [];
    }
    const json = await res.json();
    const raw = Array.isArray(json?.observations) ? json.observations : [];
    // FRED encodes missing values as the literal string "." — drop
    // them rather than coercing to NaN/0, so the regression's joint
    // filter doesn't have to know about FRED's sentinel.
    const out = [];
    for (const obs of raw) {
      if (!obs || typeof obs.date !== 'string') continue;
      if (obs.value === '.' || obs.value == null) continue;
      const v = Number(obs.value);
      if (!Number.isFinite(v)) continue;
      out.push({ date: obs.date, value: v });
    }
    // Oldest-first ordering. FRED's default is already oldest-first
    // when sort_order is omitted, but pin it explicitly — a vendor
    // flip would silently invert the date intersection downstream.
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    seriesCache.set(cacheKey, { at: Date.now(), data: out });
    return out;
  } catch (err) {
    console.warn(`FRED series ${id} fetch failed:`, err.message);
    seriesCache.set(cacheKey, { at: Date.now(), data: [] });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Test-only cache bust so tests don't bleed cached observations into
// each other. Not exported via index — only the colocated suite uses it.
export function _resetFredSeriesCache() {
  seriesCache.clear();
}
