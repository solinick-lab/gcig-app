// LLM-powered summaries of news content, hitting the same local Ollama
// endpoint as the ranker. Two entry points:
//
//   summarizeArticle(url, plainText)
//     → 2-3 sentence TL;DR of a single article. Cached in ArticleRanking.summary
//       so a URL is summarized at most once.
//
//   summarizeTickerNews(ticker, articles)
//     → 2-3 sentence paragraph synthesizing the last batch of headlines for
//       a ticker. NOT persisted per-ticker — newsapi itself only gives us a
//       fresh set on cache miss, so we cache this in memory tied to the
//       article set we were given.
//
// Both fail open — if Ollama is unreachable or returns garbage, we return
// null and callers render as if summaries aren't available.
import prisma from '../db.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_TIMEOUT_MS = 25_000;

function baseUrl(raw) {
  const s = String(raw).trim().replace(/\/+$/, '');
  if (/\/v1$/.test(s)) return s;
  return `${s}/v1`;
}

async function callChat(systemPrompt, userContent) {
  const url = process.env.LOCAL_LLM_URL;
  if (!url) return null;
  const model = process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl(url)}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LOCAL_LLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`articleSummarizer: LLM responded ${res.status}`);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    return content.trim();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('articleSummarizer failed:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-article summaries ─────────────────────────────────────────────

const ARTICLE_SYSTEM_PROMPT = `You are summarizing a news article for members of a student-run investment club. Write 2-3 short sentences (max 60 words total) capturing what happened, why it matters for the company, and any concrete numbers mentioned. Plain prose — no headers, no bullet points, no hedging language like "reportedly" or "appears to". If the text is paywalled or clearly incomplete, return exactly: INSUFFICIENT`;

// Pull an already-saved summary for this URL, if any.
async function loadPersistedSummary(url) {
  try {
    const row = await prisma.articleRanking.findUnique({
      where: { url },
      select: { summary: true },
    });
    return row?.summary || null;
  } catch {
    return null;
  }
}

async function persistSummary(url, summary) {
  try {
    // Upsert so summaries can attach to rows that may not yet have a
    // ranking (e.g. articles fetched but never ranked).
    await prisma.articleRanking.upsert({
      where: { url },
      update: { summary },
      create: { url, summary },
    });
  } catch (err) {
    console.warn('articleSummarizer: persistSummary failed:', err.message);
  }
}

export async function summarizeArticle(url, plainText) {
  if (!url || typeof plainText !== 'string' || plainText.length < 200) return null;
  // Don't re-summarize a URL we've already handled.
  const cached = await loadPersistedSummary(url);
  if (cached) return cached;

  // Keep input bounded; long articles don't need the full body for a
  // tight TL;DR and they eat tokens.
  const body = plainText.slice(0, 6000);
  const out = await callChat(
    ARTICLE_SYSTEM_PROMPT,
    `Article body:\n\n${body}`
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;

  // Drop any stray wrappers the model might add (quotes, "Summary:" prefix).
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();

  if (cleaned.length < 20) return null;

  // Fire-and-forget save; caller doesn't wait for the write.
  persistSummary(url, cleaned).catch(() => {});
  return cleaned;
}

// ── Per-ticker news synthesis ─────────────────────────────────────────

const TICKER_SYSTEM_PROMPT = `You are synthesizing recent news coverage for a stock for members of a student-run investment club. You will be given a list of article headlines with one-line descriptions. Write 2-3 short sentences (max 70 words total) describing the overall narrative: what are investors actually paying attention to right now, what's the mood, and are there any standout items. Plain prose — no bullet points, no meta-commentary, no mention of the article list format. If the batch is too thin to have a narrative (fewer than 3 distinct topics), return exactly: INSUFFICIENT`;

const tickerSummaryCache = new Map();
const TICKER_SUMMARY_TTL_MS = 30 * 60 * 1000;

function tickerCacheKey(ticker, articles) {
  // Cache keyed by the URL set — if the same batch comes back, we reuse.
  const urls = articles
    .map((a) => a.url)
    .filter(Boolean)
    .sort()
    .join('|');
  return `${ticker}::${urls}`;
}

export async function summarizeTickerNews(ticker, articles) {
  if (!Array.isArray(articles) || articles.length < 3) return null;
  const key = tickerCacheKey(ticker, articles);
  const cached = tickerSummaryCache.get(key);
  if (cached && Date.now() - cached.at < TICKER_SUMMARY_TTL_MS) {
    return cached.summary;
  }

  const bullets = articles
    .slice(0, 12)
    .map(
      (a, i) =>
        `${i + 1}. ${a.title}${a.description ? ' — ' + a.description.slice(0, 180) : ''}`
    )
    .join('\n');

  const out = await callChat(
    TICKER_SYSTEM_PROMPT,
    `Ticker: ${ticker}\n\nArticles:\n${bullets}`
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
  if (cleaned.length < 30) return null;
  tickerSummaryCache.set(key, { at: Date.now(), summary: cleaned });
  return cleaned;
}
