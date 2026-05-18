import { Router } from 'express';
import YahooFinance from 'yahoo-finance2';
// yahoo-finance2 v2.14 ships the class as the default export; instantiate once.
// Only `quote` / `autoc` are exposed — profile/sector data is fetched via a
// direct HTTP call to Yahoo's quoteSummary endpoint below.
const yahooFinance = new YahooFinance();

// Finnhub is our primary data source when FINNHUB_API_KEY is configured.
// Free tier: 60 calls/min, real-time US quotes, company profile included.
async function fetchFinnhub(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const base = 'https://finnhub.io/api/v1';
  try {
    const [quoteRes, profileRes, metricRes] = await Promise.all([
      fetch(`${base}/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`),
      fetch(`${base}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`),
      fetch(`${base}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`),
    ]);
    if (!quoteRes.ok) return null;
    const [q, profile, metric] = await Promise.all([
      quoteRes.json(),
      profileRes.ok ? profileRes.json() : {},
      metricRes.ok ? metricRes.json() : {},
    ]);
    // Finnhub returns c=0 for unknown tickers.
    if (!q || !q.c) return null;
    const m = metric?.metric || {};
    return {
      ticker,
      name: profile?.name || ticker,
      exchange: profile?.exchange || null,
      currency: profile?.currency || 'USD',
      sector: profile?.finnhubIndustry || null,
      industry: profile?.finnhubIndustry || null,
      website: profile?.weburl || null,
      summary: null, // Finnhub profile2 has no business summary on free tier
      employees: null,
      country: profile?.country || null,
      price: q.c,
      previousClose: q.pc,
      dayHigh: q.h,
      dayLow: q.l,
      fiftyTwoWeekHigh: m['52WeekHigh'] ?? null,
      fiftyTwoWeekLow: m['52WeekLow'] ?? null,
      // Finnhub returns marketCapitalization in millions.
      marketCap:
        profile?.marketCapitalization != null
          ? profile.marketCapitalization * 1e6
          : null,
      trailingPE: m.peBasicExclExtraTTM ?? m.peInclExtraTTM ?? null,
      forwardPE: m.peNormalizedAnnual ?? null,
      dividendYield:
        m.currentDividendYieldTTM != null
          ? m.currentDividendYieldTTM / 100
          : null,
      beta: m.beta ?? null,
      volume: null,
      avgVolume: m['10DayAverageTradingVolume']
        ? m['10DayAverageTradingVolume'] * 1e6
        : null,
      _source: 'finnhub',
    };
  } catch (err) {
    console.warn(`finnhub(${ticker}) failed:`, err.message);
    return null;
  }
}

// Fallback: Yahoo's v8 chart endpoint returns meta with current price + previous
// close + 52w range WITHOUT needing a crumb. Used if the library's quote() call
// fails because of rate limiting / cookie issues.
async function fetchChartMeta(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json?.chart?.result?.[0]?.meta || null;
  } catch {
    return null;
  }
}

// Fetch profile/sector/summary from Yahoo's public quoteSummary endpoint.
// This is a best-effort call; Yahoo sometimes returns 401 without a crumb,
// in which case we return null and the caller falls back to quote-only data.
async function fetchQuoteSummary(ticker) {
  const modules = 'summaryProfile,summaryDetail,price,defaultKeyStatistics';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json?.quoteSummary?.result?.[0] || null;
  } catch {
    return null;
  }
}
import prisma from '../db.js';
import { verifyJwt, requireSuperAdmin, requireRole } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { getNewsForTicker, extractArticle } from '../services/news.js';
import { getBusinessSummary } from '../services/secBusinessSummary.js';
import {
  generateRiskCommentary,
  detectThesisDrift,
  checkThesisAgainstNews,
} from '../services/riskCommentary.js';
import {
  getUpcomingEarnings,
  getUpcomingEarningsBatch,
  getAnalystConsensus,
} from '../services/marketData.js';
import { getRecentFilings } from '../services/secFilings.js';
import { computeCashInterest } from '../services/cashInterest.js';
import { scrapeAndStoreDailyRates } from '../services/gsamRates.js';
import { backfillFgtxxFromEdgar } from '../services/secNmfp.js';

const router = Router();

// Tiny in-memory cache so clicking the same ticker twice doesn't hammer Yahoo.
// 15-minute TTL — fundamentals don't change intraday.
const tickerCache = new Map();
const TICKER_TTL_MS = 15 * 60 * 1000;

// Machine-to-machine endpoint for the daily cron. Authed via shared secret,
// NOT JWT. Mounted before verifyJwt so no user login is needed.
router.post('/snapshot/daily', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  try {
    // Skip the 20-min memory cache so the cron always gets a fresh read of
    // the sheet (otherwise a user who opened the page 15 min earlier could
    // freeze today's snapshot at pre-close prices).
    const data = await getSheetPortfolio({ forceFresh: true });
    if (data.totals.totalValue <= 0) {
      return res.status(400).json({ error: 'Sheet returned zero total value' });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const snap = await prisma.portfolioSnapshot.upsert({
      where: { date: today },
      update: {
        totalValue: data.totals.totalValue,
        cashValue: data.totals.cashValue,
      },
      create: {
        date: today,
        totalValue: data.totals.totalValue,
        cashValue: data.totals.cashValue,
      },
    });
    res.json({
      ok: true,
      date: snap.date,
      totalValue: snap.totalValue,
      cashValue: snap.cashValue,
    });
  } catch (err) {
    console.error('Daily snapshot cron failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.use(verifyJwt);

// Live portfolio pulled from the club's Google Sheet.
// The sheet IS the source of truth — the local Holding table is unused
// in this mode.
router.get('/quotes', async (_req, res) => {
  try {
    const data = await getSheetPortfolio();

    // Write a daily snapshot for today from the sheet total + cash.
    if (data.totals.totalValue > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      await prisma.portfolioSnapshot.upsert({
        where: { date: today },
        update: {
          totalValue: data.totals.totalValue,
          cashValue: data.totals.cashValue,
        },
        create: {
          date: today,
          totalValue: data.totals.totalValue,
          cashValue: data.totals.cashValue,
        },
      });
    }

    res.json(data);
  } catch (err) {
    console.error('Sheet portfolio error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Fetch basic company/quote info for a ticker from Yahoo Finance.
// Used by the portfolio holding detail modal.
router.get('/info/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  // Tickers are ASCII letters, digits, dot, dash (e.g. BRK.B, RDS-A). Reject anything else.
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const cached = tickerCache.get(raw);
  if (cached && Date.now() - cached.at < TICKER_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    // Primary: Finnhub (reliable, real-time, no rate-limit issues).
    if (process.env.FINNHUB_API_KEY) {
      const finnhubData = await fetchFinnhub(raw);
      if (finnhubData) {
        // Finnhub's free tier has no business summary, so DES would
        // render quote + brief with no prose. Yahoo's profile endpoint is
        // the obvious source but it's 429/401-blocked from datacenter IPs
        // (the same wall as the GSAM scraper). EDGAR's 10-K Item 1 is
        // reachable from Render; use it. Best-effort and cached a week —
        // never let it block the live quote we already have.
        if (!finnhubData.summary) {
          finnhubData.summary = await getBusinessSummary(raw);
        }
        tickerCache.set(raw, { at: Date.now(), data: finnhubData });
        return res.json(finnhubData);
      }
    }

    // Fallback: Yahoo Finance. Yahoo rate-limits aggressively on the crumb
    // endpoint, so we also try chart meta + quoteSummary directly.
    const opts = { validateResult: false };
    const [quoteResult, summaryResult, chartResult] = await Promise.allSettled([
      yahooFinance.quote(raw, {}, opts),
      fetchQuoteSummary(raw),
      fetchChartMeta(raw),
    ]);
    let quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    const chartMeta = chartResult.status === 'fulfilled' ? chartResult.value : null;
    if (quoteResult.status === 'rejected') {
      console.warn(`yahoo quote(${raw}) failed:`, quoteResult.reason?.message);
    }

    // If the library's quote failed (often rate-limited crumb), synthesize a
    // minimal quote object from the chart meta so the modal still renders
    // price, prev close, 52w range, exchange.
    if (!quote && chartMeta) {
      quote = {
        longName: chartMeta.longName || chartMeta.shortName,
        shortName: chartMeta.shortName,
        fullExchangeName: chartMeta.fullExchangeName || chartMeta.exchangeName,
        currency: chartMeta.currency,
        regularMarketPrice: chartMeta.regularMarketPrice,
        regularMarketPreviousClose:
          chartMeta.chartPreviousClose ?? chartMeta.previousClose,
        regularMarketDayHigh: chartMeta.regularMarketDayHigh,
        regularMarketDayLow: chartMeta.regularMarketDayLow,
        fiftyTwoWeekHigh: chartMeta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: chartMeta.fiftyTwoWeekLow,
        regularMarketVolume: chartMeta.regularMarketVolume,
      };
    }

    if (!quote && !summary) {
      const reason = quoteResult.reason?.message || 'Ticker not found';
      return res.status(404).json({ error: reason });
    }

    const profile = summary?.summaryProfile || {};
    const detail = summary?.summaryDetail || {};
    const price = summary?.price || {};
    const stats = summary?.defaultKeyStatistics || {};

    // Yahoo wraps numbers as { raw: 12345, fmt: "12.3K" } — unwrap .raw.
    const r = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : v);

    const data = {
      ticker: raw,
      name:
        quote?.longName ||
        quote?.shortName ||
        r(price?.longName) ||
        r(price?.shortName) ||
        raw,
      exchange: quote?.fullExchangeName || r(price?.exchangeName) || null,
      currency: quote?.currency || r(price?.currency) || 'USD',
      sector: profile.sector || null,
      industry: profile.industry || null,
      website: profile.website || null,
      summary: profile.longBusinessSummary || null,
      employees: r(profile.fullTimeEmployees) || null,
      country: profile.country || null,
      price: quote?.regularMarketPrice ?? r(price?.regularMarketPrice) ?? null,
      previousClose:
        quote?.regularMarketPreviousClose ?? r(detail?.previousClose) ?? null,
      dayHigh: quote?.regularMarketDayHigh ?? r(detail?.dayHigh) ?? null,
      dayLow: quote?.regularMarketDayLow ?? r(detail?.dayLow) ?? null,
      fiftyTwoWeekHigh:
        quote?.fiftyTwoWeekHigh ?? r(detail?.fiftyTwoWeekHigh) ?? null,
      fiftyTwoWeekLow:
        quote?.fiftyTwoWeekLow ?? r(detail?.fiftyTwoWeekLow) ?? null,
      marketCap: quote?.marketCap ?? r(price?.marketCap) ?? null,
      trailingPE: quote?.trailingPE ?? r(detail?.trailingPE) ?? null,
      forwardPE: quote?.forwardPE ?? r(detail?.forwardPE) ?? null,
      dividendYield: r(detail?.dividendYield) ?? null,
      beta: r(stats?.beta) ?? r(detail?.beta) ?? null,
      volume: quote?.regularMarketVolume ?? r(detail?.volume) ?? null,
      avgVolume:
        quote?.averageDailyVolume3Month ?? r(detail?.averageVolume) ?? null,
    };

    // Yahoo's longBusinessSummary is usually empty from datacenter IPs;
    // fall back to EDGAR so the description still loads when Finnhub is
    // down and we're on this path.
    if (!data.summary) data.summary = await getBusinessSummary(raw);

    tickerCache.set(raw, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(`Ticker info fetch failed for ${raw}:`, err);
    res.status(502).json({ error: err.message || 'Failed to fetch ticker info' });
  }
});

// Full-text extraction of a single article URL. Fetched server-side so we
// bypass CORS, run Mozilla's Readability to pull the main content, and
// sanitize the result before sending it back. 1-hour cache per URL.
router.get('/news/article', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const data = await extractArticle(url);
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.warn(`article extract failed for ${url}: ${err.message}`);
    res.status(status).json({ error: err.message || 'Failed to extract article' });
  }
});

// Recent news headlines for a ticker, sourced from newsapi.org. The service
// caches 15 minutes so a rapid round of holding clicks doesn't burn quota.
router.get('/news/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  // Company name optionally passed via ?name= so the query can be scoped to
  // the actual company rather than the ticker string (which collides with
  // common words).
  const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 80) : '';
  try {
    const data = await getNewsForTicker(raw, name);
    res.json(data);
  } catch (err) {
    console.error(`news(${raw}) failed:`, err.message);
    res.status(err.status || 502).json({ error: err.message || 'Failed to fetch news' });
  }
});

// Research coverage for a ticker: pitches and reports the club has produced.
// Returned alongside ticker info in the holding detail modal.
router.get('/coverage/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,10}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const [pitches, reports] = await Promise.all([
      prisma.pitch.findMany({
        where: { ticker: { equals: raw, mode: 'insensitive' } },
        orderBy: { date: 'desc' },
        include: {
          industry: { select: { id: true, name: true } },
          presenters: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.report.findMany({
        where: { ticker: { equals: raw, mode: 'insensitive' } },
        orderBy: { date: 'desc' },
      }),
    ]);
    res.json({
      pitches: pitches.map((p) => ({
        id: p.id,
        date: p.date,
        slideshowUrl: p.slideshowUrl,
        location: p.location,
        industry: p.industry,
        presenters:
          p.presenters.length > 0
            ? p.presenters.map((pp) => pp.user.name)
            : [p.pitcherName],
      })),
      reports: reports.map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        date: r.date,
        description: r.description,
        fileUrl: r.fileUrl,
      })),
    });
  } catch (err) {
    console.error(`coverage(${raw}) failed:`, err);
    res.status(500).json({ error: 'Failed to load coverage' });
  }
});


// ── Holding Lots ─────────────────────────────────────────────────────
// Per-purchase cost basis tracking. Anyone authed can read; only the super
// admin can mutate.

function validTicker(t) {
  return !!t && /^[A-Z0-9.\-]{1,10}$/.test(t);
}

router.get('/lots/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!validTicker(raw)) return res.status(400).json({ error: 'Invalid ticker' });
  const lots = await prisma.holdingLot.findMany({
    where: { ticker: raw },
    orderBy: { buyDate: 'asc' },
  });
  res.json(lots);
});

router.post('/lots', requireSuperAdmin, async (req, res) => {
  const { ticker, shares, pricePerShare, buyDate, note } = req.body || {};
  const t = String(ticker || '').trim().toUpperCase();
  const s = Number(shares);
  const p = Number(pricePerShare);
  const d = buyDate ? new Date(buyDate) : null;
  if (!validTicker(t)) return res.status(400).json({ error: 'Invalid ticker' });
  if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'Invalid shares' });
  if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Invalid price' });
  if (!d || Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid buy date' });
  const lot = await prisma.holdingLot.create({
    data: { ticker: t, shares: s, pricePerShare: p, buyDate: d, note: note || null },
  });
  res.status(201).json(lot);
});

router.put('/lots/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const { shares, pricePerShare, buyDate, note } = req.body || {};
  const data = {};
  if (shares !== undefined) {
    const s = Number(shares);
    if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'Invalid shares' });
    data.shares = s;
  }
  if (pricePerShare !== undefined) {
    const p = Number(pricePerShare);
    if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Invalid price' });
    data.pricePerShare = p;
  }
  if (buyDate !== undefined) {
    const d = new Date(buyDate);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid buy date' });
    data.buyDate = d;
  }
  if (note !== undefined) data.note = note || null;
  try {
    const lot = await prisma.holdingLot.update({ where: { id }, data });
    res.json(lot);
  } catch {
    res.status(404).json({ error: 'Lot not found' });
  }
});

router.delete('/lots/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await prisma.holdingLot.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Lot not found' });
  }
});

// Super-admin-only: overwrite a single day's snapshot. Used to correct days
// where Google Sheets served a stale CSV (the known Apr 14–17 flat stretch).
router.put('/snapshot/:date', requireSuperAdmin, async (req, res) => {
  const iso = String(req.params.date || '').trim();
  // Accept YYYY-MM-DD.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const { totalValue, cashValue } = req.body || {};
  const tv = Number(totalValue);
  if (!Number.isFinite(tv) || tv <= 0) {
    return res.status(400).json({ error: 'totalValue (positive number) required' });
  }
  const cv = cashValue == null || cashValue === '' ? null : Number(cashValue);
  if (cv != null && !Number.isFinite(cv)) {
    return res.status(400).json({ error: 'cashValue must be a number if provided' });
  }
  // Snapshots are stored at UTC midnight.
  const date = new Date(`${iso}T00:00:00Z`);
  const snap = await prisma.portfolioSnapshot.upsert({
    where: { date },
    update: { totalValue: tv, cashValue: cv },
    create: { date, totalValue: tv, cashValue: cv },
  });
  res.json(snap);
});

router.delete('/snapshot/:date', requireSuperAdmin, async (req, res) => {
  const iso = String(req.params.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const date = new Date(`${iso}T00:00:00Z`);
  try {
    await prisma.portfolioSnapshot.delete({ where: { date } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Snapshot not found' });
  }
});

// Batch beta lookup for every non-cash position in the current sheet.
// Used by the PM+ risk panel. Cached for 30 min — betas don't move intraday.
// Each ticker goes through the same Finnhub → Yahoo fallback as /info/:ticker
// but we only ask for the number we need.
const betasCache = { at: 0, data: null };
const BETAS_TTL_MS = 30 * 60 * 1000;

async function fetchBetaOnly(ticker) {
  // Try Finnhub metric endpoint first (1 call for beta).
  const key = process.env.FINNHUB_API_KEY;
  if (key) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`
      );
      if (r.ok) {
        const j = await r.json();
        const b = j?.metric?.beta;
        if (typeof b === 'number' && Number.isFinite(b)) return { beta: b, source: 'finnhub' };
      }
    } catch {
      /* fall through */
    }
  }
  // Fallback: Yahoo quoteSummary.
  const summary = await fetchQuoteSummary(ticker);
  const stats = summary?.defaultKeyStatistics;
  const detail = summary?.summaryDetail;
  const raw =
    (stats?.beta && typeof stats.beta === 'object' ? stats.beta.raw : stats?.beta) ??
    (detail?.beta && typeof detail.beta === 'object' ? detail.beta.raw : detail?.beta);
  if (typeof raw === 'number' && Number.isFinite(raw)) return { beta: raw, source: 'yahoo' };
  return { beta: null, source: null };
}

router.get('/betas', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    if (betasCache.data && Date.now() - betasCache.at < BETAS_TTL_MS) {
      return res.json(betasCache.data);
    }
    const portfolio = await getSheetPortfolio();
    const tickers = portfolio.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker);
    // Parallel but cap fan-out at 6 at a time to stay inside Finnhub's 60/min free tier.
    const byTicker = {};
    const CHUNK = 6;
    for (let i = 0; i < tickers.length; i += CHUNK) {
      const slice = tickers.slice(i, i + CHUNK);
      const results = await Promise.all(slice.map((t) => fetchBetaOnly(t)));
      slice.forEach((t, idx) => {
        byTicker[t] = results[idx];
      });
    }
    const payload = { byTicker, fetchedAt: new Date().toISOString() };
    betasCache.at = Date.now();
    betasCache.data = payload;
    res.json(payload);
  } catch (err) {
    console.error('betas fetch failed:', err.message);
    res.status(502).json({ error: err.message || 'Failed to fetch betas' });
  }
});

router.get('/history', async (_req, res) => {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    orderBy: { date: 'asc' },
    take: 365,
  });

  // Snapshots are the sheet's own totals, which already carry the cash
  // sleeves: the leftover FGTXX cash is the sheet's CASH line, and every
  // dollar drawn out of BDA/FGTXX became a stock the sheet prices. We
  // used to layer a simulated cash-interest accrual on top here — that
  // double-counted money the club had actually spent. Return the raw
  // snapshots untouched.
  res.json(snapshots);
});

// Upcoming earnings for every held equity ticker (next 60 days). Pulled
// from Finnhub with a 12h per-ticker cache, then filtered + sorted so
// the client can render a clean "next up" list.
router.get('/earnings', async (_req, res) => {
  try {
    const sheet = await getSheetPortfolio();
    const tickers = sheet.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker.toUpperCase());
    if (tickers.length === 0) return res.json({ upcoming: [] });

    const byTicker = await getUpcomingEarningsBatch(tickers, { daysAhead: 60 });
    // Flatten to a sorted list — soonest first. Include the company name
    // alongside the ticker so clients don't need to re-lookup.
    const holdingByTicker = new Map(
      sheet.holdings
        .filter((h) => !h.isCash && h.ticker)
        .map((h) => [h.ticker.toUpperCase(), h])
    );
    const upcoming = Object.entries(byTicker)
      .map(([ticker, row]) => {
        const h = holdingByTicker.get(ticker);
        return {
          ticker,
          name: h?.name || ticker,
          sector: h?.sector || null,
          date: row.date, // 'YYYY-MM-DD'
          hour: row.hour || null, // 'bmo' | 'amc' | 'dmh' | null
          epsEstimate: row.epsEstimate ?? null,
          revenueEstimate: row.revenueEstimate ?? null,
          quarter: row.quarter ?? null,
          year: row.year ?? null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ upcoming });
  } catch (err) {
    console.error('earnings fetch failed:', err.message);
    res.status(502).json({ error: 'Failed to fetch earnings calendar' });
  }
});

// Analyst consensus for a single ticker. Latest row + ~3-month prior so
// the client can show a "current + trend" chip.
router.get('/:ticker/consensus', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const data = await getAnalystConsensus(ticker);
  if (!data) return res.json({ ticker, covered: false });
  res.json({ ticker, covered: true, ...data });
});

// Recent SEC filings for a ticker. Free EDGAR data, no API key —
// 6h cache per ticker server-side.
router.get('/:ticker/filings', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const filings = await getRecentFilings(ticker, { limit: 10 });
    res.json({ ticker, filings });
  } catch (err) {
    console.error(`filings(${ticker}) failed:`, err.message);
    res.status(502).json({ error: 'Failed to fetch SEC filings' });
  }
});

// Single-ticker earnings lookup — convenience for the holding detail modal
// so it doesn't have to fetch the whole portfolio's earnings just to show
// one row.
router.get('/:ticker/earnings', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const row = await getUpcomingEarnings(ticker);
  if (!row) return res.json({ ticker, covered: false });
  res.json({ ticker, covered: true, ...row });
});

// ── Investment thesis per ticker ──────────────────────────────────────
// Readable by any authed member. Editable by super-admin only (same tier
// that manages lots and snapshot overrides).

function normalizeTicker(raw) {
  return String(raw || '').trim().toUpperCase();
}

router.get('/:ticker/thesis', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const row = await prisma.holdingThesis.findUnique({ where: { ticker } });
  // 200 + empty so the UI can render an "Add thesis" affordance cleanly
  // instead of having to handle a 404.
  res.json(row || { ticker, thesis: null });
});

router.put('/:ticker/thesis', requireSuperAdmin, async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  const raw = req.body?.thesis;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: 'thesis (string) required' });
  }
  const thesis = raw.trim();
  if (!thesis) return res.status(400).json({ error: 'thesis cannot be empty' });
  if (thesis.length > 5000) {
    return res.status(400).json({ error: 'thesis must be 5000 characters or fewer' });
  }
  const updatedByName = req.user?.name || null;
  const row = await prisma.holdingThesis.upsert({
    where: { ticker },
    update: { thesis, updatedByName },
    create: { ticker, thesis, updatedByName },
  });
  res.json(row);
});

router.delete('/:ticker/thesis', requireSuperAdmin, async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  await prisma.holdingThesis.deleteMany({ where: { ticker } });
  res.json({ ok: true });
});

// 1-2 sentence AI read on whether recent news supports or challenges the
// stored thesis. Readable by any authed member (same tier as thesis GET).
router.get('/:ticker/thesis-check', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  try {
    const row = await prisma.holdingThesis.findUnique({ where: { ticker } });
    if (!row?.thesis) return res.json({ reading: null });

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const articles = await prisma.articleRanking.findMany({
      where: { ticker, createdAt: { gte: since }, score: { gte: 5 } },
      orderBy: { score: 'desc' },
      take: 5,
    });
    const normalizedArticles = articles.map((a) => ({
      title: a.reason || a.summary?.slice(0, 120) || null,
      description: a.summary || null,
      score: a.score,
      reason: a.reason,
      url: a.url,
    }));
    const result = await checkThesisAgainstNews({
      ticker,
      thesis: row.thesis,
      articles: normalizedArticles,
    });
    res.json(result || { reading: null });
  } catch (err) {
    console.error('thesis-check failed:', err.message);
    res.json({ reading: null });
  }
});

// ── AI risk commentary ───────────────────────────────────────────────
// Client POSTs the already-computed risk metrics (weights, beta, vol,
// drawdown, HHI, cash %). Server calls the LLM, caches daily, returns a
// 3-4 sentence narrative or null if the LLM is unreachable.
router.post(
  '/risk-commentary',
  requireRole('PortfolioManager'),
  async (req, res) => {
    try {
      const metrics = req.body || {};
      const result = await generateRiskCommentary(metrics);
      res.json(result || { commentary: null });
    } catch (err) {
      console.error('risk-commentary failed:', err.message);
      // Fail open — panel keeps showing metrics without the narrative.
      res.json({ commentary: null });
    }
  }
);

// ── Thesis-vs-news drift ─────────────────────────────────────────────
// For each held non-cash ticker with both a thesis and recent ranked
// news, ask the LLM whether the news materially contradicts the thesis.
// Returns an array of flagged tickers only — tickers with drift:false
// are omitted so the UI can render a clean alert list.
router.get('/thesis-drift', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    const portfolio = await getSheetPortfolio();
    const tickers = portfolio.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker);
    if (tickers.length === 0) return res.json({ alerts: [] });

    const theses = await prisma.holdingThesis.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, thesis: true },
    });
    const thesisByTicker = new Map(theses.map((t) => [t.ticker, t.thesis]));
    const tickersWithThesis = tickers.filter((t) => thesisByTicker.has(t));
    if (tickersWithThesis.length === 0) return res.json({ alerts: [] });

    // 30-day window for materiality. Articles the club never surfaced
    // (no ranking) are ignored — we don't want the drift check to drive
    // new newsapi calls.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const articles = await prisma.articleRanking.findMany({
      where: {
        ticker: { in: tickersWithThesis },
        createdAt: { gte: since },
        score: { gte: 5 },
      },
      orderBy: { score: 'desc' },
      take: 100,
    });

    const articlesByTicker = new Map();
    for (const a of articles) {
      if (!articlesByTicker.has(a.ticker)) articlesByTicker.set(a.ticker, []);
      articlesByTicker.get(a.ticker).push({
        // ArticleRanking stores the rank + reason, not the headline text.
        // Pull from summary when present; fall back to ranker's 12-word reason.
        title: a.reason || a.summary?.slice(0, 120) || null,
        description: a.summary || null,
        score: a.score,
        reason: a.reason,
        url: a.url,
      });
    }

    // Concurrency-limited LLM fan-out so we don't spam the provider.
    const alerts = [];
    const CHUNK = 3;
    for (let i = 0; i < tickersWithThesis.length; i += CHUNK) {
      const slice = tickersWithThesis.slice(i, i + CHUNK);
      const results = await Promise.all(
        slice.map(async (t) => {
          const arts = articlesByTicker.get(t);
          if (!arts || arts.length === 0) return null;
          const drift = await detectThesisDrift({
            ticker: t,
            thesis: thesisByTicker.get(t),
            articles: arts,
          });
          if (!drift?.drift) return null;
          return {
            ticker: t,
            severity: drift.severity,
            reason: drift.reason,
            articleCount: arts.length,
          };
        })
      );
      for (const r of results) if (r) alerts.push(r);
    }

    // High severity first, then medium, then low.
    const rank = { high: 3, medium: 2, low: 1 };
    alerts.sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0));
    res.json({ alerts, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error('thesis-drift failed:', err.message);
    res.json({ alerts: [] });
  }
});

// YTD interest earned on the club's cash position, split between the
// FGTXX money-market sleeve and the Bank USA deposit sleeve. Open to
// every logged-in member — the cash sleeve isn't sensitive and the
// numbers are useful context for the dashboard.
router.get('/cash-yield', async (_req, res) => {
  try {
    const data = await computeCashInterest();
    // Strip the verbose per-day series for the default response; clients
    // that want the daily breakdown can pass ?series=1.
    const { series, ...summary } = data;
    if (_req.query.series === '1') {
      return res.json({ ...summary, series });
    }
    return res.json(summary);
  } catch (err) {
    console.error('cash-yield failed:', err.message);
    res.status(500).json({ error: 'Failed to compute cash interest' });
  }
});

// Manual trigger so an admin can force a re-scrape if the cron missed
// a day or the PDF was published late. The daily cron handles the
// happy path; this is the "fix it now" button.
router.post('/cash-yield/refresh', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    const rows = await scrapeAndStoreDailyRates(['FGTXX']);
    res.json({ scraped: rows.length, latest: rows[0] || null });
  } catch (err) {
    console.error('gsam scrape failed:', err.message);
    res.status(502).json({ error: err.message || 'Scrape failed' });
  }
});

// One-shot historical backfill from SEC N-MFP3 filings. Idempotent — safe
// to re-hit. Super-admin only because it talks to EDGAR and writes a
// chunk of rows; we don't want this firing accidentally.
router.post('/cash-yield/backfill', requireSuperAdmin, async (_req, res) => {
  try {
    const stats = await backfillFgtxxFromEdgar();
    res.json(stats);
  } catch (err) {
    console.error('n-mfp backfill failed:', err.message);
    res.status(502).json({ error: err.message || 'Backfill failed' });
  }
});

export default router;
