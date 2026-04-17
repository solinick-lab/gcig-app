import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

// TOTP config: 6 digits, 30-second step, 1-step skew tolerance (i.e. accept
// the previous/next 30s window) to handle clock drift on phones.
authenticator.options = { digits: 6, step: 30, window: 1 };

const ISSUER = 'GCIG';

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

// Generates 8 human-readable backup codes in `AAAA-BBBB` format.
// Returns { plain, hashed } — plain is shown to the user ONCE, hashed is stored.
export async function generateBackupCodes(count = 8) {
  const plain = [];
  const hashed = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`; // 4-4 grouping, 8 chars
    const hash = await bcrypt.hash(formatted, 10);
    plain.push(formatted);
    hashed.push(hash);
  }
  return { plain, hashed };
}

// Consumes a backup code if it matches one of the user's unused codes.
// Returns true if consumed, false otherwise.
export async function consumeBackupCode(prisma, userId, code) {
  if (!code) return false;
  const cleaned = String(code).trim().toUpperCase();
  const candidates = await prisma.backupCode.findMany({
    where: { userId, usedAt: null },
  });
  for (const c of candidates) {
    const ok = await bcrypt.compare(cleaned, c.codeHash);
    if (ok) {
      await prisma.backupCode.update({
        where: { id: c.id },
        data: { usedAt: new Date() },
      });
      return true;
    }
  }
  return false;
}
