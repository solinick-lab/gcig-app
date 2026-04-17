import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { verifyJwt, issueJwt } from '../middleware/auth.js';
import { authLimiter, codeLimiter } from '../middleware/rateLimit.js';
import { auditReq } from '../services/audit.js';
import {
  generateSecret,
  buildQrCodeDataUrl,
  verifyToken,
  generateBackupCodes,
  consumeBackupCode,
} from '../services/twoFactor.js';

const router = Router();

// Short-lived "you've passed password, now prove TOTP" challenge token.
const CHALLENGE_TTL = '5m';

function signChallenge(userId) {
  return jwt.sign(
    { id: userId, purpose: '2fa_challenge' },
    process.env.JWT_SECRET,
    { expiresIn: CHALLENGE_TTL }
  );
}

function verifyChallenge(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.purpose !== '2fa_challenge') return null;
    return payload.id;
  } catch {
    return null;
  }
}

// ── SETUP ────────────────────────────────────────────────────────────

// Begin enrollment: generate a secret, store it (disabled until verified),
// return QR + recovery codes. Can be called again to regenerate (wipes prior
// pending/confirmed 2FA).
router.post('/setup', verifyJwt, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEnabled) {
    return res
      .status(400)
      .json({ error: '2FA is already enabled. Disable it first to regenerate.' });
  }

  const secret = generateSecret();
  const { plain, hashed } = await generateBackupCodes(8);
  const qrCodeDataUrl = await buildQrCodeDataUrl(user.email, secret);

  // Clear any previous pending setup + prior codes.
  await prisma.$transaction([
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret, twoFactorEnabled: false },
    }),
    prisma.backupCode.createMany({
      data: hashed.map((codeHash) => ({ userId: user.id, codeHash })),
    }),
  ]);

  await auditReq(req, '2fa.setup_started', 'user', user.id);

  res.json({
    secret, // shown in case QR doesn't scan
    qrCodeDataUrl,
    backupCodes: plain, // shown ONCE
  });
});

// Confirm the enrollment by providing a current TOTP code.
router.post('/verify-setup', verifyJwt, codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorSecret) {
    return res.status(400).json({ error: 'No setup in progress. Start again.' });
  }
  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }
  if (!verifyToken(user.twoFactorSecret, code)) {
    return res.status(400).json({ error: 'Incorrect code. Check your authenticator app.' });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true },
  });
  await auditReq(req, '2fa.enabled', 'user', user.id);
  res.json({ ok: true });
});

// Disable 2FA on your own account — requires password + a current code.
router.post('/disable', verifyJwt, authLimiter, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const pwOk = await bcrypt.compare(password, user.passwordHash);
  if (!pwOk) return res.status(401).json({ error: 'Incorrect password' });

  if (user.twoFactorEnabled) {
    const codeOk =
      verifyToken(user.twoFactorSecret, code) ||
      (await consumeBackupCode(prisma, user.id, code));
    if (!codeOk) {
      return res.status(400).json({ error: 'Incorrect 2FA code' });
    }
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        tokenVersion: { increment: 1 }, // nuke other sessions just in case
      },
    }),
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
  ]);
  await auditReq(req, '2fa.disabled', 'user', user.id);

  // Re-issue token for the caller so they stay logged in on this device.
  const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
  const token = issueJwt(refreshed);
  res.json({ ok: true, token });
});

// Regenerate backup codes (keeps 2FA enabled; invalidates all old codes).
router.post('/regenerate-backup-codes', verifyJwt, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA is not enabled' });
  }
  const { plain, hashed } = await generateBackupCodes(8);
  await prisma.$transaction([
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
    prisma.backupCode.createMany({
      data: hashed.map((codeHash) => ({ userId: user.id, codeHash })),
    }),
  ]);
  await auditReq(req, '2fa.backup_codes_regenerated', 'user', user.id);
  res.json({ backupCodes: plain });
});

// ── LOGIN (2nd factor) ───────────────────────────────────────────────

// Second step of login when 2FA is enabled. Takes the challenge token from
// /auth/login + a TOTP or backup code. On success, issues the real JWT.
router.post('/login', codeLimiter, async (req, res) => {
  const { challengeToken, code } = req.body || {};
  const userId = verifyChallenge(challengeToken);
  if (!userId) {
    return res.status(401).json({ error: 'Challenge expired. Sign in again.' });
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA not enabled on this account' });
  }

  const totpOk = verifyToken(user.twoFactorSecret, code);
  const backupOk = !totpOk && (await consumeBackupCode(prisma, user.id, code));

  if (!totpOk && !backupOk) {
    await auditReq(
      { ...req, user: { id: user.id, name: user.name } },
      '2fa.login_failed',
      'user',
      user.id
    );
    return res.status(400).json({ error: 'Incorrect code' });
  }

  const jwtToken = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    backupOk ? '2fa.login_backup_code' : '2fa.login_success',
    'user',
    user.id
  );
  res.json({
    token: jwtToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// Admin: reset 2FA on another user's account (lost-phone + lost-backup recovery).
// Destructive — deletes their secret and backup codes; they'll log in with
// password alone until they re-enroll.
router.post('/admin-reset/:id', verifyJwt, async (req, res) => {
  if (req.user.role !== 'President') {
    return res.status(403).json({ error: 'President only' });
  }
  const id = Number(req.params.id);
  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.backupCode.deleteMany({ where: { userId: id } }),
  ]);
  await auditReq(req, '2fa.admin_reset', 'user', id);
  res.json({ ok: true });
});

export default router;

// Exported helpers for use by /auth/login
export { signChallenge };
