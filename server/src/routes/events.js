import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

router.get('/', async (_req, res) => {
  const events = await prisma.event.findMany({ orderBy: { date: 'desc' } });
  res.json(events);
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) return res.status(404).json({ error: 'Not found' });
  res.json(event);
});

router.post('/', requireExecutive, async (req, res) => {
  const { title, date, location, description } = req.body || {};
  if (!title || !date) {
    return res.status(400).json({ error: 'title and date required' });
  }
  const event = await prisma.event.create({
    data: {
      title,
      date: new Date(date),
      location: location || null,
      description: description || null,
    },
  });
  res.status(201).json(event);
});

router.put('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.recurring) {
    return res.status(400).json({ error: 'Recurring meetings are managed in code' });
  }
  const { title, date, location, description } = req.body || {};
  const data = {};
  if (title !== undefined) data.title = title;
  if (date !== undefined) data.date = new Date(date);
  if (location !== undefined) data.location = location || null;
  if (description !== undefined) data.description = description || null;
  const event = await prisma.event.update({ where: { id }, data });
  res.json(event);
});

router.delete('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.recurring) {
    return res.status(400).json({ error: 'Recurring meetings are managed in code' });
  }
  await prisma.event.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
