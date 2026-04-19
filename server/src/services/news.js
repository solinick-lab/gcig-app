// Thin wrapper around newsapi.org. Returns a normalized list of articles for
// a ticker, cached in memory so repeat clicks on the same holding don't burn
// free-tier quota.
//
// Free tier is 100 requests/day and disallows browser-origin calls, so we
// ALWAYS call from the server — the client talks to /api/holdings/news/:ticker.
//
// Query strategy: search for the company name in quotes + ticker context, and
// pin to English. We sort by publishedAt and cap to 10 to keep payloads light.

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — headlines don't change minute-to-minute
const cache = new Map(); // key = ticker|name, value = { at, data }

function cacheKey(ticker, name) {
  return `${ticker}|${name || ''}`.toLowerCase();
}

// newsapi.org accepts a reasonably rich query syntax. We want articles about
// the company, not unrelated ticker collisions ("AI" the ticker vs. the field).
// Quoting the name and OR-ing with a "ticker: TSLA" style hint avoids most noise.
function buildQuery(ticker, name) {
  const safeName = (name || '').replace(/"/g, '').trim();
  if (safeName) return `"${safeName}"`;
  return ticker;
}

export async function getNewsForTicker(ticker, name) {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    const err = new Error('NEWS_API_KEY is not set');
    err.status = 501;
    throw err;
  }
  const ck = cacheKey(ticker, name);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const q = buildQuery(ticker, name);
  const params = new URLSearchParams({
    q,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: '12',
  });
  const url = `https://newsapi.org/v2/everything?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      'X-Api-Key': key,
      // newsapi rejects requests without a User-Agent from some hosts.
      'User-Agent': 'GCIG/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(
      `newsapi responded ${res.status}: ${body.slice(0, 200)}`
    );
    err.status = 502;
    throw err;
  }
  const json = await res.json();
  if (json.status !== 'ok') {
    const err = new Error(json.message || 'newsapi error');
    err.status = 502;
    throw err;
  }
  const articles = (json.articles || [])
    .filter((a) => a.title && a.url)
    .map((a) => ({
      title: a.title,
      description: a.description || null,
      url: a.url,
      source: a.source?.name || null,
      author: a.author || null,
      publishedAt: a.publishedAt || null,
      imageUrl: a.urlToImage || null,
    }));

  const data = {
    ticker,
    fetchedAt: new Date().toISOString(),
    articles,
  };
  cache.set(ck, { at: Date.now(), data });
  return data;
}
