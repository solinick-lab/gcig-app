import { Router } from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import prisma from '../db.js';
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
    // Generating line-by-line JSON over a multi-page essay is intrinsically
    // slow on a 7B local model; the global 25s default in llmChat is for
    // short-summary calls and trips here.
    timeoutMs: 4 * 60 * 1000,
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

// Save a (essay, teacher feedback, real grade) tuple for the training
// corpus. Posted from the data-collection panel that appears below a
// prediction once the student has the actual returned paper in hand.
// We also store the cold-start prediction the model made on the same
// essay so a later evaluation pass can backtest predicted-vs-actual.
router.post('/grade-predictor/train', async (req, res) => {
  const {
    essay,
    teacher,
    rubric,
    feedback,
    grade,
    predictedGrade,
    predictedFeedback,
  } = req.body || {};

  if (!essay || typeof essay !== 'string' || essay.trim().length < 20) {
    return res.status(400).json({ error: 'essay is required' });
  }
  if (!feedback || typeof feedback !== 'string' || feedback.trim().length < 1) {
    return res.status(400).json({ error: 'feedback is required' });
  }
  if (!grade || typeof grade !== 'string' || grade.trim().length < 1) {
    return res.status(400).json({ error: 'grade is required' });
  }

  const row = await prisma.gradePredictorExample.create({
    data: {
      essay,
      teacher: typeof teacher === 'string' && teacher.trim() ? teacher.trim() : null,
      rubric: typeof rubric === 'string' && rubric.trim() ? rubric.trim() : null,
      feedback: feedback.trim(),
      grade: grade.trim(),
      predictedGrade:
        typeof predictedGrade === 'string' && predictedGrade.trim()
          ? predictedGrade.trim()
          : null,
      predictedFeedback:
        typeof predictedFeedback === 'string' && predictedFeedback.trim()
          ? predictedFeedback.trim()
          : null,
      createdById: req.user.id,
    },
    select: { id: true, teacher: true, createdAt: true },
  });

  res.json({ id: row.id, teacher: row.teacher, createdAt: row.createdAt });
});

// Parse a .docx upload into { text, comments }. text is the body of the
// document (paragraph-joined); comments is every Word review comment
// inside the file, with author + date + the comment text. The point is
// to let students upload the graded .docx their teacher returned and
// have the body fill the essay field while the teacher's actual margin
// notes flow into the training-data feedback field. .docx is just a
// zip, so we read it with the jszip we already use elsewhere — no new
// runtime dep.
const docxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Pulls visible text out of a Word XML fragment. Splits on paragraph
// boundaries so we get newlines between paragraphs (otherwise the body
// reads as one giant blob), then walks each paragraph's <w:t> runs.
function extractTextFromWordXml(xml) {
  if (!xml) return '';
  const paragraphs = xml.split(/<w:p[\s>]/);
  const out = [];
  for (const p of paragraphs) {
    const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)];
    if (runs.length === 0) continue;
    const text = runs.map((m) => unescapeXml(m[1])).join('');
    if (text.trim()) out.push(text);
  }
  return out.join('\n');
}

async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Not a valid .docx (missing word/document.xml)');
  }
  const docXml = await docFile.async('string');
  const text = extractTextFromWordXml(docXml);

  const comments = [];
  const commentsFile = zip.file('word/comments.xml');
  if (commentsFile) {
    const commentsXml = await commentsFile.async('string');
    const matches = [...commentsXml.matchAll(/<w:comment\s([^>]*?)>([\s\S]*?)<\/w:comment>/g)];
    for (const m of matches) {
      const attrs = m[1];
      const body = m[2];
      const author = (attrs.match(/w:author="([^"]*)"/) || [])[1] || '';
      const date = (attrs.match(/w:date="([^"]*)"/) || [])[1] || '';
      const commentText = extractTextFromWordXml(body);
      if (commentText.trim()) {
        comments.push({ author, date, text: commentText });
      }
    }
  }
  return { text, comments };
}

router.post(
  '/grade-predictor/parse-docx',
  docxUpload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const name = (req.file.originalname || '').toLowerCase();
    const isDocx =
      req.file.mimetype ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      name.endsWith('.docx');
    if (!isDocx) {
      return res.status(400).json({ error: 'Only .docx files are supported' });
    }
    try {
      const { text, comments } = await parseDocx(req.file.buffer);
      res.json({ text, comments });
    } catch (e) {
      console.warn('parse-docx failed:', e.message);
      res
        .status(400)
        .json({ error: e.message || 'Failed to parse .docx' });
    }
  }
);

// Per-teacher counts. Drives the "Corpus" hint in the UI so the user
// can see at a glance how much grading data each teacher has built up.
router.get('/grade-predictor/teachers', async (_req, res) => {
  const rows = await prisma.gradePredictorExample.groupBy({
    by: ['teacher'],
    _count: { _all: true },
  });
  // Untagged examples (teacher = null) get bucketed under "(unknown)"
  // so the UI can still show them rather than silently dropping them.
  const teachers = rows
    .map((r) => ({
      name: r.teacher || '(unknown)',
      examples: r._count._all,
    }))
    .sort((a, b) => b.examples - a.examples);
  res.json(teachers);
});

export default router;
