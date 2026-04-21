// AI-generated risk narratives for the PM+ risk panel.
//
// Two entry points:
//
//   generateRiskCommentary(metrics)
//     → 3-4 sentence plain-English read of the portfolio's risk profile,
//       with one concrete next action. Called with the same payload the
//       frontend computes (weights, beta, vol, hhi, cash %, etc.).
//
//   detectThesisDrift({ ticker, thesis, articles })
//     → { drift: bool, severity: 'high'|'medium'|'low', reason: string }
//       Flags tickers where recent news materially undercuts the stored
//       investment thesis. Called per-ticker from the drift endpoint.
//
// Both cache results (in-memory, 24h) so daily traffic doesn't rerun the
// LLM, and both fail open: if the LLM is unreachable or returns garbage
// we return null / drift:false so the UI falls back to just showing
// metrics without commentary.
import { llmChat } from './llm.js';

const TTL_MS = 24 * 60 * 60 * 1000;

// Simple string-keyed cache. Restart-lossy, which is fine — first request
// after a deploy just pays one LLM call to warm back up.
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

// Stable hash of a structured payload so equivalent portfolios share a
// cache entry (e.g. a recheck right after the daily snapshot ran).
function hashPayload(payload) {
  // Sort keys so property order doesn't change the hash.
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  let h = 0;
  for (let i = 0; i < stable.length; i++) {
    h = (h * 31 + stable.charCodeAt(i)) | 0;
  }
  return String(h);
}

function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

// ── Risk commentary ──────────────────────────────────────────────────

const COMMENTARY_PROMPT = `You are a risk analyst reviewing a student-run investment fund's portfolio. Write 3-4 short sentences (max 90 words total) that:
1. Interpret the current concentration, beta, and volatility in plain English.
2. Identify the biggest real risk — often hidden overlap between ETFs (VOO/QQQ/VGT commonly share top holdings) or sector concentration that's larger than position-weight % suggests.
3. End with ONE concrete next action: which specific move would most improve the risk profile, using tickers or sectors from the payload.

Strict rules:
- Only reference tickers and sectors that appear in the payload.
- Never invent holdings, betas, or sector names.
- Plain prose. No bullets, no headers, no preamble like "Here's an analysis:".
- Be specific ("trim VGT by ~3% and add XLV") over vague ("consider diversifying").
- If the payload has fewer than 3 non-cash positions, return exactly: INSUFFICIENT`;

export async function generateRiskCommentary(metrics) {
  // Quick shape check before hashing / calling LLM.
  if (!metrics || !Array.isArray(metrics.weights) || metrics.weights.length < 3) {
    return null;
  }
  const key = `commentary:${todayUtcKey()}:${hashPayload(metrics)}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const out = await llmChat({
    messages: [
      { role: 'system', content: COMMENTARY_PROMPT },
      { role: 'user', content: JSON.stringify(metrics, null, 2) },
    ],
    temperature: 0.3,
  });
  if (!out || out.trim() === 'INSUFFICIENT') return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*(summary|analysis|commentary)\s*:\s*/i, '')
    .trim();
  if (cleaned.length < 40) return null;

  const payload = { commentary: cleaned, generatedAt: new Date().toISOString() };
  cacheSet(key, payload);
  return payload;
}

// ── Thesis-vs-news drift ─────────────────────────────────────────────

// Always-on 1-2 sentence reading: does recent news support, challenge, or
// not touch the thesis? Rendered inline under each ticker's thesis so a
// member can tell at a glance whether to re-read the thesis or not.
const THESIS_CHECK_PROMPT = `You are giving a 1-2 sentence state-of-the-thesis update based on recent news coverage.

Output rules:
- Plain prose, 1-2 short sentences, max 45 words.
- If news supports the thesis: lead with "News supports the thesis —" and cite a specific fact.
- If news is neutral or doesn't touch the thesis's claims: return exactly "No material news affecting the thesis."
- If news contradicts a specific claim in the thesis: lead with "Thesis pressure —" and cite the specific contradicting fact.
- Never invent facts. Use only facts present in the news payload.
- No markdown, no labels, no quotes around your output.`;

export async function checkThesisAgainstNews({ ticker, thesis, articles }) {
  if (!thesis) return null;
  if (!Array.isArray(articles) || articles.length === 0) {
    return { reading: 'No recent news to check against the thesis.' };
  }
  const headlines = articles.slice(0, 5).map((a, i) => ({
    index: i,
    title: a.title,
    description: (a.description || '').slice(0, 300),
    reason: a.reason || null,
    score: a.score ?? null,
  }));
  const key = `thesis-check:${todayUtcKey()}:${ticker}:${hashPayload({ thesis, headlines })}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const out = await llmChat({
    messages: [
      { role: 'system', content: THESIS_CHECK_PROMPT },
      {
        role: 'user',
        content: `Ticker: ${ticker}\n\nThesis:\n${thesis}\n\nRecent news:\n${JSON.stringify(headlines, null, 2)}`,
      },
    ],
    temperature: 0.2,
  });
  if (!out) return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*(reading|update|summary)\s*:\s*/i, '')
    .trim();
  if (cleaned.length < 10) return null;

  const result = { reading: cleaned };
  cacheSet(key, result);
  return result;
}

const DRIFT_PROMPT = `You are checking whether recent news contradicts a stored investment thesis for a stock. The club owns this stock based on the thesis below.

Return a JSON object exactly of the form:
{ "drift": true, "severity": "high", "reason": "one short sentence, <= 20 words" }

Rules:
- drift = true ONLY if the news materially undercuts a specific claim in the thesis. Examples: thesis says "dominant market share" but news reports a major customer loss; thesis relies on margin expansion but news reports margin compression; thesis is a growth story but news shows revenue decline.
- Generic volatility, price movement, analyst noise, lawsuits unrelated to core business, macro headlines = drift: false.
- If uncertain, err toward drift: false.
- severity: "high" = thesis is broken; "medium" = thesis weakened but intact; "low" = minor pressure.
- reason is a single short sentence, <= 20 words, citing the specific news fact that contradicts the thesis.`;

export async function detectThesisDrift({ ticker, thesis, articles }) {
  if (!thesis || !Array.isArray(articles) || articles.length === 0) {
    return { drift: false };
  }
  // Use title + description + reason (the ranker's 12-word rationale).
  // These are already in-DB and don't require another fetch.
  const headlines = articles.slice(0, 5).map((a, i) => ({
    index: i,
    title: a.title,
    description: (a.description || '').slice(0, 300),
    reason: a.reason || null,
    score: a.score ?? null,
  }));

  const key = `drift:${todayUtcKey()}:${ticker}:${hashPayload({ thesis, headlines })}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const out = await llmChat({
    messages: [
      { role: 'system', content: DRIFT_PROMPT },
      {
        role: 'user',
        content: `Ticker: ${ticker}\n\nThesis:\n${thesis}\n\nRecent news:\n${JSON.stringify(headlines, null, 2)}`,
      },
    ],
    temperature: 0.2,
    jsonMode: true,
  });
  if (!out) return { drift: false };

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    const match = out.match(/\{[\s\S]*\}/);
    if (!match) return { drift: false };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { drift: false };
    }
  }
  const drift = parsed?.drift === true;
  const severity = ['high', 'medium', 'low'].includes(parsed?.severity)
    ? parsed.severity
    : 'low';
  const reason =
    typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 200) : null;

  const result = drift ? { drift: true, severity, reason } : { drift: false };
  cacheSet(key, result);
  return result;
}
