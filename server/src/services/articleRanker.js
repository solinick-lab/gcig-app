// Ranks newsapi articles by investment materiality using a locally hosted
// OpenAI-compatible LLM (Ollama running Qwen 2.5 14B on the club's own
// hardware, tunneled to Render via Cloudflare).
//
// Config:
//   LOCAL_LLM_URL         required. Base URL ending at /v1 or the host root,
//                         e.g. "https://llm.thegriffinfund.org" or
//                         "https://xyz.trycloudflare.com". Ollama exposes
//                         the OpenAI-compatible endpoint at /v1/chat/completions.
//   LOCAL_LLM_MODEL       defaults to "qwen2.5:14b-instruct-q4_K_M"
//   LOCAL_LLM_TIMEOUT_MS  defaults to 25000
//
// If LOCAL_LLM_URL is missing or the call fails/times out, articles are
// returned unchanged (in their original newsapi order). Never blocks news
// delivery — ranking is strictly a best-effort enhancement.

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

export async function rankArticles(articles, { ticker } = {}) {
  if (!Array.isArray(articles) || articles.length === 0) return articles;
  const url = process.env.LOCAL_LLM_URL;
  if (!url) return articles; // ranking disabled

  const model = process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.LOCAL_LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const compact = compactForRanking(articles);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = `${baseUrl(url)}/chat/completions`;

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
      return articles;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return articles;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Some models wrap the JSON in markdown fences despite json mode.
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return articles;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return articles;
      }
    }
    const rankings = Array.isArray(parsed?.rankings) ? parsed.rankings : null;
    if (!rankings) return articles;

    // Merge priority + reason back into the original articles by index.
    const byIndex = new Map();
    for (const r of rankings) {
      if (typeof r?.index !== 'number') continue;
      const p = String(r?.priority || '').toLowerCase();
      if (!['high', 'medium', 'low'].includes(p)) continue;
      byIndex.set(r.index, {
        priority: p,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 120) : null,
      });
    }
    const ranked = articles.map((a, i) => {
      const r = byIndex.get(i);
      if (!r) return { ...a, priority: 'medium', reason: null };
      return { ...a, priority: r.priority, reason: r.reason };
    });

    // Sort: high → medium → low, preserving publish-order within a tier.
    const order = { high: 0, medium: 1, low: 2 };
    ranked.sort((a, b) => {
      const pa = order[a.priority] ?? 1;
      const pb = order[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return 0; // stable within tier
    });
    return ranked;
  } catch (err) {
    // Timeouts land here as AbortError. Graceful fallback.
    if (err.name !== 'AbortError') {
      console.warn('articleRanker failed:', err.message);
    }
    return articles;
  } finally {
    clearTimeout(timer);
  }
}
