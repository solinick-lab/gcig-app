import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// List industries with leader + members.
router.get('/', async (_req, res) => {
  const industries = await prisma.industry.findMany({
    orderBy: { name: 'asc' },
    include: {
      leader: { select: { id: true, name: true, role: true } },
      members: {
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      },
    },
  });
  const shaped = industries.map((i) => ({
    id: i.id,
    name: i.name,
    leader: i.leader,
    members: i.members.map((m) => m.user),
  }));
  res.json(shaped);
});

// Create industry (President only).
router.post('/', requireAdmin, async (req, res) => {
  const { name, leaderId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const industry = await prisma.industry.create({
      data: {
        name: String(name).trim(),
        leaderId: leaderId ? Number(leaderId) : null,
      },
    });
    res.status(201).json(industry);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'An industry with that name already exists' });
    }
    throw err;
  }
});

// Update industry name / leader (President only).
router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, leaderId } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (leaderId !== undefined) data.leaderId = leaderId ? Number(leaderId) : null;
  const industry = await prisma.industry.update({ where: { id }, data });
  res.json(industry);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.industry.delete({ where: { id } });
  res.json({ ok: true });
});

// Add a member to an industry (President only).
router.post('/:id/members', requireAdmin, async (req, res) => {
  const industryId = Number(req.params.id);
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await prisma.userIndustry.upsert({
    where: { userId_industryId: { userId: Number(userId), industryId } },
    update: {},
    create: { userId: Number(userId), industryId },
  });
  res.json({ ok: true });
});

// Remove a member from an industry (President only).
router.delete('/:id/members/:userId', requireAdmin, async (req, res) => {
  const industryId = Number(req.params.id);
  const userId = Number(req.params.userId);
  await prisma.userIndustry.delete({
    where: { userId_industryId: { userId, industryId } },
  });
  res.json({ ok: true });
});

export default router;
