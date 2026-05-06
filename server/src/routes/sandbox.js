import { Router } from 'express';
import { verifyJwt, requireSuperAdmin } from '../middleware/auth.js';
import { llmChat, probeProviders } from '../services/llm.js';

// Sandbox routes — super-admin-only scratch endpoints for in-progress
// projects. Currently hosts the Grade Predictor, which routes through
// the shared LLM client (qwen2.5:14b on the local Ollama tunnel, with
// OpenAI fallback) instead of the standalone FastAPI service that the
// scaffold originally pointed at. That keeps everything inside the
// gcig-api deploy with no extra hosts to babysit.

const router = Router();

router.use(verifyJwt, requireSuperAdmin);

router.get('/grade-predictor/health', async (_req, res) => {
  const status = await probeProviders({ timeoutMs: 4000 });
  res.json({
    ok: !!status.active,
    active: status.active,
    local: status.local,
    openai: status.openai,
  });
});

function truncate(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 50) + ' […truncated…]';
}

function buildColdStartPrompt({ essay, teacher, rubric }) {
  const parts = [];
  if (teacher) {
    parts.push(
      `You are grading a student essay. The teacher's name is ${teacher}, ` +
        `but you don't yet have prior examples of their grading style — ` +
        `fall back to standard high-school / college English grading. ` +
        `Be specific and constructive.`
    );
  } else {
    parts.push(
      'You are grading a student essay using standard high-school / ' +
        'college English grading. Be specific and constructive.'
    );
  }
  if (rubric) parts.push(`\n--- RUBRIC ---\n${truncate(rubric, 3000)}`);
  parts.push(`\n--- ESSAY ---\n${truncate(essay, 8000)}`);
  parts.push(
    '\n--- TASK ---\n' +
      'Output ONLY a JSON object:\n' +
      '  "line_by_line": array of {"quote": "...", "comment": "..."}\n' +
      '  "overall_feedback": string\n' +
      '  "grade": string (letter grade or percent)\n' +
      '  "rubric_breakdown": object | null\n' +
      'Quote phrases that actually appear verbatim in the essay.'
  );
  return parts.join('\n');
}

// Strip ``` fences and any prose around a JSON object, then parse. The
// local model is asked for raw JSON but occasionally wraps it in a
// fenced block or adds a sentence on either side; this is the same
// salvage pass we use elsewhere for LLM-emitted JSON.
function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

router.post('/grade-predictor/predict', async (req, res) => {
  const { essay, teacher, rubric } = req.body || {};
  if (!essay || typeof essay !== 'string' || essay.trim().length < 20) {
    return res
      .status(400)
      .json({ error: 'essay is required (at least 20 characters)' });
  }

  const prompt = buildColdStartPrompt({
    essay,
    teacher: typeof teacher === 'string' ? teacher.trim() : '',
    rubric: typeof rubric === 'string' ? rubric.trim() : '',
  });

  const content = await llmChat({
    messages: [
      {
        role: 'system',
        content:
          'You are an experienced English teacher producing structured grade predictions. ' +
          'Always respond with a single JSON object — no prose, no code fences.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.4,
    jsonMode: true,
  });

  if (!content) {
    return res
      .status(503)
      .json({ error: 'LLM unreachable (local + fallback both unavailable)' });
  }

  const parsed = extractJson(content);
  if (!parsed) {
    return res.json({
      result: { _parse_error: 'Model did not return parseable JSON', _raw: content },
      examples_used: 0,
      examples_available: 0,
    });
  }

  res.json({
    result: parsed,
    examples_used: 0,
    examples_available: 0,
  });
});

export default router;
