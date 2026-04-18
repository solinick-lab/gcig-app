import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { verifyJwt, issueJwt, serializeUser } from '../middleware/auth.js';
import { authLimiter, codeLimiter } from '../middleware/rateLimit.js';
import { auditReq } from '../services/audit.js';
import { trackLogin } from '../services/knownLogins.js';
import {
  generateSecret,
  buildQrCodeDataUrl,
  verifyToken,
  generateEmailCode,
  consumeEmailCode,
} from '../services/twoFactor.js';
import { sendTwoFactorCodeEmail } from '../services/email.js';

const router = Router();

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

async function issueEmailCode(userId, purpose) {
  const code = generateEmailCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.$transaction([
    prisma.twoFactorCode.deleteMany({ where: { userId, purpose } }),
    prisma.twoFactorCode.create({ data: { userId, codeHash, expiresAt, purpose } }),
  ]);
  return code;
}

// ── TOTP enrollment ─────────────────────────────────────────────────

router.post('/setup', verifyJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.twoFactorTotpEnabled) {
      return res.status(400).json({ error: 'Authenticator app is already set up.' });
    }

    const secret = generateSecret();
    const qrCodeDataUrl = await buildQrCodeDataUrl(user.email, secret);

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorSecret: secret },
    });

    await auditReq(req, '2fa.setup_started', 'user', user.id, { method: 'totp' });
    res.json({ secret, qrCodeDataUrl });
  } catch (err) {
    console.error('2FA TOTP setup failed:', err);
    res.status(500).json({ error: `Setup failed: ${err.message}` });
  }
});

router.post('/verify-setup', verifyJwt, codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorSecret || user.twoFactorTotpEnabled) {
    return res.status(400).json({ error: 'No TOTP setup in progress. Start again.' });
  }
  if (!verifyToken(user.twoFactorSecret, code)) {
    return res.status(400).json({ error: 'Incorrect code. Check your authenticator app.' });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorTotpEnabled: true, twoFactorEnabled: true },
  });
  await auditReq(req, '2fa.enabled', 'user', user.id, { method: 'totp' });
  res.json({ ok: true });
});

router.post('/disable-totp', verifyJwt, authLimiter, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  if (user.twoFactorTotpEnabled && !verifyToken(user.twoFactorSecret, code)) {
    return res.status(400).json({ error: 'Incorrect authenticator code' });
  }
  const stillAnyEnabled = user.twoFactorEmailEnabled;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorSecret: null,
      twoFactorTotpEnabled: false,
      twoFactorEnabled: stillAnyEnabled,
      tokenVersion: { increment: 1 },
    },
  });
  await auditReq(req, '2fa.disabled', 'user', user.id, { method: 'totp' });
  const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
  const token = issueJwt(refreshed);
  res.json({ ok: true, token });
});

// ── Email enrollment ────────────────────────────────────────────────

router.post('/setup-email', verifyJwt, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.twoFactorEmailEnabled) {
      return res.status(400).json({ error: 'Email 2FA is already on.' });
    }
    const code = await issueEmailCode(user.id, 'setup');
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'setup' });
    await auditReq(req, '2fa.setup_started', 'user', user.id, { method: 'email' });
    res.json({ email: user.email });
  } catch (err) {
    console.error('2FA email setup failed:', err);
    res.status(500).json({ error: `Setup failed: ${err.message}` });
  }
});

router.post('/verify-setup-email', verifyJwt, codeLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEmailEnabled) {
    return res.status(400).json({ error: 'Email 2FA already on.' });
  }
  const ok = await consumeEmailCode(prisma, user.id, code, 'setup');
  if (!ok) {
    return res.status(400).json({ error: 'Incorrect or expired code.' });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEmailEnabled: true, twoFactorEnabled: true },
  });
  await auditReq(req, '2fa.enabled', 'user', user.id, { method: 'email' });
  res.json({ ok: true });
});

router.post('/resend-setup-email', verifyJwt, codeLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user.twoFactorEmailEnabled) {
    return res.status(400).json({ error: 'Email 2FA already on' });
  }
  try {
    const code = await issueEmailCode(user.id, 'setup');
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'setup' });
  } catch (err) {
    console.error('Resend 2FA setup email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

router.post('/send-disable-email-code', verifyJwt, codeLimiter, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorEmailEnabled) {
    return res.status(400).json({ error: 'Email 2FA is not on' });
  }
  try {
    const code = await issueEmailCode(user.id, 'disable');
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'login' });
  } catch (err) {
    console.error('Disable code email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

router.post('/disable-email', verifyJwt, authLimiter, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  if (user.twoFactorEmailEnabled) {
    const ok = await consumeEmailCode(prisma, user.id, code, 'disable');
    if (!ok) return res.status(400).json({ error: 'Incorrect or expired email code' });
  }
  const stillAnyEnabled = user.twoFactorTotpEnabled;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      twoFactorEmailEnabled: false,
      twoFactorEnabled: stillAnyEnabled,
      tokenVersion: { increment: 1 },
    },
  });
  await auditReq(req, '2fa.disabled', 'user', user.id, { method: 'email' });
  const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
  const token = issueJwt(refreshed);
  res.json({ ok: true, token });
});

// ── Login (second factor) ───────────────────────────────────────────

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

  // Accept a code from either method the user has enabled.
  let acceptedVia = null;
  if (user.twoFactorTotpEnabled && verifyToken(user.twoFactorSecret, code)) {
    acceptedVia = 'totp';
  } else if (
    user.twoFactorEmailEnabled &&
    (await consumeEmailCode(prisma, user.id, code, 'login'))
  ) {
    acceptedVia = 'email';
  }

  if (!acceptedVia) {
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
    { via: acceptedVia }
  );
  trackLogin(user, req).catch((err) =>
    console.error('trackLogin failed:', err.message)
  );
  res.json({
    token: jwtToken,
    user: serializeUser(user),
  });
});

router.post('/resend-login-email', codeLimiter, async (req, res) => {
  const { challengeToken } = req.body || {};
  const userId = verifyChallenge(challengeToken);
  if (!userId) {
    return res.status(401).json({ error: 'Challenge expired. Sign in again.' });
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorEmailEnabled) {
    return res.status(400).json({ error: 'Email 2FA is not enabled' });
  }
  try {
    const code = await issueEmailCode(user.id, 'login');
    await sendTwoFactorCodeEmail(user.email, { name: user.name, code, purpose: 'login' });
  } catch (err) {
    console.error('Resend 2FA login email failed:', err.message);
    return res.status(500).json({ error: 'Failed to send email.' });
  }
  res.json({ ok: true });
});

// Admin: wipe a user's 2FA (lost-device recovery).
router.post('/admin-reset/:id', verifyJwt, async (req, res) => {
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin only' });
  }
  const id = Number(req.params.id);
  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: {
        twoFactorSecret: null,
        twoFactorTotpEnabled: false,
        twoFactorEmailEnabled: false,
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
export { signChallenge, issueEmailCode };
