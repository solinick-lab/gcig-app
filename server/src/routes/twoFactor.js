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
  generateEmailCode,
  consumeEmailCode,
} from '../services/twoFactor.js';
import { sendTwoFactorCodeEmail } from '../services/email.js';

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

router.post('/setup', verifyJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.twoFactorEnabled) {
      return res
        .status(400)
        .json({ error: '2FA is already enabled. Disable it first to regenerate.' });
    }

    const secret = generateSecret();
    const qrCodeDataUrl = await buildQrCodeDataUrl(user.email, secret);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: secret,
        twoFactorMethod: 'totp',
        twoFactorEnabled: false,
      },
    });

    await auditReq(req, '2fa.setup_started', 'user', user.id, { method: 'totp' });

    res.json({ method: 'totp', secret, qrCodeDataUrl });
  } catch (err) {
    console.error('2FA TOTP setup failed:', err);
    res.status(500).json({ error: `Setup failed: ${err.message}` });
  }
});

router.post('/setup-email', verifyJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.twoFactorEnabled) {
      return res
        .status(400)
        .json({ error: '2FA is already enabled. Disable it first to regenerate.' });
    }

    const code = generateEmailCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.$transaction([
      prisma.twoFactorCode.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorMethod: 'email',
          twoFactorSecret: null,
          twoFactorEnabled: false,
        },
      }),
      prisma.twoFactorCode.create({
        data: { userId: user.id, codeHash, expiresAt, purpose: 'setup' },
      }),
    ]);

    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'setup' });
    await auditReq(req, '2fa.setup_started', 'user', user.id, { method: 'email' });
    res.json({ method: 'email', email: user.email });
  } catch (err) {
    console.error('2FA email setup failed:', err);
    res.status(500).json({ error: `Setup failed: ${err.message}` });
  }
});

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
  await auditReq(req, '2fa.enabled', 'user', user.id, { method: 'totp' });
  res.json({ ok: true });
});

router.post('/verify-setup-email', verifyJwt, codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEnabled) {
    return res.status(400).json({ error: '2FA already enabled' });
  }
  if (user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'No email 2FA setup in progress. Start again.' });
  }
  const ok = await consumeEmailCode(prisma, user.id, code, 'setup');
  if (!ok) {
    return res.status(400).json({ error: 'Incorrect or expired code. Try again or resend.' });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true },
  });
  await auditReq(req, '2fa.enabled', 'user', user.id, { method: 'email' });
  res.json({ ok: true });
});

router.post('/resend-setup-email', verifyJwt, codeLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEnabled || user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'No email 2FA setup in progress' });
  }
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.$transaction([
    prisma.twoFactorCode.deleteMany({ where: { userId: user.id, purpose: 'setup' } }),
    prisma.twoFactorCode.create({
      data: { userId: user.id, codeHash, expiresAt, purpose: 'setup' },
    }),
  ]);
  try {
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'setup' });
  } catch (err) {
    console.error('Resend 2FA setup email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

// ── DISABLE ─────────────────────────────────────────────────────────

// Request a disable code (email method only). TOTP users use their app.
router.post('/send-disable-code', verifyJwt, codeLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorEnabled || user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'Not applicable' });
  }
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.$transaction([
    prisma.twoFactorCode.deleteMany({ where: { userId: user.id, purpose: 'disable' } }),
    prisma.twoFactorCode.create({
      data: { userId: user.id, codeHash, expiresAt, purpose: 'disable' },
    }),
  ]);
  try {
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'login' });
  } catch (err) {
    console.error('Disable code email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

router.post('/disable', verifyJwt, authLimiter, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  const pwOk = await bcrypt.compare(password, user.passwordHash);
  if (!pwOk) return res.status(401).json({ error: 'Incorrect password' });

  if (user.twoFactorEnabled) {
    let codeOk = false;
    if (user.twoFactorMethod === 'totp') {
      codeOk = verifyToken(user.twoFactorSecret, code);
    } else if (user.twoFactorMethod === 'email') {
      codeOk = await consumeEmailCode(prisma, user.id, code, 'disable');
    }
    if (!codeOk) {
      return res.status(400).json({ error: 'Incorrect 2FA code' });
    }
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: null,
        twoFactorMethod: null,
        twoFactorEnabled: false,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.twoFactorCode.deleteMany({ where: { userId: user.id } }),
  ]);
  await auditReq(req, '2fa.disabled', 'user', user.id);

  const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
  const token = issueJwt(refreshed);
  res.json({ ok: true, token });
});

// ── LOGIN (2nd factor) ───────────────────────────────────────────────

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

  let ok = false;
  if (user.twoFactorMethod === 'totp') {
    ok = verifyToken(user.twoFactorSecret, code);
  } else if (user.twoFactorMethod === 'email') {
    ok = await consumeEmailCode(prisma, user.id, code, 'login');
  }

  if (!ok) {
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
    '2fa.login_success',
    'user',
    user.id,
    { method: user.twoFactorMethod }
  );
  res.json({
    token: jwtToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

router.post('/resend-login-email', codeLimiter, async (req, res) => {
  const { challengeToken } = req.body || {};
  const userId = verifyChallenge(challengeToken);
  if (!userId) {
    return res.status(401).json({ error: 'Challenge expired. Sign in again.' });
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorEnabled || user.twoFactorMethod !== 'email') {
    return res.status(400).json({ error: 'Email 2FA is not enabled' });
  }
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.$transaction([
    prisma.twoFactorCode.deleteMany({ where: { userId: user.id, purpose: 'login' } }),
    prisma.twoFactorCode.create({
      data: { userId: user.id, codeHash, expiresAt, purpose: 'login' },
    }),
  ]);
  try {
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'login' });
  } catch (err) {
    console.error('Resend 2FA login email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

// Admin: wipe a user's 2FA (lost-device recovery).
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
        twoFactorMethod: null,
        twoFactorEnabled: false,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.twoFactorCode.deleteMany({ where: { userId: id } }),
  ]);
  await auditReq(req, '2fa.admin_reset', 'user', id);
  res.json({ ok: true });
});

export default router;

export { signChallenge };
