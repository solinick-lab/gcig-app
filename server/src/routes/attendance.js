import { Router } from 'express';
import { Parser } from 'json2csv';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);

// Full matrix — President only.
// Only show events from 3 months ago through 2 weeks from now —
// no one needs to mark attendance for meetings months in the future.
router.get('/', requireAdmin, async (_req, res) => {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 3);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);

  const [users, events, records] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.event.findMany({
      where: { date: { gte: from, lte: to } },
      select: { id: true, title: true, date: true },
      orderBy: { date: 'asc' },
    }),
    prisma.attendance.findMany(),
  ]);
  res.json({ users, events, records });
});

// Attendance for a single event — President only.
// Returns all members plus an object { userId: status } for existing records.
router.get('/event/:id', requireAdmin, async (req, res) => {
  const eventId = Number(req.params.id);
  const [event, users, records] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId } }),
    prisma.user.findMany({
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.attendance.findMany({ where: { eventId } }),
  ]);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const byUser = {};
  for (const r of records) byUser[r.userId] = r.status;
  res.json({ event, users, records: byUser });
});

// Current user's own record + percentage
router.get('/mine', async (req, res) => {
  const records = await prisma.attendance.findMany({
    where: { userId: req.user.id },
    include: { event: { select: { id: true, title: true, date: true } } },
    orderBy: { event: { date: 'desc' } },
  });
  const total = records.length;
  const present = records.filter((r) => r.status === 'Present').length;
  const excused = records.filter((r) => r.status === 'Excused').length;
  const pct = total > 0 ? Math.round(((present + excused) / total) * 100) : 0;
  res.json({ records, total, present, excused, percentage: pct });
});

// Upsert one attendance mark
router.post('/', requireAdmin, async (req, res) => {
  const { userId, eventId, status } = req.body || {};
  if (!userId || !eventId || !status) {
    return res.status(400).json({ error: 'userId, eventId, status required' });
  }
  if (!['Present', 'Absent', 'Excused'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const record = await prisma.attendance.upsert({
    where: { userId_eventId: { userId: Number(userId), eventId: Number(eventId) } },
    update: { status },
    create: { userId: Number(userId), eventId: Number(eventId), status },
  });
  res.json(record);
});

router.get('/export.csv', requireAdmin, async (_req, res) => {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - 3);
  const to = new Date(now);
  to.setDate(to.getDate() + 14);

  const [users, events, records] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    }),
    prisma.event.findMany({
      where: { date: { gte: from, lte: to } },
      select: { id: true, title: true, date: true },
      orderBy: { date: 'asc' },
    }),
    prisma.attendance.findMany(),
  ]);

  const recordMap = new Map();
  for (const r of records) {
    recordMap.set(`${r.userId}:${r.eventId}`, r.status);
  }

  const eventColumns = events.map((e) => `${e.title} (${new Date(e.date).toISOString().slice(0, 10)})`);
  const rows = users.map((u) => {
    const row = { Name: u.name, Role: u.role };
    events.forEach((e, i) => {
      row[eventColumns[i]] = recordMap.get(`${u.id}:${e.id}`) || '';
    });
    return row;
  });

  const fields = ['Name', 'Role', ...eventColumns];
  const parser = new Parser({ fields });
  const csv = parser.parse(rows);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="gcig-attendance.csv"');
  res.send(csv);
});

export default router;
