// otplib ships CJS exports that Node ESM can't named-import. Use
// createRequire to pull it in — works regardless of otplib version.
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

const require = createRequire(import.meta.url);
const { authenticator } = require('otplib');

// TOTP config: 6 digits, 30-second step, 1-step skew tolerance (i.e. accept
// the previous/next 30s window) to handle clock drift on phones.
authenticator.options = { digits: 6, step: 30, window: 1 };

const ISSUER = 'The Griffin Fund';

export function generateSecret() {
  return authenticator.generateSecret();
}

export function buildOtpAuthUrl(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

export async function buildQrCodeDataUrl(email, secret) {
  const uri = buildOtpAuthUrl(email, secret);
  return QRCode.toDataURL(uri, { margin: 1, width: 256 });
}

export function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const cleaned = String(token).replace(/\s+/g, '');
  try {
    return authenticator.verify({ token: cleaned, secret });
  } catch {
    return false;
  }
}

// 8-character alphanumeric code (ambiguous chars removed) for email 2FA.
// Format: XXXX-XXXX (displayed dashed, stored without dash).
const EMAIL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateEmailCode() {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += EMAIL_ALPHABET[crypto.randomInt(0, EMAIL_ALPHABET.length)];
  }
  return raw;
}

export function normalizeEmailCode(code) {
  return String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Consume a valid TwoFactorCode matching the given purpose.
// Returns true if consumed (also deletes it), false otherwise.
export async function consumeEmailCode(prisma, userId, code, purpose) {
  const cleaned = normalizeEmailCode(code);
  if (!cleaned) return false;
  const candidates = await prisma.twoFactorCode.findMany({
    where: { userId, purpose, expiresAt: { gte: new Date() } },
  });
  for (const c of candidates) {
    const ok = await bcrypt.compare(cleaned, c.codeHash);
    if (ok) {
      await prisma.twoFactorCode.delete({ where: { id: c.id } });
      return true;
    }
  }
  return false;
}

