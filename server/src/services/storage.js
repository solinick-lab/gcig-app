import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_DIR = path.join(__dirname, '..', '..', 'uploads');

// Decide storage backend based on env. If all R2 vars are set, we upload to
// Cloudflare R2. Otherwise we fall back to local disk (dev / first-time setup).
const R2_ENABLED =
  !!process.env.R2_ACCOUNT_ID &&
  !!process.env.R2_ACCESS_KEY_ID &&
  !!process.env.R2_SECRET_ACCESS_KEY &&
  !!process.env.R2_BUCKET &&
  !!process.env.R2_PUBLIC_URL;

let s3Client = null;
function getS3() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

function makeKey(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const id = crypto.randomBytes(8).toString('hex');
  return `${Date.now()}-${id}${ext}`;
}

/**
 * Upload a file buffer and return a publicly accessible URL.
 *   { url: string, key: string, backend: 'r2' | 'local' }
 */
export async function uploadFile({ buffer, originalName, mimetype }) {
  const key = makeKey(originalName);

  if (R2_ENABLED) {
    await getS3().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype || 'application/octet-stream',
      })
    );
    const base = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
    return { url: `${base}/${key}`, key, backend: 'r2' };
  }

  // Local disk fallback
  await fs.promises.mkdir(LOCAL_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(LOCAL_DIR, key), buffer);
  return { url: `/uploads/${key}`, key, backend: 'local' };
}

/**
 * Best-effort delete of a previously uploaded file. Silently swallows errors
 * so callers don't have to worry about stale files.
 */
export async function deleteFile(urlOrKey) {
  if (!urlOrKey) return;
  const key = urlOrKey.split('/').pop();

  if (R2_ENABLED) {
    try {
      await getS3().send(
        new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })
      );
    } catch (err) {
      console.warn('R2 delete failed:', err.message);
    }
    return;
  }

  try {
    await fs.promises.unlink(path.join(LOCAL_DIR, key));
  } catch {
    /* not a fatal error */
  }
}

export const usingR2 = R2_ENABLED;
