import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireRole } from '../middleware/auth.js';
import { sendPitchAssignmentEmail } from '../services/email.js';

const canEditPitches = requireRole('PortfolioManager');

const router = Router();
router.use(verifyJwt);

function pitchInclude() {
  return {
    presenters: {
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    },
  };
}

function shapePitch(p) {
  if (!p) return p;
  const { presenters = [], ...rest } = p;
  return {
    ...rest,
    presenters: presenters.map((pp) => pp.user),
  };
}

router.get('/', async (_req, res) => {
  const pitches = await prisma.pitch.findMany({
    orderBy: { date: 'desc' },
    include: pitchInclude(),
  });
  res.json(pitches.map(shapePitch));
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const pitch = await prisma.pitch.findUnique({ where: { id }, include: pitchInclude() });
  if (!pitch) return res.status(404).json({ error: 'Not found' });
  res.json(shapePitch(pitch));
});

// Pitches I'm presenting that are in the future and I haven't dismissed.
router.get('/mine/upcoming', async (req, res) => {
  const now = new Date();
  const rows = await prisma.pitchPresenter.findMany({
    where: {
      userId: req.user.id,
      seenAt: null,
      pitch: { date: { gte: now } },
    },
    include: {
      pitch: {
        include: {
          presenters: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  });
  res.json(
    rows.map((r) => ({
      pitchId: r.pitchId,
      assignedAt: r.assignedAt,
      pitch: {
        ...r.pitch,
        presenters: r.pitch.presenters.map((pp) => pp.user),
      },
    }))
  );
});

// Mark my assignment as seen (dismisses popup).
router.post('/mine/seen/:pitchId', async (req, res) => {
  const pitchId = Number(req.params.pitchId);
  await prisma.pitchPresenter.updateMany({
    where: { pitchId, userId: req.user.id },
    data: { seenAt: new Date() },
  });
  res.json({ ok: true });
});

async function notifyNewPresenters(pitch, newPresenterIds, clientOrigin) {
  if (newPresenterIds.length === 0) return;
  const [users, allPresenters] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: newPresenterIds } },
      select: { id: true, name: true, email: true },
    }),
    prisma.pitchPresenter.findMany({
      where: { pitchId: pitch.id },
      include: { user: { select: { name: true } } },
    }),
  ]);
  const pitcherDisplay = allPresenters.map((p) => p.user.name).join(', ') || pitch.pitcherName;

  await Promise.all(
    users.map((u) =>
      sendPitchAssignmentEmail(u.email, {
        name: u.name,
        ticker: pitch.ticker,
        pitcherDisplay,
        date: pitch.date,
        location: pitch.location,
        dashboardUrl: clientOrigin,
      }).catch((err) =>
        console.error(`Pitch assignment email to ${u.email} failed:`, err.message)
      )
    )
  );
}

router.post('/', canEditPitches, async (req, res) => {
  const { pitcherName, ticker, date, location, slideshowUrl, presenterIds } = req.body;
  if (!pitcherName || !ticker || !date) {
    return res.status(400).json({ error: 'pitcherName, ticker, date required' });
  }
  const ids = Array.isArray(presenterIds) ? presenterIds.map(Number).filter(Boolean) : [];

  const pitch = await prisma.pitch.create({
    data: {
      pitcherName,
      ticker: ticker.toUpperCase(),
      date: new Date(date),
      location: location || null,
      slideshowUrl: slideshowUrl || null,
      presenters: ids.length
        ? { create: ids.map((userId) => ({ userId })) }
        : undefined,
    },
    include: pitchInclude(),
  });

  // Fire-and-forget email notifications to newly-assigned presenters.
  notifyNewPresenters(
    pitch,
    ids,
    process.env.CLIENT_ORIGIN || 'https://gcig-client.onrender.com'
  ).catch(() => {});

  res.status(201).json(shapePitch(pitch));
});

router.put('/:id', canEditPitches, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.pitch.findUnique({
    where: { id },
    include: { presenters: true },
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { pitcherName, ticker, date, location, slideshowUrl, presenterIds } = req.body;
  const data = {};
  if (pitcherName !== undefined) data.pitcherName = pitcherName;
  if (ticker !== undefined) data.ticker = ticker.toUpperCase();
  if (date !== undefined) data.date = new Date(date);
  if (location !== undefined) data.location = location || null;
  if (slideshowUrl !== undefined) data.slideshowUrl = slideshowUrl || null;

  let newPresenterIds = [];
  if (Array.isArray(presenterIds)) {
    const desired = new Set(presenterIds.map(Number).filter(Boolean));
    const current = new Set(existing.presenters.map((p) => p.userId));
    const toAdd = [...desired].filter((x) => !current.has(x));
    const toRemove = [...current].filter((x) => !desired.has(x));
    newPresenterIds = toAdd;

    await prisma.$transaction([
      ...(toRemove.length
        ? [
            prisma.pitchPresenter.deleteMany({
              where: { pitchId: id, userId: { in: toRemove } },
            }),
          ]
        : []),
      ...toAdd.map((userId) =>
        prisma.pitchPresenter.create({ data: { pitchId: id, userId } })
      ),
    ]);
  }

  const pitch = await prisma.pitch.update({
    where: { id },
    data,
    include: pitchInclude(),
  });

  if (newPresenterIds.length > 0) {
    notifyNewPresenters(
      pitch,
      newPresenterIds,
      process.env.CLIENT_ORIGIN || 'https://gcig-client.onrender.com'
    ).catch(() => {});
  }

  res.json(shapePitch(pitch));
});

router.delete('/:id', canEditPitches, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.pitch.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await prisma.pitch.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
