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
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

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

router.get('/history', async (_req, res) => {
  const snapshots = await prisma.portfolioSnapshot.findMany({
    orderBy: { date: 'asc' },
    take: 365,
  });
  res.json(snapshots);
});

export default router;
