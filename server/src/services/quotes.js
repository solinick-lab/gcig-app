import yahooFinance from 'yahoo-finance2';

// Suppress the optional survey notice if the installed version supports it.
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
    // Fetch each ticker independently so one bad symbol can't poison the batch.
    const settled = await Promise.allSettled(
      missing.map((t) => yahooFinance.quote(t))
    );
    settled.forEach((s, i) => {
      const t = missing[i];
      if (s.status === 'fulfilled') {
        const n = normalize(s.value);
        if (n) {
          // Key by the user's original ticker so cache lookups match on retry.
          results[t] = { ...n, ticker: t };
          setCached(t, results[t]);
          return;
        }
      } else {
        console.error(`yahoo-finance2 error for ${t}:`, s.reason?.message || s.reason);
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
