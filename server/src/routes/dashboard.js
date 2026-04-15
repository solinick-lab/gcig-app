import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

const router = Router();
router.use(verifyJwt);

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

  res.json({
    nextPitch,
    upcomingEvents,
    holdingsCount,
    activity,
  });
});

export default router;
