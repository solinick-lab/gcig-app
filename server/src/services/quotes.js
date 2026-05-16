import YahooFinance from 'yahoo-finance2';

// yahoo-finance2 v2.14 ships the class as the default export, not a ready
// instance. `import yahooFinance` then `yahooFinance.quote()` throws
// "quote is not a function" — the call site that finally exercised this
// (terminal WEI) is why it surfaced. Instantiate once, same as
// routes/holdings.js, which already documents this.
const yahooFinance = new YahooFinance();

// Older builds exposed suppressNotices on the instance; v2.14 doesn't.
// Guard it — a harmless no-op when absent, still correct if it returns.
if (typeof yahooFinance.suppressNotices === 'function') {
  yahooFinance.suppressNotices(['yahooSurvey']);
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // ticker -> { at, data }

function getCached(ticker) {
  const hit = cache.get(ticker);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(ticker);
    return null;
  }
  return hit.data;
}

function setCached(ticker, data) {
  cache.set(ticker, { at: Date.now(), data });
}

function normalize(q) {
  if (!q) return null;
  return {
    ticker: q.symbol,
    price: q.regularMarketPrice ?? null,
    change: q.regularMarketChange ?? null,
    changePercent: q.regularMarketChangePercent ?? null,
    currency: q.currency ?? 'USD',
    name: q.shortName ?? q.longName ?? q.symbol,
  };
}

// Crumb-free price path. Yahoo gates the crumb endpoint behind an
// aggressive per-IP rate limit that Render's datacenter address trips
// almost immediately, so yahoo-finance2's quote() comes back empty in
// production (the WEI panel rendered all dashes for exactly this). The
// v8 chart endpoint needs no crumb and carries enough in `meta` — last
// price and prior close — to derive the day move. Same URL and headers
// routes/holdings.js already leans on for this reason. Best-effort: any
// failure returns null and the caller stubs the row.
async function fetchChartQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=1d&range=1d`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const meta = (await r.json())?.chart?.result?.[0]?.meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change = prev != null ? price - prev : null;
    return {
      ticker: meta.symbol ?? ticker,
      price,
      change,
      // Percent units (1.23 == +1.23%) to match yahoo-finance2's
      // regularMarketChangePercent, so callers treat both sources alike.
      changePercent: change != null && prev ? (change / prev) * 100 : null,
      currency: meta.currency ?? 'USD',
      name: meta.shortName ?? meta.symbol ?? ticker,
    };
  } catch {
    return null;
  }
}

// One ticker: chart endpoint first (the path that actually works from
// Render), yahoo-finance2's quote() only as a backstop for the rare
// symbol the chart feed misses. Never throws — a bad symbol resolves to
// null and the caller stubs it, so it can't poison the batch.
async function resolveQuote(t) {
  const chart = await fetchChartQuote(t);
  if (chart && chart.price != null) return chart;
  try {
    const n = normalize(await yahooFinance.quote(t, {}, { validateResult: false }));
    if (n && n.price != null) return n;
  } catch (err) {
    console.error(`quotes: ${t} chart+quote both failed:`, err?.message || err);
  }
  return null;
}

/**
 * Fetch quotes for a list of tickers, using per-ticker cache.
 * Returns array in the same order as input.
 */
export async function getQuotes(tickers) {
  if (!tickers || tickers.length === 0) return [];
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));

  const results = {};
  const missing = [];
  for (const t of unique) {
    const cached = getCached(t);
    if (cached) results[t] = cached;
    else missing.push(t);
  }

  if (missing.length > 0) {
    const settled = await Promise.allSettled(missing.map((t) => resolveQuote(t)));
    settled.forEach((s, i) => {
      const t = missing[i];
      const q = s.status === 'fulfilled' ? s.value : null;
      if (q && q.price != null) {
        // Key by the caller's ticker so cache hits line up on retry.
        results[t] = { ...q, ticker: t };
        // Only cache hits — a null stub must retry on the next 60s
        // tick, not freeze a blank row in for a minute.
        setCached(t, results[t]);
        return;
      }
      results[t] = {
        ticker: t,
        price: null,
        change: null,
        changePercent: null,
        currency: 'USD',
        name: t,
      };
    });
  }

  return tickers.map((t) => results[t.toUpperCase()]);
}
