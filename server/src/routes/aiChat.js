import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyJwt, requireSuperAdmin } from '../middleware/auth.js';
import { llmChat } from '../services/llm.js';
import { getClubSystemPrompt } from '../ai/clubBrief.js';

// ChatGPT-style conversational endpoint backed by the club's own local
// Ollama model (with OpenAI fallback). Super-admin only for now — this is
// an experimental sandbox that costs real GPU time and shouldn't be open
// to every member until we have a usage model. History is client-owned:
// each turn ships the full message array back; the server is stateless.
//
// The system prompt is NOT client-controllable. We build it server-side
// from the club's IPS, internal policies, and live portfolio/voting data
// so the model always answers in-scope and on-topic. Any `role: 'system'`
// messages the client sends are dropped.

const router = Router();
router.use(verifyJwt);
router.use(requireSuperAdmin);

// 30 requests / 5 minutes per user. Generous for a single person iterating,
// tight enough to catch a runaway client-side loop.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `ai-chat:${req.user?.id || req.ip}`,
  message: { error: 'AI chat rate limit reached. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Only user/assistant turns are accepted from the client. Any `system`
// messages are silently dropped — the server owns the system prompt.
const CLIENT_ROLES = new Set(['user', 'assistant']);
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8000;

function validateMessages(raw) {
  if (!Array.isArray(raw)) return { error: 'messages must be an array' };
  if (raw.length === 0) return { error: 'messages cannot be empty' };
  if (raw.length > MAX_MESSAGES) {
    return { error: `Conversation too long (max ${MAX_MESSAGES} turns)` };
  }
  const cleaned = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') return { error: 'Each message must be an object' };
    // Skip client-sent system messages — those are advisory only; the
    // server's club brief is the authoritative system prompt.
    if (m.role === 'system') continue;
    if (!CLIENT_ROLES.has(m.role)) {
      return { error: `Invalid role "${m.role}" — must be user or assistant` };
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      return { error: 'Each message must have non-empty string content' };
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return { error: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` };
    }
    cleaned.push({ role: m.role, content: m.content });
  }
  if (cleaned.length === 0) {
    return { error: 'No user/assistant messages provided' };
  }
  // Last turn must be from the user — otherwise there's nothing to respond to.
  if (cleaned[cleaned.length - 1].role !== 'user') {
    return { error: 'Conversation must end with a user message' };
  }
  return { messages: cleaned };
}

router.post('/', chatLimiter, async (req, res) => {
  const { temperature } = req.body || {};
  const { messages, error } = validateMessages(req.body?.messages);
  if (error) return res.status(400).json({ error });

  const temp =
    typeof temperature === 'number' && temperature >= 0 && temperature <= 2
      ? temperature
      : 0.7;

  // Prepend the club's authoritative system prompt (IPS + internal policies
  // + live portfolio/votes/pitches data). The club brief is cached 60s; the
  // per-user addendum (name + role) is appended fresh each call so drafted
  // messages sign with the right name.
  const systemPrompt = await getClubSystemPrompt({ user: req.user });
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  const reply = await llmChat({ messages: fullMessages, temperature: temp });
  if (!reply) {
    return res.status(503).json({
      error:
        'AI provider unavailable. Check the local LLM tunnel and OpenAI fallback.',
    });
  }
  res.json({ reply });
});

export default router;
