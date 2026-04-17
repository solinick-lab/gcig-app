import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(verifyJwt);
router.use(requireAdmin);

// President-only: tail of the audit log.
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json(logs);
});

export default router;
