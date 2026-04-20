import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { generateWeekInReview } from '../services/articleSummarizer.js';
import { getNewsForTicker } from '../services/news.js';

const router = Router();
router.use(verifyJwt);

// Week-in-Review cache. The paragraph covers a rolling 7-day window and the
// club's actual cadence is weekly meetings, so regenerating a couple of
// times per week is plenty. 3.5 days = refresh roughly mid-week and again
// right before the next meeting.
const WIR_TTL_MS = 3.5 * 24 * 60 * 60 * 1000;
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
  // Look 14 days ahead for "upcoming" pitches so the WIR surfaces items
  // scheduled for the next club meeting even if it's ~10 days out.
  const lookahead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Pull the sheet first so we can use the actual holding list to gate
  // which news articles are allowed into the summary. No point surfacing
  // AAPL news when the club doesn't own AAPL.
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
      // Also strip any broad-market ETFs the club happens to hold — those
      // surface category news, not thesis-moving items.
      .filter((t) => !BROAD_MARKET_TICKERS.includes(t));
  } catch {
    /* sheet unreachable — heldTickers stays null and we fall back to the
       broad filter below. */
  }

  // Proactively fetch + rank news for each held ticker. Without this the
  // ArticleRanking table only has entries for tickers users have manually
  // clicked, which means the WIR news section is empty if nobody's been
  // browsing. getNewsForTicker respects its own 15-minute memory cache
  // and the persistent DB ranking cache, so this is cheap on warm runs.
  if (heldTickers && heldTickers.length > 0) {
    await Promise.all(
      heldTickers.map((t) =>
        getNewsForTicker(t).catch((err) => {
          console.warn(`WIR: prefetch news for ${t} failed:`, err.message);
        })
      )
    );
  }

  // News query: restrict to held tickers (or a safe fallback), then take
  // the top-ranked items we've ever classified — no hard date bound, no
  // hard score floor. Rationale: for thinly-covered holdings (MLAB, GD,
  // NOC, etc.) legitimately material news can be weeks old and score
  // 5-6 rather than 8+. Silencing news entirely made the WIR feel empty.
  //
  // The summarizer prompt is calibrated so the LLM de-emphasizes
  // low-score items (anything below 6 gets at most half a clause) and
  // can skip them if the set is thin. Score-ordering is preserved via
  // orderBy so the best-available news always leads.
  const newsWhere = {
    ...(heldTickers && heldTickers.length > 0
      ? { ticker: { in: heldTickers } }
      : { ticker: { not: null, notIn: BROAD_MARKET_TICKERS } }),
    // Include only rows the ranker actually scored — legacy priority-only
    // rows would inject noise we can't rank-order properly.
    score: { not: null },
  };

  const [newPitches, upcomingPitches, openVotes, closedVotes, snapshots, topNews] =
    await Promise.all([
      prisma.pitch.findMany({
        where: { date: { gte: weekAgo, lte: now } },
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
        where: { status: 'closed', closedAt: { gte: weekAgo } },
        orderBy: { closedAt: 'desc' },
        select: { ticker: true, title: true, closedAt: true, synthesis: true },
      }),
      prisma.portfolioSnapshot.findMany({
        where: { date: { gte: weekAgo } },
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

router.get('/', async (_req, res) => {
  const now = new Date();
  const lookaheadDays = 30;
  const lookaheadEnd = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  const [
    nextPitch,
    upcomingEventsRaw,
    upcomingPitchesRaw,
    recentPitches,
    recentEvents,
    recentReports,
  ] = await Promise.all([
    prisma.pitch.findFirst({
      where: { date: { gte: now } },
      orderBy: { date: 'asc' },
    }),
    prisma.event.findMany({
      where: { date: { gte: now, lte: lookaheadEnd } },
      orderBy: { date: 'asc' },
      take: 10,
    }),
    prisma.pitch.findMany({
      where: { date: { gte: now, lte: lookaheadEnd } },
      orderBy: { date: 'asc' },
      take: 10,
      include: { industry: { select: { name: true } } },
    }),
    prisma.pitch.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
    prisma.event.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
    prisma.report.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
  ]);

  // Merge upcoming pitches into the Upcoming Events feed the dashboard
  // renders. Pitches are projected into the same {id, title, date, location}
  // shape the client already expects, with a `kind` discriminator so the
  // UI can style them differently later if it wants.
  const upcomingEvents = [
    ...upcomingEventsRaw.map((e) => ({
      id: `event-${e.id}`,
      kind: 'event',
      title: e.title,
      date: e.date,
      location: e.location || null,
    })),
    ...upcomingPitchesRaw.map((p) => {
      const presenter = p.pitcherName || p.industry?.name || 'TBD';
      return {
        id: `pitch-${p.id}`,
        kind: 'pitch',
        title: `${p.ticker} pitch — ${presenter}`,
        date: p.date,
        location: p.location || null,
      };
    }),
  ]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 5);

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
