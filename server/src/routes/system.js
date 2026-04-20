import { Router } from 'express';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';
import { probeProviders } from '../services/llm.js';

const router = Router();

// Admin-only live health check for the LLM providers that power Week in
// Review, article ranking, per-article summaries, and vote synthesis.
router.get('/llm-status', verifyJwt, requireAdmin, async (_req, res) => {
  const status = await probeProviders();
  res.json(status);
});

export default router;
