import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireRole } from '../middleware/auth.js';

const canEditPitches = requireRole('PortfolioManager');

const router = Router();
router.use(verifyJwt);

router.get('/', async (_req, res) => {
  const pitches = await prisma.pitch.findMany({ orderBy: { date: 'desc' } });
  res.json(pitches);
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const pitch = await prisma.pitch.findUnique({ where: { id } });
  if (!pitch) return res.status(404).json({ error: 'Not found' });
  res.json(pitch);
});

router.post('/', canEditPitches, async (req, res) => {
  const { pitcherName, ticker, date, location, slideshowUrl } = req.body;
  if (!pitcherName || !ticker || !date) {
    return res.status(400).json({ error: 'pitcherName, ticker, date required' });
  }
  const pitch = await prisma.pitch.create({
    data: {
      pitcherName,
      ticker: ticker.toUpperCase(),
      date: new Date(date),
      location: location || null,
      slideshowUrl: slideshowUrl || null,
    },
  });
  res.status(201).json(pitch);
});

router.put('/:id', canEditPitches, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.pitch.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { pitcherName, ticker, date, location, slideshowUrl } = req.body;
  const data = {};
  if (pitcherName !== undefined) data.pitcherName = pitcherName;
  if (ticker !== undefined) data.ticker = ticker.toUpperCase();
  if (date !== undefined) data.date = new Date(date);
  if (location !== undefined) data.location = location || null;
  if (slideshowUrl !== undefined) data.slideshowUrl = slideshowUrl || null;

  const pitch = await prisma.pitch.update({ where: { id }, data });
  res.json(pitch);
});

router.delete('/:id', canEditPitches, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.pitch.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await prisma.pitch.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
