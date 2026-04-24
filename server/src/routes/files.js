import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireSuperAdmin } from '../middleware/auth.js';
import {
  getAuthorizeUrl,
  exchangeCodeForTokens,
  uploadFile,
  streamDownload,
  getMetadata,
  getStatus,
  disconnect,
  isConfigured,
} from '../services/oneDriveStorage.js';
import {
  summarizeFile,
  getCachedSummary,
} from '../services/fileSummarizer.js';

// File-storage endpoints. Backed by OneDrive via Microsoft Graph.
// The OAuth callback (`/oauth/callback`) intentionally sits OUTSIDE
// the verifyJwt guard because Microsoft redirects the browser back
// anonymously — we secure it via a CSRF `state` nonce instead.
//
// All other endpoints are JWT-authed so only club members can upload
// or download files.

const router = Router();

// Multer: keep files in memory (no temp-disk writes) and cap per-file
// size at 25 MB. Pitch decks are typically 5-15 MB; 25 MB leaves
// headroom for big image-heavy PDFs without opening a giant file
// surface to abuse.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Per-user upload throttle — 30 uploads / 10 min. Generous for real
// use, enough to catch a runaway client or bulk-dump attempt.
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `file-upload:${req.user?.id || req.ip}`,
  message: { error: 'Upload rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI summary generation is expensive (10-30s of GPU time per request
// on the local LLM). Cap each user at 10 generations per 10 min to
// prevent loops. Reads from the cached summary aren't gated.
const summarizeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `file-summarize:${req.user?.id || req.ip}`,
  message: { error: 'Summarize rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// CSRF state for the OAuth redirect. 5-minute window between /start
// and /callback is plenty and keeps memory use trivial.
const STATE_CACHE = new Map();
const STATE_TTL_MS = 5 * 60 * 1000;
function createState() {
  // Cleanup stale entries on each issue — avoids unbounded growth.
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, at] of STATE_CACHE) {
    if (at < cutoff) STATE_CACHE.delete(k);
  }
  const s = crypto.randomBytes(16).toString('hex');
  STATE_CACHE.set(s, Date.now());
  return s;
}
function consumeState(s) {
  const at = STATE_CACHE.get(s);
  if (!at) return false;
  STATE_CACHE.delete(s);
  return Date.now() - at < STATE_TTL_MS;
}

// Allowed MIME types. Gates which files members can upload — keeps
// things to documents / presentations / images. Adjust here if you
// want to broaden.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.ms-powerpoint', // legacy ppt
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword', // legacy doc
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // legacy xls
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
]);

// ── OAuth flow (super-admin only for /start; callback is public) ──────

// Returns the Microsoft authorize URL instead of 302-redirecting.
// The client JS navigates the browser to it — that way the initial
// request can carry the JWT in its Authorization header (a full-page
// browser navigation can't).
router.get('/oauth/start', verifyJwt, requireSuperAdmin, (_req, res) => {
  if (!isConfigured()) {
    return res.status(500).json({
      error: 'OneDrive is not configured on the server (missing env vars)',
    });
  }
  const state = createState();
  res.json({ url: getAuthorizeUrl(state) });
});

router.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;
  if (error) {
    return res
      .status(400)
      .type('html')
      .send(`<h1>OneDrive auth error</h1><p>${error}: ${errDesc}</p>`);
  }
  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }
  if (!consumeState(String(state))) {
    return res.status(400).send('Invalid or expired state — try again');
  }
  try {
    await exchangeCodeForTokens(String(code));
    const clientOrigin = (process.env.CLIENT_ORIGIN || '').split(',')[0] || '';
    const redirectTo = clientOrigin
      ? `${clientOrigin}/admin?onedrive=connected`
      : '/admin?onedrive=connected';
    res.redirect(redirectTo);
  } catch (err) {
    console.error('OneDrive token exchange failed:', err.message);
    res
      .status(502)
      .type('html')
      .send(`<h1>Token exchange failed</h1><pre>${err.message}</pre>`);
  }
});

// ── Status + admin controls ───────────────────────────────────────────

router.get('/status', verifyJwt, async (_req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disconnect', verifyJwt, requireSuperAdmin, async (_req, res) => {
  try {
    await disconnect();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Upload + download ─────────────────────────────────────────────────

router.post(
  '/upload',
  verifyJwt,
  uploadLimiter,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file field in the request' });
    }
    if (!ALLOWED_MIME.has(req.file.mimetype)) {
      return res
        .status(400)
        .json({ error: `File type ${req.file.mimetype} is not allowed` });
    }
    try {
      const item = await uploadFile({
        buffer: req.file.buffer,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
      // Fire-and-forget background summarization. The upload response
      // shouldn't wait 20+ seconds for the LLM — instead we let the
      // user finish filling the form while the summary gets ready.
      // Failures (unsupported type, image-only deck, LLM down) are
      // logged but never bubble up to the caller. Supported types
      // are filtered here so non-summarizable uploads don't log
      // noisy "unsupported" warnings.
      const canSummarize = /\.(pdf|pptx|docx|txt|md)$/i.test(item.name || '');
      if (canSummarize) {
        setImmediate(() => {
          summarizeFile(item.id).catch((err) => {
            console.warn(
              `auto-summarize(${item.id}) failed: ${err.message}`
            );
          });
        });
      }

      res.json({
        itemId: item.id,
        name: item.name,
        size: item.size,
        webUrl: item.webUrl,
        contentType: req.file.mimetype,
        // Opaque reference clients store in their own tables
        // (pitch.slideshowUrl, report.fileUrl, etc.). The `onedrive:`
        // scheme tells the UI "this is a managed file, download via
        // the /api/files endpoint"; bare http:// URLs keep working as
        // external links. Using a scheme (not a path) keeps item IDs
        // — which contain `!` and other chars — intact without
        // URL-encoding gymnastics.
        ref: `onedrive:${item.id}`,
        // Tells the client whether to expect a summary soon.
        summaryPending: canSummarize,
      });
    } catch (err) {
      if (err.code === 'NOT_AUTHORIZED') {
        return res
          .status(503)
          .json({ error: 'OneDrive is not connected yet. Ask a super admin.' });
      }
      console.error('OneDrive upload failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

// Cached summary — cheap read, no LLM call. Returns 404 if none
// exists yet so the UI can prompt a generation.
router.get('/:itemId/summary', verifyJwt, async (req, res) => {
  try {
    const row = await getCachedSummary(req.params.itemId);
    if (!row) return res.status(404).json({ error: 'No summary yet' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate (or return cached) a summary. Summaries are one-shot —
// once a row exists in FileSummary, this endpoint always returns
// that cached row. Regeneration is intentionally not exposed: the
// file is immutable once uploaded, so the summary should be too.
// Upload another file if you need a different summary.
router.post('/:itemId/summarize', verifyJwt, summarizeLimiter, async (req, res) => {
  try {
    const row = await summarizeFile(req.params.itemId);
    res.json(row);
  } catch (err) {
    if (err.code === 'NOT_AUTHORIZED') {
      return res.status(503).json({ error: 'OneDrive not connected' });
    }
    if (err.code === 'UNSUPPORTED_TYPE') {
      return res.status(415).json({ error: err.message });
    }
    console.error('summarize failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Metadata — filename + size, for rendering file chips in the UI.
router.get('/:itemId/info', verifyJwt, async (req, res) => {
  try {
    const m = await getMetadata(req.params.itemId);
    res.json({ id: m.id, name: m.name, size: m.size, webUrl: m.webUrl });
  } catch (err) {
    if (err.code === 'NOT_AUTHORIZED') {
      return res.status(503).json({ error: 'OneDrive not connected' });
    }
    res.status(502).json({ error: err.message });
  }
});

// Streamed download. Kept last because the wildcard path eats
// anything not matched above.
router.get('/:itemId', verifyJwt, async (req, res) => {
  const { itemId } = req.params;
  if (!itemId) return res.status(400).json({ error: 'Bad item id' });
  try {
    await streamDownload(itemId, res);
  } catch (err) {
    if (err.code === 'NOT_AUTHORIZED') {
      return res.status(503).json({ error: 'OneDrive not connected' });
    }
    console.error('OneDrive download failed:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: err.message });
    }
  }
});

export default router;
