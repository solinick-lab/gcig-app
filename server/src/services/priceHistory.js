import prisma from '../db.js';

// Daily price-bar cache. Powers the Terminal GP chart and any future
// time-series feature (screener, total return, COMP overlays).
//
// Strategy:
//   - Lazy 5y backfill on first request for an unknown ticker.
//   - Read-through cache on subsequent requests: if the most recent
//     bar in the DB is from today (or the most recent trading day),
//     we serve from DB. Otherwise we top up from Yahoo.
//   - Daily cron (see index.js) refreshes the universe at 21:00 ET so
//     the next morning's reads are warm.
//
// Yahoo's /v8/finance/chart endpoint is free, no key, no CORS for
// server-side calls. We respect a User-Agent header to avoid 401s.

const YAHOO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const VALID_RANGES = new Set(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const VALID_INTERVALS = new Set(['1d', '5d', '1wk', '1mo']);

// How fresh is fresh enough before we top-up from Yahoo?
// 18 hours: serves all weekend traffic from cache; weekday morning
// triggers a top-up to pull in yesterday's close.
const FRESHNESS_MS = 18 * 60 * 60 * 1000;

function startOfDayUTC(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function rangeToCutoff(range) {
  const now = Date.now();
  switch (range) {
    case '1mo': return new Date(now - 31 * 86400_000);
    case '3mo': return new Date(now - 95 * 86400_000);
    case '6mo': return new Date(now - 190 * 86400_000);
    case '1y':  return new Date(now - 372 * 86400_000);
    case '2y':  return new Date(now - 740 * 86400_000);
    case '5y':  return new Date(now - 1830 * 86400_000);
    case '10y': return new Date(now - 3660 * 86400_000);
    case 'ytd': {
      const d = new Date();
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case 'max':
    default:    return new Date(0);
  }
}

// Pull from Yahoo and upsert. Returns the number of rows written.
async function fetchYahooAndStore(ticker, range = '5y', interval = '1d') {
  if (!VALID_RANGES.has(range)) range = '5y';
  if (!VALID_INTERVALS.has(interval)) interval = '1d';

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=${range}&interval=${interval}&includeAdjustedClose=true`;

  const res = await fetch(url, {
    headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`Yahoo HTTP ${res.status}`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const adj = result?.indicators?.adjclose?.[0]?.adjclose || [];

  const rows = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i];
    if (!ts) continue;
    const close = quote.close?.[i];
    if (close == null) continue;
    rows.push({
      ticker,
      date: startOfDayUTC(new Date(ts * 1000)),
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close,
      adjClose: adj[i] ?? null,
      volume: quote.volume?.[i] != null ? BigInt(quote.volume[i]) : null,
    });
  }

  if (rows.length === 0) return 0;

  // Upsert one bar at a time. Prisma doesn't expose ON CONFLICT-batched
  // updates for SQLite/Postgres uniformly, but the row count is small
  // enough that per-row upsert is fine in practice.
  for (const r of rows) {
    await prisma.priceBar.upsert({
      where: { ticker_date: { ticker: r.ticker, date: r.date } },
      create: r,
      update: {
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        adjClose: r.adjClose,
        volume: r.volume,
        source: 'yahoo',
        fetchedAt: new Date(),
      },
    });
  }

  return rows.length;
}

// Public: read history from cache. Backfills if missing or stale.
// Returns array of { date (ISO string), open, high, low, close, adjClose, volume }.
export async function getHistory(rawTicker, range = '6mo') {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    const err = new Error('Invalid ticker');
    err.status = 400;
    throw err;
  }
  if (!VALID_RANGES.has(range)) range = '6mo';

  // Check current cache state.
  const latest = await prisma.priceBar.findFirst({
    where: { ticker },
    orderBy: { date: 'desc' },
    select: { date: true, fetchedAt: true },
  });

  const isEmpty = !latest;
  const isStale = latest && Date.now() - latest.fetchedAt.getTime() > FRESHNESS_MS;

  if (isEmpty) {
    // First sighting of this ticker — backfill 5y so future range
    // requests up to 5y are served from cache.
    try {
      await fetchYahooAndStore(ticker, '5y', '1d');
    } catch (err) {
      if (err.status === 404) {
        const e = new Error('Ticker not found');
        e.status = 404;
        throw e;
      }
      // Other failures: degrade to whatever we have (nothing) rather
      // than throwing — caller can decide to retry or fall back to a
      // direct fetch.
      console.warn(`priceHistory(${ticker}) backfill failed:`, err.message);
    }
  } else if (isStale) {
    // Top up with a short pull so we don't blow the rate budget on
    // a full 5y refetch every day. The unique index dedupes overlapping
    // bars; we just add today's (and any holiday-recovery bars).
    try {
      await fetchYahooAndStore(ticker, '1mo', '1d');
    } catch (err) {
      console.warn(`priceHistory(${ticker}) top-up failed:`, err.message);
    }
  }

  const cutoff = rangeToCutoff(range);
  const bars = await prisma.priceBar.findMany({
    where: { ticker, date: { gte: cutoff } },
    orderBy: { date: 'asc' },
    select: { date: true, open: true, high: true, low: true, close: true, adjClose: true, volume: true },
  });

  return bars.map((b) => ({
    date: b.date.toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    adjClose: b.adjClose,
    volume: b.volume != null ? Number(b.volume) : null,
  }));
}

// Universe = distinct tickers we already have any bars for. Cron job
// refreshes all of them nightly. Empty on a fresh DB; grows naturally
// as users hit GP for new tickers.
export async function getTrackedTickers() {
  const rows = await prisma.priceBar.groupBy({
    by: ['ticker'],
    _count: { ticker: true },
  });
  return rows.map((r) => r.ticker);
}

// Cron entry point: top-up the latest bar for every tracked ticker.
// Throttled to avoid Yahoo rate-limiting (one request every 250ms).
export async function refreshUniverse() {
  const tickers = await getTrackedTickers();
  let ok = 0;
  let failed = 0;
  for (const ticker of tickers) {
    try {
      await fetchYahooAndStore(ticker, '1mo', '1d');
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn(`refreshUniverse(${ticker}) failed:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { tickers: tickers.length, ok, failed };
}
