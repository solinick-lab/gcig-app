import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { llmChat } from '../services/llm.js';
import { getHistory } from '../services/priceHistory.js';
import { getPortfolioMovers } from '../services/sheetPortfolio.js';
import { getPeers, getPeerSnapshot } from '../services/marketData.js';
import { getNewsForTicker } from '../services/news.js';
import { getQuotes } from '../services/quotes.js';

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

// MOVR — every holding and how much it's up or down today, read live
// from the positions sheet (same source as the dashboard). Not the
// tickers charted in the terminal: the actual book. The sheet service
// caches 20m internally, so hitting this often is cheap. If the sheet
// is unreachable we surface that rather than a half-empty list — the
// panel renders the message.
router.get('/movers', async (_req, res) => {
  try {
    const data = await getPortfolioMovers();
    res.json(data);
  } catch (err) {
    console.error('terminal/movers failed:', err.message);
    res.status(502).json({ error: 'Portfolio unavailable — could not read the positions sheet.' });
  }
});

// PEER — sector peer comparison for the focused ticker. Finnhub's peer
// set (free tier), then a compact fundamentals snapshot for the focus
// plus up to 6 peers, fetched a few at a time so a single load never
// bursts the 60 rpm budget. Snapshots cache 15m; a peer that fails
// just renders blank cells rather than failing the panel. An empty
// peer set (common for ETFs) still returns the focus row with a flag.
router.get('/peers/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const list = await getPeers(raw);
    const peers = [...new Set(list)].filter((t) => t !== raw).slice(0, 6);
    const symbols = [raw, ...peers];

    // Small concurrency window — never fire all snapshots at once.
    const snaps = [];
    const POOL = 4;
    for (let i = 0; i < symbols.length; i += POOL) {
      const batch = symbols.slice(i, i + POOL);
      snaps.push(...(await Promise.all(batch.map((s) => getPeerSnapshot(s)))));
    }

    const rows = symbols.map((s, i) => {
      const snap = snaps[i];
      return {
        ticker: s,
        isFocus: s === raw,
        name: snap?.name || s,
        price: snap?.price ?? null,
        changePct: snap?.changePct ?? null,
        marketCap: snap?.marketCap ?? null,
        trailingPE: snap?.trailingPE ?? null,
        forwardPE: snap?.forwardPE ?? null,
        dividendYield: snap?.dividendYield ?? null,
        beta: snap?.beta ?? null,
      };
    });

    if (peers.length === 0 && rows[0]?.price == null) {
      return res.status(404).json({ error: 'No data for this ticker' });
    }
    res.json({ ticker: raw, count: peers.length, rows });
  } catch (err) {
    console.error(`terminal/peers(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Peer comparison failed' });
  }
});

// TOP — market-wide general news. Uses Finnhub's general category feed
// via the same news service (which routes broad-market tickers like SPY
// through the general endpoint). 10-min cache via the service layer.
router.get('/top-news', async (_req, res) => {
  try {
    const data = await getNewsForTicker('SPY', '');
    const articles = (data?.articles || []).slice(0, 20).map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
      publishedAt: a.publishedAt,
      score: a.score ?? null,
    }));
    res.json({ articles, fetchedAt: data?.fetchedAt || new Date().toISOString() });
  } catch (err) {
    console.error('terminal/top-news failed:', err.message);
    res.status(502).json({ error: 'Top news unavailable' });
  }
});

// WEI — world equity indices. A fixed, regionally-grouped basket of the
// benchmarks a generalist desk actually watches at the open: the US
// majors, the European cash indices, the big Asia-Pacific board, and a
// volatility read. Yahoo carries all of these as `^`-prefixed index
// symbols (Shanghai is the one exception, a bare `000001.SS`), so we
// lean on the same getQuotes path the rest of the app uses rather than
// standing up a second data source. Order here is the order rendered.
const WORLD_INDICES = [
  { symbol: '^GSPC', name: 'S&P 500', region: 'Americas' },
  { symbol: '^DJI', name: 'Dow Jones Industrial', region: 'Americas' },
  { symbol: '^IXIC', name: 'Nasdaq Composite', region: 'Americas' },
  { symbol: '^RUT', name: 'Russell 2000', region: 'Americas' },
  { symbol: '^GSPTSE', name: 'S&P/TSX Composite', region: 'Americas' },
  { symbol: '^BVSP', name: 'Bovespa', region: 'Americas' },
  { symbol: '^FTSE', name: 'FTSE 100', region: 'EMEA' },
  { symbol: '^GDAXI', name: 'DAX', region: 'EMEA' },
  { symbol: '^FCHI', name: 'CAC 40', region: 'EMEA' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', region: 'EMEA' },
  { symbol: '^IBEX', name: 'IBEX 35', region: 'EMEA' },
  { symbol: '^N225', name: 'Nikkei 225', region: 'Asia-Pacific' },
  { symbol: '^HSI', name: 'Hang Seng', region: 'Asia-Pacific' },
  { symbol: '000001.SS', name: 'Shanghai Composite', region: 'Asia-Pacific' },
  { symbol: '^AXJO', name: 'S&P/ASX 200', region: 'Asia-Pacific' },
  { symbol: '^NSEI', name: 'Nifty 50', region: 'Asia-Pacific' },
  { symbol: '^KS11', name: 'KOSPI', region: 'Asia-Pacific' },
  { symbol: '^VIX', name: 'CBOE Volatility', region: 'Volatility' },
];

const REGION_ORDER = ['Americas', 'EMEA', 'Asia-Pacific', 'Volatility'];

// GET /api/terminal/indices — snapshot of the WORLD_INDICES basket.
// One bad symbol can't sink the panel: getQuotes settles each ticker
// independently and hands back a null-priced stub for any that fail,
// which we pass through so the row still renders as "—".
router.get('/indices', async (_req, res) => {
  try {
    const symbols = WORLD_INDICES.map((i) => i.symbol);
    const quotes = await getQuotes(symbols);
    const bySymbol = new Map(
      quotes.filter(Boolean).map((q) => [q.ticker, q])
    );
    const rows = WORLD_INDICES.map((idx) => {
      const q = bySymbol.get(idx.symbol.toUpperCase());
      return {
        symbol: idx.symbol,
        name: idx.name,
        region: idx.region,
        last: q?.price ?? null,
        change: q?.change ?? null,
        // yahoo-finance2 reports the percent move in percent units
        // already (1.23 == +1.23%), not as a fraction.
        changePercent: q?.changePercent ?? null,
        currency: q?.currency ?? null,
      };
    });
    res.json({ asOf: new Date().toISOString(), regions: REGION_ORDER, rows });
  } catch (err) {
    console.error('terminal/indices failed:', err.message);
    res.status(502).json({ error: 'Index snapshot failed' });
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
        'Be concrete: cite numbers from the context when relevant. ' +
        'IMPORTANT: Use ONLY the exact figures provided in the panel data. Never estimate, round differently, or invent numbers. ' +
        'If a value is missing from the data, do not guess it. ' +
        'No bullet lists. No disclaimers. ' +
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
