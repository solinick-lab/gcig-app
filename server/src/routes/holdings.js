import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

const router = Router();
router.use(verifyJwt);

// Live portfolio pulled from the club's Google Sheet.
// The sheet IS the source of truth — the local Holding table is unused
// in this mode.
router.get('/quotes', async (_req, res) => {
  try {
    const data = await getSheetPortfolio();

    // Write a daily snapshot for today from the sheet total.
    if (data.totals.totalValue > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      await prisma.portfolioSnapshot.upsert({
        where: { date: today },
        update: { totalValue: data.totals.totalValue },
        create: { date: today, totalValue: data.totals.totalValue },
      });
    }

    res.json(data);
  } catch (err) {
    console.error('Sheet portfolio error:', err.message);
    res.status(502).json({ error: err.message });
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
