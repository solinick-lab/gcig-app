import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { llmChat } from '../services/llm.js';
import { getHistory } from '../services/priceHistory.js';
import { getPortfolioMovers, getSheetPortfolio } from '../services/sheetPortfolio.js';
import { getProxyStatement } from '../services/proxyStatement.js';
import { getExecutiveBios } from '../services/executiveBios.js';
import { parseLeadership, parseBoard, parseComp, buildNetwork } from '../services/governanceParsers.js';
import { getPeers, getPeerSnapshot, getEarnings, getConsensus } from '../services/marketData.js';
import { getNewsForTicker } from '../services/news.js';
import { getWorldIndices, REGION_ORDER } from '../services/worldIndices.js';
import { getInsiderTransactions } from '../services/insiderTx.js';
import { getLiveQuotes } from '../services/liveQuotes.js';
import { getRecentFilings } from '../services/secFilings.js';
import { getMacroSensitivity } from '../services/factorSensitivity.js';
import { scanUniverse as scanInsiderClusters } from '../services/insiderClusters.js';

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
  { id: 'INSDR', label: 'Insider Activity', summary: 'Form 4 insider buys/sells overlaid on the price chart.' },
  { id: 'EARN', label: 'Earnings', summary: 'Next report date + estimate and a trailing EPS beat/miss history.' },
  { id: 'CON', label: 'Analyst Consensus', summary: 'Analyst buy/hold/sell breakdown and recent trend.' },
  { id: 'CMP', label: 'Compare', summary: '2–4 tickers side by side: live price, day %, and key valuation.' },
  { id: 'ICLUSTER', label: 'Insider Clusters', summary: 'Multi-insider open-market buy clusters across the book (last 60d).' },
  { id: 'NOTE', label: 'Notes', summary: 'Your private research notes for this ticker, saved to your profile.' },
  { id: 'MGMT', label: 'Management & Board', summary: 'CEO, executives, board, compensation, and interlocking-board network from the latest DEF 14A.' },
  { id: 'BI', label: 'Bloomberg Intelligence', summary: 'Free-form research chat with workspace context.' },
  { id: 'WEI', label: 'World Equity Indices', summary: 'Global index snapshot.' },
  { id: 'TOP', label: 'Top News', summary: 'Market-wide top headlines.' },
  { id: 'MOVR', label: 'Movers', summary: 'Day\'s biggest gainers and losers.' },
  { id: 'ECO', label: 'Economic Calendar', summary: 'Upcoming releases and central bank events.' },
  { id: 'MACRO', label: 'Macro Sensitivity', summary: 'Portfolio β to 10Y / WTI / USD / VIX / SPY (252-day OLS), top contributors, scenario preview.' },
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

// INSDR — insider Form 4 activity for a ticker. Service is best-effort
// (Finnhub primary, SEC EDGAR fallback) and never throws; an empty
// result is a normal 200 so the panel can say "no activity".
router.get('/insiders/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const data = await getInsiderTransactions(raw);
    res.json(data);
  } catch (err) {
    console.error(`terminal/insiders(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Insider data unavailable' });
  }
});

// MGMT — leadership, board, comp and interlocking-board network for a
// ticker, all from its latest DEF 14A. Every section is best-effort
// and independently nullable; an unparseable proxy is a normal 200.
router.get('/governance/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const proxy = await getProxyStatement(raw);
    const { ceo, execs } = parseLeadership(proxy.html);
    const board = parseBoard(proxy.html);
    const comp = parseComp(proxy.html);
    let holdings = [];
    try {
      const hp = await getSheetPortfolio();
      const arr = Array.isArray(hp) ? hp : (hp?.holdings || []);
      holdings = arr.map((h) => ({ ticker: h.ticker || '', name: h.name || '' }));
    } catch {
      holdings = [];
    }
    const network = buildNetwork(raw, board, holdings);
    res.json({ ticker: raw, asOf: proxy.filedAt, source: proxy._source, ceo, execs, board, comp, network });
  } catch (err) {
    console.error(`terminal/governance(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Governance data unavailable' });
  }
});

// MGMT, executive half — per-officer bios pulled lazily from the 10-K
// (directors' bios already ride the DEF 14A in /governance above; the
// SEC puts the officer disclosure in the 10-K, not the proxy). Split
// out as its own endpoint so the panel only pays the second filing
// fetch when a user actually opens an exec card.
//
// Unlike /governance, the service here (executiveBios.js) is itself
// never-throws and returns an honest empty stub on any miss — no 10-K,
// fetch error, or the incorporated-by-reference filers (MLAB, AAPL)
// that carry no officer section at all. So a parse miss is a normal
// 200 with officers:[], never a 5xx; the modal renders "no bios
// disclosed" rather than an error. The handler is extracted with an
// injectable service (same shape executiveBios.test.js uses to stay
// off the network) and still wraps the call in its own try/catch:
// even though the service contract is never-throws, the route does not
// rely on that to hold — any unexpected rejection still degrades to
// the same honest-empty 200, so this endpoint can never 5xx.
export async function execBiosHandler(req, res, deps = {}) {
  const fetchBios = deps.getExecutiveBios || getExecutiveBios;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const { ticker, source, officers } = await fetchBios(raw);
    res.json({ ticker, source, officers });
  } catch (err) {
    console.warn(`terminal/exec-bios(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, source: null, officers: [] });
  }
}

router.get('/governance/:ticker/exec-bios', (req, res) =>
  execBiosHandler(req, res)
);

// EARN — a ticker's next scheduled report (date + EPS estimate) and a
// trailing beat/miss record (EPS estimate vs. actual + surprise %),
// off the same Finnhub /calendar/earnings feed PEER/holdings already
// use (one widened window; getEarnings owns the split + the shared
// 12h cache). The service is never-throws and returns its honest
// empty stub on any miss — ETFs, illiquid names, or no consensus
// coverage — so a coverage gap is a normal 200 with upcoming:null /
// history:[], never a 5xx; the panel says "no earnings data" and
// suppresses the AI brief rather than erroring. Handler extracted with
// an injectable service (the shape terminal.earnings.test.js uses to
// stay off the network) and wrapped in its own try/catch: even though
// the service contract is never-throws, the route does not lean on
// that — any unexpected rejection still degrades to the same honest-
// empty 200 with a warn, so this endpoint can never 5xx.
export async function earningsHandler(req, res, deps = {}) {
  const fetchEarnings = deps.getEarnings || getEarnings;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const { upcoming, history } = await fetchEarnings(raw);
    res.json({ ticker: raw, upcoming, history });
  } catch (err) {
    console.warn(`terminal/earnings(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, upcoming: null, history: [] });
  }
}

router.get('/earnings/:ticker', (req, res) => earningsHandler(req, res));

// CON — a ticker's analyst buy/hold/sell breakdown (the latest period)
// plus the recent trend, off the same Finnhub /stock/recommendation
// feed Peers already consumes; getConsensus owns the newest-first
// reshape and shares the recommendation cache (its own namespaced
// key). The service is never-throws and returns its honest empty stub
// on any miss — ETFs, illiquid names, or no analyst coverage — so a
// coverage gap is a normal 200 with latest:null / trend:[], never a
// 5xx; the panel says "no analyst coverage" and suppresses the AI
// brief rather than erroring. Handler extracted with an injectable
// service (the shape terminal.consensus.test.js uses to stay off the
// network) and wrapped in its own try/catch: even though the service
// contract is never-throws, the route does not lean on that — any
// unexpected rejection still degrades to the same honest-empty 200
// with a warn, so this endpoint can never 5xx.
export async function consensusHandler(req, res, deps = {}) {
  const fetchConsensus = deps.getConsensus || getConsensus;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const { latest, trend } = await fetchConsensus(raw);
    res.json({ ticker: raw, latest, trend });
  } catch (err) {
    console.warn(`terminal/consensus(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, latest: null, trend: [] });
  }
}

router.get('/consensus/:ticker', (req, res) => consensusHandler(req, res));

// GET /quotes?tickers=A,B,C — the only live-price tap the terminal's
// quote panels (DES, Peers, MOVR) draw on. Thin by design: it owns the
// abuse net, not the cache. liveQuotes.js already de-dupes/upper-cases
// and deliberately does not cap (a caller passes only its on-screen
// set); the route caps at 40 so a hand-crafted ?tickers= can't fan a
// single request into a Finnhub burst — on-screen sets are an order of
// magnitude smaller, so a legitimate panel never trips it. A simply-
// empty list is not an error: unlike the single-path-param governance
// routes (which 400 a malformed ticker), this takes a free-form list
// and the service itself degrades empty/junk to {}, so the lenient,
// honest answer is a 200 {} — the same never-error posture as exec-bios
// rather than a 4xx.
//
// Handler extracted with an injectable service (the shape
// terminal.quotes.test.js uses to stay off the network) and wrapped in
// its own try/catch: liveQuotes.js is contractually never-throws, but
// the route does not lean on that — any unexpected rejection still
// degrades to a 200 {} with a warn, so this endpoint can never 5xx and
// a failed poll just leaves the panel on its last good values.
export async function quotesHandler(req, res, deps = {}) {
  const fetchQuotes = deps.getLiveQuotes || getLiveQuotes;
  const list = Array.from(
    new Set(
      String(req.query?.tickers || '')
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    )
  ).slice(0, 40);
  if (list.length === 0) return res.json({});
  try {
    res.json(await fetchQuotes(list));
  } catch (err) {
    console.warn('terminal/quotes degraded:', err.message);
    res.json({});
  }
}

router.get('/quotes', (req, res) => quotesHandler(req, res));

// CMP — 2–4 tickers side by side: the comparison columns Peers
// already shows (name, mkt cap, P/E, fwd P/E, div, beta) for an
// arbitrary user-picked set rather than a sector peer list. Pure
// reuse of getPeerSnapshot — the same per-name fundamentals bundle
// PEER lifts, one snapshot per requested ticker, sharing its 15m
// cache; there is no new Finnhub path here. Live price + day % are
// not this route's job: the panel overlays /terminal/quotes via
// useLiveRefresh exactly like Peers/Movers, so /compare stays the
// slow fundamentals snapshot only.
//
// The ?tickers list is normalized by the identical rule
// quotesHandler uses (split, trim, upper-case, drop empties, dedupe)
// but capped at 4 — the panel never compares more than four, and the
// cap keeps a hand-crafted list from fanning into a snapshot burst.
// One row per requested ticker is the contract: a snapshot miss
// (unknown symbol, Finnhub gap, or even a per-ticker rejection) keeps
// the row with every fundamental nulled so the panel still renders a
// column for every name the user asked for. An empty list is the
// lenient honest 200 { tickers:[], rows:[] }, not a 4xx — the same
// free-form-list posture as /quotes, not the single-path-param
// governance guards.
//
// Handler extracted with an injectable service (the shape
// terminal.compare.test.js uses to stay off the network) and wrapped
// in its own try/catch around both the per-ticker fetch and the
// whole pass: getPeerSnapshot is contractually never-throws, but the
// route does not lean on that — a per-ticker rejection degrades that
// row, and any handler-level failure degrades to a 200
// { tickers:[], rows:[] } with a warn, so this endpoint can never
// 5xx.
export async function compareHandler(req, res, deps = {}) {
  const fetchSnapshot = deps.getPeerSnapshot || getPeerSnapshot;
  try {
    const list = Array.from(
      new Set(
        String(req.query?.tickers || '')
          .split(',')
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean)
      )
    ).slice(0, 4);
    if (list.length === 0) return res.json({ tickers: [], rows: [] });

    const snaps = await Promise.all(
      list.map((t) => Promise.resolve(fetchSnapshot(t)).catch(() => null))
    );

    const rows = list.map((t, i) => {
      const s = snaps[i];
      return {
        ticker: t,
        name: s?.name ?? null,
        marketCap: s?.marketCap ?? null,
        peRatio: s?.trailingPE ?? null,
        forwardPE: s?.forwardPE ?? null,
        dividendYield: s?.dividendYield ?? null,
        beta: s?.beta ?? null,
      };
    });
    res.json({ tickers: list, rows });
  } catch (err) {
    console.warn('terminal/compare degraded:', err.message);
    res.json({ tickers: [], rows: [] });
  }
}

router.get('/compare', (req, res) => compareHandler(req, res));

// FIL — a ticker's recent SEC filings (8-K, 10-Q, 10-K, DEF 14A,
// Form 4 …) straight off the EDGAR submissions feed. Pure reuse of
// secFilings.js: getRecentFilings already backs holdings.js and owns
// its own 6h per-ticker cache, ticker→CIK resolution (including the
// dot/dash share-class convention), and the never-throws empty
// degrade — there is no new SEC fetch path here. We pull a 40-row
// window: deep enough that an annual DEF 14A or 10-K isn't buried
// behind a torrent of 8-Ks/Form 4s for an active large-cap, while
// still a single cached JSON read.
//
// Handler extracted with an injectable service (the shape
// terminal.filings.test.js uses to stay off the network) and wrapped
// in its own try/catch: getRecentFilings is contractually never-
// throws (it returns [] on any miss), but the route does not lean on
// that — any unexpected rejection still degrades to a 200
// { ticker, filings: [] } with a warn, so this endpoint can never
// 5xx and the panel says "no recent filings" rather than erroring.
// A malformed path param is the one 400, matching the sibling
// /governance and exec-bios input guards exactly.
export async function filingsHandler(req, res, deps = {}) {
  const fetchFilings = deps.getRecentFilings || getRecentFilings;
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const filings = await fetchFilings(raw, { limit: 40 });
    res.json({ ticker: raw, filings: Array.isArray(filings) ? filings : [] });
  } catch (err) {
    console.warn(`terminal/filings(${raw}) degraded:`, err.message);
    res.json({ ticker: raw, filings: [] });
  }
}

router.get('/filings/:ticker', (req, res) => filingsHandler(req, res));

// MACRO — portfolio sensitivity to the five macro factors (10Y yield,
// WTI oil, USD index, VIX, SPY) over a 252-trading-day OLS. The whole
// matrix is assembled by factorSensitivity.js: every holding × every
// factor's daily regression, aggregated to a portfolio β per factor
// with the n≥60 filter + weight redistribution + top-3 contributors
// + a default-shock scenario preview. The service is never-throws and
// returns honest empty (lookbackDays only, factors:[], holdings:[],
// marketValues:{}) on any failure mode — a missing FRED_API_KEY, a
// sheet outage, a NASDAQ 502 on the price-bar refresh — so the panel
// always paints a stable frame and the empty-state copy ("FRED
// unavailable") never collapses into a 5xx splash.
//
// Handler extracted with an injectable service (the shape
// terminal.macroSensitivity.test.js uses to stay off both the FRED
// observation feed and the price-bar cache) and wrapped in its own
// try/catch: getMacroSensitivity is contractually never-throws, but
// the route does not lean on that — any unexpected rejection still
// degrades to the same honest-empty 200 with a warn, so this endpoint
// can never 5xx.
export async function macroSensitivityHandler(req, res, deps = {}) {
  const fetchMatrix = deps.getMacroSensitivity || getMacroSensitivity;
  try {
    const data = await fetchMatrix();
    res.json(data);
  } catch (err) {
    console.warn('terminal/macro-sensitivity degraded:', err.message);
    res.json({
      asOf: new Date().toISOString(),
      lookbackDays: 252,
      factors: [],
      holdings: [],
      marketValues: {},
    });
  }
}

// ICLUSTER — multi-insider open-market buy clusters across a small
// universe (v1 = the fund's holdings, optionally + watchlist if its
// route ships). The whole methodology — 60d window, ≥3 distinct
// insiders, code-P only, role-weighted score, into-weakness flag — is
// the cluster service's call; this route owns the universe-building
// (cash filter, watchlist loose-coupling, ?tickers= override, 50-
// ticker defensive cap) and the honest-empty degrade.
//
// The watchlist is loose-coupled per the spec: PR #32 hasn't merged on
// this branch, so we attempt a dynamic import of the future watchlist
// service and silently fall back to "holdings only" when it isn't
// there. Once #32 ships, the same import resolves and a default
// watchlist provider is mixed in without touching this file. A test-
// injected deps.getWatchlistTickers wins outright (a throw is also
// degraded so a flaky watchlist read never breaks the cluster scan).
//
// scanUniverse is contractually never-throws (per-ticker errors are
// absorbed by getTickerCluster), but the route does not lean on that —
// any unexpected rejection still degrades to a 200 honest-empty
// { asOf, universe:[], results:[] } with a console.warn so this
// endpoint can never 5xx.
//
// IMPORTANT FRAMING: per the spec this is a SCREEN, not a backtested
// signal. The panel footer and the AI brief both carry that line —
// the data layer surfaces the pattern, the UI never overstates it.
export async function insiderClustersHandler(req, res, deps = {}) {
  const scan = deps.scanUniverse || scanInsiderClusters;
  const fetchPortfolio = deps.getSheetPortfolio || getSheetPortfolio;
  // The watchlist provider on this branch doesn't exist yet. When the
  // tests inject one, it wins; otherwise we try the dynamic import,
  // and if that yields nothing useful we skip it silently.
  let fetchWatchlist = deps.getWatchlistTickers;
  if (!fetchWatchlist) {
    try {
      const mod = await import('./watchlist.js');
      if (mod && typeof mod.getWatchlistTickers === 'function') {
        fetchWatchlist = mod.getWatchlistTickers;
      }
    } catch {
      // ERR_MODULE_NOT_FOUND on this branch — expected; nothing to do.
    }
  }

  try {
    // ?tickers=A,B,C overrides the computed universe entirely — the
    // same split/trim/upper-case/dedupe normalization /quotes uses.
    const raw = String(req.query?.tickers || '').trim();
    let list;
    if (raw) {
      list = Array.from(
        new Set(
          raw
            .split(',')
            .map((t) => t.trim().toUpperCase())
            .filter(Boolean)
        )
      );
    } else {
      const holdings = await (async () => {
        try {
          const p = await fetchPortfolio();
          const arr = Array.isArray(p) ? p : p?.holdings || [];
          return arr
            .filter((h) => h && !h.isCash)
            .map((h) => String(h.ticker || '').trim().toUpperCase())
            .filter(Boolean);
        } catch (err) {
          console.warn('insiderClusters portfolio degraded:', err.message);
          return [];
        }
      })();
      const watch = fetchWatchlist
        ? await (async () => {
            try {
              const arr = await fetchWatchlist();
              return Array.isArray(arr)
                ? arr.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean)
                : [];
            } catch (err) {
              // A missing or throwing watchlist provider is honestly
              // degraded — the universe falls back to holdings only.
              console.warn('insiderClusters watchlist degraded:', err.message);
              return [];
            }
          })()
        : [];
      list = Array.from(new Set([...holdings, ...watch]));
    }
    // Defensive cap so a hand-crafted ?tickers= can't fan one
    // request into a Finnhub burst. Legitimate universes are an
    // order of magnitude below this.
    list = list.slice(0, 50);

    const results = await scan(list);
    res.json({
      asOf: new Date().toISOString(),
      universe: list,
      results: Array.isArray(results) ? results : [],
    });
  } catch (err) {
    console.warn('terminal/insider-clusters degraded:', err.message);
    res.json({
      asOf: new Date().toISOString(),
      universe: [],
      results: [],
    });
  }
}

router.get('/macro-sensitivity', (req, res) => macroSensitivityHandler(req, res));
router.get('/insider-clusters', (req, res) => insiderClustersHandler(req, res));

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

// GET /api/terminal/indices — world index snapshot. Data sourcing and
// the Stooq→Finnhub fallback live in services/worldIndices.js (Yahoo is
// unreachable from Render's IP). The service never throws and stubs any
// miss, so a bad feed degrades a row to "—" rather than failing here.
router.get('/indices', async (_req, res) => {
  try {
    const rows = await getWorldIndices();
    res.json({ asOf: new Date().toISOString(), regions: REGION_ORDER, rows });
  } catch (err) {
    console.error('terminal/indices failed:', err.message);
    res.status(502).json({ error: 'Index snapshot failed' });
  }
});

// ── Function-specific AI prompts ────────────────────────────────────
// Each panel gets a tailored system prompt so the AI acts like a domain
// expert rather than a generic summarizer. All share the same grounding
// rules (exact figures, no guessing), but the analytical lens differs.

const GROUNDING_RULES =
  'IMPORTANT: Use ONLY the exact figures provided in the panel data. Never estimate, round differently, or invent numbers. ' +
  'If a value is missing from the data, do not guess it. ' +
  'No bullet lists. No disclaimers. ' +
  'If the context is empty or the data is missing, write a single line: "Data unavailable."';

const FN_PROMPTS = {
  DES:
    'You are a senior equity analyst annotating a company snapshot for GCIG, a student investment fund. ' +
    'Write a 2–4 sentence brief that contextualizes the fundamentals. ' +
    'Highlight what stands out: is the P/E rich or cheap vs. the sector? Is the stock near a 52-week extreme? ' +
    'Does the dividend yield or beta suggest anything about risk/reward? ' +
    'Connect the numbers to the business summary when possible. ' +
    GROUNDING_RULES,

  CN:
    'You are a newsroom analyst at GCIG, a student investment fund. ' +
    'Read the headlines below and write a 2–3 sentence synthesis of the dominant narrative. ' +
    'What is the market focused on for this name right now? Is the tone bullish, bearish, or mixed? ' +
    'Flag if multiple sources are converging on the same story — that amplifies signal. ' +
    'If headlines are stale (all older than a day), note the lack of fresh catalysts. ' +
    GROUNDING_RULES,

  TOP:
    'You are a macro strategist at GCIG, a student investment fund. ' +
    'Scan these market-wide headlines and write a 2–3 sentence brief on the prevailing market narrative. ' +
    'What themes dominate: rates, earnings, geopolitics, sector rotation? ' +
    'Is the overall tone risk-on or risk-off? Flag any headline that could move markets in the next session. ' +
    GROUNDING_RULES,

  PEER:
    'You are a sector analyst at GCIG, a student investment fund, comparing a company against its peer group. ' +
    'Write a 2–4 sentence brief. How does the focus stock\'s valuation (P/E, forward P/E) compare to the group median? ' +
    'Is it trading at a premium or discount, and does its growth or dividend profile justify it? ' +
    'Call out the cheapest and most expensive names. Note any outlier betas. ' +
    GROUNDING_RULES,

  INSDR:
    'You are a forensic analyst at GCIG, a student investment fund, interpreting Form 4 insider transactions. ' +
    'Write a 2–4 sentence brief. Is the pattern net buying or net selling? Are the buyers C-suite or directors? ' +
    'Cluster buys from multiple insiders in the same period are a strong signal — flag them. ' +
    'Large option exercises followed by immediate sells are routine, not bearish — distinguish them from open-market conviction buys. ' +
    GROUNDING_RULES,

  EARN:
    'You are an earnings analyst at GCIG, a student investment fund, reading a company\'s report history. ' +
    'Write a 2–3 sentence brief. When is the next report, and is it near? ' +
    'Has the recent record been a beat or miss streak, and is the EPS surprise trend widening or narrowing? ' +
    'Flag if the estimate set is thin (few quarters) or stale, which makes the next print less predictable. ' +
    GROUNDING_RULES,

  MOVR:
    'You are a portfolio risk analyst at GCIG, a student investment fund, reviewing today\'s performance across the book. ' +
    'Write a 2–3 sentence brief. Is the fund broadly green or red? How concentrated is the move — is one name driving most of the P&L? ' +
    'Flag any holding moving more than ±3% as it likely has a catalyst. Note if the portfolio is moving with or against the broader market. ' +
    GROUNDING_RULES,

  MGMT:
    'You are a governance analyst at GCIG, a student investment fund. ' +
    'Write a 2–3 sentence brief on the leadership team. Note CEO tenure and any recent turnover. ' +
    'Flag if compensation appears outsized relative to company size, or if the board has notable interlocking directorships with portfolio companies. ' +
    GROUNDING_RULES,

  FIL:
    'You are a filings analyst at GCIG, a student investment fund, reading a ticker\'s recent SEC submissions. ' +
    'Write a 2–3 sentence brief on what is notable. Flag a fresh 10-K or 10-Q, a material 8-K, or a new DEF 14A, and note clustered Form 4s in a short window. ' +
    'Distinguish substantive filings from routine boilerplate (144s, ownership amendments). ' +
    'If nothing has been filed recently or the feed is stale, say so plainly rather than overstating thin activity. ' +
    GROUNDING_RULES,

  CON:
    'You are a sell-side-coverage analyst at GCIG, a student investment fund, reading a ticker\'s analyst recommendation distribution. ' +
    'Write a 2–3 sentence brief. What is the current skew — is the latest period weighted to buy, hold, or sell? ' +
    'Comparing the recent periods, is sentiment improving (upgrades, buys rising) or deteriorating (downgrades, holds/sells rising)? ' +
    'Flag thin or absent coverage (only a handful of analysts, or none), which makes the consensus weak signal. ' +
    GROUNDING_RULES,

  CMP:
    'You are a relative-value analyst at GCIG, a student investment fund, comparing a small hand-picked set of tickers head to head. ' +
    'Write a 2–3 sentence brief. Which name looks rich and which looks cheap on P/E (and forward P/E) relative to the group, and does any growth, yield, or beta difference justify that gap? ' +
    'Name the clear outlier — the cheapest, the most expensive, or the one whose risk profile (beta) or income (dividend) sets it apart. ' +
    'If the set is too small or fundamentals are missing for most names, say so plainly rather than forcing a comparison. ' +
    GROUNDING_RULES,

  WEI:
    'You are a global macro analyst at GCIG, a student investment fund. ' +
    'Write a 2–3 sentence brief on the global equity picture. Which regions are leading and lagging? ' +
    'Is there a risk-on or risk-off pattern across geographies? Note any index moving more than ±1.5% as it likely has a story behind it. ' +
    GROUNDING_RULES,

  MACRO:
    'You are a macro factor analyst at GCIG, a student investment fund, reading the portfolio\'s sensitivity to 10Y yields, WTI oil, USD index, VIX, and SPY from a 252-trading-day OLS regression. ' +
    'Write a 2–3 sentence brief. Cite the portfolio β per factor with its sign (a negative β to 10Y means the book falls when yields rise) and name the 1–3 dominant contributing tickers along with their individual β. ' +
    'Summarize what the default scenario implies in plain language (e.g. "if 10Y rises 50bps, the book is expected down ~X%"), and mention R² and n so the reader knows how predictive past sensitivity has been — single-factor R² on individual stocks is typically low (0.05–0.30), which is honest, not a bug. ' +
    'Frame this explicitly as past sensitivity, not a forecast: rolling betas drift across regimes, so the scenario is a "what the book did when this factor moved historically" cue, not a prediction. ' +
    GROUNDING_RULES,

  ICLUSTER:
    'You are a forensic analyst at GCIG, a student investment fund, reading a cluster-scanner output across the book. ' +
    'Write a 2–3 sentence brief. Flag the top scoring names by their role composition and total dollars committed, and distinguish into-weakness clusters (insiders buying after a drawdown) from into-strength clusters. ' +
    'Frame this explicitly as a SCREEN, not a standalone signal — evidence to bring to a fundamentals thesis, not a trade trigger on its own. ' +
    GROUNDING_RULES,
};

const DEFAULT_PROMPT =
  'You are the AI annotation layer inside a Bloomberg-style terminal at GCIG, a student investment fund. ' +
  'For the panel and data below, write a 2–4 sentence brief that adds insight, not restatement. ' +
  'Be concrete: cite numbers from the context when relevant. ' +
  GROUNDING_RULES;

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
      content: FN_PROMPTS[safeFn] || DEFAULT_PROMPT,
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
        'You translate natural language into a terminal command for a Bloomberg-style workstation at GCIG, a student investment fund.\n' +
        `Available functions: ${functionIds}.\n` +
        'Rules:\n' +
        '- Reply with strict JSON only, no prose, no code fences.\n' +
        '- Shape: {"ticker": string|null, "function": string, "args": string|null, "explanation": string}\n' +
        '- "function" must be one of the listed IDs. "ticker" is uppercase if present.\n' +
        '- Map intent to the best function: "news about Apple" → AAPL CN, "who runs Tesla" → TSLA MGMT, ' +
        '"compare Nike to peers" → NKE PEER, "insider buying at JPM" → JPM INSDR, "market overview" → TOP, ' +
        '"what\'s moving" → MOVR, "global markets" → WEI.\n' +
        '- If the user names a company, resolve it to the standard ticker (e.g. "Home Depot" → HD, "Google" → GOOGL).\n' +
        '- "explanation" is one short sentence describing what the command does.',
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
        'You are the Bloomberg Intelligence research console at GCIG, a student-run investment fund. ' +
        'You think like a buy-side analyst: rigorous, quantitative, and opinionated when the data supports it.\n\n' +
        'Guidelines:\n' +
        '- Lead with the answer, then support it. Don\'t hedge everything.\n' +
        '- Cite specific numbers from the workspace context when available.\n' +
        '- When comparing companies, use relative valuation (P/E vs. peers, EV/EBITDA, PEG).\n' +
        '- For "why is X up/down" questions, distinguish between catalysts (earnings, news) and technicals (positioning, flows).\n' +
        '- For bull/bear cases, identify the 2–3 key variables that matter most, not a laundry list.\n' +
        '- If asked about a holding in the GCIG portfolio, frame the analysis around position sizing and conviction.\n' +
        '- Keep responses under 200 words unless the question demands depth.\n' +
        '- Use short paragraphs, not bullet lists. Write like a morning research note, not a chatbot.\n' +
        '- If you genuinely don\'t know or the data is insufficient, say so in one sentence.' +
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
