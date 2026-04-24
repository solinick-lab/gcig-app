import prisma from '../db.js';
import { llmChat } from './llm.js';
import { getAccessToken } from './oneDriveStorage.js';

// AI summarization for uploaded files. Flow:
//   1. Fetch the file bytes from OneDrive via Graph (auth handled by
//      the oneDriveStorage service — same access token the upload path
//      uses).
//   2. Extract text with pdf-parse (PDF only for now — other types
//      fall through to a helpful "unsupported" error).
//   3. Cap the text at MAX_CHARS so we stay well inside the local
//      Ollama model's context window, then send to llmChat with a
//      pitch-club-tuned system prompt.
//   4. Persist the result to FileSummary keyed by fileRef so repeat
//      opens read from the DB instead of burning GPU cycles.
//
// Regeneration is available via summarizeFile(itemId, { force: true }).

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ~40K chars ≈ 10K tokens. Leaves plenty of headroom for the system
// prompt + a detailed response inside qwen2.5:14b's context window.
const MAX_CHARS = 40_000;

const SYSTEM_PROMPT = `You are summarizing a document for members of The Griffin Fund, a student-run investment club at Grace Church School. Documents are typically pitch decks, research reports, or financial analyses; occasionally they are meeting minutes or general notes.

Produce a concise summary with this structure, using the exact section headers. Use markdown.

## Thesis
2–3 sentences on the core idea of the document. If it's a pitch/report, the investment thesis. Otherwise, the main topic.

## Key Points
3–5 bullet points covering the most important claims, findings, or conclusions. Be specific — prefer concrete figures and named drivers over generic "positive outlook" language.

## Risks & Caveats
2–4 bullet points on downside scenarios, counterarguments, or limitations named in the doc. If nothing is named, write "None explicitly named in the document." Do not invent risks not mentioned.

## Numbers
Any specific figures that appear — revenue, margins, price targets, dates, allocation sizes. One per line, in the format "**Label:** value". If none, omit this section entirely.

Constraints:
- Stick to what's in the document. Do NOT add external market commentary, industry trivia, or opinions.
- If a section would be empty, omit it entirely (except Risks, which always gets the "none named" note).
- Keep total output under 400 words.
- Plain prose inside each bullet — no nested lists.`;

// Pull the raw bytes for a OneDrive item. Uses the shared access
// token (refreshed on demand) that the rest of oneDriveStorage uses.
async function fetchBuffer(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fetch file bytes failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function fetchItemMetadata(itemId) {
  const token = await getAccessToken();
  const url = `${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Metadata fetch failed (${res.status})`);
  return res.json();
}

// ── Text extraction ─────────────────────────────────────────────────
// PPTX / DOCX are ZIP archives with XML inside. Rather than pulling
// in a heavy Office-doc library, we unzip with jszip and pull text
// from the well-defined text-run tags with a light regex. That
// catches ~99% of real documents — slightly-malformed or image-only
// slides are silently skipped, which is the right behavior.

// Unescape the handful of XML entities that show up in real text.
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Pull `<TAG>...</TAG>` bodies out of XML, in document order.
// self-closing `<TAG/>` tags are ignored (they carry no text).
function extractTagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const decoded = decodeXmlEntities(m[1]).trim();
    if (decoded) out.push(decoded);
  }
  return out;
}

async function extractPptxText(buffer) {
  const JSZipModule = await import('jszip');
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(buffer);
  // Slide files live at ppt/slides/slide<N>.xml. Sort by number so
  // the extracted text reads slide-1-first.
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)[1]);
      const nb = Number(b.match(/slide(\d+)/)[1]);
      return na - nb;
    });
  if (slideFiles.length === 0) {
    throw new Error('PPTX has no slides — file may be corrupt.');
  }
  const parts = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.file(slideFiles[i]).async('string');
    // <a:t> is the DrawingML text-run element used across slides.
    const runs = extractTagText(xml, 'a:t');
    if (runs.length === 0) continue;
    parts.push(`--- Slide ${i + 1} ---\n${runs.join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

async function extractDocxText(buffer) {
  const JSZipModule = await import('jszip');
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) {
    throw new Error('DOCX has no document.xml — file may be corrupt.');
  }
  const xml = await file.async('string');
  // <w:t> is WordprocessingML's text-run element. <w:p> paragraphs
  // get a newline separator so the output reads like the source doc.
  const paragraphs = xml.split(/<\/w:p>/);
  const out = [];
  for (const p of paragraphs) {
    const runs = extractTagText(p, 'w:t');
    if (runs.length > 0) out.push(runs.join(''));
  }
  return out.join('\n').trim();
}

async function extractText(buffer, filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) {
    // pdf-parse is CJS; dynamic import to avoid ESM interop pain.
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const data = await pdfParse(buffer);
    return (data.text || '').trim();
  }
  if (lower.endsWith('.pptx')) {
    return extractPptxText(buffer);
  }
  if (lower.endsWith('.docx')) {
    return extractDocxText(buffer);
  }
  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    return buffer.toString('utf8').trim();
  }
  const err = new Error(
    `Summarization supports PDF / PPTX / DOCX / TXT / MD — got ${filename || 'an unknown type'}.`
  );
  err.code = 'UNSUPPORTED_TYPE';
  throw err;
}

/**
 * Generate (or fetch cached) an AI summary for a OneDrive-hosted
 * file. Returns the full FileSummary row.
 *
 * @param {string} itemId - OneDrive item id (without any scheme prefix)
 * @param {object} opts
 * @param {boolean} opts.force - Regenerate even if a row exists
 */
export async function summarizeFile(itemId, { force = false } = {}) {
  const fileRef = `onedrive:${itemId}`;

  if (!force) {
    const existing = await prisma.fileSummary.findUnique({ where: { fileRef } });
    if (existing) return existing;
  }

  const meta = await fetchItemMetadata(itemId);
  const buffer = await fetchBuffer(itemId);
  const text = await extractText(buffer, meta.name);
  if (!text || text.length < 100) {
    throw new Error(
      `Extracted too little text (${text.length} chars) — the document may be image-only or empty.`
    );
  }

  const truncated = text.length > MAX_CHARS;
  const input = truncated ? text.slice(0, MAX_CHARS) : text;
  const userMsg = truncated
    ? `[Note: document is ${text.length.toLocaleString()} chars; summarizing the first ${MAX_CHARS.toLocaleString()} chars — about the opening portion. Acknowledge at the end if that limits your read.]\n\n${input}`
    : input;

  const summary = await llmChat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.3,
  });
  if (!summary) {
    throw new Error('LLM returned no content — check local Ollama / OpenAI fallback.');
  }

  const modelTag = process.env.LOCAL_LLM_URL ? 'local' : 'openai';

  return prisma.fileSummary.upsert({
    where: { fileRef },
    create: {
      fileRef,
      filename: meta.name || null,
      summary,
      model: modelTag,
      charCount: text.length,
      truncated,
    },
    update: {
      filename: meta.name || null,
      summary,
      model: modelTag,
      charCount: text.length,
      truncated,
    },
  });
}

export async function getCachedSummary(itemId) {
  const fileRef = `onedrive:${itemId}`;
  return prisma.fileSummary.findUnique({ where: { fileRef } });
}
