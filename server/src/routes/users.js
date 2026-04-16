import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import prisma from '../db.js';
import { verifyJwt, requireAdmin } from '../middleware/auth.js';
import { sendInviteEmail } from '../services/email.js';

const router = Router();

const ROLES = [
  'President',
  'CIO',
  'SeniorPortfolioManager',
  'PortfolioManager',
  'SeniorAnalyst',
  'JuniorAnalyst',
];

function generateTempPassword() {
  return crypto.randomBytes(6).toString('base64url') + '!A1';
}

router.use(verifyJwt);

// All authed users can list members (shown on attendance sheet)
router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});

router.post('/', requireAdmin, async (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email, role required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  try {
    const user = await prisma.user.create({
      data: { name, email: email.toLowerCase(), role, passwordHash },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });

    // Send invite email with credentials. Non-fatal — if email fails,
    // the account is still created and the temp password is shown to the President.
    let emailSent = false;
    try {
      const loginUrl = process.env.CLIENT_ORIGIN || 'https://gcig-client.onrender.com';
      const ROLE_LABELS = {
        President: 'President',
        CIO: 'CIO',
        SeniorPortfolioManager: 'Senior Portfolio Manager',
        PortfolioManager: 'Portfolio Manager',
        SeniorAnalyst: 'Senior Analyst',
        JuniorAnalyst: 'Junior Analyst',
      };
      await sendInviteEmail(user.email, {
        name: user.name,
        tempPassword,
        role: ROLE_LABELS[user.role] || user.role,
        loginUrl,
      });
      emailSent = true;
    } catch (emailErr) {
      console.error('Invite email failed:', emailErr.message);
    }

    res.status(201).json({ user, tempPassword, emailSent });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    throw err;
  }
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
