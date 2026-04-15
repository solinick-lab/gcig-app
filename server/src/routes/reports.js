import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';
import { upload } from '../services/upload.js';
import { uploadFile, deleteFile } from '../services/storage.js';

const router = Router();
router.use(verifyJwt);

router.get('/', async (_req, res) => {
  const reports = await prisma.report.findMany({ orderBy: { date: 'desc' } });
  res.json(reports);
});

router.post('/', requireAdmin, upload.single('file'), async (req, res) => {
  const { title, author, ticker, date, description } = req.body;
  if (!title || !author || !date || !req.file) {
    return res.status(400).json({ error: 'title, author, date, and file required' });
  }

  const { url } = await uploadFile({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
  });

  const report = await prisma.report.create({
    data: {
      title,
      author,
      ticker: ticker ? ticker.toUpperCase() : null,
      date: new Date(date),
      description: description || null,
      fileUrl: url,
    },
  });
  res.status(201).json(report);
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.report.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await deleteFile(existing.fileUrl);
  await prisma.report.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
