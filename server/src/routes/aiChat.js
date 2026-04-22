import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { llmChat } from '../services/llm.js';
import { getClubSystemPrompt } from '../ai/clubBrief.js';

// The Griffin Fund AI Assistant — conversational endpoint backed by the
// club's own local Ollama model (with OpenAI fallback). Open to every
// authenticated member.
//
// Conversations are server-owned: each turn the client sends only a
// sessionId + a new user message. The full history is loaded from the
// DB server-side before calling the model. This prevents a malicious
// client from forging "assistant" turns and asking the model to treat
// them as precedent. The system prompt (IPS + policies + live club
// data) is built by ai/clubBrief.js and is never client-controllable.

const router = Router();
router.use(verifyJwt);

// 60 requests / 10 minutes per user. Generous for normal Q&A, tight
// enough to catch a runaway client or bulk-prompt abuse.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `ai-chat:${req.user?.id || req.ip}`,
  message: { error: 'AI Assistant rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const MAX_MESSAGE_CHARS = 8_000;
const MAX_TURNS_PER_SESSION = 80; // 40 user + 40 assistant
const MAX_TOTAL_SESSION_CHARS = 60_000; // matches the model's usable context

function truncateTitle(s, n = 80) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trimEnd() + '…';
}

// ------------------------------------------------------------
// Session listing + management
// ------------------------------------------------------------

router.get('/sessions', async (req, res) => {
  const sessions = await prisma.aiChatSession.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  res.json(
    sessions.map((s) => ({
      id: s.id,
      title: s.title || 'New conversation',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s._count.messages,
    }))
  );
});

router.get('/sessions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad session id' });
  const session = await prisma.aiChatSession.findUnique({
    where: { id },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({
    id: session.id,
    title: session.title || 'New conversation',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
  });
});

router.delete('/sessions/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad session id' });
  const session = await prisma.aiChatSession.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!session || session.userId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  await prisma.aiChatSession.delete({ where: { id } });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Send a turn
// ------------------------------------------------------------

router.post('/', chatLimiter, async (req, res) => {
  const { sessionId, message, temperature } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res
      .status(400)
      .json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` });
  }
  const temp =
    typeof temperature === 'number' && temperature >= 0 && temperature <= 2
      ? temperature
      : 0.7;

  // Resolve (or create) the session. A client-supplied sessionId must
  // belong to the current user — otherwise we treat it as "start new".
  let session = null;
  if (sessionId != null) {
    const id = Number(sessionId);
    if (Number.isFinite(id)) {
      session = await prisma.aiChatSession.findUnique({ where: { id } });
      if (session && session.userId !== req.user.id) session = null;
    }
  }
  if (!session) {
    session = await prisma.aiChatSession.create({
      data: { userId: req.user.id },
    });
  }

  // Load the existing thread. If it's already past the turn / size caps,
  // refuse — the user should start a new conversation.
  const priorMessages = await prisma.aiChatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });
  if (priorMessages.length >= MAX_TURNS_PER_SESSION) {
    return res.status(400).json({
      error: 'This conversation is at the turn limit. Start a new chat.',
    });
  }
  const priorChars = priorMessages.reduce((s, m) => s + m.content.length, 0);
  if (priorChars + message.length > MAX_TOTAL_SESSION_CHARS) {
    return res.status(400).json({
      error: 'This conversation has grown too long. Start a new chat.',
    });
  }

  // Persist the user turn before calling the model — that way if the LLM
  // errors we still have a record + the UI can retry against the same
  // session without losing the message.
  await prisma.aiChatMessage.create({
    data: { sessionId: session.id, role: 'user', content: message.trim() },
  });

  // Build the model input: server system prompt + thread from DB.
  const systemPrompt = await getClubSystemPrompt({ user: req.user });
  const modelMessages = [
    { role: 'system', content: systemPrompt },
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message.trim() },
  ];

  const startedAt = Date.now();
  const reply = await llmChat({ messages: modelMessages, temperature: temp });
  const latencyMs = Date.now() - startedAt;

  if (!reply) {
    return res.status(503).json({
      error:
        'AI provider unavailable. Check the local LLM tunnel and OpenAI fallback.',
      sessionId: session.id,
    });
  }

  // Persist the assistant turn. Provider identification is best-effort —
  // llmChat currently returns just the content string, so we tag based on
  // which env is configured (local preferred, fallback to openai).
  const providerTag = process.env.LOCAL_LLM_URL
    ? 'local?'
    : process.env.OPENAI_API_KEY
      ? 'openai'
      : 'unknown';
  await prisma.aiChatMessage.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      model: providerTag,
      latencyMs,
    },
  });

  // Title the session from the first user message if still blank.
  let title = session.title;
  if (!title) {
    title = truncateTitle(message, 80);
    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { title, updatedAt: new Date() },
    });
  } else {
    // Bump updatedAt so the sidebar orders by last activity.
    await prisma.aiChatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });
  }

  res.json({
    sessionId: session.id,
    title,
    reply,
  });
});

export default router;
