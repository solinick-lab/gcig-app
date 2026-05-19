import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';

// Private per-member research notes, one per (user, ticker). This is the
// personal counterpart to HoldingThesis: HoldingThesis is the club-wide
// thesis on a holding; this is a member's own scratchpad while doing
// diligence on any ticker, never shared. Auth + user-scoping mirror
// presidentReview.js — verifyJwt on the whole router, every query hard-
// bound to req.user.id so the (userId,ticker) unique key is the only way
// in and a caller can never read or mutate another member's note.
//
// Each handler is exported and dependency-injected (a `db` Prisma
// double) so it can be unit-tested without a database, following the
// stepDownHandler / execBiosHandler precedent. The express routes are
// thin wrappers over the exported handlers. Per-handler try/catch keeps
// the panel honest: a read that fails degrades to the empty shape, a
// write that fails returns a surfacing 4xx (never a 5xx), and the
// client holds the user's text rather than wiping it.

const router = Router();
router.use(verifyJwt);

// Same ticker grammar the terminal routes enforce. A malformed path
// param is the one 4xx these handlers raise.
const TICKER_RE = /^[A-Z0-9.\-]{1,12}$/;

// Free-text notes are generous but bounded — 10k characters is a long
// memo and well past any real thesis, while still capping a single row.
// We cap (slice) rather than reject so a paste that runs slightly long
// saves the leading 10k instead of losing the whole save.
const MAX_BODY = 10_000;

function normalizeTicker(raw) {
  return String(raw || '').trim().toUpperCase();
}

// The honest-empty shape every read/clear/delete settles on. The panel
// renders this as a blank textarea with no error — "you haven't written
// anything here yet", not a failure.
function emptyNote(ticker) {
  return { ticker, body: '', updatedAt: null };
}

// GET /api/notes/:ticker — the caller's own note for the ticker, or the
// honest-empty shape if they've never written one. The lookup is bound
// to the composite (userId, ticker) unique key, so it can only ever
// resolve the caller's row. A DB hiccup degrades to empty (the panel
// says it couldn't load) rather than 5xx-ing the terminal.
export async function getNoteHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const ticker = normalizeTicker(req.params.ticker);
  if (!TICKER_RE.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const note = await db.researchNote.findUnique({
      where: { userId_ticker: { userId: req.user.id, ticker } },
      select: { body: true, updatedAt: true },
    });
    if (!note) return res.json(emptyNote(ticker));
    return res.json({
      ticker,
      body: note.body || '',
      updatedAt: note.updatedAt,
    });
  } catch (err) {
    console.warn(`notes GET(${ticker}) degraded:`, err.message);
    return res.json(emptyNote(ticker));
  }
}

// PUT /api/notes/:ticker { body } — save (upsert) the caller's note.
// Trim + cap first. An empty / whitespace-only / missing body is the
// "clear and save" path: the row is deleted and the empty shape comes
// back, so the textarea ends blank and durable. Otherwise upsert on the
// (userId, ticker) unique key — inherently idempotent, re-saving just
// updates. Both branches are hard-scoped to req.user.id. A failed write
// is a surfacing 4xx, never a 5xx; the client keeps the user's text and
// shows the error.
export async function putNoteHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const ticker = normalizeTicker(req.params.ticker);
  if (!TICKER_RE.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const raw = req.body?.body;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const body = trimmed.slice(0, MAX_BODY);

  try {
    if (body.length === 0) {
      // Clearing a note that may or may not exist — deleteMany is the
      // idempotent no-op-safe form, scoped to this user only.
      await db.researchNote.deleteMany({
        where: { userId: req.user.id, ticker },
      });
      return res.json(emptyNote(ticker));
    }

    const saved = await db.researchNote.upsert({
      where: { userId_ticker: { userId: req.user.id, ticker } },
      create: { userId: req.user.id, ticker, body },
      update: { body },
      select: { body: true, updatedAt: true },
    });
    return res.json({
      ticker,
      body: saved.body || '',
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    // Never 5xx (the contract the route comment and the sibling
    // terminal handlers promise). A persistence failure is surfaced as
    // a plain 400 the client can show — it deliberately keeps the
    // user's typed text in the textarea rather than wiping it, so the
    // save can be retried without retyping.
    console.warn(`notes PUT(${ticker}) degraded:`, err.message);
    return res.status(400).json({ error: 'Could not save note. Try again.' });
  }
}

// DELETE /api/notes/:ticker — drop the caller's note for the ticker.
// deleteMany scoped to req.user.id means an absent note is a clean
// no-op (count 0), so hitting Clear on an empty note is success, not a
// 404. A failed delete is a surfacing 4xx, never a 5xx.
export async function deleteNoteHandler(req, res, deps = {}) {
  const { db = prisma } = deps;
  const ticker = normalizeTicker(req.params.ticker);
  if (!TICKER_RE.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    await db.researchNote.deleteMany({
      where: { userId: req.user.id, ticker },
    });
    return res.json(emptyNote(ticker));
  } catch (err) {
    // Same never-5xx contract as the save path — a surfacing 400, not
    // a 500, so a failed clear is retryable and the terminal stays up.
    console.warn(`notes DELETE(${ticker}) degraded:`, err.message);
    return res.status(400).json({ error: 'Could not delete note. Try again.' });
  }
}

router.get('/:ticker', (req, res) => getNoteHandler(req, res));
router.put('/:ticker', (req, res) => putNoteHandler(req, res));
router.delete('/:ticker', (req, res) => deleteNoteHandler(req, res));

export default router;
