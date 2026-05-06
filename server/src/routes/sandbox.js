import { Router } from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';
import { llmChat, probeProviders } from '../services/llm.js';
import {
  uploadFile as oneDriveUpload,
  isConfigured as oneDriveConfigured,
} from '../services/oneDriveStorage.js';

// Where every grade-predictor essay lands inside the connected OneDrive.
// The shared upload helper prepends ONEDRIVE_FOLDER as a parent (default
// "GriffinFund/Uploads"); we tack on a Sandbox/GradePredictor leg so the
// essays don't mingle with pitch decks and reports.
const ONEDRIVE_SUBFOLDER = 'Sandbox/GradePredictor/Essays';

// Best-effort upload: always returns { ref, url } where both are null
// when OneDrive isn't configured / authorized / reachable. The caller
// proceeds with the prediction or training-data save either way — we
// don't want a flaky OneDrive to block the corpus from growing.
async function tryUploadEssay({ buffer, filename, contentType }) {
  if (!oneDriveConfigured()) return { ref: null, url: null };
  try {
    const item = await oneDriveUpload({
      buffer,
      filename: `${ONEDRIVE_SUBFOLDER}/${filename}`,
      contentType: contentType || 'application/octet-stream',
    });
    return { ref: item?.id || null, url: item?.webUrl || null };
  } catch (err) {
    console.warn('grade-predictor: OneDrive upload failed:', err.message);
    return { ref: null, url: null };
  }
}

// Filename-safe slug. Strips characters OneDrive / Graph dislike, caps
// length so a paranoid copy of "the_great_gatsby_fitzgerald_chapter_…"
// doesn't blow past the 256-char path limit.
function slugifyForFile(s) {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return cleaned.slice(0, 60) || 'essay';
}

function timestampSlug() {
  // 2026-05-06_141530 — ISO-ish but filesystem-safe.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// Sandbox routes — super-admin-only scratch endpoints for in-progress
// projects. Currently hosts the Grade Predictor, which routes through
// the shared LLM client (qwen2.5:14b on the local Ollama tunnel, with
// OpenAI fallback) instead of the standalone FastAPI service that the
// scaffold originally pointed at. That keeps everything inside the
// gcig-api deploy with no extra hosts to babysit.

const router = Router();

// Open to every logged-in member, not just super admins. The grade
// predictor is the kind of tool that's most useful student-by-student;
// gating it to admins meant the people who would use it most couldn't.
// Cost surface is bounded by JWT auth + the LLM client's existing
// rate-limit / fallback behavior.
router.use(verifyJwt);

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

// Per-teacher RAG: when the user names a teacher we already have prior
// examples for, inject those examples into the prompt so the model
// imitates that teacher's voice, comment density, and grade distribution.
// Each prior example contributes (student essay → teacher's comments →
// grade given) so the model has a tight stimulus-response pattern to
// mirror. Truncations are deliberately generous on the comments side
// (those carry the teaching style) and tighter on the essay (just
// enough context to ground the comments).
function buildRagPrompt({ essay, teacher, rubric, examples }) {
  const parts = [];
  parts.push(
    `You are predicting how the teacher named ${teacher} would grade a ` +
      `student essay. You have ${examples.length} prior example` +
      `${examples.length === 1 ? '' : 's'} of how this teacher grades. ` +
      `Match their style, comment density, vocabulary, and grade ` +
      `distribution — your job is to mimic this specific teacher, not ` +
      `to give your own opinion.`
  );
  parts.push(`\n--- PRIOR EXAMPLES OF ${teacher.toUpperCase()}'S GRADING ---`);
  examples.forEach((ex, i) => {
    parts.push(
      `\n=== EXAMPLE ${i + 1} ===\n` +
        `STUDENT ESSAY:\n${truncate(ex.essay, 2500)}\n\n` +
        `TEACHER'S COMMENTS / FEEDBACK:\n${truncate(ex.feedback, 2000)}\n\n` +
        `GRADE GIVEN: ${ex.grade}`
    );
  });
  if (rubric) {
    parts.push(`\n--- RUBRIC FOR THE NEW ESSAY ---\n${truncate(rubric, 3000)}`);
  }
  parts.push(`\n--- NEW ESSAY TO GRADE ---\n${truncate(essay, 8000)}`);
  parts.push(
    '\n--- TASK ---\n' +
      "Produce a grade prediction for the new essay in this teacher's style. " +
      'Output ONLY a JSON object with these keys (no prose before or after):\n' +
      '  "line_by_line": array of {"quote": "<short verbatim phrase from the essay>",' +
      ' "comment": "<margin note in this teacher\'s voice>",' +
      ' "severity": "praise" | "suggestion" | "concern",' +
      ' "category": "<thesis | evidence | analysis | structure | style | mechanics | strength>"}\n' +
      '  "overall_feedback": string — 2-4 sentences in the teacher\'s voice (the "end comment")\n' +
      '  "grade": string — match the format the teacher used in the examples (letter grade, percent, X/Y, etc.)\n' +
      '  "letter_grade": string — single letter (A, A-, B+, …) inferred from "grade", omit if uncertain\n' +
      '  "numeric_grade": integer 0-100 inferred from "grade", omit if uncertain\n' +
      '  "confidence": "high" | "medium" | "low" — how sure you are given the corpus depth and prompt fit\n' +
      '  "reasoning": array of 2-4 short strings — why this grade, in this teacher\'s frame\n' +
      '  "strengths": array of 2-4 short strings — what the essay does well\n' +
      '  "weaknesses": array of 2-4 short strings — what holds it back\n' +
      '  "next_steps": array of 2-4 short strings — concrete revision priorities, ordered\n' +
      '  "rubric_breakdown": object mapping rubric criterion → score + one-sentence reason, or null if no rubric was given\n' +
      'Aim for 6-15 line_by_line entries depending on essay length. ' +
      'Mix praise, suggestions, and concerns. Quote phrases that actually appear ' +
      'in the essay verbatim. Do not invent passages.'
  );
  return parts.join('\n');
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
      '  "line_by_line": array of {"quote": "...", "comment": "...",' +
      ' "severity": "praise" | "suggestion" | "concern",' +
      ' "category": "<thesis | evidence | analysis | structure | style | mechanics | strength>"}\n' +
      '  "overall_feedback": string (the "end comment")\n' +
      '  "grade": string (letter grade or percent)\n' +
      '  "letter_grade": string (single letter, e.g. A-, B+) — omit if uncertain\n' +
      '  "numeric_grade": integer 0-100 — omit if uncertain\n' +
      '  "confidence": "low" — always low for cold-start, no prior examples to anchor on\n' +
      '  "reasoning": array of 2-4 short strings\n' +
      '  "strengths": array of 2-4 short strings\n' +
      '  "weaknesses": array of 2-4 short strings\n' +
      '  "next_steps": array of 2-4 short strings — concrete revision priorities, ordered\n' +
      '  "rubric_breakdown": object | null\n' +
      'Mix praise, suggestions, and concerns. Quote phrases that actually appear verbatim in the essay.'
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

// How many prior examples we inject into the RAG prompt. Plenty for the
// 32K-token context on qwen2.5:7b once each example is truncated, and
// small enough to keep the prediction fast.
const RAG_TOP_K = 3;

router.post('/grade-predictor/predict', async (req, res) => {
  const { essay, teacher, rubric } = req.body || {};
  if (!essay || typeof essay !== 'string' || essay.trim().length < 20) {
    return res
      .status(400)
      .json({ error: 'essay is required (at least 20 characters)' });
  }

  const cleanTeacher = typeof teacher === 'string' ? teacher.trim() : '';
  const cleanRubric = typeof rubric === 'string' ? rubric.trim() : '';

  // Retrieve prior examples for this teacher. Case-insensitive match so
  // "Anna Grafton" and "anna grafton" share a corpus instead of starting
  // separate ones. Most-recent-first is the simplest "relevance" we can
  // serve before we have an embedding store; with a small N per teacher
  // it's also a perfectly fine proxy for "what did this teacher value
  // most recently".
  let examples = [];
  let examplesAvailable = 0;
  if (cleanTeacher) {
    const where = { teacher: { equals: cleanTeacher, mode: 'insensitive' } };
    examplesAvailable = await prisma.gradePredictorExample.count({ where });
    if (examplesAvailable > 0) {
      examples = await prisma.gradePredictorExample.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: RAG_TOP_K,
        select: { id: true, essay: true, feedback: true, grade: true },
      });
    }
  }

  const prompt =
    examples.length > 0
      ? buildRagPrompt({
          essay,
          teacher: cleanTeacher,
          rubric: cleanRubric,
          examples,
        })
      : buildColdStartPrompt({
          essay,
          teacher: cleanTeacher,
          rubric: cleanRubric,
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
  const usedExampleIds = examples.map((e) => e.id);
  if (!parsed) {
    return res.json({
      result: { _parse_error: 'Model did not return parseable JSON', _raw: content },
      examples_used: examples.length,
      examples_available: examplesAvailable,
      used_example_ids: usedExampleIds,
      mode: examples.length > 0 ? 'rag' : 'cold-start',
    });
  }

  res.json({
    result: parsed,
    examples_used: examples.length,
    examples_available: examplesAvailable,
    used_example_ids: usedExampleIds,
    mode: examples.length > 0 ? 'rag' : 'cold-start',
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
    fileRef: passedFileRef,
    fileUrl: passedFileUrl,
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

  // OneDrive persistence: prefer the fileRef the client carried over
  // from a .docx parse-and-upload. If they pasted essay text directly,
  // serialize it as a .txt and upload that on save so every saved
  // training row points at a real file in OneDrive.
  let essayFileRef = typeof passedFileRef === 'string' ? passedFileRef : null;
  let essayFileUrl = typeof passedFileUrl === 'string' ? passedFileUrl : null;
  if (!essayFileRef) {
    const baseName = slugifyForFile(
      teacher ? `${teacher}_essay` : 'essay'
    );
    const finalName = `${timestampSlug()}_${baseName}.txt`;
    const { ref, url } = await tryUploadEssay({
      buffer: Buffer.from(essay, 'utf8'),
      filename: finalName,
      contentType: 'text/plain; charset=utf-8',
    });
    essayFileRef = ref;
    essayFileUrl = url;
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
      essayFileRef,
      essayFileUrl,
      createdById: req.user.id,
    },
    select: { id: true, teacher: true, createdAt: true, essayFileUrl: true },
  });

  res.json({
    id: row.id,
    teacher: row.teacher,
    createdAt: row.createdAt,
    essayFileUrl: row.essayFileUrl,
  });
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
      // Persist the .docx to OneDrive — original filename, just slugified
      // and prefixed with a timestamp so two uploads of "Essay.docx" don't
      // collide. The fileRef + url come back to the client so the training-
      // data save can carry them through onto the row.
      const baseName = slugifyForFile(req.file.originalname.replace(/\.docx$/i, ''));
      const finalName = `${timestampSlug()}_${baseName}.docx`;
      const { ref, url } = await tryUploadEssay({
        buffer: req.file.buffer,
        filename: finalName,
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      res.json({ text, comments, fileRef: ref, fileUrl: url });
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
