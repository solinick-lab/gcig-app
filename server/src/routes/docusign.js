// DocuSign trade-confirmation routes.
//
// Two endpoints:
//   POST /api/docusign/sessions/:id/send  Exec-only. Computes shares from
//     the live quote + average Buy ballot, looks up the signer, and posts
//     an envelope built from the configured template. Persists envelope id
//     + a frozen tradeContext on the VotingSession.
//   POST /api/docusign/webhook  Public, HMAC-verified DocuSign Connect
//     callback. Updates docusignStatus + docusignCompletedAt when the
//     envelope completes (or declines / voids).

import { Router } from 'express';
import crypto from 'node:crypto';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { computeTally } from './votes.js';
import {
  isConfigured,
  sendTradeConfirmationEnvelope,
  getEnvelope,
  getKeyDiagnostics,
  bankApiCalls,
} from '../services/docusign.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────

// Minimal Finnhub price call — duplicates a slice of routes/holdings.js's
// quote logic on purpose. We only need `price` here, and keeping this
// inline avoids reaching across routes to share state.
async function fetchLivePrice(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    ticker
  )}&token=${key}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const p = Number(data?.c);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

// Map a DocuSign envelope status string onto the short labels we store on
// the session. Connect uses lowercase verbs ("sent", "delivered", etc.);
// the REST status field uses the same vocabulary. We keep the set tight so
// downstream UI doesn't have to handle an open universe of values.
function normalizeEnvelopeStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['completed', 'declined', 'voided', 'delivered', 'sent'].includes(s)) {
    return s;
  }
  return s || null;
}

// ── Routes ─────────────────────────────────────────────────────────────

// POST /api/docusign/sessions/:id/send — kick off the trade confirmation.
router.post(
  '/sessions/:id/send',
  verifyJwt,
  requireExecutive,
  async (req, res, next) => {
    try {
      if (!isConfigured()) {
        return res.status(503).json({
          error:
            'DocuSign is not configured on the server. See CLAUDE.md for env-var setup.',
        });
      }

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'Invalid session id' });
      }

      const session = await prisma.votingSession.findUnique({
        where: { id },
        include: { ballots: true },
      });
      if (!session) return res.status(404).json({ error: 'Session not found' });
      if (session.status !== 'closed') {
        return res
          .status(400)
          .json({ error: 'Session must be closed before sending' });
      }
      if (session.docusignEnvelopeId) {
        return res.status(409).json({
          error: 'A trade confirmation has already been sent for this session.',
        });
      }

      // Recompute the tally to derive buyAmountStats + final decision rather
      // than trust whatever the client thought — same source of truth as the
      // session detail endpoint.
      const allUsers = await prisma.user.findMany({
        select: { id: true, name: true, role: true, email: true, extraRoles: true },
      });
      const tally = computeTally(session.ballots, allUsers);
      if (tally.finalDecision !== 'Buy') {
        return res.status(400).json({
          error: `Cannot send a trade confirmation — final decision was ${tally.finalDecision}, not Buy.`,
        });
      }
      if (!tally.buyAmountStats) {
        return res
          .status(400)
          .json({ error: 'No Buy ballots with allocation amounts.' });
      }

      const price = await fetchLivePrice(session.ticker);
      if (!price) {
        return res.status(502).json({
          error: `Couldn't pull a live quote for ${session.ticker}. Try again in a moment.`,
        });
      }
      const proposed = tally.buyAmountStats.avg;
      const shares = Math.max(0, Math.round(proposed / price));
      if (shares === 0) {
        return res.status(400).json({
          error: `Proposed allocation $${Math.round(proposed)} is smaller than one share at $${price.toFixed(2)}.`,
        });
      }
      const totalCost = shares * price;

      // Anchor strings the template's PDF must contain (invisible text, see
      // CLAUDE.md). DocuSign drops any anchor it can't find, so over-sending
      // is fine — they're harmless if the PDF only uses a subset.
      //
      // Single-session sends land in row 1 of the same table the bundled
      // flow uses, so we use the indexed anchors (\\ticker1\\, \\shares1\\,
      // …) — the unindexed legacy anchors were retired from the PDF when
      // the table grew to support multi-row bundles.
      const decisionDate = new Date().toISOString().slice(0, 10);
      const anchorTabs = {
        '\\ticker1\\': session.ticker,
        '\\shares1\\': shares.toString(),
        // Per-row date anchor (\decisiondate1\) so rows 2..N stay blank.
        // Pairs with the bundled flow's indexed scheme — the legacy
        // unindexed `\decisiondate\` is no longer emitted.
        '\\decisiondate1\\': decisionDate,
        '\\buysell1\\': 'Buy',
        '\\price1\\': `$${price.toFixed(2)}`,
        '\\total1\\': `$${totalCost.toFixed(2)}`,
      };

      const envelope = await sendTradeConfirmationEnvelope({
        anchorTabs,
        emailSubject: `Trade confirmation — ${session.ticker} (${shares} shares)`,
        emailBlurb: [
          `Club voted Buy ${session.ticker}.`,
          `Sized at ${shares} share${shares === 1 ? '' : 's'} ` +
            `× $${price.toFixed(2)} = $${totalCost.toFixed(2)}.`,
          `Average proposed allocation across ${tally.buyAmountStats.count} ` +
            `Buy ballot${tally.buyAmountStats.count === 1 ? '' : 's'} was ` +
            `$${Math.round(proposed).toLocaleString()}.`,
        ].join('\n'),
      });

      const updated = await prisma.votingSession.update({
        where: { id },
        data: {
          docusignEnvelopeId: envelope.envelopeId,
          docusignStatus: normalizeEnvelopeStatus(envelope.status) || 'sent',
          docusignSentAt: new Date(),
          docusignTradeContext: {
            ticker: session.ticker,
            shares,
            pricePerShare: price,
            totalCost,
            proposedAllocation: proposed,
            decisionDate,
            sentAt: new Date().toISOString(),
          },
        },
      });

      res.json({
        envelopeId: envelope.envelopeId,
        status: updated.docusignStatus,
        sentAt: updated.docusignSentAt,
        tradeContext: updated.docusignTradeContext,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/docusign/webhook — Connect callback.
//
// DocuSign Connect signs the request body with HMAC-SHA256, base64-encoded,
// in the X-Docusign-Signature-1 header (rotate keys add -2, -3, …; we accept
// any of them so key rotation doesn't drop events). Configure the secret in
// the Connect listener config and mirror it as DOCUSIGN_WEBHOOK_HMAC_KEY.
router.post('/webhook', async (req, res, next) => {
  try {
    const secret = process.env.DOCUSIGN_WEBHOOK_HMAC_KEY;
    if (!secret) {
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    const raw = req.rawBody;
    if (!raw) {
      return res.status(400).json({ error: 'Missing body' });
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(raw)
      .digest('base64');

    const sigHeaders = Object.entries(req.headers)
      .filter(([k]) => /^x-docusign-signature-\d+$/i.test(k))
      .map(([, v]) => String(v));
    const ok = sigHeaders.some((h) => {
      try {
        return crypto.timingSafeEqual(
          Buffer.from(h, 'base64'),
          Buffer.from(expected, 'base64')
        );
      } catch {
        return false;
      }
    });
    if (!ok) return res.status(401).json({ error: 'Bad signature' });

    // Connect payloads come in two flavors: legacy XML and the JSON Connect
    // schema. We only enable JSON. Shape:
    //   { event: "envelope-completed", data: { envelopeId, envelopeSummary: { status, ... } } }
    const { event, data } = req.body || {};
    const envelopeId = data?.envelopeId;
    const status =
      data?.envelopeSummary?.status ||
      // Some Connect builds put the bare status at the top of `data`.
      data?.status ||
      (typeof event === 'string' ? event.replace(/^envelope-/, '') : null);
    if (!envelopeId) {
      return res.status(400).json({ error: 'Missing envelopeId' });
    }
    const normalized = normalizeEnvelopeStatus(status);

    // Envelope id could belong to either the legacy single-session flow
    // (VotingSession.docusign*) or the bundled TradeRequest flow. Try both
    // — they're disjoint by construction.
    const session = await prisma.votingSession.findFirst({
      where: { docusignEnvelopeId: envelopeId },
    });
    const tradeRequest = session
      ? null
      : await prisma.tradeRequest.findFirst({
          where: { docusignEnvelopeId: envelopeId },
        });
    if (!session && !tradeRequest) {
      // Not ours, but ack so DocuSign doesn't keep retrying.
      return res.json({ ok: true, matched: false });
    }

    if (session) {
      const completedAt =
        normalized === 'completed' ? new Date() : session.docusignCompletedAt;
      await prisma.votingSession.update({
        where: { id: session.id },
        data: {
          docusignStatus: normalized || session.docusignStatus,
          docusignCompletedAt: completedAt,
        },
      });
    } else {
      const completedAt =
        normalized === 'completed' ? new Date() : tradeRequest.docusignCompletedAt;
      await prisma.tradeRequest.update({
        where: { id: tradeRequest.id },
        data: {
          docusignStatus: normalized || tradeRequest.docusignStatus,
          docusignCompletedAt: completedAt,
        },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/docusign/sessions/:id/refresh — pull current envelope status
// directly from DocuSign. Useful when Connect is down or before it's wired.
router.get(
  '/sessions/:id/refresh',
  verifyJwt,
  requireExecutive,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const session = await prisma.votingSession.findUnique({ where: { id } });
      if (!session?.docusignEnvelopeId) {
        return res.status(404).json({ error: 'No envelope on this session' });
      }
      const env = await getEnvelope(session.docusignEnvelopeId);
      const normalized = normalizeEnvelopeStatus(env.status);
      const updated = await prisma.votingSession.update({
        where: { id },
        data: {
          docusignStatus: normalized || session.docusignStatus,
          docusignCompletedAt:
            normalized === 'completed' && !session.docusignCompletedAt
              ? new Date()
              : session.docusignCompletedAt,
        },
      });
      res.json({
        envelopeId: env.envelopeId,
        status: updated.docusignStatus,
        completedAt: updated.docusignCompletedAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/docusign/diagnose — non-secret metadata about the configured
// integration. Admin-only. Used to debug PEM parsing without ever leaking
// the key itself.
router.get('/diagnose', verifyJwt, requireExecutive, (_req, res) => {
  res.json({
    configured: isConfigured(),
    envVars: {
      DOCUSIGN_INTEGRATION_KEY: !!process.env.DOCUSIGN_INTEGRATION_KEY,
      DOCUSIGN_USER_ID: !!process.env.DOCUSIGN_USER_ID,
      DOCUSIGN_ACCOUNT_ID: !!process.env.DOCUSIGN_ACCOUNT_ID,
      DOCUSIGN_TEMPLATE_ID: !!process.env.DOCUSIGN_TEMPLATE_ID,
      DOCUSIGN_WEBHOOK_HMAC_KEY: !!process.env.DOCUSIGN_WEBHOOK_HMAC_KEY,
      DOCUSIGN_OAUTH_BASE: process.env.DOCUSIGN_OAUTH_BASE || '(default)',
      DOCUSIGN_API_BASE: process.env.DOCUSIGN_API_BASE || '(default)',
      DOCUSIGN_SIGNER_ROLE_NAME:
        process.env.DOCUSIGN_SIGNER_ROLE_NAME || '(default President)',
    },
    privateKey: getKeyDiagnostics(),
  });
});

// POST /api/docusign/bank-calls?count=25 — fire N successful read calls to
// DocuSign's account-info endpoint. Used to clear the 20-call threshold
// DocuSign requires before approving a go-live submission. Admin-only.
router.post(
  '/bank-calls',
  verifyJwt,
  requireExecutive,
  async (req, res, next) => {
    try {
      const count = Number(req.query.count) || Number(req.body?.count) || 25;
      const result = await bankApiCalls(count);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
