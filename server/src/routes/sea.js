// Tanker Tracker routes.
//
// HMAC-authed (called from the Windows-side sea_tracker publisher):
//   POST /api/sea/signals    Bulk-upsert SeaSignal rows.
//   POST /api/sea/snapshot   Upsert the singleton SeaSnapshot row.
//
// JWT-authed (called by the React app):
//   GET  /api/sea/latest     The current snapshot payload + meta.
//   GET  /api/sea/history    Per-signal day-by-day series for sparklines.
//
// HMAC scheme matches sea_tracker/api_client.py:
//   message = `${timestamp}.${path}.${rawBody}`
//   signature = hex( HMAC_SHA256(SEA_INGEST_SECRET, message) )
//   X-Sea-Timestamp: <unix seconds>
//   X-Sea-Signature: <hex digest>
//
// Path is bound into the signature so a captured /signals signature
// cannot be replayed against /snapshot inside the 5-min tolerance.

import { Router } from 'express';
import crypto from 'node:crypto';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';

const router = Router();

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function verifyHmac(pathForSig) {
  return (req, res, next) => {
    const secret = process.env.SEA_INGEST_SECRET;
    if (!secret) return res.status(503).json({ error: 'Sea ingest not configured' });

    const tsHeader = req.headers['x-sea-timestamp'];
    const sigHeader = req.headers['x-sea-signature'];
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

// ── Off-platform: bootstrap external API keys ───────────────────────
// The Windows-side collector hits this once at startup so the AISStream
// key never has to live on disk on the server. Same idea as how the
// CPI forecaster pulls FRED through Render — keeps every external API
// key behind Render's env settings, with the lone unavoidable secret
// (SEA_INGEST_SECRET) shared between Render and the Windows box.
router.get(
  '/secrets',
  verifyHmac('/api/sea/secrets'),
  async (_req, res) => {
    const aisstreamApiKey = process.env.AISSTREAM_API_KEY || '';
    if (!aisstreamApiKey) {
      return res.status(503).json({ error: 'AISSTREAM_API_KEY not set on Render' });
    }
    return res.json({ aisstreamApiKey });
  }
);

// ── Off-platform: bulk signal upsert ─────────────────────────────────
router.post(
  '/signals',
  verifyHmac('/api/sea/signals'),
  async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.signals)) {
      return res.status(400).json({ error: 'signals[] missing' });
    }
    let written = 0;
    for (const row of body.signals) {
      if (!row || typeof row !== 'object') continue;
      const { date, name, value } = row;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
      if (typeof name !== 'string' || !name) continue;
      const numeric = value === null || value === undefined ? null : Number(value);
      if (numeric !== null && !Number.isFinite(numeric)) continue;
      await prisma.seaSignal.upsert({
        where: { date_signalName: { date: new Date(date), signalName: name } },
        update: { value: numeric },
        create: { date: new Date(date), signalName: name, value: numeric },
      });
      written += 1;
    }
    return res.json({ ok: true, written });
  }
);

// ── Off-platform: snapshot upsert ────────────────────────────────────
router.post(
  '/snapshot',
  verifyHmac('/api/sea/snapshot'),
  async (req, res) => {
    const body = req.body || {};
    const { snapshotAt, vesselCount, payload } = body;
    if (!snapshotAt) {
      return res.status(400).json({ error: 'snapshotAt missing' });
    }
    const at = new Date(snapshotAt);
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({ error: 'snapshotAt must be ISO 8601' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload object missing' });
    }
    const count = Number.isFinite(Number(vesselCount)) ? Number(vesselCount) : 0;
    const row = await prisma.seaSnapshot.upsert({
      where: { id: 1 },
      update: { snapshotAt: at, vesselCount: count, payload },
      create: { id: 1, snapshotAt: at, vesselCount: count, payload },
    });
    return res.json({ ok: true, snapshotAt: row.snapshotAt });
  }
);

// ── In-app reads (members only) ──────────────────────────────────────
router.use(verifyJwt);

router.get('/latest', async (_req, res) => {
  const row = await prisma.seaSnapshot.findUnique({ where: { id: 1 } });
  if (!row) {
    return res.json({ configured: false, snapshot: null });
  }
  return res.json({
    configured: true,
    snapshot: {
      snapshotAt: row.snapshotAt,
      vesselCount: row.vesselCount,
      ...row.payload,
    },
  });
});

router.get('/history', async (req, res) => {
  const signal = String(req.query.signal || '').trim();
  if (!signal) return res.status(400).json({ error: 'signal query param required' });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.seaSignal.findMany({
    where: { signalName: signal, date: { gte: since } },
    orderBy: { date: 'asc' },
  });
  return res.json({
    points: rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      value: r.value,
    })),
  });
});

// ── Satellite SAR vessel detections (Global Fishing Watch) ───────────
// Free non-commercial API. We proxy here so GFW_API_TOKEN never
// touches the browser. GFW data lags real-time by ~5 days but covers
// the entire Persian Gulf — including Iran, Saudi, Kuwait waters
// that terrestrial AIS can't reach. Useful for spotting dark-fleet
// activity and verifying AIS-visible flow.
//
// To enable: set GFW_API_TOKEN on Render. Until then this returns
// `enabled: false` and the React layer hides itself.
const GFW_BBOX = [
  [47.5, 23.5], [57.5, 23.5], [57.5, 30.5], [47.5, 30.5], [47.5, 23.5],
];
const GFW_DATASET = 'public-global-sar-presence:latest';
const GFW_REPORT_URL = 'https://gateway.api.globalfishingwatch.org/v3/4wings/report';

let _sarCache = { at: 0, ttlMs: 60 * 60 * 1000, days: null, body: null };

router.get('/sar-detections', async (req, res) => {
  const token = process.env.GFW_API_TOKEN;
  if (!token) {
    return res.json({ enabled: false, reason: 'GFW_API_TOKEN not set on Render' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

  const now = Date.now();
  if (
    _sarCache.body &&
    _sarCache.days === days &&
    (now - _sarCache.at) < _sarCache.ttlMs
  ) {
    return res.json(_sarCache.body);
  }

  // GFW doesn't ship data closer than ~5 days to real-time, so end the
  // window 5 days back. start = end - days.
  const fmt = (d) => d.toISOString().slice(0, 10);
  const end = new Date(now - 5 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  const url = new URL(GFW_REPORT_URL);
  url.searchParams.append('datasets[0]', GFW_DATASET);
  url.searchParams.append('date-range', `${fmt(start)},${fmt(end)}`);
  url.searchParams.append('temporal-resolution', 'DAILY');
  url.searchParams.append('spatial-resolution', 'LOW');
  url.searchParams.append('format', 'JSON');

  const region = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [GFW_BBOX] },
    }],
  };

  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ region }),
    });
  } catch (err) {
    return res.status(503).json({ enabled: true, error: `GFW network: ${err.message}` });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return res
      .status(503)
      .json({ enabled: true, error: `GFW ${upstream.status}: ${text.slice(0, 200)}` });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return res.status(503).json({ enabled: true, error: `GFW json: ${err.message}` });
  }

  const body = {
    enabled: true,
    fetchedAt: new Date().toISOString(),
    dateRange: { start: fmt(start), end: fmt(end) },
    days,
    raw: data,
  };
  _sarCache = { at: now, ttlMs: _sarCache.ttlMs, days, body };
  res.json(body);
});

export default router;
