// Ranks newsapi articles by investment materiality using a locally hosted
// OpenAI-compatible LLM (Ollama running Qwen 2.5 on the club's own hardware,
// tunneled to Render via Cloudflare).
//
// Rankings are persisted per URL in the ArticleRanking table so we never
// pay to re-classify the same article twice. On every call we:
//   1. Look up existing rankings by URL
//   2. Send ONLY the unknown URLs to the LLM
//   3. Persist the new rankings
//   4. Merge cached + newly-computed rankings back into the article list
// If every article in a batch is already ranked, the LLM is never called.
//
// Config:
//   LOCAL_LLM_URL         required. Base URL ending at /v1 or the host root,
//                         e.g. "https://llm.thegriffinfund.org" or
//                         "https://xyz.trycloudflare.com". Ollama exposes
//                         the OpenAI-compatible endpoint at /v1/chat/completions.
//   LOCAL_LLM_MODEL       defaults to "qwen2.5:14b-instruct-q4_K_M"
//   LOCAL_LLM_TIMEOUT_MS  defaults to 25000
//
// If LOCAL_LLM_URL is missing or the call fails/times out, cached rankings
// are still applied; uncached articles just stay unranked. Ranking is
// strictly a best-effort enhancement — never blocks news delivery.
import prisma from '../db.js';

const DEFAULT_MODEL = 'qwen2.5:14b-instruct-q4_K_M';
const DEFAULT_TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT = `You are ranking news articles for a student-run investment club. For each article, score its priority as "high", "medium", or "low" based on how material it is for an equity investor:

high   — Events that meaningfully move a stock or signal thesis change: earnings results, pre-announcements, guidance changes, M&A (completed or rumored with named parties), major analyst upgrades/downgrades from top-tier shops, SEC filings with substantive content (10-K/10-Q/8-K), lawsuits affecting core business, regulatory approvals/denials, C-suite changes, major product launches tied to financial impact, bankruptcy / restructuring.

medium — Industry shifts that affect the company indirectly, analyst commentary without a rating change, product announcements without clear financial impact, second-tier media coverage of competitors, macro data points tied to the sector.

low    — Generic press releases, minor product news, social-media chatter, stock-price recaps, unrelated company collisions with the ticker, opinion pieces without new information.

Return a JSON object of the form:
{ "rankings": [ { "index": 0, "priority": "high", "reason": "Earnings beat, raised guidance" }, ... ] }

Each element's "index" MUST match the input array position. "reason" must be at most 12 words. Do not invent facts not present in the title or description.`;

// Build a compact payload: only fields that matter for ranking. Reduces
// tokens dramatically vs. sending the full article object.
function compactForRanking(articles) {
  return articles.map((a, i) => ({
    index: i,
    title: a.title || '',
    description: (a.description || '').slice(0, 300),
    source: a.source || '',
  }));
}

function baseUrl(raw) {
  // Accept either "https://host" or "https://host/v1"; we always append /v1.
  const s = String(raw).trim().replace(/\/+$/, '');
  if (/\/v1$/.test(s)) return s;
  return `${s}/v1`;
}

// Load existing rankings for a list of URLs in one query. Returns a Map
// keyed by URL. Silently returns an empty map if the query fails (DB
// hiccups must never block news delivery).
async function loadPersistedRankings(urls) {
  if (urls.length === 0) return new Map();
  try {
    const rows = await prisma.articleRanking.findMany({
      where: { url: { in: urls } },
      select: { url: true, priority: true, reason: true },
    });
    const map = new Map();
    for (const r of rows) {
      map.set(r.url, { priority: r.priority, reason: r.reason });
    }
    return map;
  } catch (err) {
    console.warn('articleRanker: loadPersistedRankings failed:', err.message);
    return new Map();
  }
}

// Upsert a batch of freshly-ranked URLs. Fire-and-forget — never throws.
async function persistRankings(items, model) {
  if (!items.length) return;
  try {
    // Prisma's upsert doesn't batch; use a transaction of upserts so one
    // bad row doesn't nuke the whole write.
    await prisma.$transaction(
      items.map((it) =>
        prisma.articleRanking.upsert({
          where: { url: it.url },
          update: { priority: it.priority, reason: it.reason, model },
          create: {
            url: it.url,
            priority: it.priority,
            reason: it.reason,
            model,
          },
        })
      )
    );
  } catch (err) {
    console.warn('articleRanker: persistRankings failed:', err.message);
  }
}

export async function rankArticles(articles, { ticker } = {}) {
  if (!Array.isArray(articles) || articles.length === 0) return articles;

  // Step 1: look up what we already know. This works even if the LLM is
  // disabled — previously-ranked URLs get their tags back.
  const urls = articles.map((a) => a.url).filter(Boolean);
  const persisted = await loadPersistedRankings(urls);

  // Step 2: split into known / unknown.
  const known = articles.filter((a) => persisted.has(a.url));
  const unknown = articles.filter((a) => a.url && !persisted.has(a.url));

  const model = process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL;

  // If everything is already ranked, or the LLM is disabled and nothing is
  // ranked yet, we just apply what we have and return.
  const llmUrl = process.env.LOCAL_LLM_URL;
  if (!llmUrl || unknown.length === 0) {
    return applyAndSort(articles, persisted);
  }

  const timeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  // Only send the unknown subset to the LLM. Reduces tokens and honors
  // "don't re-rank what we've already seen".
  const compact = compactForRanking(unknown);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${baseUrl(llmUrl)}/chat/completions`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Optional bearer — some tunnel / reverse-proxy setups want one.
        ...(process.env.LOCAL_LLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        // JSON mode — both OpenAI and Ollama's openai-compat endpoint honor it.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Ticker context: ${ticker || 'unspecified'}\n\nArticles:\n${JSON.stringify(compact)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`articleRanker: LLM responded ${res.status}`);
      return applyAndSort(articles, persisted);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return applyAndSort(articles, persisted);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Some models wrap the JSON in markdown fences despite json mode.
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return applyAndSort(articles, persisted);
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return applyAndSort(articles, persisted);
      }
    }
    const rankings = Array.isArray(parsed?.rankings) ? parsed.rankings : null;
    if (!rankings) return applyAndSort(articles, persisted);

    // Walk the rankings response. Indices refer to positions in `unknown`
    // (what we actually sent), not the original full article list.
    const toPersist = [];
    for (const r of rankings) {
      if (typeof r?.index !== 'number') continue;
      const src = unknown[r.index];
      if (!src?.url) continue;
      const p = String(r?.priority || '').toLowerCase();
      if (!['high', 'medium', 'low'].includes(p)) continue;
      const reason = typeof r.reason === 'string' ? r.reason.slice(0, 120) : null;
      persisted.set(src.url, { priority: p, reason });
      toPersist.push({ url: src.url, priority: p, reason });
    }

    // Fire-and-forget save. We don't await because the response is already
    // assembled; the write happens while the client gets its data.
    persistRankings(toPersist, model).catch(() => {});

    return applyAndSort(articles, persisted);
  } catch (err) {
    // Timeouts land here as AbortError. Graceful fallback: apply whatever
    // we pulled from the DB, leave the rest untagged.
    if (err.name !== 'AbortError') {
      console.warn('articleRanker failed:', err.message);
    }
    return applyAndSort(articles, persisted);
  } finally {
    clearTimeout(timer);
  }
}

// Attach priority/reason from a URL→tag map onto each article, then sort
// high → medium → low. Articles without a tag are treated as medium so
// they don't all get buried under "low".
function applyAndSort(articles, rankingsByUrl) {
  const withPriority = articles.map((a) => {
    const r = rankingsByUrl.get(a.url);
    if (!r) return { ...a };
    return { ...a, priority: r.priority, reason: r.reason };
  });
  const order = { high: 0, medium: 1, low: 2 };
  // Only sort if at least one article has a priority — otherwise leave
  // newsapi's recency order alone.
  const anyRanked = withPriority.some((a) => a.priority);
  if (!anyRanked) return withPriority;
  withPriority.sort((a, b) => {
    const pa = order[a.priority] ?? 1;
    const pb = order[b.priority] ?? 1;
    return pa - pb;
  });
  return withPriority;
}
