// Bundled trade-confirmation routes.
//
// A TradeRequest groups several Buy lines (each tied to a closed Buy
// VotingSession) plus optional Sell lines (typically SPY to cover the
// cash demand of the Buys) into one DocuSign envelope. One envelope per
// TradeRequest, regardless of how many tickers it carries.
//
// Endpoints:
//   GET    /api/trade-requests              List (exec-only)
//   GET    /api/trade-requests/:id          Detail
//   GET    /api/trade-requests/eligible-buys
//                                           Closed Buy sessions not yet on a
//                                           TradeRequest, with avg buy stats
//                                           pre-computed for the picker.
//   POST   /api/trade-requests              Build + send envelope in one shot.
//                                           Body: { items[], note? }
//                                           Each item: { kind, ticker, shares,
//                                           pricePerShare?, votingSessionId? }
//                                           Server pulls fresh quotes — never
//                                           trust client-supplied prices.
//   GET    /api/trade-requests/:id/refresh  Pull envelope status from DocuSign
//   DELETE /api/trade-requests/:id          Drop a request (only if not sent)

import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { computeTally } from './votes.js';
import {
  isConfigured,
  sendBundledTradeEnvelope,
  getEnvelope,
} from '../services/docusign.js';

const router = Router();
router.use(verifyJwt);

// Same Finnhub quote helper as routes/docusign.js. Keeping inline rather
// than importing the holdings route's quote stack — it's a single field
// (current price) and the surface area isn't worth a shared dependency.
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

function normalizeEnvelopeStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (['completed', 'declined', 'voided', 'delivered', 'sent'].includes(s)) {
    return s;
  }
  return s || null;
}

// Maximum line items per envelope. The PDF template needs anchor rows for
// each — see CLAUDE.md for how to grow this. The server caps at 8 so a
// caller can't accidentally build an envelope whose lines silently get
// dropped by the PDF.
const MAX_ITEMS = 8;

// ── Routes ──────────────────────────────────────────────────────────

// GET /api/trade-requests — list past + pending requests.
router.get('/', requireExecutive, async (_req, res, next) => {
  try {
    const rows = await prisma.tradeRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, name: true, role: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            votingSession: { select: { id: true, ticker: true, closedAt: true } },
          },
        },
      },
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/trade-requests/eligible-buys — closed Buy sessions that aren't
// yet on any TradeRequest. The composer's picker uses this list. We compute
// the tally inline so the client can size shares against the live quote
// without a second round trip per session.
router.get('/eligible-buys', requireExecutive, async (_req, res, next) => {
  try {
    const claimed = await prisma.tradeRequestItem.findMany({
      where: { kind: 'Buy', votingSessionId: { not: null } },
      select: { votingSessionId: true },
    });
    const claimedIds = new Set(claimed.map((c) => c.votingSessionId));

    const closed = await prisma.votingSession.findMany({
      where: { status: 'closed' },
      orderBy: { closedAt: 'desc' },
      include: {
        ballots: true,
        creator: { select: { id: true, name: true } },
      },
    });
    const allUsers = await prisma.user.findMany({
      select: { id: true, name: true, role: true, email: true, extraRoles: true },
    });

    const eligible = [];
    for (const s of closed) {
      if (claimedIds.has(s.id)) continue;
      const tally = computeTally(s.ballots, allUsers);
      if (tally.finalDecision !== 'Buy' || !tally.buyAmountStats) continue;
      eligible.push({
        id: s.id,
        ticker: s.ticker,
        title: s.title,
        closedAt: s.closedAt,
        createdAt: s.createdAt,
        creator: s.creator,
        buyAmountStats: tally.buyAmountStats,
        ballotCount: s.ballots.length,
      });
    }

    res.json(eligible);
  } catch (err) {
    next(err);
  }
});

// GET /api/trade-requests/:id — detail.
router.get('/:id', requireExecutive, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const row = await prisma.tradeRequest.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, name: true, role: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            votingSession: { select: { id: true, ticker: true, closedAt: true } },
          },
        },
      },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// POST /api/trade-requests — build + send.
//
// Body:
//   {
//     items: [
//       { kind: "Buy",  votingSessionId: 12 },        // shares derived from
//                                                     // avg ballot ÷ quote
//       { kind: "Buy",  ticker: "AAPL", shares: 30 }, // explicit override
//       { kind: "Sell", ticker: "SPY",  shares: 8 },  // explicit
//       { kind: "Sell", ticker: "SPY",  coverAmount: 3500 }
//                                                     // shares = ceil(amt/qt)
//     ],
//     note: "Optional exec note"
//   }
router.post('/', requireExecutive, async (req, res, next) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({
        error:
          'DocuSign is not configured on the server. See CLAUDE.md for env-var setup.',
      });
    }

    const { items: rawItems, note } = req.body || {};
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ error: 'items[] required' });
    }
    if (rawItems.length > MAX_ITEMS) {
      return res.status(400).json({
        error: `Too many items — the PDF template supports up to ${MAX_ITEMS} lines per envelope.`,
      });
    }

    // Resolve each line into a canonical { kind, ticker, shares, price,
    // totalCost, votingSessionId? } record. Quotes are pulled here, not
    // accepted from the client — the client is just for picking sessions
    // and proposing shares.
    const resolved = [];
    for (const raw of rawItems) {
      const kind = raw?.kind;
      if (kind !== 'Buy' && kind !== 'Sell') {
        return res
          .status(400)
          .json({ error: `Each item.kind must be "Buy" or "Sell" (got ${kind})` });
      }

      // Buy lines: prefer the votingSession path. Shares = round(avg ballot
      // / live price) unless the caller explicitly overrode `shares`.
      let ticker = (raw.ticker || '').toUpperCase().trim();
      let votingSessionId = null;
      let proposedAvg = null;

      if (kind === 'Buy' && raw.votingSessionId) {
        const id = Number(raw.votingSessionId);
        const session = await prisma.votingSession.findUnique({
          where: { id },
          include: { ballots: true },
        });
        if (!session) {
          return res
            .status(404)
            .json({ error: `Voting session ${id} not found` });
        }
        if (session.status !== 'closed') {
          return res
            .status(400)
            .json({ error: `Session ${id} (${session.ticker}) isn't closed yet` });
        }
        const allUsers = await prisma.user.findMany({
          select: { id: true, name: true, role: true, email: true, extraRoles: true },
        });
        const tally = computeTally(session.ballots, allUsers);
        if (tally.finalDecision !== 'Buy' || !tally.buyAmountStats) {
          return res.status(400).json({
            error: `Session ${id} (${session.ticker}) did not result in Buy`,
          });
        }
        ticker = session.ticker;
        votingSessionId = session.id;
        proposedAvg = tally.buyAmountStats.avg;
      }

      if (!ticker) {
        return res
          .status(400)
          .json({ error: 'Each item needs a ticker (or votingSessionId)' });
      }

      const price = await fetchLivePrice(ticker);
      if (!price) {
        return res.status(502).json({
          error: `Couldn't pull a live quote for ${ticker}. Try again in a moment.`,
        });
      }

      let shares = null;
      if (raw.shares != null) {
        const n = Math.round(Number(raw.shares));
        if (!Number.isFinite(n) || n <= 0) {
          return res
            .status(400)
            .json({ error: `Invalid shares for ${ticker}` });
        }
        shares = n;
      } else if (raw.coverAmount != null) {
        // Sell-to-cover: how many shares to free a given dollar amount. Round
        // UP so we always raise at least that much cash.
        const amt = Number(raw.coverAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
          return res
            .status(400)
            .json({ error: `Invalid coverAmount for ${ticker}` });
        }
        shares = Math.ceil(amt / price);
      } else if (proposedAvg != null) {
        // Buy from a session: round to nearest whole share at the live quote.
        shares = Math.max(1, Math.round(proposedAvg / price));
      } else {
        return res.status(400).json({
          error: `Item for ${ticker} needs shares, coverAmount, or a votingSessionId`,
        });
      }

      const totalCost = shares * price;
      resolved.push({
        kind,
        ticker,
        shares,
        pricePerShare: price,
        totalCost,
        votingSessionId,
      });
    }

    // Build the email body. Bundles the line summary so signers can sanity-
    // check at a glance without opening the PDF.
    const decisionDate = new Date().toISOString().slice(0, 10);
    const totalBuy = resolved
      .filter((i) => i.kind === 'Buy')
      .reduce((s, i) => s + i.totalCost, 0);
    const totalSell = resolved
      .filter((i) => i.kind === 'Sell')
      .reduce((s, i) => s + i.totalCost, 0);
    const netCash = totalSell - totalBuy;
    const subject =
      resolved.length === 1
        ? `Trade confirmation — ${resolved[0].kind} ${resolved[0].shares} ${resolved[0].ticker}`
        : `Trade confirmation — ${resolved.length} lines`;

    const blurbLines = resolved.map(
      (i) =>
        `${i.kind} ${i.shares} share${i.shares === 1 ? '' : 's'} ${i.ticker}` +
        ` @ $${i.pricePerShare.toFixed(2)} = $${i.totalCost.toFixed(2)}`
    );
    if (resolved.some((i) => i.kind === 'Sell') && resolved.some((i) => i.kind === 'Buy')) {
      blurbLines.push('');
      blurbLines.push(
        `Net cash flow: ${netCash >= 0 ? '+' : '−'}$${Math.abs(netCash).toFixed(2)}`
      );
    }
    if (note) {
      blurbLines.push('');
      blurbLines.push(note);
    }

    // Create the record first (so we have an id to attribute the envelope
    // to on the audit trail), then send, then write the envelope id back.
    const created = await prisma.tradeRequest.create({
      data: {
        createdBy: req.user.id,
        note: note || null,
        items: { create: resolved.map((i) => ({ ...i })) },
      },
      include: { items: true },
    });

    let envelope;
    try {
      envelope = await sendBundledTradeEnvelope({
        items: resolved,
        decisionDate,
        emailSubject: subject,
        emailBlurb: blurbLines.join('\n'),
      });
    } catch (err) {
      // Roll back so a failed send doesn't leave an orphan record claiming
      // sessions the user might want to retry with.
      await prisma.tradeRequest
        .delete({ where: { id: created.id } })
        .catch(() => {});
      throw err;
    }

    const updated = await prisma.tradeRequest.update({
      where: { id: created.id },
      data: {
        docusignEnvelopeId: envelope.envelopeId,
        docusignStatus: normalizeEnvelopeStatus(envelope.status) || 'sent',
        docusignSentAt: new Date(),
        tradeContext: {
          items: resolved,
          totalBuy,
          totalSell,
          netCash,
          decisionDate,
          sentAt: new Date().toISOString(),
        },
      },
      include: {
        creator: { select: { id: true, name: true, role: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            votingSession: { select: { id: true, ticker: true, closedAt: true } },
          },
        },
      },
    });

    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/trade-requests/:id/refresh — pull envelope status from DocuSign.
router.get('/:id/refresh', requireExecutive, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tr = await prisma.tradeRequest.findUnique({ where: { id } });
    if (!tr) return res.status(404).json({ error: 'Not found' });
    if (!tr.docusignEnvelopeId) {
      return res.status(404).json({ error: 'No envelope on this trade request' });
    }
    const env = await getEnvelope(tr.docusignEnvelopeId);
    const normalized = normalizeEnvelopeStatus(env.status);
    const updated = await prisma.tradeRequest.update({
      where: { id },
      data: {
        docusignStatus: normalized || tr.docusignStatus,
        docusignCompletedAt:
          normalized === 'completed' && !tr.docusignCompletedAt
            ? new Date()
            : tr.docusignCompletedAt,
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
});

// DELETE /api/trade-requests/:id — drop a request. Only allowed before the
// envelope has gone out: once a TradeRequest has a docusignEnvelopeId, the
// claim on its sessions is permanent (audit trail) and the envelope itself
// can only be voided via DocuSign.
router.delete('/:id', requireExecutive, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tr = await prisma.tradeRequest.findUnique({ where: { id } });
    if (!tr) return res.status(404).json({ error: 'Not found' });
    if (tr.docusignEnvelopeId) {
      return res.status(409).json({
        error: "Can't delete — envelope was already sent. Void it in DocuSign first.",
      });
    }
    await prisma.tradeRequest.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
