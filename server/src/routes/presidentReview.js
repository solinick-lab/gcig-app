import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireSuperAdmin } from '../middleware/auth.js';
import { auditReq } from '../services/audit.js';

const router = Router();
router.use(verifyJwt);

// Nine statements rated 1-5 (Strongly Disagree -> Strongly Agree). Keyed
// by q1..q9 in the stored JSON so the question wording can evolve without
// touching the schema; the prompts themselves are the source of truth and
// are shipped to the client alongside the form.
export const QUESTIONS = [
  { id: 'q1', text: "Ran meetings effectively and used members' time well" },
  { id: 'q2', text: 'Communicated clearly and on time (emails, announcements, group chats)' },
  { id: 'q3', text: 'Followed through on commitments and deadlines' },
  { id: 'q4', text: 'Was responsive when I had questions or ideas' },
  { id: 'q5', text: 'Made members feel included and heard' },
  { id: 'q6', text: 'Encouraged participation from people across experience levels' },
  { id: 'q7', text: "Set a positive tone for the club's culture" },
  { id: 'q8', text: 'Handled disagreements or pushback constructively' },
  { id: 'q9', text: 'Helped me grow or learn something this year' },
];

const QUESTION_IDS = QUESTIONS.map((q) => q.id);

// Academic-year cycle string ("2025-2026"). The school year flips in
// August — anything before August belongs to the year that just ended.
function currentCycle(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0 = Jan
  const start = m >= 7 ? y : y - 1; // Aug = month 7
  return `${start}-${start + 1}`;
}

// "Presidents" = anyone whose primary role OR extraRoles contains
// President. We surface them sorted by name so the form is deterministic.
async function listPresidents() {
  return prisma.user.findMany({
    where: {
      OR: [
        { role: 'President' },
        { extraRoles: { has: 'President' } },
      ],
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, role: true },
  });
}

function validateRatings(input) {
  if (!input || typeof input !== 'object') return 'Ratings missing';
  const out = {};
  for (const id of QUESTION_IDS) {
    const v = input[id];
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      return `Rating ${id} must be an integer 1-5`;
    }
    out[id] = v;
  }
  return out;
}

// Public-to-members: question list + the president roster. The form's
// initial render uses this single round-trip.
router.get('/config', async (req, res) => {
  try {
    const presidents = await listPresidents();
    return res.json({
      cycle: currentCycle(),
      questions: QUESTIONS,
      presidents,
    });
  } catch (err) {
    console.error('president-review /config failed', err);
    return res.status(500).json({ error: 'Failed to load review config' });
  }
});

// Submissions the caller has already made this cycle, so the form can
// pre-fill and the "Submitted" pill can render per president.
router.get('/mine', async (req, res) => {
  try {
    const rows = await prisma.presidentReview.findMany({
      where: { reviewerId: req.user.id, cycle: currentCycle() },
      select: {
        presidentId: true,
        ratings: true,
        comment: true,
        submittedAt: true,
        updatedAt: true,
      },
    });
    return res.json({ cycle: currentCycle(), submissions: rows });
  } catch (err) {
    console.error('president-review /mine failed', err);
    return res.status(500).json({ error: 'Failed to load your submissions' });
  }
});

// Submit (or resubmit — upsert on the unique key) one president's review.
router.post('/', async (req, res) => {
  const { presidentId, ratings, comment } = req.body || {};
  if (!Number.isInteger(presidentId)) {
    return res.status(400).json({ error: 'presidentId required' });
  }

  const validated = validateRatings(ratings);
  if (typeof validated === 'string') {
    return res.status(400).json({ error: validated });
  }

  // Don't allow reviewing yourself — keeps the aggregate honest.
  if (presidentId === req.user.id) {
    return res.status(400).json({ error: 'You cannot review yourself' });
  }

  // Confirm the target actually holds the President role (primary or extra).
  const target = await prisma.user.findUnique({
    where: { id: presidentId },
    select: { id: true, role: true, extraRoles: true },
  });
  if (!target) return res.status(404).json({ error: 'President not found' });
  const isPresident =
    target.role === 'President' ||
    (Array.isArray(target.extraRoles) && target.extraRoles.includes('President'));
  if (!isPresident) {
    return res.status(400).json({ error: 'Target user is not a President' });
  }

  const trimmedComment =
    typeof comment === 'string' && comment.trim().length > 0
      ? comment.trim().slice(0, 4000)
      : null;

  const cycle = currentCycle();

  try {
    const row = await prisma.presidentReview.upsert({
      where: {
        reviewerId_presidentId_cycle: {
          reviewerId: req.user.id,
          presidentId,
          cycle,
        },
      },
      create: {
        reviewerId: req.user.id,
        presidentId,
        cycle,
        ratings: validated,
        comment: trimmedComment,
      },
      update: {
        ratings: validated,
        comment: trimmedComment,
      },
      select: {
        presidentId: true,
        ratings: true,
        comment: true,
        submittedAt: true,
        updatedAt: true,
      },
    });

    // Audit trail records WHO submitted (so a member can request removal of
    // their own review) but the aggregate endpoint never exposes this.
    auditReq(req, 'president_review.submit', `president=${presidentId} cycle=${cycle}`);

    return res.json({ ok: true, submission: row });
  } catch (err) {
    console.error('president-review submit failed', err);
    return res.status(500).json({ error: 'Failed to save review' });
  }
});

// Aggregated results for all presidents in the current (or requested)
// cycle. Super-admin only — comments are returned without any reviewer
// attribution. Per-question averages + distribution counts.
router.get('/results', requireSuperAdmin, async (req, res) => {
  const cycle = typeof req.query.cycle === 'string' && req.query.cycle
    ? req.query.cycle
    : currentCycle();

  try {
    const presidents = await listPresidents();
    const rows = await prisma.presidentReview.findMany({
      where: { cycle },
      select: { presidentId: true, ratings: true, comment: true, submittedAt: true },
      orderBy: { submittedAt: 'asc' },
    });

    const byPresident = new Map();
    for (const p of presidents) {
      byPresident.set(p.id, {
        president: p,
        count: 0,
        perQuestion: Object.fromEntries(
          QUESTION_IDS.map((id) => [id, { sum: 0, n: 0, dist: [0, 0, 0, 0, 0] }])
        ),
        comments: [],
      });
    }

    for (const r of rows) {
      const bucket = byPresident.get(r.presidentId);
      if (!bucket) continue;
      bucket.count += 1;
      for (const id of QUESTION_IDS) {
        const v = r.ratings?.[id];
        if (Number.isInteger(v) && v >= 1 && v <= 5) {
          bucket.perQuestion[id].sum += v;
          bucket.perQuestion[id].n += 1;
          bucket.perQuestion[id].dist[v - 1] += 1;
        }
      }
      if (r.comment) {
        bucket.comments.push({ comment: r.comment, submittedAt: r.submittedAt });
      }
    }

    const out = [];
    for (const bucket of byPresident.values()) {
      const perQuestion = {};
      let totalSum = 0;
      let totalN = 0;
      for (const id of QUESTION_IDS) {
        const q = bucket.perQuestion[id];
        const avg = q.n > 0 ? q.sum / q.n : null;
        perQuestion[id] = { avg, n: q.n, dist: q.dist };
        totalSum += q.sum;
        totalN += q.n;
      }
      out.push({
        president: bucket.president,
        responseCount: bucket.count,
        overallAvg: totalN > 0 ? totalSum / totalN : null,
        perQuestion,
        comments: bucket.comments,
      });
    }

    return res.json({
      cycle,
      questions: QUESTIONS,
      results: out,
    });
  } catch (err) {
    console.error('president-review /results failed', err);
    return res.status(500).json({ error: 'Failed to load results' });
  }
});

export default router;
