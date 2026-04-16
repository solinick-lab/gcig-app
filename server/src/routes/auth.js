import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { sendVerificationCode } from '../services/email.js';

const router = Router();

const ALLOWED_SIGNUP_DOMAIN = '@gcschool.org';
const CODE_EXPIRY_MINUTES = 10;

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

// Step 1: User submits name/email/password → server sends a 6-digit code.
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password required' });
  }
  const normalized = String(email).trim().toLowerCase();
  if (!normalized.endsWith(ALLOWED_SIGNUP_DOMAIN)) {
    return res.status(403).json({
      error: `Self-signup is restricted to ${ALLOWED_SIGNUP_DOMAIN} email addresses.`,
    });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  // Upsert so re-signups before verification just refresh the code.
  await prisma.pendingVerification.upsert({
    where: { email: normalized },
    update: { name: String(name).trim(), passwordHash, code, expiresAt },
    create: {
      name: String(name).trim(),
      email: normalized,
      passwordHash,
      code,
      expiresAt,
    },
  });

  try {
    await sendVerificationCode(normalized, code);
  } catch (err) {
    console.error('Failed to send verification email:', err.message);
    return res.status(500).json({ error: 'Failed to send verification email. Try again.' });
  }

  res.json({ message: 'Verification code sent', email: normalized });
});

// Step 2: User submits the code → server creates the real account + returns JWT.
router.post('/verify', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code required' });
  }
  const normalized = String(email).trim().toLowerCase();
  const pending = await prisma.pendingVerification.findUnique({
    where: { email: normalized },
  });

  if (!pending) {
    return res.status(400).json({ error: 'No pending signup for this email. Start over.' });
  }
  if (pending.code !== String(code).trim()) {
    return res.status(400).json({ error: 'Incorrect code' });
  }
  if (new Date() > pending.expiresAt) {
    return res.status(400).json({ error: 'Code expired. Click "Resend" to get a new one.' });
  }

  // Double-check no one registered while the code was pending.
  const existingUser = await prisma.user.findUnique({ where: { email: normalized } });
  if (existingUser) {
    await prisma.pendingVerification.delete({ where: { email: normalized } });
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const user = await prisma.user.create({
    data: {
      name: pending.name,
      email: normalized,
      passwordHash: pending.passwordHash,
      role: 'JuniorAnalyst',
    },
  });
  await prisma.pendingVerification.delete({ where: { email: normalized } });

  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// Resend a fresh code (same pending signup, new code + expiry).
router.post('/resend-code', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const normalized = String(email).trim().toLowerCase();

  const pending = await prisma.pendingVerification.findUnique({
    where: { email: normalized },
  });
  if (!pending) {
    return res.status(400).json({ error: 'No pending signup for this email. Start over.' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);
  await prisma.pendingVerification.update({
    where: { email: normalized },
    data: { code, expiresAt },
  });

  try {
    await sendVerificationCode(normalized, code);
  } catch (err) {
    console.error('Failed to resend verification email:', err.message);
    return res.status(500).json({ error: 'Failed to send email. Try again.' });
  }

  res.json({ message: 'New code sent', email: normalized });
});

// Fetch invite metadata by token (used by AcceptInvite page to display name/role).
router.get('/invite/:token', async (req, res) => {
  const invite = await prisma.pendingInvite.findUnique({
    where: { token: req.params.token },
  });
  if (!invite) {
    return res.status(404).json({ error: 'Invalid or used invite link' });
  }
  if (new Date() > invite.expiresAt) {
    return res.status(400).json({ error: 'This invite has expired. Ask the President to re-send.' });
  }
  res.json({ email: invite.email, name: invite.name, role: invite.role });
});

// Accept an invite — invitee picks their password, account is created, JWT returned.
router.post('/accept-invite', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const invite = await prisma.pendingInvite.findUnique({ where: { token } });
  if (!invite) {
    return res.status(400).json({ error: 'Invalid or used invite link' });
  }
  if (new Date() > invite.expiresAt) {
    return res.status(400).json({ error: 'This invite has expired. Ask the President to re-send.' });
  }

  // Guard against a real account being created between invite send + accept.
  const existingUser = await prisma.user.findUnique({
    where: { email: invite.email },
  });
  if (existingUser) {
    await prisma.pendingInvite.delete({ where: { id: invite.id } });
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      name: invite.name,
      email: invite.email,
      role: invite.role,
      passwordHash,
    },
  });
  await prisma.pendingInvite.delete({ where: { id: invite.id } });

  const jwtToken = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.status(201).json({
    token: jwtToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

router.get('/me', verifyJwt, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/change-password', verifyJwt, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

export default router;
