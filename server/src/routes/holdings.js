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
import { getNewsForTicker } from '../services/news.js';

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

    tickerCache.set(raw, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(`Ticker info fetch failed for ${raw}:`, err);
    res.status(502).json({ error: err.message || 'Failed to fetch ticker info' });
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
  res.json(snapshots);
});

export default router;
