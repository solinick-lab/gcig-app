import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { generateDayInReview } from '../services/articleSummarizer.js';
import { getNewsForTicker } from '../services/news.js';
import { eventAudienceWhere } from './events.js';

const router = Router();
router.use(verifyJwt);

// Day-in-Review cache. The paragraph represents "as of 4:00 PM ET market
// close", so it's keyed by the ET review-day. We regenerate at most once
// per ET trading day — the first dashboard load after 4pm ET triggers a
// fresh paragraph; everyone else serves the cached one until the next
// 4pm crossover. First deploy with an empty cache generates immediately
// so the card lights up on day one.
const dirCache = { reviewDay: null, generatedAt: null, text: null };

// The YYYY-MM-DD key the DIR is stamped against, based on ET 4pm cutoff.
//   - Before 4pm ET: return yesterday's date (today's close hasn't happened)
//   - At/after 4pm ET: return today's date
// So the key only flips once per day, at 4pm ET.
function currentReviewDayET() {
  const now = new Date();
  // Pull the hour + date components in America/New_York. Intl gives us
  // parts that respect DST automatically — simpler than subtracting a
  // fixed 4 or 5 hours.
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
  // ET date as UTC midnight for easy arithmetic.
  const etDate = new Date(Date.UTC(y, m - 1, d));
  if (hour < 16) {
    etDate.setUTCDate(etDate.getUTCDate() - 1);
  }
  return etDate.toISOString().slice(0, 10);
}

// Broad-market / sector ETFs whose "news" is category headlines rather than
// company-specific reporting. Excluded from Day in Review — they'd otherwise
// fill it with Samsung/iPhone-style noise via QQQ's tech-category feed or
// random Fed blurbs via VOO's business-category feed. Keep in sync with
// TICKER_TOPIC_OVERRIDES in services/news.js.
const BROAD_MARKET_TICKERS = ['VOO', 'VGT', 'QQQ', 'SPY', 'XLK', 'XLV'];

// Build the structured payload the LLM summarizes. Kept small and factual;
// the prose is the model's job. Window is roughly 24 hours back — today's
// trading session — so the paragraph reads as a daily close recap.
async function buildDayInReviewPayload() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Portfolio comparison needs a bit more history (last ~3 days of
  // snapshots) so we can find the most recent prior-session snapshot
  // even after a weekend.
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  // Look 14 days ahead for "upcoming" pitches so the DIR surfaces items
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

  // Day-over-day portfolio delta: latest snapshot vs the most recent prior
  // snapshot. If we only have one snapshot (or none), return null — the
  // prompt will omit portfolio commentary.
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

router.get('/', async (req, res) => {
  const now = new Date();
  const lookaheadDays = 30;
  const lookaheadEnd = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  // Advisory Board events are hidden from members without visibility
  // (applied to upcoming + recent events queries below). Helper checks
  // primary role, extraRoles, and leadership exemptions.
  const audienceFilter = eventAudienceWhere(req.user);
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
      where: { date: { gte: now, lte: lookaheadEnd }, ...audienceFilter },
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
    prisma.event.findMany({
      where: audienceFilter,
      orderBy: { createdAt: 'desc' },
      take: 3,
    }),
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

  // Day in Review used to be inlined here, awaiting the LLM call —
  // which made every cache miss block the whole dashboard for 10-30s.
  // It now has its own endpoint (GET /day-in-review) that the client
  // fires in parallel; this handler returns instantly with whatever
  // is already cached. If the cached DIR is for the current review-day
  // we return it; otherwise the client gets null and its own request
  // triggers the generation.
  const reviewDay = currentReviewDayET();
  const haveCached = dirCache.text && dirCache.reviewDay === reviewDay;
  const dayInReview = haveCached ? dirCache.text : null;
  const dayInReviewAt = haveCached ? dirCache.generatedAt : null;

  res.json({
    nextPitch,
    upcomingEvents,
    holdingsCount,
    activity,
    dayInReview,
    dayInReviewAt,
  });
});

// Day in Review on a separate endpoint so its slow LLM call never
// blocks the rest of the dashboard. The client fetches both in
// parallel and lets the DIR card render whenever it's ready.
//
// On cache miss this DOES wait for the LLM (10-30s), but only this
// one card is suspended in the UI — everything else has already
// rendered.
router.get('/day-in-review', async (_req, res) => {
  const reviewDay = currentReviewDayET();
  const haveCached = dirCache.text && dirCache.reviewDay === reviewDay;
  if (haveCached) {
    return res.json({
      dayInReview: dirCache.text,
      dayInReviewAt: dirCache.generatedAt,
      cached: true,
    });
  }
  if (!process.env.LOCAL_LLM_URL) {
    return res.json({ dayInReview: null, dayInReviewAt: null, cached: false });
  }
  try {
    const payload = await buildDayInReviewPayload();
    const text = await generateDayInReview(payload);
    if (!text) {
      return res.json({ dayInReview: null, dayInReviewAt: null, cached: false });
    }
    const stampedAt = new Date().toISOString();
    dirCache.reviewDay = reviewDay;
    dirCache.generatedAt = stampedAt;
    dirCache.text = text;
    res.json({ dayInReview: text, dayInReviewAt: stampedAt, cached: false });
  } catch (err) {
    console.warn('day-in-review generation failed:', err.message);
    res.json({ dayInReview: null, dayInReviewAt: null, cached: false });
  }
});

export default router;
