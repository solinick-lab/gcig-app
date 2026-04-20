import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../db.js';
import { verifyJwt, issueJwt, serializeUser } from '../middleware/auth.js';
import { authLimiter, codeLimiter } from '../middleware/rateLimit.js';
import {
  sendVerificationCode,
  sendPasswordResetEmail,
  primaryClientOrigin,
} from '../services/email.js';
import { auditReq } from '../services/audit.js';
import { trackLogin } from '../services/knownLogins.js';
import { signChallenge } from './twoFactor.js';

const router = Router();

const ALLOWED_SIGNUP_DOMAIN = '@gcschool.org';
const CODE_EXPIRY_MINUTES = 10;
const RESET_EXPIRY_MINUTES = 30;

// Lazily built so the server boots even without GOOGLE_CLIENT_ID set
// (Google Sign-In just returns 503 until it's configured).
let googleClient = null;
function getGoogleClient() {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  if (!googleClient) googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  return googleClient;
}
async function verifyGoogleCredential(credential) {
  const client = getGoogleClient();
  if (!client) return { error: 'not_configured' };
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email_verified) return { error: 'email_not_verified' };
    return { payload };
  } catch (err) {
    return { error: 'invalid_token', detail: err.message };
  }
}

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
    user: serializeUser(user),
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
    user: serializeUser(user),
  });
});

// ── Login / logout ───────────────────────────────────────────────────

// Dummy bcrypt hash used to equalize response timing when the email doesn't
// exist. Without this, the "no user" branch returns in ~1ms while the "bad
// password" branch takes ~80ms — an attacker can enumerate valid emails.
// This hash is of a random string nobody knows and will never match.
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.paj6J5gQY5z1KqL7SdHYqNQYxj5e';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const normalized = String(email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized } });

  // If the account is locked, bail without doing bcrypt (but still keep the
  // response consistent with "wrong password").
  if (user && user.lockedUntil && user.lockedUntil > new Date()) {
    await auditReq(req, 'login.locked', 'user', user.id, { email: normalized });
    return res.status(401).json({
      error: 'Account temporarily locked after too many failed attempts. Try again later.',
    });
  }

  // Always run bcrypt — against the real hash if the user exists, against a
  // dummy hash otherwise — so response time is identical either way.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok) {
    if (user) {
      const failed = (user.failedLogins ?? 0) + 1;
      const shouldLock = failed >= MAX_FAILED_LOGINS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: failed,
          lockedUntil: shouldLock
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
            : null,
        },
      });
      if (shouldLock) {
        await auditReq(req, 'login.account_locked', 'user', user.id, {
          email: normalized,
          after_attempts: failed,
        });
      } else {
        await auditReq(req, 'login.failed', 'user', user.id, {
          email: normalized,
          reason: 'bad_password',
          attempt: failed,
        });
      }
    } else {
      await auditReq(req, 'login.failed', 'user', null, {
        email: normalized,
        reason: 'no_user',
      });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Successful login — reset the failure counter and clear any lock.
  if (user.failedLogins > 0 || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null },
    });
  }

  // If the user has 2FA enabled, password is only the first factor —
  // hand back a short-lived challenge token and make them complete 2FA.
  //
  // We never auto-send an email code. The client requests one explicitly via
  // /2fa/resend-login-email (email-only users click "Send me a code"; users
  // with both methods enabled click the Email toggle).
  if (user.twoFactorEnabled) {
    const challengeToken = signChallenge(user.id);
    await auditReq(
      { ...req, user: { id: user.id, name: user.name, role: user.role } },
      'login.password_ok_awaiting_2fa',
      'user',
      user.id,
      {
        totp: user.twoFactorTotpEnabled,
        email: user.twoFactorEmailEnabled,
      }
    );
    return res.json({
      twoFactorRequired: true,
      challengeToken,
      methods: {
        totp: user.twoFactorTotpEnabled,
        email: user.twoFactorEmailEnabled,
      },
    });
  }

  const token = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    'login.success',
    'user',
    user.id
  );
  // Fire-and-forget new-device alert.
  trackLogin(user, req).catch((err) =>
    console.error('trackLogin failed:', err.message)
  );
  res.json({
    token,
    user: serializeUser(user),
  });
});

// ── Sign in with Google ──────────────────────────────────────────────
//
// Three behaviors in one endpoint:
//   1. If a User matches by googleId → sign in.
//   2. If a User matches by email (no googleId yet) → auto-link and sign in.
//   3. Otherwise, if the Google email ends in ALLOWED_SIGNUP_DOMAIN, create
//      a new JuniorAnalyst account. Non-school emails are rejected.
//
// Google sign-in skips our local 2FA — Google enforces its own and the
// credential has already been verified cryptographically.
router.post('/google', authLimiter, async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ error: 'Google credential required' });
  }
  const { payload, error } = await verifyGoogleCredential(credential);
  if (error === 'not_configured') {
    return res.status(503).json({ error: 'Google Sign-In is not configured on the server' });
  }
  if (error === 'email_not_verified') {
    return res.status(403).json({ error: 'Your Google account email is not verified' });
  }
  if (error) {
    await auditReq(req, 'google.verify_failed', 'user', null, { reason: error });
    return res.status(401).json({ error: 'Could not verify Google credentials' });
  }

  const email = String(payload.email).toLowerCase();
  const googleId = payload.sub;
  const name = payload.name || email.split('@')[0];

  let user = await prisma.user.findUnique({ where: { googleId } });

  if (!user) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId },
      });
      await auditReq(
        { ...req, user: { id: user.id, name: user.name, role: user.role } },
        'google.auto_linked',
        'user',
        user.id
      );
    }
  }

  if (!user) {
    if (!email.endsWith(ALLOWED_SIGNUP_DOMAIN)) {
      await auditReq(req, 'google.signup_rejected', 'user', null, {
        email,
        reason: 'domain',
      });
      return res.status(403).json({
        error: `Sign-in is restricted to ${ALLOWED_SIGNUP_DOMAIN} Google accounts.`,
      });
    }
    user = await prisma.user.create({
      data: {
        name,
        email,
        googleId,
        role: 'JuniorAnalyst',
        // passwordHash omitted — Google-only users can set one later via forgot-password
      },
    });
    await auditReq(
      { ...req, user: { id: user.id, name: user.name, role: user.role } },
      'google.signup_completed',
      'user',
      user.id
    );
  }

  // Account lockout from password brute-forcing shouldn't block a verified
  // Google sign-in, but we do clear the counters so the user isn't locked
  // out after they come back to password login.
  if (user.failedLogins > 0 || user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null },
    });
  }

  const token = issueJwt(user);
  await auditReq(
    { ...req, user: { id: user.id, name: user.name, role: user.role } },
    'login.google',
    'user',
    user.id
  );
  trackLogin(user, req).catch((err) =>
    console.error('trackLogin failed:', err.message)
  );
  res.json({ token, user: serializeUser(user) });
});

// Link a Google account to the currently-signed-in user. Requires the Google
// email to match the account email so you can't accidentally (or maliciously)
// link someone else's Google account.
router.post('/google/link', verifyJwt, async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ error: 'Google credential required' });
  }
  const { payload, error } = await verifyGoogleCredential(credential);
  if (error === 'not_configured') {
    return res.status(503).json({ error: 'Google Sign-In is not configured on the server' });
  }
  if (error === 'email_not_verified') {
    return res.status(403).json({ error: 'Your Google account email is not verified' });
  }
  if (error) {
    return res.status(401).json({ error: 'Could not verify Google credentials' });
  }

  const current = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (String(payload.email).toLowerCase() !== current.email.toLowerCase()) {
    return res.status(403).json({
      error: 'Google account email must match your GCIG account email.',
    });
  }

  const claimed = await prisma.user.findFirst({
    where: { googleId: payload.sub, NOT: { id: req.user.id } },
  });
  if (claimed) {
    return res.status(409).json({
      error: 'This Google account is already linked to another member.',
    });
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: { googleId: payload.sub },
  });
  await auditReq(req, 'google.linked', 'user', req.user.id);
  res.json({ ok: true });
});

router.post('/google/unlink', verifyJwt, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.passwordHash) {
    return res.status(400).json({
      error: 'Set a password first (via Forgot Password) so you can still sign in after unlinking.',
    });
  }
  await prisma.user.update({
    where: { id: req.user.id },
    data: { googleId: null },
  });
  await auditReq(req, 'google.unlinked', 'user', req.user.id);
  res.json({ ok: true });
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

  const resetUrl = `${primaryClientOrigin('https://gcig-client.onrender.com')}/reset-password?token=${token}`;

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
      twoFactorTotpEnabled: true,
      twoFactorEmailEnabled: true,
      googleId: true,
      passwordHash: true,
      createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { googleId, passwordHash, ...safe } = user;
  res.json({
    ...safe,
    ...serializeUser(user),
    googleLinked: !!googleId,
    hasPassword: !!passwordHash,
  });
});

router.post('/change-password', verifyJwt, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  // Google-only accounts have no password yet — they can set one without
  // a currentPassword, since Google sign-in already authenticated them.
  if (user.passwordHash) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password required' });
    }
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
  }

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
