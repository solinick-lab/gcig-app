import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { verifyJwt, requireExecutive, ROLE_RANK } from '../middleware/auth.js';
import { sendBroadcastEmail } from '../services/email.js';
import { auditReq } from '../services/audit.js';

// Club-wide messaging for CIO+. Sends a single BCC'd email to a resolved
// recipient list. Audiences:
//   all              every member
//   industry:<id>    members of a specific pod (leader included)
//   role:<Role>      users with exactly that role
//   rank_gte:<Role>  users at that role or above (e.g. rank_gte:PortfolioManager)
//
// Throttled to 5 sends / 10 minutes per user to prevent accidental blast loops.

const router = Router();
router.use(verifyJwt);
router.use(requireExecutive);

const SUBJECT_MAX = 150;
const BODY_MAX = 10_000;

const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `broadcast:${req.user?.id || req.ip}`,
  message: { error: 'Broadcast limit reached. Wait 10 minutes before sending another.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const KNOWN_ROLES = Object.keys(ROLE_RANK);
const ADVISORY_ROLES = new Set(['AdvisoryBoardMember', 'FacultyAdvisory']);

// Advisory members are observers and should not receive club broadcasts
// unless the sender explicitly targets an advisory role. "Only advisory"
// means their primary role is advisory AND every extraRole (if any) is also
// advisory — someone serving on the advisory board who also holds an
// operational extra role (e.g. a dual-hat alum) still receives.
function isAdvisoryOnly(user) {
  if (!ADVISORY_ROLES.has(user.role)) return false;
  const extras = user.extraRoles || [];
  if (extras.length === 0) return true;
  return extras.every((r) => ADVISORY_ROLES.has(r));
}

// Whether the selected audience is an explicit opt-in to emailing advisors.
function audienceTargetsAdvisors(parsed) {
  if (parsed.kind === 'role' && ADVISORY_ROLES.has(parsed.role)) return true;
  // rank_gte uses operational ranks where advisory sits at the floor (rank 1).
  // Targeting rank_gte: an advisory role means "everyone" — not an advisor opt-in.
  return false;
}

function parseAudience(audience) {
  if (!audience || typeof audience !== 'string') return null;
  if (audience === 'all') return { kind: 'all' };
  const m =
    audience.match(/^industry:(\d+)$/) ||
    audience.match(/^role:([A-Za-z]+)$/) ||
    audience.match(/^rank_gte:([A-Za-z]+)$/);
  if (!m) return null;
  if (audience.startsWith('industry:')) return { kind: 'industry', id: Number(m[1]) };
  if (audience.startsWith('role:')) {
    if (!KNOWN_ROLES.includes(m[1])) return null;
    return { kind: 'role', role: m[1] };
  }
  if (audience.startsWith('rank_gte:')) {
    if (!KNOWN_ROLES.includes(m[1])) return null;
    return { kind: 'rank_gte', role: m[1] };
  }
  return null;
}

async function resolveRecipients(parsed) {
  const baseSelect = { id: true, email: true, name: true, role: true, extraRoles: true };
  let users = [];
  if (parsed.kind === 'all') {
    users = await prisma.user.findMany({ select: baseSelect });
  } else if (parsed.kind === 'industry') {
    const rows = await prisma.userIndustry.findMany({
      where: { industryId: parsed.id },
      include: { user: { select: baseSelect } },
    });
    users = rows.map((r) => r.user);
    // Include the pod leader even if not a listed member (Industries page
    // self-heals membership but we double-check for safety).
    const industry = await prisma.industry.findUnique({
      where: { id: parsed.id },
      include: { leader: { select: baseSelect } },
    });
    if (industry?.leader && !users.some((u) => u.id === industry.leader.id)) {
      users.push(industry.leader);
    }
  } else if (parsed.kind === 'role') {
    users = await prisma.user.findMany({
      where: { role: parsed.role },
      select: baseSelect,
    });
  } else if (parsed.kind === 'rank_gte') {
    const minRank = ROLE_RANK[parsed.role];
    const eligible = Object.entries(ROLE_RANK)
      .filter(([, rank]) => rank >= minRank)
      .map(([role]) => role);
    users = await prisma.user.findMany({
      where: { role: { in: eligible } },
      select: baseSelect,
    });
  }
  // Strip advisory-only users unless the audience explicitly asked for advisors.
  if (!audienceTargetsAdvisors(parsed)) {
    users = users.filter((u) => !isAdvisoryOnly(u));
  }
  return users;
}

function audienceLabel(parsed, context = {}) {
  if (parsed.kind === 'all') return 'all members';
  if (parsed.kind === 'industry')
    return context.industryName ? `${context.industryName} pod` : `industry #${parsed.id}`;
  if (parsed.kind === 'role') return `role: ${parsed.role}`;
  if (parsed.kind === 'rank_gte') return `${parsed.role} and above`;
  return '';
}

// Escape HTML before interpolating user-supplied text into the email template.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Preview the recipient count + names for an audience without sending.
router.get('/preview', async (req, res) => {
  const parsed = parseAudience(String(req.query.audience || ''));
  if (!parsed) return res.status(400).json({ error: 'Unknown audience' });
  const users = await resolveRecipients(parsed);
  const deliverable = users.filter((u) => u.email);
  res.json({
    count: deliverable.length,
    skipped: users.length - deliverable.length,
    sample: deliverable.slice(0, 20).map((u) => ({ name: u.name, role: u.role })),
  });
});

// List industries the caller could broadcast to (so the UI can build a picker
// without a second roundtrip).
router.get('/audiences', async (_req, res) => {
  const industries = await prisma.industry.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  res.json({ industries, roles: KNOWN_ROLES });
});

router.post('/send', sendLimiter, async (req, res) => {
  const { audience, subject, body } = req.body || {};
  const parsed = parseAudience(String(audience || ''));
  if (!parsed) return res.status(400).json({ error: 'Unknown audience' });
  const s = String(subject || '').trim();
  const b = String(body || '').trim();
  if (!s) return res.status(400).json({ error: 'Subject is required' });
  if (s.length > SUBJECT_MAX) return res.status(400).json({ error: `Subject max ${SUBJECT_MAX} chars` });
  if (!b) return res.status(400).json({ error: 'Body is required' });
  if (b.length > BODY_MAX) return res.status(400).json({ error: `Body max ${BODY_MAX} chars` });

  const users = await resolveRecipients(parsed);
  const emails = users.map((u) => u.email).filter(Boolean);
  if (emails.length === 0) {
    return res.status(400).json({ error: 'No recipients for that audience' });
  }

  let industryName = null;
  if (parsed.kind === 'industry') {
    const ind = await prisma.industry.findUnique({
      where: { id: parsed.id },
      select: { name: true },
    });
    industryName = ind?.name || null;
  }
  const label = audienceLabel(parsed, { industryName });

  try {
    await sendBroadcastEmail(emails, {
      subject: s,
      bodyHtml: escapeHtml(b),
      senderName: req.user.name,
      audienceLabel: label,
    });
  } catch (err) {
    console.error('broadcast send failed:', err.message);
    return res.status(502).json({ error: 'Failed to send email' });
  }

  await auditReq(req, 'broadcast.sent', 'user', null, {
    audience,
    label,
    subject: s,
    recipientCount: emails.length,
  });

  res.json({ ok: true, recipientCount: emails.length, audience: label });
});

export default router;
