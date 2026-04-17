import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive, ROLE_RANK } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// Ensure the leader is also a member of their own industry.
async function ensureLeaderIsMember(industryId, leaderId) {
  if (!leaderId) return;
  await prisma.userIndustry.upsert({
    where: { userId_industryId: { userId: leaderId, industryId } },
    update: {},
    create: { userId: leaderId, industryId },
  });
}

router.get('/', async (_req, res) => {
  // Self-heal: ensure every leader is also in their industry's member list.
  // One-shot upserts — idempotent, fast on a handful of industries.
  const withLeaders = await prisma.industry.findMany({
    where: { leaderId: { not: null } },
    select: { id: true, leaderId: true },
  });
  await Promise.all(
    withLeaders.map((i) =>
      prisma.userIndustry.upsert({
        where: { userId_industryId: { userId: i.leaderId, industryId: i.id } },
        update: {},
        create: { userId: i.leaderId, industryId: i.id },
      })
    )
  );

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

router.post('/', requireExecutive, async (req, res) => {
  const { name, leaderId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const lId = leaderId ? Number(leaderId) : null;
  try {
    const industry = await prisma.industry.create({
      data: { name: String(name).trim(), leaderId: lId },
    });
    await ensureLeaderIsMember(industry.id, lId);
    res.status(201).json(industry);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'An industry with that name already exists' });
    }
    throw err;
  }
});

router.put('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const { name, leaderId } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = String(name).trim();
  if (leaderId !== undefined) data.leaderId = leaderId ? Number(leaderId) : null;
  const industry = await prisma.industry.update({ where: { id }, data });
  await ensureLeaderIsMember(industry.id, industry.leaderId);
  res.json(industry);
});

router.delete('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.industry.delete({ where: { id } });
  res.json({ ok: true });
});

// Only President can add/remove members. Industry leaders manage roles only.
router.post('/:id/members', requireExecutive, async (req, res) => {
  const industryId = Number(req.params.id);
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const memberId = Number(userId);

  await prisma.userIndustry.upsert({
    where: { userId_industryId: { userId: memberId, industryId } },
    update: {},
    create: { userId: memberId, industryId },
  });

  res.json({ ok: true });
});

router.delete('/:id/members/:userId', requireExecutive, async (req, res) => {
  const industryId = Number(req.params.id);
  const userId = Number(req.params.userId);
  await prisma.userIndustry.delete({
    where: { userId_industryId: { userId, industryId } },
  });
  res.json({ ok: true });
});

export default router;
