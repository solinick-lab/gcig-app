import { Router } from 'express';
import yahooFinance from 'yahoo-finance2';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

const router = Router();

// Suppress yahoo-finance2's survey prompt & schema-notice noise on first call.
yahooFinance.suppressNotices?.(['yahooSurvey', 'ripHistorical']);

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
    const data = await getSheetPortfolio();
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
    // yahoo-finance2 is strict about schema validation and sometimes throws on
    // unexpected fields. Wrap each call so one failing doesn't kill the other.
    // Also disable validation since Yahoo's schema drifts and we tolerate missing fields.
    const opts = { validateResult: false };
    const [quoteResult, summaryResult] = await Promise.allSettled([
      yahooFinance.quote(raw, {}, opts),
      yahooFinance.quoteSummary(
        raw,
        {
          modules: ['summaryProfile', 'summaryDetail', 'price', 'defaultKeyStatistics'],
        },
        opts
      ),
    ]);
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null;
    const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    if (quoteResult.status === 'rejected') {
      console.warn(`yahoo quote(${raw}) failed:`, quoteResult.reason?.message);
    }
    if (summaryResult.status === 'rejected') {
      console.warn(`yahoo quoteSummary(${raw}) failed:`, summaryResult.reason?.message);
    }

    if (!quote && !summary) {
      const reason =
        quoteResult.reason?.message ||
        summaryResult.reason?.message ||
        'Ticker not found';
      return res.status(404).json({ error: reason });
    }

    const profile = summary?.summaryProfile || {};
    const detail = summary?.summaryDetail || {};
    const price = summary?.price || {};
    const stats = summary?.defaultKeyStatistics || {};

    const data = {
      ticker: raw,
      name: quote?.longName || quote?.shortName || price?.longName || price?.shortName || raw,
      exchange: quote?.fullExchangeName || price?.exchangeName || null,
      currency: quote?.currency || price?.currency || 'USD',
      sector: profile.sector || null,
      industry: profile.industry || null,
      website: profile.website || null,
      summary: profile.longBusinessSummary || null,
      employees: profile.fullTimeEmployees || null,
      country: profile.country || null,
      price: quote?.regularMarketPrice ?? price?.regularMarketPrice ?? null,
      previousClose: quote?.regularMarketPreviousClose ?? detail?.previousClose ?? null,
      dayHigh: quote?.regularMarketDayHigh ?? detail?.dayHigh ?? null,
      dayLow: quote?.regularMarketDayLow ?? detail?.dayLow ?? null,
      fiftyTwoWeekHigh: quote?.fiftyTwoWeekHigh ?? detail?.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: quote?.fiftyTwoWeekLow ?? detail?.fiftyTwoWeekLow ?? null,
      marketCap: quote?.marketCap ?? price?.marketCap ?? null,
      trailingPE: quote?.trailingPE ?? detail?.trailingPE ?? null,
      forwardPE: quote?.forwardPE ?? detail?.forwardPE ?? null,
      dividendYield: detail?.dividendYield ?? null,
      beta: stats?.beta ?? detail?.beta ?? null,
      volume: quote?.regularMarketVolume ?? detail?.volume ?? null,
      avgVolume: quote?.averageDailyVolume3Month ?? detail?.averageVolume ?? null,
    };

    tickerCache.set(raw, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(`Ticker info fetch failed for ${raw}:`, err);
    res.status(502).json({ error: err.message || 'Failed to fetch ticker info' });
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
