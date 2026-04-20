// Thin wrapper around newsapi.org. Returns a normalized list of articles for
// a ticker, cached in memory so repeat clicks on the same holding don't burn
// free-tier quota.
//
// Free tier is 100 requests/day and disallows browser-origin calls, so we
// ALWAYS call from the server — the client talks to /api/holdings/news/:ticker.
//
// Query strategy: search for the company name in quotes + ticker context, and
// pin to English. We sort by publishedAt and cap to 10 to keep payloads light.
//
// We also extract full article bodies server-side (see extractArticle below)
// so members can read the whole story without leaving the app.
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import sanitizeHtml from 'sanitize-html';
import { rankArticles } from './articleRanker.js';
import { summarizeTickerNews, summarizeArticle } from './articleSummarizer.js';

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

// Some tickers are broad-market or sector ETFs where "news about Vanguard
// S&P 500 ETF" isn't what a member actually wants to read. For these we
// switch to newsapi's top-headlines endpoint scoped to a topical category
// so VOO readers see actual market news and QQQ readers see actual tech
// news. Expand this map as other sector ETFs enter the portfolio.
const TICKER_TOPIC_OVERRIDES = {
  VOO: { category: 'business', topic: 'Market news' },
  SPY: { category: 'business', topic: 'Market news' },
  QQQ: { category: 'technology', topic: 'Tech news' },
  XLK: { category: 'technology', topic: 'Tech news' },
  XLV: { category: 'health', topic: 'Healthcare news' },
};

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

  const override = TICKER_TOPIC_OVERRIDES[ticker];
  let url;
  let topic = null;
  if (override) {
    // top-headlines is curated by newsapi, so we just ask for US + category.
    // Everything endpoint's free-text search for "market news" returns a mess.
    const params = new URLSearchParams({
      country: 'us',
      category: override.category,
      pageSize: '12',
    });
    url = `https://newsapi.org/v2/top-headlines?${params.toString()}`;
    topic = override.topic;
  } else {
    const q = buildQuery(ticker, name);
    const params = new URLSearchParams({
      q,
      language: 'en',
      sortBy: 'publishedAt',
      pageSize: '12',
    });
    url = `https://newsapi.org/v2/everything?${params.toString()}`;
  }

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
  const rawArticles = (json.articles || [])
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
