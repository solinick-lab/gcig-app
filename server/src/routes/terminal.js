import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { llmChat } from '../services/llm.js';
import { getHistory } from '../services/priceHistory.js';

// Terminal — AI-driven endpoints that back the /terminal workstation.
// Quote/news/fundamentals data is reused from /api/holdings/* (already
// gated by verifyJwt). This router only owns the AI-shaped endpoints:
//   POST /api/terminal/annotate       AI brief for a panel
//   POST /api/terminal/parse-command  Natural language -> mnemonic command
//   POST /api/terminal/chat           Free-form chat with workspace context
//
// Gated executive-only initially; opens to PM+ later.

const router = Router();
router.use(verifyJwt);
router.use(requireExecutive);

const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => `terminal-ai:${req.user?.id || req.ip}`,
  message: { error: 'Terminal AI rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(aiLimiter);

const KNOWN_FUNCTIONS = [
  { id: 'DES', label: 'Description', summary: 'Company snapshot: quote, fundamentals, business summary, AI brief.' },
  { id: 'GP', label: 'Chart', summary: 'Price chart with selectable interval.' },
  { id: 'CN', label: 'Company News', summary: 'Latest news headlines for the focused ticker.' },
  { id: 'FA', label: 'Financial Analysis', summary: 'Multi-year fundamentals deep dive.' },
  { id: 'PEER', label: 'Peers', summary: 'Sector peer comparison table.' },
  { id: 'BI', label: 'Bloomberg Intelligence', summary: 'Free-form research chat with workspace context.' },
  { id: 'WEI', label: 'World Equity Indices', summary: 'Global index snapshot.' },
  { id: 'TOP', label: 'Top News', summary: 'Market-wide top headlines.' },
  { id: 'MOVR', label: 'Movers', summary: 'Day\'s biggest gainers and losers.' },
  { id: 'ECO', label: 'Economic Calendar', summary: 'Upcoming releases and central bank events.' },
  { id: 'HELP', label: 'Help', summary: 'List of available terminal functions.' },
];

router.get('/functions', (_req, res) => {
  res.json({ functions: KNOWN_FUNCTIONS });
});

// Chart history. Reads from the PriceBar cache (services/priceHistory.js)
// which lazy-backfills 5y on first sighting of a ticker and tops up daily
// via the price-cache cron. Falls back to a direct Yahoo proxy if the
// cache layer throws unexpectedly so a single bad row doesn't kill GP.
router.get('/chart/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  const range = String(req.query.range || '6mo');
  if (!/^(1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/.test(range)) {
    return res.status(400).json({ error: 'Invalid range' });
  }
  try {
    const bars = await getHistory(raw, range);
    const points = bars.map((b) => ({ t: new Date(b.date).getTime(), close: b.close }));
    res.json({ ticker: raw, range, interval: '1d', points, _source: 'cache' });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Ticker not found' });
    console.error(`terminal/chart(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Chart fetch failed' });
  }
});

// AI brief for a single panel. Body: { ticker, function, context }
// Returns: { brief: string }
router.post('/annotate', async (req, res) => {
  const { ticker, function: fn, context } = req.body || {};
  if (!fn) return res.status(400).json({ error: 'function is required' });
  const safeTicker = typeof ticker === 'string' ? ticker.toUpperCase().slice(0, 12) : '';
  const safeFn = String(fn).toUpperCase().slice(0, 8);
  const safeContext = typeof context === 'string' ? context.slice(0, 6000) : '';

  const fnDoc = KNOWN_FUNCTIONS.find((f) => f.id === safeFn);
  const fnLabel = fnDoc?.label || safeFn;

  const messages = [
    {
      role: 'system',
      content:
        'You are the AI annotation layer inside a Bloomberg-style terminal at GCIG, a student investment fund. ' +
        'For the panel and data below, write a 2–4 sentence brief that adds insight, not restatement. ' +
        'Be concrete: cite numbers from the context when relevant. No bullet lists. No disclaimers. ' +
        'If the context is empty or the data is missing, write a single line: "Data unavailable."',
    },
    {
      role: 'user',
      content:
        `Panel: ${safeFn} (${fnLabel})` +
        (safeTicker ? `\nTicker: ${safeTicker}` : '') +
        (safeContext ? `\n\nPanel data:\n${safeContext}` : ''),
    },
  ];

  const brief = await llmChat({ messages, temperature: 0.3, timeoutMs: 20_000 });
  res.json({ brief: brief || 'Data unavailable.' });
});

// Natural language -> mnemonic command parser. Body: { input }
// Returns: { ticker, function, args, explanation }
// Falls back to a heuristic parse if the LLM is unreachable.
router.post('/parse-command', async (req, res) => {
  const input = String(req.body?.input || '').trim();
  if (!input) return res.status(400).json({ error: 'input is required' });

  // Heuristic first: if it already looks like a mnemonic, skip the LLM.
  const heuristic = mnemonicParse(input);
  if (heuristic) return res.json({ ...heuristic, explanation: null, _source: 'heuristic' });

  const functionIds = KNOWN_FUNCTIONS.map((f) => f.id).join(', ');
  const messages = [
    {
      role: 'system',
      content:
        'You translate natural language into a terminal command for a Bloomberg-style workstation. ' +
        `Available functions: ${functionIds}. ` +
        'Reply with strict JSON only, no prose, no code fences. Shape: ' +
        '{"ticker": string|null, "function": string, "args": string|null, "explanation": string}. ' +
        'function must be one of the listed IDs. ticker is uppercase if present. explanation is one short sentence.',
    },
    { role: 'user', content: input },
  ];

  const raw = await llmChat({ messages, jsonMode: true, temperature: 0, timeoutMs: 12_000 });
  if (!raw) {
    return res.json({
      ticker: null,
      function: 'HELP',
      args: null,
      explanation: 'Could not interpret. Try TICKER FUNCTION, e.g. AAPL DES.',
      _source: 'fallback',
    });
  }
  try {
    const parsed = JSON.parse(raw);
    const fn = String(parsed.function || '').toUpperCase();
    if (!KNOWN_FUNCTIONS.find((f) => f.id === fn)) {
      throw new Error('unknown function');
    }
    res.json({
      ticker: parsed.ticker ? String(parsed.ticker).toUpperCase().slice(0, 12) : null,
      function: fn,
      args: parsed.args ? String(parsed.args).slice(0, 80) : null,
      explanation: String(parsed.explanation || '').slice(0, 240),
      _source: 'llm',
    });
  } catch {
    res.json({
      ticker: null,
      function: 'HELP',
      args: null,
      explanation: 'Could not interpret. Try TICKER FUNCTION, e.g. AAPL DES.',
      _source: 'fallback',
    });
  }
});

// Free-form chat for the BI panel. Body: { messages: [{role, content}], context }
// `context` is the live workspace summary the client builds (current ticker, panes, etc.)
// Returns: { reply }
router.post('/chat', async (req, res) => {
  const userMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const context = typeof req.body?.context === 'string' ? req.body.context.slice(0, 6000) : '';
  if (userMessages.length === 0) return res.status(400).json({ error: 'messages required' });

  const trimmed = userMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  const messages = [
    {
      role: 'system',
      content:
        'You are the AI research console inside the GCIG Terminal. Be concise, numerate, and cite ' +
        'specific figures from the workspace context when relevant. Prefer short paragraphs over bullets. ' +
        'If you don\'t know, say so plainly.' +
        (context ? `\n\nWorkspace context:\n${context}` : ''),
    },
    ...trimmed,
  ];

  const reply = await llmChat({ messages, temperature: 0.3, timeoutMs: 30_000 });
  res.json({ reply: reply || 'AI is unavailable right now. Try again in a moment.' });
});

// Mnemonic parser: TICKER FUNCTION [ARGS] -> structured form.
// Also accepts function-only commands like "HELP" or "WEI".
function mnemonicParse(input) {
  const cleaned = String(input).trim().replace(/\s+/g, ' ').toUpperCase();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');
  const fnIds = new Set(KNOWN_FUNCTIONS.map((f) => f.id));

  // Single token: either a function (HELP, WEI, TOP, MOVR, ECO) or a ticker alone (defaults to DES).
  if (parts.length === 1) {
    const tok = parts[0];
    if (fnIds.has(tok)) return { ticker: null, function: tok, args: null };
    if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(tok)) return { ticker: tok, function: 'DES', args: null };
    return null;
  }

  // First token is ticker, second is function.
  const [t, f, ...rest] = parts;
  if (fnIds.has(f) && /^[A-Z][A-Z0-9.\-]{0,11}$/.test(t)) {
    return { ticker: t, function: f, args: rest.length ? rest.join(' ').slice(0, 80) : null };
  }
  // First token is function, second... rest are args (e.g. "HELP DES")
  if (fnIds.has(t)) {
    return { ticker: null, function: t, args: rest.length ? [f, ...rest].join(' ').slice(0, 80) : f };
  }
  return null;
}

export default router;
