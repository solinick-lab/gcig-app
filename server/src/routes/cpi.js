// CPI forecast routes.
//
// HMAC-authed (no JWT, called from the off-platform Python forecaster):
//   GET  /api/cpi/fred-panel   Pulls the FRED panel server-side (using
//                              FRED_API_KEY which lives only on Render)
//                              and returns aligned monthly history.
//   POST /api/cpi/ingest       Receives the forecast payload and upserts it.
//
// JWT-authed (called by the React app):
//   GET  /api/cpi/forecast     Latest forecast.
//   GET  /api/cpi/history      Recent runs for the prediction-history table.
//
// HMAC scheme (matches Python publish.py / api_client.py):
//   message = `${timestamp}.${path}.${rawBody}`
//   signature = hex( HMAC_SHA256(CPI_INGEST_SECRET, message) )
//   X-CPI-Timestamp: <unix seconds>
//   X-CPI-Signature: <hex digest>
//
// Path is bound into the signature so a captured signature for /ingest
// can't be replayed against /fred-panel within the 5-minute timestamp
// tolerance.

import { Router } from 'express';
import crypto from 'node:crypto';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { getFredPanel } from '../services/fredPanel.js';

const router = Router();

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// HMAC verification middleware. Use on every off-platform route. The
// `pathForSig` is the canonical full path the client signed (e.g.,
// '/api/cpi/ingest') — pass it explicitly rather than reading req.url
// because mounting points can shift the apparent path.
//
// Body bytes for the signature are captured by index.js's express.json
// `verify` hook into req.rawBody. GETs have no body, so we fall back to
// an empty buffer in that case.
function verifyHmac(pathForSig) {
  return (req, res, next) => {
    const secret = process.env.CPI_INGEST_SECRET;
    if (!secret) return res.status(503).json({ error: 'Ingest not configured' });

    const tsHeader = req.headers['x-cpi-timestamp'];
    const sigHeader = req.headers['x-cpi-signature'];
    if (!tsHeader || !sigHeader) {
      return res.status(401).json({ error: 'Missing signature headers' });
    }
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) {
      return res.status(401).json({ error: 'Invalid timestamp' });
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > TIMESTAMP_TOLERANCE_SECONDS) {
      return res.status(401).json({ error: 'Timestamp outside tolerance window' });
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${tsHeader}.${pathForSig}.`)
      .update(req.rawBody || Buffer.alloc(0))
      .digest('hex');
    let sigOk = false;
    try {
      sigOk = crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(String(sigHeader), 'hex')
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) return res.status(401).json({ error: 'Invalid signature' });
    next();
  };
}

// ── Off-platform: FRED proxy ─────────────────────────────────────────
// Python forecaster fetches the macro panel from us instead of FRED
// directly, so FRED_API_KEY never leaves Render.
router.get(
  '/fred-panel',
  verifyHmac('/api/cpi/fred-panel'),
  async (_req, res) => {
    try {
      const panel = await getFredPanel();
      res.json(panel);
    } catch (err) {
      console.error('fred-panel failed:', err.message);
      res.status(503).json({ error: 'FRED fetch failed' });
    }
  }
);

// ── Off-platform: forecast ingest ─────────────────────────────────────
router.post(
  '/ingest',
  verifyHmac('/api/cpi/ingest'),
  async (req, res) => {
    const payload = req.body || {};
    const asOfMonth = payload.asOfMonth;
    const runAtRaw = payload.runAt;
    if (!asOfMonth || !/^\d{4}-\d{2}$/.test(String(asOfMonth))) {
      return res.status(400).json({ error: 'asOfMonth must be YYYY-MM' });
    }
    if (!Array.isArray(payload.forecasts) || payload.forecasts.length === 0) {
      return res.status(400).json({ error: 'forecasts[] missing or empty' });
    }
    let runAt;
    try {
      runAt = runAtRaw ? new Date(runAtRaw) : new Date();
      if (Number.isNaN(runAt.getTime())) throw new Error('bad date');
    } catch {
      return res.status(400).json({ error: 'runAt must be ISO 8601' });
    }

    const row = await prisma.cpiForecast.upsert({
      where: { asOfMonth },
      update: { runAt, payload },
      create: { asOfMonth, runAt, payload },
    });
    return res.json({ ok: true, id: row.id, asOfMonth: row.asOfMonth });
  }
);

// ── In-app reads (members only) ───────────────────────────────────────
router.use(verifyJwt);

router.get('/forecast', async (_req, res) => {
  const latest = await prisma.cpiForecast.findFirst({
    orderBy: { runAt: 'desc' },
  });
  if (!latest) {
    return res.json({ configured: false, latest: null });
  }
  res.json({
    configured: true,
    latest: {
      asOfMonth: latest.asOfMonth,
      runAt: latest.runAt,
      ...latest.payload,
    },
  });
});

router.get('/history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 60);
  const rows = await prisma.cpiForecast.findMany({
    orderBy: { runAt: 'desc' },
    take: limit,
  });
  res.json({
    runs: rows.map((r) => ({
      asOfMonth: r.asOfMonth,
      runAt: r.runAt,
      ...r.payload,
    })),
  });
});

export default router;
