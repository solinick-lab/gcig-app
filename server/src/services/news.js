// News service backed by Finnhub. Returns a normalized list of articles for
// a ticker, cached in memory so repeat clicks don't burn quota.
//
// We picked Finnhub over newsapi.org because:
//   - Free tier is 60 req/minute with NO daily cap (newsapi = 100/day)
//   - Financial-news-only → fewer irrelevant hits (no Bayonetta for QQQ)
//   - Same API key already powers /holdings/info quote lookups
//
// Endpoints:
//   /company-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD   per-ticker
//   /news?category=general                                     market-wide
//
// We also extract full article bodies server-side (see extractArticle below)
// so members can read the whole story without leaving the app.
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { rankArticles } from './articleRanker.js';
import { summarizeTickerNews, summarizeArticle } from './articleSummarizer.js';

// 24 hours — news doesn't move fast enough for a long-term-hold investment
// club to justify tighter refreshes, and longer caching also means fewer
// LLM calls for ranking + narrative generation. Finnhub could support more
// frequent polling but there's no user-visible benefit.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // key = ticker|name, value = { at, data }

function cacheKey(ticker, name) {
  return `${ticker}|${name || ''}`.toLowerCase();
}

// Format a JS date as YYYY-MM-DD for Finnhub's from/to params.
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Broad-market / sector ETFs that should use the general market feed rather
// than per-symbol company news. Finnhub's "general" category is the curated
// financial headlines stream — better than trying to search for "news about
// the SPDR S&P 500 ETF", which mostly returns fund-mechanics articles.
const TICKER_TOPIC_OVERRIDES = {
  VOO: { topic: 'Market news' },
  SPY: { topic: 'Market news' },
  QQQ: { topic: 'Market news' },
  VGT: { topic: 'Market news' },
  XLK: { topic: 'Market news' },
  XLV: { topic: 'Market news' },
};

// Pull 12 normalized articles from Finnhub. Throws with .status on error.
async function fetchFinnhubArticles(ticker, key) {
  const override = TICKER_TOPIC_OVERRIDES[ticker];
  let url;
  if (override) {
    url = `https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}`;
  } else {
    const to = new Date();
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      symbol: ticker,
      from: isoDate(from),
      to: isoDate(to),
      token: key,
    });
    url = `https://finnhub.io/api/v1/company-news?${params.toString()}`;
  }

  const res = await fetch(url, { headers: { 'User-Agent': 'GCIG/1.0' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`finnhub responded ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  const json = await res.json();
  const raw = Array.isArray(json) ? json : [];

  // Normalize to the shape the rest of the pipeline expects. Finnhub
  // delivers: { headline, summary, url, source, datetime (unix seconds),
  // image, id, category, related }. Dedupe by URL — Finnhub occasionally
  // returns the same article under multiple sources.
  const seen = new Set();
  return raw
    .filter((a) => a.headline && a.url && !seen.has(a.url) && seen.add(a.url))
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
    .slice(0, 12)
    .map((a) => ({
      title: a.headline,
      description: a.summary || null,
      url: a.url,
      source: a.source || null,
      author: null,
      publishedAt: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
      imageUrl: a.image || null,
    }));
}

export async function getNewsForTicker(ticker, name) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    const err = new Error('FINNHUB_API_KEY is not set');
    err.status = 501;
    throw err;
  }
  const ck = cacheKey(ticker, name);
  const cached = cache.get(ck);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // If the cached batch was fetched while the LLM was unreachable, try to
    // rank it again on cache hit — cheap when every URL is already in the
    // ArticleRanking DB, and will retry the LLM for the unknown ones.
    const data = cached.data;
    const hasRankings = data.articles.some((a) => typeof a.score === 'number');
    if (!hasRankings && process.env.LOCAL_LLM_URL) {
      try {
        const retried = await rankArticles(data.articles, { ticker });
        data.articles = retried;
        data.ranked = retried.some((a) => typeof a.score === 'number');
        if (!data.narrative) {
          data.narrative = await summarizeTickerNews(ticker, retried);
        }
      } catch {
        /* keep original cached payload */
      }
    }
    return data;
  }

  const override = TICKER_TOPIC_OVERRIDES[ticker];
  const topic = override?.topic || null;

  let rawArticles;
  try {
    rawArticles = await fetchFinnhubArticles(ticker, key);
  } catch (err) {
    // On 429 (rate limit) serve stale cache if we have one, flagged so the
    // UI can say "news may be outdated". Better than a blank panel.
    if (err.status === 429 && cached) {
      return { ...cached.data, stale: true, staleReason: 'rate_limit' };
    }
    throw err;
  }

  // Best-effort rank via the local LLM. Returns articles unchanged if
  // LOCAL_LLM_URL is unset or the call fails/times out. Ranking runs
  // in-line so it's cached alongside the articles and not recomputed
  // every request.
  const articles = await rankArticles(rawArticles, { ticker });

  // Ticker-level narrative. Summarizer caches by URL set so repeat
  // fetches don't re-call the LLM.
  const narrative = await summarizeTickerNews(ticker, articles);

  const data = {
    ticker,
    topic,
    fetchedAt: new Date().toISOString(),
    // Client uses this to decide whether to show score badges.
    ranked: articles.some((a) => typeof a.score === 'number'),
    narrative,
    articles,
  };
  cache.set(ck, { at: Date.now(), data });
  return data;
}

// ── Article extraction ─────────────────────────────────────────────────
//
// Fetches the article URL server-side (newsapi gives us the publisher URL),
// parses it with JSDOM, runs Mozilla's Readability (same algorithm as
// Firefox's reader view), then sanitizes the resulting HTML before returning
// it to the client. Sanitization is non-negotiable because Readability hands
// back whatever was on the page — including <script> and inline event
// handlers in a worst case.
//
// Cache is separate from the headline cache, keyed by URL, 1-hour TTL. News
// articles don't change after publish, so a longer TTL is safe.

const articleCache = new Map();
const ARTICLE_TTL_MS = 60 * 60 * 1000;
const MAX_ARTICLE_BYTES = 2_000_000; // 2 MB ceiling on any fetched page

// Very conservative allowlist. Semantic + inline formatting tags, plus links
// and images. Everything else (scripts, iframes, forms, styles) is stripped.
const SANITIZE_OPTS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'mark', 'small', 'sub', 'sup',
    'ul', 'ol', 'li',
    'blockquote', 'cite', 'q',
    'figure', 'figcaption',
    'img',
    'a',
    'span', 'div',
    'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // Open every surviving link in a new tab with safe rel.
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noreferrer noopener',
      },
    }),
  },
};

function isHttpUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function extractArticle(url) {
  if (!isHttpUrl(url)) {
    const err = new Error('Invalid article URL');
    err.status = 400;
    throw err;
  }
  const cached = articleCache.get(url);
  if (cached && Date.now() - cached.at < ARTICLE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Publisher sites often gate bot-looking UAs. Present a normal browser.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    const err = new Error(`Publisher returned ${res.status}`);
    err.status = 502;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    const err = new Error('Not an HTML page');
    err.status = 415;
    throw err;
  }

  // Read up to MAX_ARTICLE_BYTES. Some news sites serve surprisingly large
  // pages (tracking SDKs, embedded videos). Cutting here bounds memory.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ARTICLE_BYTES) {
      const err = new Error('Article page too large');
      err.status = 413;
      throw err;
    }
    chunks.push(value);
  }
  const html = Buffer.concat(chunks).toString('utf8');

  const dom = new JSDOM(html, { url });
  if (!isProbablyReaderable(dom.window.document)) {
    const err = new Error('This page does not look like a readable article');
    err.status = 422;
    throw err;
  }
  const reader2 = new Readability(dom.window.document);
  const parsed = reader2.parse();
  if (!parsed || !parsed.content) {
    const err = new Error('Could not extract the article');
    err.status = 422;
    throw err;
  }

  const safeContent = sanitizeHtml(parsed.content, SANITIZE_OPTS);

  // Generate / load the AI summary for this article. Cached in DB so
  // subsequent opens don't re-summarize. Best-effort; null if LLM off.
  const plain = parsed.textContent || ''; // Readability gives clean plain text separately
  const summary = await summarizeArticle(url, plain);

  const data = {
    url,
    title: parsed.title || null,
    byline: parsed.byline || null,
    siteName: parsed.siteName || null,
    excerpt: parsed.excerpt || null,
    publishedTime: parsed.publishedTime || null,
    length: parsed.length || null,
    contentHtml: safeContent,
    summary,
    fetchedAt: new Date().toISOString(),
  };
  articleCache.set(url, { at: Date.now(), data });
  return data;
}
