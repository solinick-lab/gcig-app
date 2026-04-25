import prisma from '../db.js';
import { getSheetPortfolio } from './sheetPortfolio.js';
import { generateDayInReview } from './articleSummarizer.js';
import { getNewsForTicker } from './news.js';

// Day-in-Review service. Owns the cache, the ET review-day key, the
// payload builder, and the LLM-call orchestration.
//
// Two consumers:
//   1. The Dashboard route — reads the cached paragraph for the
//      current review-day, or kicks off lazy generation if missing.
//   2. The scheduled cron (node-cron in index.js, plus a manual
//      cron-secret endpoint) — proactively generates the paragraph
//      shortly after 4pm ET so the next dashboard load is instant.
//
// In-memory cache. Single-instance deploys (Render web service) hold
// this fine; multi-instance setups would need DB-backed state.

const dirCache = { reviewDay: null, generatedAt: null, text: null };

// Broad-market / sector ETFs whose "news" is category headlines
// rather than company-specific reporting. Excluded from the news
// pool so the paragraph isn't filled with iPhone / Fed noise.
const BROAD_MARKET_TICKERS = ['VOO', 'VGT', 'QQQ', 'SPY', 'XLK', 'XLV'];

// The YYYY-MM-DD key the DIR is stamped against, based on ET 4pm
// cutoff. Before 4pm ET → yesterday's date (today's close hasn't
// happened); at/after 4pm ET → today's date. Key flips once per
// trading day, at 4pm ET.
export function currentReviewDayET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const hour = Number(get('hour'));
  const etDate = new Date(Date.UTC(y, m - 1, d));
  if (hour < 16) {
    etDate.setUTCDate(etDate.getUTCDate() - 1);
  }
  return etDate.toISOString().slice(0, 10);
}

async function buildPayload() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const lookahead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  let liveTotals = null;
  let heldTickers = null;
  try {
    const sheet = await getSheetPortfolio();
    liveTotals = {
      totalValue: Number((sheet.totals.totalValue || 0).toFixed(0)),
      cashValue: Number((sheet.totals.cashValue || 0).toFixed(0)),
      holdings: sheet.holdings.length,
    };
    heldTickers = sheet.holdings
      .filter((h) => !h.isCash && h.ticker)
      .map((h) => h.ticker.toUpperCase())
      .filter((t) => !BROAD_MARKET_TICKERS.includes(t));
  } catch {
    /* sheet unreachable — fall through with null heldTickers */
  }

  // Prefetch news for held tickers so the ranking table is warm.
  if (heldTickers && heldTickers.length > 0) {
    await Promise.all(
      heldTickers.map((t) =>
        getNewsForTicker(t).catch((err) => {
          console.warn(`DIR: prefetch news for ${t} failed:`, err.message);
        })
      )
    );
  }

  const newsWhere = {
    ...(heldTickers && heldTickers.length > 0
      ? { ticker: { in: heldTickers } }
      : { ticker: { not: null, notIn: BROAD_MARKET_TICKERS } }),
    score: { not: null },
  };

  const [newPitches, upcomingPitches, openVotes, closedVotes, snapshots, topNews] =
    await Promise.all([
      prisma.pitch.findMany({
        where: { date: { gte: dayAgo, lte: now } },
        orderBy: { date: 'desc' },
        select: { ticker: true, pitcherName: true, date: true, votedOutcome: true },
      }),
      prisma.pitch.findMany({
        where: { date: { gt: now, lte: lookahead } },
        orderBy: { date: 'asc' },
        select: { ticker: true, pitcherName: true, date: true },
      }),
      prisma.votingSession.findMany({
        where: { status: 'open' },
        orderBy: { deadline: 'asc' },
        select: { ticker: true, title: true, deadline: true },
      }),
      prisma.votingSession.findMany({
        where: { status: 'closed', closedAt: { gte: dayAgo } },
        orderBy: { closedAt: 'desc' },
        select: { ticker: true, title: true, closedAt: true, synthesis: true },
      }),
      prisma.portfolioSnapshot.findMany({
        where: { date: { gte: threeDaysAgo } },
        orderBy: { date: 'asc' },
        select: { date: true, totalValue: true },
      }),
      prisma.articleRanking.findMany({
        where: newsWhere,
        orderBy: { score: 'desc' },
        take: 5,
        select: { url: true, reason: true, score: true, summary: true, ticker: true },
      }),
    ]);

  let portfolio = null;
  if (snapshots.length >= 2) {
    const end = snapshots[snapshots.length - 1];
    const start = snapshots[snapshots.length - 2];
    const delta = end.totalValue - start.totalValue;
    const pct = start.totalValue > 0 ? (delta / start.totalValue) * 100 : 0;
    portfolio = {
      startValue: Number(start.totalValue.toFixed(0)),
      endValue: Number(end.totalValue.toFixed(0)),
      dollarChange: Number(delta.toFixed(0)),
      percentChange: Number(pct.toFixed(2)),
    };
  }

  return {
    asOf: now.toISOString(),
    portfolio,
    liveTotals,
    heldTickers,
    newPitches: newPitches.slice(0, 6),
    upcomingPitches: upcomingPitches.slice(0, 4),
    openVotes: openVotes.slice(0, 4),
    closedVotes: closedVotes.slice(0, 4),
    topNews,
  };
}

/**
 * Returns the cached DIR for the current review-day, or null if the
 * cache is empty / stale. Never blocks — pure read.
 */
export function getCached() {
  const reviewDay = currentReviewDayET();
  if (dirCache.text && dirCache.reviewDay === reviewDay) {
    return {
      dayInReview: dirCache.text,
      dayInReviewAt: dirCache.generatedAt,
      reviewDay,
    };
  }
  return null;
}

/**
 * Generate (or return cached) the DIR for the current review-day.
 * Slow path — calls the LLM if cache is empty / stale. Used by both
 * the lazy dashboard endpoint and the scheduled cron.
 *
 * @param {object} opts
 * @param {boolean} opts.force - Regenerate even if a cached row exists
 * @returns {object|null} { dayInReview, dayInReviewAt, reviewDay, cached } or null
 */
export async function regenerate({ force = false } = {}) {
  const reviewDay = currentReviewDayET();
  if (!force) {
    const cached = getCached();
    if (cached) return { ...cached, cached: true };
  }
  if (!process.env.LOCAL_LLM_URL) {
    return null;
  }
  try {
    const payload = await buildPayload();
    const text = await generateDayInReview(payload);
    if (!text) return null;
    const stampedAt = new Date().toISOString();
    dirCache.reviewDay = reviewDay;
    dirCache.generatedAt = stampedAt;
    dirCache.text = text;
    return {
      dayInReview: text,
      dayInReviewAt: stampedAt,
      reviewDay,
      cached: false,
    };
  } catch (err) {
    console.warn('day-in-review generation failed:', err.message);
    return null;
  }
}
