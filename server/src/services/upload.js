import multer from 'multer';
import path from 'node:path';

const ALLOWED_EXT = new Set(['.pdf', '.pptx', '.ppt']);

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXT.has(ext)) return cb(null, true);
  cb(new Error('Only .pdf, .ppt, and .pptx files are allowed'));
}

// In-memory storage so we can stream the buffer into whichever backend
// storage.js is configured for (R2 in prod, disk in dev).
export const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});
