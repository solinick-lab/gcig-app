import prisma from '../db.js';

// Benchmark time-series service. Pulls adjusted daily closes from Yahoo
// Finance (same endpoint pattern as routes/holdings.js live quotes),
// carries them forward through weekends + holidays so every calendar
// date has a value, and persists into BenchmarkSnapshot for overlay on
// the Portfolio chart.
//
// Shared by:
//   - POST /api/holdings/benchmark/backfill (super-admin one-shot)
//   - POST /api/holdings/snapshot/daily (cron — updates today's row)
//   - GET  /api/holdings/benchmark (reads series out)
//
// Dividend-adjusted close (adjClose) is preferred because the Portfolio
// line we compare against is total-return with reinvestment implicit;
// raw close would understate VOO's return by ~1.5%/yr of dividend drag.

// Default benchmark ticker. VOO (Vanguard S&P 500 ETF) tracks the
// same index as SPY, is liquid enough to have clean adjusted-close
// data back to 2010, and is also a club holding — so the overlay is
// "the club's active returns vs. doing nothing but buying VOO."
export const DEFAULT_BENCHMARK = 'VOO';

// Club inception date — no portfolio snapshots exist before this, so
// the backfill starts here by default.
export const DEFAULT_START_DATE = new Date('2025-10-17T00:00:00Z');

const YF_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

// Fetch Yahoo's v8/finance/chart endpoint for `ticker` between two
// dates. Three-attempt backoff since Yahoo 429s shared IPs.
async function fetchChartRange(ticker, start, end) {
  const period1 = Math.floor(start.getTime() / 1000);
  const period2 = Math.floor(end.getTime() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${period1}&period2=${period2}&interval=1d`;
  const backoffMs = [0, 2000, 6000];
  let lastErr = '';
  for (let i = 0; i < backoffMs.length; i++) {
    if (backoffMs[i]) await new Promise((r) => setTimeout(r, backoffMs[i]));
    try {
      const res = await fetch(url, { headers: YF_HEADERS });
      if (res.ok) return res.json();
      lastErr = `yahoo ${res.status} ${res.statusText}`;
      // 429 + 5xx → retry; anything else won't get better.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastErr = `fetch failed: ${err.message}`;
    }
  }
  throw new Error(lastErr || 'yahoo fetch failed');
}

// Parse Yahoo response → Map<YYYY-MM-DD (UTC), close>.
function parseDailyCloses(json) {
  const result = json?.chart?.result?.[0];
  if (!result) {
    const msg = json?.chart?.error?.description || 'no data';
    throw new Error(`Yahoo returned no chart result: ${msg}`);
  }
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const adjcloses = result.indicators?.adjclose?.[0]?.adjclose || [];
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const val = adjcloses[i] ?? closes[i];
    if (val == null) continue;
    const d = new Date(timestamps[i] * 1000);
    const key = d.toISOString().slice(0, 10);
    byDate.set(key, val);
  }
  return byDate;
}

// Expand a date-keyed map of trading-day closes into every calendar
// day between start and end, carrying the most recent close forward
// on weekends and market holidays. Returns [{ date: Date, close,
// source }].
function expandWithCarryForward(byDate, start, end) {
  const rows = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const stop = new Date(end);
  stop.setUTCHours(0, 0, 0, 0);
  let lastClose = null;
  while (cursor <= stop) {
    const key = cursor.toISOString().slice(0, 10);
    const close = byDate.get(key);
    if (close != null) {
      lastClose = close;
      rows.push({ date: new Date(cursor), close, source: 'close' });
    } else if (lastClose != null) {
      rows.push({ date: new Date(cursor), close: lastClose, source: 'carry-forward' });
    }
    // else: pre-first-trading-day, skip.
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

/**
 * One-shot backfill. Fetches `ticker` from `start` to today, expands
 * to daily rows (with weekend carry-forward), and upserts each into
 * BenchmarkSnapshot. Safe to run repeatedly — existing rows get the
 * same value re-upserted, which is a no-op in practice.
 */
export async function backfillBenchmark(ticker = DEFAULT_BENCHMARK, start = DEFAULT_START_DATE) {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const json = await fetchChartRange(ticker, start, end);
  const byDate = parseDailyCloses(json);
  const rows = expandWithCarryForward(byDate, start, end);

  // Upsert each row. createMany would be faster but doesn't support
  // per-row `onConflict` in Prisma-for-Postgres yet; at ~200 rows for
  // a 6-month window the perf hit is negligible.
  let written = 0;
  for (const r of rows) {
    await prisma.benchmarkSnapshot.upsert({
      where: { ticker_date: { ticker, date: r.date } },
      update: { close: r.close, source: r.source },
      create: { ticker, date: r.date, close: r.close, source: r.source },
    });
    written++;
  }
  return {
    ticker,
    start: rows[0]?.date?.toISOString().slice(0, 10) || null,
    end: rows[rows.length - 1]?.date?.toISOString().slice(0, 10) || null,
    rows: written,
    tradingDays: rows.filter((r) => r.source === 'close').length,
    carryForward: rows.filter((r) => r.source === 'carry-forward').length,
  };
}

/**
 * Incremental update — pulls the last ~7 days to catch any missing
 * rows and refreshes today's close. Called from the daily cron.
 */
export async function updateBenchmarkToday(ticker = DEFAULT_BENCHMARK) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return backfillBenchmark(ticker, weekAgo);
}

/**
 * Reader. Returns the full stored series for a ticker, sorted by date
 * ascending. Shape: [{ date: ISOString, close, source }].
 */
export async function getBenchmarkSeries(ticker = DEFAULT_BENCHMARK) {
  const rows = await prisma.benchmarkSnapshot.findMany({
    where: { ticker },
    orderBy: { date: 'asc' },
    select: { date: true, close: true, source: true },
  });
  return rows.map((r) => ({
    date: r.date.toISOString(),
    close: r.close,
    source: r.source,
  }));
}
