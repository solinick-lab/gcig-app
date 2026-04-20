import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { generateWeekInReview } from '../services/articleSummarizer.js';

const router = Router();
router.use(verifyJwt);

// Week-in-Review cache. Regenerating this every dashboard load would burn
// the LLM and the sheet cache too. 3-hour TTL means the narrative updates
// a few times per day, roughly matching how often something meaningful
// actually happens in the club.
const WIR_TTL_MS = 3 * 60 * 60 * 1000;
const wirCache = { at: 0, text: null };

// Broad-market / sector ETFs whose "news" is category headlines rather than
// company-specific reporting. Excluded from Week in Review — they'd otherwise
// fill it with Samsung/iPhone/Bayonetta-style noise via QQQ's tech-category
// feed or random Fed blurbs via VOO's business-category feed. Keep in sync
// with TICKER_TOPIC_OVERRIDES in services/news.js.
const BROAD_MARKET_TICKERS = ['VOO', 'VGT', 'QQQ', 'SPY', 'XLK', 'XLV'];

// Build the structured payload the LLM summarizes. Kept small and factual;
// the prose is the model's job.
async function buildWeekInReviewPayload() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [newPitches, upcomingPitches, openVotes, closedVotes, snapshots, topNews] =
    await Promise.all([
      prisma.pitch.findMany({
        where: { date: { gte: weekAgo, lte: now } },
        orderBy: { date: 'desc' },
        select: { ticker: true, pitcherName: true, date: true, votedOutcome: true },
      }),
      prisma.pitch.findMany({
        where: { date: { gt: now, lte: weekAhead } },
        orderBy: { date: 'asc' },
        select: { ticker: true, pitcherName: true, date: true },
      }),
      prisma.votingSession.findMany({
        where: { status: 'open' },
        orderBy: { deadline: 'asc' },
        select: { ticker: true, title: true, deadline: true },
      }),
      prisma.votingSession.findMany({
        where: { status: 'closed', closedAt: { gte: weekAgo } },
        orderBy: { closedAt: 'desc' },
        select: { ticker: true, title: true, closedAt: true, synthesis: true },
      }),
      prisma.portfolioSnapshot.findMany({
        where: { date: { gte: weekAgo } },
        orderBy: { date: 'asc' },
        select: { date: true, totalValue: true },
      }),
      // Highest-scored news from the past 7 days — but NOT from broad-market
      // ETF lookups (VOO/QQQ/etc.). Those fetches use newsapi's category
      // headlines (general market/tech news) which don't represent news about
      // the club's actual holdings and would muddy the Week in Review.
      //
      // The OR clause preserves rows with a NULL ticker (legacy entries
      // created before the ticker column existed) so pre-migration NVDA /
      // AAPL / etc. rankings still surface.
      prisma.articleRanking.findMany({
        where: {
          score: { gte: 7 },
          createdAt: { gte: weekAgo },
          OR: [
            { ticker: null },
            { ticker: { notIn: BROAD_MARKET_TICKERS } },
          ],
        },
        orderBy: { score: 'desc' },
        take: 6,
        select: { url: true, reason: true, score: true, summary: true, ticker: true },
      }),
    ]);

  // Portfolio delta over the week (best effort from snapshots).
  let portfolio = null;
  if (snapshots.length >= 2) {
    const start = snapshots[0];
    const end = snapshots[snapshots.length - 1];
    const delta = end.totalValue - start.totalValue;
    const pct = start.totalValue > 0 ? (delta / start.totalValue) * 100 : 0;
    portfolio = {
      startValue: Number(start.totalValue.toFixed(0)),
      endValue: Number(end.totalValue.toFixed(0)),
      dollarChange: Number(delta.toFixed(0)),
      percentChange: Number(pct.toFixed(2)),
    };
  }

  // Live totals for context (beta, cash, # of holdings).
  let liveTotals = null;
  try {
    const sheet = await getSheetPortfolio();
    liveTotals = {
      totalValue: Number((sheet.totals.totalValue || 0).toFixed(0)),
      cashValue: Number((sheet.totals.cashValue || 0).toFixed(0)),
      holdings: sheet.holdings.length,
    };
  } catch {
    /* swallow — fall through with null */
  }

  return {
    asOf: now.toISOString(),
    portfolio,
    liveTotals,
    newPitches: newPitches.slice(0, 6),
    upcomingPitches: upcomingPitches.slice(0, 4),
    openVotes: openVotes.slice(0, 4),
    closedVotes: closedVotes.slice(0, 4),
    topNews,
  };
}

router.get('/', async (_req, res) => {
  const now = new Date();
  const [nextPitch, upcomingEvents, recentPitches, recentEvents, recentReports] =
    await Promise.all([
      prisma.pitch.findFirst({
        where: { date: { gte: now } },
        orderBy: { date: 'asc' },
      }),
      prisma.event.findMany({
        where: { date: { gte: now } },
        orderBy: { date: 'asc' },
        take: 3,
      }),
      prisma.pitch.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
      prisma.event.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
      prisma.report.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
    ]);

  // Count holdings from the sheet (source of truth). Fail soft.
  let holdingsCount = 0;
  try {
    const sheet = await getSheetPortfolio();
    holdingsCount = sheet.holdings.length;
  } catch {
    holdingsCount = 0;
  }

  // Merge into a recent activity feed (newest 5)
  const activity = [
    ...recentPitches.map((p) => ({
      type: 'pitch',
      at: p.createdAt,
      label: `${p.pitcherName} pitched ${p.ticker}`,
    })),
    ...recentEvents.map((e) => ({
      type: 'event',
      at: e.createdAt,
      label: `Event scheduled: ${e.title}`,
    })),
    ...recentReports.map((r) => ({
      type: 'report',
      at: r.createdAt,
      label: `${r.author} uploaded "${r.title}"`,
    })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 5);

  // Week in Review: 3-hour cache, best-effort. Never blocks the dashboard
  // response — if the LLM call errors or times out we just return null and
  // the client hides the card.
  let weekInReview = null;
  if (wirCache.text && Date.now() - wirCache.at < WIR_TTL_MS) {
    weekInReview = wirCache.text;
  } else if (process.env.LOCAL_LLM_URL) {
    try {
      const payload = await buildWeekInReviewPayload();
      const text = await generateWeekInReview(payload);
      if (text) {
        wirCache.at = Date.now();
        wirCache.text = text;
        weekInReview = text;
      }
    } catch (err) {
      console.warn('week-in-review generation failed:', err.message);
    }
  }

  res.json({
    nextPitch,
    upcomingEvents,
    holdingsCount,
    activity,
    weekInReview,
  });
});

export default router;
