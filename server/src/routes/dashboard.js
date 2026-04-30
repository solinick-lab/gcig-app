import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
import { eventAudienceWhere } from './events.js';
import { getCached, regenerate } from '../services/dayInReview.js';
import { getMacroSnapshot } from '../services/fredMacro.js';

const router = Router();

// ── Cron-authed endpoints (no JWT needed) ─────────────────────────────
// Mounted before `router.use(verifyJwt)` so external schedulers can
// hit these without a user session. Same shared-secret pattern as
// /holdings/snapshot/daily.

// Forces a fresh DIR generation. Used by the in-process node-cron
// schedule that fires daily at 4:05 PM ET, AND available as a manual
// trigger if you ever want to re-warm the cache from outside.
router.post('/day-in-review/cron-generate', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  const force = req.body?.force === true || req.query.force === '1';
  try {
    const result = await regenerate({ force });
    if (!result) {
      return res.status(503).json({ error: 'Generation returned no content' });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('cron DIR generate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.use(verifyJwt);

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

  // Day in Review: instant cache lookup. The /day-in-review endpoint
  // owns the slow LLM path and is fired in parallel by the client.
  const cached = getCached();
  res.json({
    nextPitch,
    upcomingEvents,
    holdingsCount,
    activity,
    dayInReview: cached?.dayInReview || null,
    dayInReviewAt: cached?.dayInReviewAt || null,
  });
});

// Day in Review on a separate endpoint so its slow LLM call never
// blocks the rest of the dashboard. The client fetches both in
// parallel and lets the DIR card render whenever it's ready.
//
// On a cache hit returns instantly. On a cache miss, calls the LLM
// (10-30s) — but the dashboard page itself has already rendered.
// In normal operation the cache is warmed by the 4:05 PM ET cron so
// this lazy path is rarely the slow one.
router.get('/day-in-review', async (_req, res) => {
  const result = await regenerate();
  if (!result) {
    return res.json({ dayInReview: null, dayInReviewAt: null, cached: false });
  }
  res.json(result);
});

// Macro snapshot from FRED — 1h cache server-side. Returns
// { configured: false } when FRED_API_KEY isn't set so the client
// can hide the card cleanly without throwing errors.
router.get('/macro', async (_req, res) => {
  try {
    res.json(await getMacroSnapshot());
  } catch (err) {
    console.error('macro fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch macro snapshot' });
  }
});

export default router;
