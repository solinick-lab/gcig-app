import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { verifyJwt, issueJwt } from '../middleware/auth.js';
import { authLimiter, codeLimiter } from '../middleware/rateLimit.js';
import { sendVerificationCode, sendPasswordResetEmail } from '../services/email.js';
import { auditReq } from '../services/audit.js';
import { signChallenge } from './twoFactor.js';

const router = Router();

const ALLOWED_SIGNUP_DOMAIN = '@gcschool.org';
const CODE_EXPIRY_MINUTES = 10;
const RESET_EXPIRY_MINUTES = 30;

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Signup (2-step with email verification) ──────────────────────────

router.post('/signup', authLimiter, async (req, res) => {
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

  await auditReq(req, 'signup.code_sent', 'user', null, { email: normalized });
  res.json({ message: 'Verification code sent', email: normalized });
});

router.post('/verify', codeLimiter, async (req, res) => {
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

  const token = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    'signup.completed',
    'user',
    user.id
  );
  res.status(201).json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

router.post('/resend-code', codeLimiter, async (req, res) => {
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

// ── Invite acceptance ────────────────────────────────────────────────

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

router.post('/accept-invite', authLimiter, async (req, res) => {
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

  const jwtToken = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    'invite.accepted',
    'user',
    user.id
  );
  res.status(201).json({
    token: jwtToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// ── Login / logout ───────────────────────────────────────────────────

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    await auditReq(req, 'login.failed', 'user', null, { email, reason: 'no_user' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await auditReq(req, 'login.failed', 'user', user.id, { email, reason: 'bad_password' });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // If the user has 2FA enabled, password is only the first factor —
  // hand back a short-lived challenge token and make them complete 2FA.
  if (user.twoFactorEnabled) {
    const challengeToken = signChallenge(user.id);
    await auditReq(
      { ...req, user: { id: user.id, name: user.name, role: user.role } },
      'login.password_ok_awaiting_2fa',
      'user',
      user.id
    );
    return res.json({ twoFactorRequired: true, challengeToken });
  }

  const token = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    'login.success',
    'user',
    user.id
  );
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

router.post('/logout', async (_req, res) => {
  // Client is responsible for discarding its token.
  res.json({ ok: true });
});

router.post('/logout-everywhere', verifyJwt, async (req, res) => {
  // Bumping tokenVersion invalidates every outstanding JWT for this user.
  await prisma.user.update({
    where: { id: req.user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  await auditReq(req, 'session.logout_everywhere', 'user', req.user.id);
  res.json({ ok: true });
});

// ── Self-service password reset ──────────────────────────────────────

router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const normalized = String(email).trim().toLowerCase();

  // Always return success to avoid disclosing which emails exist.
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) {
    await auditReq(req, 'password_reset.requested', 'user', null, { email: normalized, hit: false });
    return res.json({ ok: true });
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000);
  await prisma.passwordReset.create({
    data: { email: normalized, token, expiresAt },
  });

  const clientOrigin = process.env.CLIENT_ORIGIN || 'https://gcig-client.onrender.com';
  const resetUrl = `${clientOrigin}/reset-password?token=${token}`;

  try {
    await sendPasswordResetEmail(normalized, { name: user.name, resetUrl });
  } catch (err) {
    console.error('Password reset email failed:', err.message);
  }

  await auditReq(req, 'password_reset.requested', 'user', user.id, { email: normalized, hit: true });
  res.json({ ok: true });
});

router.get('/reset/:token', async (req, res) => {
  const row = await prisma.passwordReset.findUnique({
    where: { token: req.params.token },
  });
  if (!row || new Date() > row.expiresAt) {
    return res.status(400).json({ error: 'This reset link is invalid or expired.' });
  }
  res.json({ email: row.email });
});

router.post('/reset/:token', authLimiter, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const row = await prisma.passwordReset.findUnique({
    where: { token: req.params.token },
  });
  if (!row || new Date() > row.expiresAt) {
    return res.status(400).json({ error: 'This reset link is invalid or expired.' });
  }

  const user = await prisma.user.findUnique({ where: { email: row.email } });
  if (!user) {
    await prisma.passwordReset.delete({ where: { id: row.id } });
    return res.status(400).json({ error: 'Account no longer exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // Rotate tokenVersion so any existing sessions (including a stolen one)
  // are invalidated immediately.
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  await prisma.passwordReset.delete({ where: { id: row.id } });

  await auditReq(
    { ...req, user: { id: user.id, name: user.name } },
    'password_reset.completed',
    'user',
    user.id
  );
  res.json({ ok: true });
});

// ── Current user / password change ───────────────────────────────────

router.get('/me', verifyJwt, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
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
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  // Re-issue a fresh token so the user stays logged in on this device.
  const token = issueJwt({ ...user, tokenVersion: (user.tokenVersion ?? 0) + 1 });
  await auditReq(req, 'password_changed', 'user', user.id);
  res.json({ ok: true, token });
});

export default router;
