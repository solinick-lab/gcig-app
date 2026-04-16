import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import prisma from '../db.js';
import { verifyJwt, requireAdmin, ROLE_RANK } from '../middleware/auth.js';
import { sendInviteEmail } from '../services/email.js';

const router = Router();

const ROLES = [
  'President',
  'CIO',
  'SeniorPortfolioManager',
  'PortfolioManager',
  'SeniorAnalyst',
  'Analyst',
  'JuniorAnalyst',
  'AdvisoryBoardMember',
  'FacultyAdvisory',
];

function generateTempPassword() {
  return crypto.randomBytes(6).toString('base64url') + '!A1';
}

router.use(verifyJwt);

// All authed users can list members (shown on attendance sheet)
router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      extraRoles: true,
      createdAt: true,
      industries: {
        include: { industry: { select: { id: true, name: true } } },
      },
    },
    orderBy: { name: 'asc' },
  });
  // Flatten industries for easier client use.
  const shaped = users.map((u) => ({
    ...u,
    industries: u.industries.map((ui) => ui.industry),
  }));
  res.json(shaped);
});

// Invite a new member. No account is created yet — just a PendingInvite record
// and an email with a one-time link where they set their own password.
router.post('/', requireAdmin, async (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email, role required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const normalized = String(email).trim().toLowerCase();

  // Reject if a real account already exists for this email.
  const existingUser = await prisma.user.findUnique({ where: { email: normalized } });
  if (existingUser) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Upsert so re-inviting the same email just generates a fresh token.
  await prisma.pendingInvite.upsert({
    where: { email: normalized },
    update: { name: String(name).trim(), role, token, expiresAt },
    create: {
      email: normalized,
      name: String(name).trim(),
      role,
      token,
      expiresAt,
    },
  });

  const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
  const inviteUrl = `${clientOrigin}/accept-invite?token=${token}`;

  const ROLE_LABELS = {
    President: 'President',
    CIO: 'CIO',
    SeniorPortfolioManager: 'Senior Portfolio Manager',
    PortfolioManager: 'Portfolio Manager',
    SeniorAnalyst: 'Senior Analyst',
    Analyst: 'Analyst',
    JuniorAnalyst: 'Junior Analyst',
    AdvisoryBoardMember: 'Advisory Board Member',
    FacultyAdvisory: 'Faculty Advisor',
  };

  let emailSent = false;
  try {
    await sendInviteEmail(normalized, {
      name: String(name).trim(),
      role: ROLE_LABELS[role] || role,
      inviteUrl,
    });
    emailSent = true;
  } catch (emailErr) {
    console.error('Invite email failed:', emailErr.message);
  }

  res.status(201).json({
    email: normalized,
    name: String(name).trim(),
    role,
    inviteUrl,
    emailSent,
  });
});

router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, role } = req.body || {};
  if (role && !ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email: email.toLowerCase() } : {}),
      ...(role !== undefined ? { role } : {}),
    },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  res.json(user);
});

// Change a user's primary role.
//   - President: can change anyone's role to anything.
//   - Industry leader: can change roles of members in industries they lead,
//     but only if target's current rank AND new rank are both strictly below
//     the leader's own rank.
//   - Everyone else: forbidden.
router.put('/:id/role', async (req, res) => {
  const targetId = Number(req.params.id);
  const { role: newRole } = req.body || {};
  if (!newRole || !ROLES.includes(newRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return res.status(404).json({ error: 'User not found' });

  // President: no restrictions.
  if (req.user.role === 'President') {
    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { role: newRole },
      select: { id: true, name: true, email: true, role: true, extraRoles: true },
    });
    return res.json(updated);
  }

  // Must lead an industry that contains the target.
  const sharedIndustry = await prisma.industry.findFirst({
    where: {
      leaderId: req.user.id,
      members: { some: { userId: targetId } },
    },
  });
  if (!sharedIndustry) {
    return res.status(403).json({
      error: "You can only change roles of members in industries you lead",
    });
  }

  const callerRank = ROLE_RANK[req.user.role] ?? 0;
  const currentRank = ROLE_RANK[target.role] ?? 0;
  const newRank = ROLE_RANK[newRole] ?? 0;
  if (currentRank >= callerRank) {
    return res.status(403).json({ error: 'Target is at or above your rank' });
  }
  if (newRank >= callerRank) {
    return res.status(403).json({ error: "You can't assign a role at or above your own rank" });
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: { role: newRole },
    select: { id: true, name: true, email: true, role: true, extraRoles: true },
  });
  res.json(updated);
});

// Set the entire extra roles array (replaces existing).
router.put('/:id/extra-roles', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { extraRoles } = req.body || {};
  if (!Array.isArray(extraRoles)) {
    return res.status(400).json({ error: 'extraRoles must be an array' });
  }
  const invalid = extraRoles.find((r) => !ROLES.includes(r));
  if (invalid) return res.status(400).json({ error: `Invalid role: ${invalid}` });

  const user = await prisma.user.update({
    where: { id },
    data: { extraRoles },
    select: { id: true, name: true, email: true, role: true, extraRoles: true },
  });
  res.json(user);
});

router.post('/:id/reset-password', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  await prisma.user.update({ where: { id }, data: { passwordHash } });
  res.json({ tempPassword });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await prisma.user.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
