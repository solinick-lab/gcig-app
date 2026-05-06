// Sandbox — full-screen scratchpad page for super-admin work in
// progress. Lives outside the Layout wrapper so it gets the entire
// viewport, free of the sidebar and page chrome that would distract
// from whatever's being prototyped here. Currently the home of the
// Grade Predictor project.
//
// The Grade Predictor talks to the gcig-api at /api/sandbox/grade-predictor/*,
// which fans out to the shared LLM client (qwen2.5:14b on the Cloudflare-
// tunneled local Ollama, with OpenAI fallback). No separate FastAPI
// service to babysit. Training corpus + per-teacher RAG come later;
// this is the cold-start prediction path only.

import { Navigate, useNavigate } from 'react-router-dom';
import { X, Upload, FileText, BookOpen, Loader2, AlertCircle, GraduationCap, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';

export default function Sandbox() {
  const { isSuperAdmin, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) return null;
  if (!isSuperAdmin) return <Navigate to="/dashboard" replace />;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <header className="flex items-center justify-between border-b border-navy/10 px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-md bg-gold/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-gold">
            Sandbox
          </span>
          <h1 className="text-lg font-semibold text-navy">Grade Predictor</h1>
          <span className="text-xs text-navy/40">work in progress</span>
        </div>
        <button
          type="button"
          onClick={() => navigate('/admin')}
          className="rounded-full p-2 text-navy/60 hover:bg-navy/5 hover:text-navy"
          aria-label="Close sandbox"
          title="Close sandbox"
        >
          <X size={20} />
        </button>
      </header>
      <main className="flex-1 overflow-auto bg-navy/[0.02] px-6 py-8">
        <GradePredictor />
      </main>
    </div>
  );
}

// ─── Grade Predictor scaffold ──────────────────────────────────────────
// The shape of the project as Thomas described it:
//
//   1. Student submits an essay (paste text or upload .docx / .pdf)
//      and optionally an assignment rubric.
//   2. Once the teacher returns the essay graded, the student feeds
//      the teacher's feedback + final grade back in. That tuple
//      (essay, feedback, grade, teacher) is training data.
//   3. As the corpus grows, the model learns each teacher's grading
//      style and rubric weighting. A per-teacher profile builds up.
//   4. For new essays, the model produces line-by-line comments in
//      the style of the named teacher, plus a grade prediction. If
//      a rubric is supplied up front, the prediction is broken out
//      by criterion.
//
// This component lays out the entry surfaces. No backend wiring yet
// — buttons are inert. The upstream pipeline lives at
// `~/Desktop/gcig-app/sandbox/` (separate from gcig-app's React+API
// stack so the model code, training data, and any heavy ML deps can
// stay isolated).

function GradePredictor() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);

  // Probe /health on mount so the panel can show which provider is
  // active (local Ollama vs OpenAI fallback) and surface a friendly
  // banner when neither is reachable.
  useEffect(() => {
    let alive = true;
    api
      .get('/sandbox/grade-predictor/health')
      .then((r) => { if (alive) { setHealth(r.data); setHealthError(null); } })
      .catch((err) => {
        if (alive) setHealthError(err.response?.data?.error || err.message || String(err));
      });
    return () => { alive = false; };
  }, []);

  const llmDown = health && !health.active;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {(healthError || llmDown) && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">LLM not reachable</div>
            <div className="mt-1 text-xs">
              {healthError
                ? <>Health check failed — {healthError}.</>
                : <>Both the local Ollama tunnel and the OpenAI fallback are unavailable.</>}
            </div>
          </div>
        </div>
      )}
      {health?.active && (
        <div className="rounded-xl border border-navy/10 bg-white p-3 text-xs text-navy/70">
          <span className="font-semibold text-navy">Model:</span>{' '}
          {health.active === 'local'
            ? <>local Ollama · <code>{health.local?.model}</code> · {health.local?.latencyMs}ms</>
            : <>OpenAI · <code>{health.openai?.model}</code> · {health.openai?.latencyMs}ms</>}
        </div>
      )}
      <PredictPanel />
    </div>
  );
}

function PredictPanel() {
  const [essay, setEssay] = useState('');
  const [rubric, setRubric] = useState('');
  const [teacher, setTeacher] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [meta, setMeta] = useState(null);
  // Comments extracted from an uploaded .docx (Word review comments).
  // Surfaced as a chip on the essay card and pre-fed into the
  // SaveActualFeedback panel once the prediction renders.
  const [docComments, setDocComments] = useState([]);
  const [uploading, setUploading] = useState(false);

  async function handleDocxUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same filename
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      setError('Only .docx files are supported.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post(
        '/sandbox/grade-predictor/parse-docx',
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      if (data.text) setEssay(data.text);
      setDocComments(Array.isArray(data.comments) ? data.comments : []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to parse .docx');
    } finally {
      setUploading(false);
    }
  }

  async function runPredict() {
    setLoading(true); setError(null); setResult(null); setMeta(null);
    try {
      const { data } = await api.post('/sandbox/grade-predictor/predict', {
        teacher: teacher.trim(),
        essay,
        rubric: rubric.trim() || null,
      });
      setResult(data.result);
      setMeta({
        examples_used: data.examples_used,
        examples_available: data.examples_available,
      });
    } catch (e) {
      setError(e.response?.data?.error || e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
          <header className="flex items-start gap-3">
            <FileText className="mt-1 shrink-0 text-gold" size={20} />
            <div>
              <h2 className="text-base font-semibold text-navy">Essay</h2>
              <p className="text-xs text-navy/60">Paste the full essay text. File upload coming.</p>
            </div>
          </header>
          <textarea
            value={essay}
            onChange={(e) => setEssay(e.target.value)}
            placeholder="Paste the essay here, or upload a .docx →"
            className="h-64 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
          />
          <div className="flex items-center justify-between text-xs text-navy/50">
            <span>{essay.length.toLocaleString()} chars · {countWords(essay).toLocaleString()} words</span>
            <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-navy/30 px-2 py-1 text-navy/70 hover:border-gold hover:text-navy">
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {uploading ? 'Parsing…' : 'Upload .docx'}
              <input
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleDocxUpload}
                className="hidden"
              />
            </label>
          </div>
          {docComments.length > 0 && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-900">
              Extracted {docComments.length} teacher comment{docComments.length === 1 ? '' : 's'} from the .docx.
              They'll be pre-filled in the training-data panel below the prediction.
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
          <header className="flex items-start gap-3">
            <BookOpen className="mt-1 shrink-0 text-gold" size={20} />
            <div>
              <h2 className="text-base font-semibold text-navy">Context (optional)</h2>
              <p className="text-xs text-navy/60">A rubric and the grading teacher both improve the prediction.</p>
            </div>
          </header>
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Teacher (optional)</label>
            <input
              value={teacher}
              onChange={(e) => setTeacher(e.target.value)}
              placeholder="e.g. Dr. Hsu"
              className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-navy/50">
              Per-teacher RAG comes later. For now, every prediction is cold-start.
            </p>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Assignment rubric</label>
            <textarea
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
              placeholder="Paste the rubric, or leave blank for an open-ended grade prediction…"
              className="mt-1 h-32 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={!essay || loading}
            onClick={runPredict}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Generating…' : 'Predict grade & generate line-by-line comments'}
          </button>
          {error && (
            <p className="text-[11px] text-red-700">{error}</p>
          )}
        </section>
      </div>
      {(loading || result) && (
        <ResultPanel loading={loading} result={result} meta={meta} essay={essay} />
      )}
      {result && !result._parse_error && (
        <SaveActualFeedback
          essay={essay}
          rubric={rubric}
          teacher={teacher}
          predictedGrade={result.grade || ''}
          predictedFeedback={result.overall_feedback || ''}
          initialFeedback={formatExtractedComments(docComments)}
        />
      )}
    </>
  );
}

// Data-collection panel. Shown below the prediction so the student can
// come back when their teacher returns the paper, paste the real grade
// + comments, and have it land in the training corpus alongside the
// prediction the model originally made. Reuses the essay + teacher +
// rubric the student typed in above so they don't have to retype them.
function SaveActualFeedback({ essay, rubric, teacher, predictedGrade, predictedFeedback, initialFeedback }) {
  const [feedback, setFeedback] = useState(initialFeedback || '');
  const [grade, setGrade] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedId, setSavedId] = useState(null);

  // If the user uploads a .docx after the prediction is already on
  // screen, refresh the feedback field with the freshly-extracted
  // comments — but only while it's empty or unchanged from the last
  // auto-fill, so we don't clobber typing they've done in the meantime.
  const lastInitialRef = useRef(initialFeedback || '');
  useEffect(() => {
    if (!initialFeedback) return;
    if (feedback === '' || feedback === lastInitialRef.current) {
      setFeedback(initialFeedback);
      lastInitialRef.current = initialFeedback;
    }
  }, [initialFeedback]);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedId(null);
    try {
      const { data } = await api.post('/sandbox/grade-predictor/train', {
        essay,
        teacher: teacher.trim() || null,
        rubric: rubric.trim() || null,
        feedback,
        grade: grade.trim(),
        predictedGrade,
        predictedFeedback,
      });
      setSavedId(data.id);
      setFeedback('');
      setGrade('');
    } catch (e) {
      setError(e.response?.data?.error || e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  if (savedId !== null) {
    return (
      <section className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900">
        <Check size={18} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold">Saved to the training corpus</div>
          <div className="mt-1 text-xs">
            Example #{savedId}. The next iteration of the predictor will use
            this {teacher ? `as ${teacher}'s grading style` : 'as cold-start training data'}.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
      <header className="flex items-start gap-3">
        <GraduationCap className="mt-1 shrink-0 text-gold" size={20} />
        <div>
          <h2 className="text-base font-semibold text-navy">
            Got the paper back? Save the actual feedback
          </h2>
          <p className="text-xs text-navy/60">
            Optional, but it builds the per-teacher training corpus the next
            iteration of the predictor will use.
          </p>
        </div>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Final grade</label>
          <input
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            placeholder="e.g. A-, 92, 4/5"
            className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
          />
        </div>
        <div className="flex items-end text-[11px] text-navy/50">
          {teacher ? <>Saving under <code className="ml-1">{teacher}</code></> : 'No teacher set — saved as untagged'}
        </div>
      </div>
      <div>
        <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Teacher's comments</label>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Paste every margin note, end-comment, rubric scoring…"
          className="mt-1 h-40 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
        />
      </div>
      <button
        type="button"
        disabled={!feedback || !grade || saving}
        onClick={save}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {saving ? 'Saving…' : 'Save as training example'}
      </button>
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </section>
  );
}

function ResultPanel({ loading, result, meta, essay }) {
  if (loading) {
    return (
      <section className="rounded-2xl border border-navy/10 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3 text-navy">
          <Loader2 className="animate-spin" size={20} />
          <span className="font-medium">qwen2.5:14b is thinking…</span>
        </div>
        <p className="mt-2 text-xs text-navy/50">
          Calls the shared local LLM (with OpenAI fallback). Usually 10–60s on
          this model size.
        </p>
      </section>
    );
  }
  if (!result) return null;
  if (result._parse_error) {
    return (
      <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
        <div className="font-semibold text-amber-900">Couldn't parse the model's response as JSON</div>
        <div className="mt-1 text-xs text-amber-800">{result._parse_error}</div>
        <pre className="mt-3 max-h-96 overflow-auto rounded bg-white/60 p-3 text-xs text-amber-900">{result._raw}</pre>
      </section>
    );
  }
  return (
    <section className="space-y-5 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
      <header className="flex items-baseline justify-between gap-4 border-b border-navy/10 pb-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-navy/50">Predicted grade</div>
          <div className="mt-1 text-3xl font-semibold text-navy">{result.grade || '—'}</div>
        </div>
      </header>

      {result.overall_feedback && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-navy/60">Overall feedback</div>
          <p className="mt-1 text-sm leading-relaxed text-navy">{result.overall_feedback}</p>
        </div>
      )}

      {Array.isArray(result.line_by_line) && result.line_by_line.length > 0 && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-navy/60">Line-by-line comments</div>
          <div className="mt-2 space-y-3">
            {result.line_by_line.map((c, i) => (
              <div key={i} className="rounded-lg border border-navy/10 bg-navy/[0.02] p-3">
                <div className="text-xs italic text-navy/70">"{c.quote}"</div>
                <div className="mt-1 text-sm text-navy">{c.comment}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.rubric_breakdown && typeof result.rubric_breakdown === 'object' && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-navy/60">Rubric breakdown</div>
          <div className="mt-2 space-y-2">
            {Object.entries(result.rubric_breakdown).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-navy/10 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-navy/60">{k}</div>
                <div className="mt-0.5 text-sm text-navy">{String(v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function countWords(s) {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

// Render a list of {author, date, text} comments pulled from a .docx
// into a single string the user can sanity-check before saving as
// training data. Author tags up front so the corpus doesn't lose
// "who said what" if the same paper went through multiple readers.
function formatExtractedComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return '';
  return comments
    .map((c) => {
      const tag = c.author ? `[${c.author}]` : '[comment]';
      return `${tag} ${c.text}`.trim();
    })
    .join('\n\n');
}
