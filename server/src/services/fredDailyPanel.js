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

// FRED rate-limits with HTTP 500 (not 429) when too many concurrent
// requests arrive from one IP. Retry with jittered exponential backoff —
// 5xx responses are retryable, 4xx are not.
const MAX_RETRIES = 3;

async function fetchSeries(seriesId) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY not configured');
  const url =
    `${FRED_BASE}/series/observations?series_id=${seriesId}` +
    `&api_key=${key}&file_type=json&sort_order=asc` +
    `&observation_start=${DEFAULT_START}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        const obs = Array.isArray(data?.observations) ? data.observations : [];
        if (attempt > 0) console.log(`daily-panel ${seriesId}: OK ${obs.length} obs (attempt ${attempt + 1})`);
        return obs;
      }
      // 5xx is the FRED rate-limit signature — back off and retry.
      if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
        const wait = 400 * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`daily-panel ${seriesId}: HTTP ${res.status}, retry in ${wait.toFixed(0)}ms`);
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // 4xx or final 5xx — give up.
      const body = await res.text().catch(() => '');
      console.warn(`daily-panel ${seriesId}: FINAL HTTP ${res.status} body="${body.slice(0, 200)}"`);
      throw new Error(`FRED ${seriesId} responded ${res.status}`);
    } catch (err) {
      // AbortController timeout, network error, etc.
      if (attempt < MAX_RETRIES - 1) {
        const wait = 400 * Math.pow(2, attempt) + Math.random() * 300;
        console.warn(`daily-panel ${seriesId}: EXCEPTION ${err.message}, retry in ${wait.toFixed(0)}ms`);
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.warn(`daily-panel ${seriesId}: FINAL EXCEPTION ${err.message}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`FRED ${seriesId} all ${MAX_RETRIES} retries exhausted`);
}

// Bounded-concurrency map. Caps simultaneous in-flight requests so we
// don't trigger FRED's rate limit. Acts like Promise.allSettled but with
// a worker-pool throttle.
async function pLimited(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]) };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }
  const workers = Array(Math.min(limit, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
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

  // Throttle to 5 concurrent FRED requests — going wider triggers their
  // rate limit (returns 5xx). pLimited acts like Promise.allSettled with
  // a worker-pool throttle.
  const allIds = [...DAILY_SERIES, ...WEEKLY_SERIES];
  const results = await pLimited(allIds, 5, async (id) => {
    const obs = await fetchSeries(id);
    return { id, obs };
  });

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
