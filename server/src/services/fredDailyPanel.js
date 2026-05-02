// Daily-frequency FRED panel for the nowcaster.
//
// The existing fredPanel.js aggregates everything to month-end averages —
// great for monthly forecasting, useless for nowcasting. This service
// returns the RAW daily history of high-frequency series so the Python
// side can construct partial-month aggregates ("month-to-date oil avg
// through day 20" etc.) and predict the current month's CPI before BLS
// releases it.
//
// Series included here are ONLY the daily/weekly ones that have signal
// for current-month CPI:
//   - Energy: WTI, Brent, retail gas, diesel
//   - Rates: 10y, 2y, 10y-2y spread, 10y-3m spread
//   - Inflation expectations: T5YIE, T10YIE, T5YIFR
//   - Credit: HY spread
//   - Labor: weekly jobless claims
//
// Cached 1h on the server (these series update at most daily — refreshing
// hourly is more than enough for a nowcaster that runs daily at most).

const FRED_BASE = 'https://api.stlouisfed.org/fred';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_START = '2010-01-01';

let cache = { at: 0, data: null };

const DAILY_SERIES = [
  'DCOILWTICO',
  'DCOILBRENTEU',
  'DTWEXBGS',
  'DGS10',
  'DGS2',
  'T10Y2Y',
  'T10Y3M',
  'T5YIE',
  'T10YIE',
  'T5YIFR',
  'BAMLH0A0HYM2',
];

const WEEKLY_SERIES = [
  'GASREGW',  // retail gas, weekly
  'GASDESW',  // diesel, weekly
  'ICSA',     // initial jobless claims, weekly
];

async function fetchSeries(seriesId) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY not configured');
  const url =
    `${FRED_BASE}/series/observations?series_id=${seriesId}` +
    `&api_key=${key}&file_type=json&sort_order=asc` +
    `&observation_start=${DEFAULT_START}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`FRED ${seriesId} responded ${res.status}`);
    const data = await res.json();
    const obs = Array.isArray(data?.observations) ? data.observations : [];
    return obs;
  } finally {
    clearTimeout(timer);
  }
}

// Returns:
//   {
//     fetchedAt: ISO,
//     daily: { SERIES_ID: [{date, value}, ...], ... },
//     weekly: { SERIES_ID: [{date, value}, ...], ... },
//   }
// Each series's array is sorted by date asc, with `.` (no observation)
// values dropped server-side so the client gets clean numeric arrays.
export async function getDailyPanel({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const allIds = [...DAILY_SERIES, ...WEEKLY_SERIES];
  const results = await Promise.allSettled(
    allIds.map((id) => fetchSeries(id).then((obs) => ({ id, obs })))
  );

  const daily = {};
  const weekly = {};
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.warn('daily-panel: series failed:', r.reason?.message);
      continue;
    }
    const { id, obs } = r.value;
    try {
      const cleaned = obs
        .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
        .filter((o) => Number.isFinite(o.value));
      if (DAILY_SERIES.includes(id)) {
        daily[id] = cleaned;
      } else {
        weekly[id] = cleaned;
      }
    } catch (err) {
      console.warn(`daily-panel: transform failed for ${id}:`, err.message);
    }
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    daily,
    weekly,
  };
  cache = { at: Date.now(), data };
  return data;
}
