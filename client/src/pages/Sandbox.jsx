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
import { X, Upload, FileText, BookOpen, Loader2, AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
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
            placeholder="Paste the essay here…"
            className="h-64 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
          />
          <div className="flex items-center justify-between text-xs text-navy/50">
            <span>{essay.length.toLocaleString()} chars · {countWords(essay).toLocaleString()} words</span>
            <button type="button" disabled className="inline-flex items-center gap-1 rounded-md border border-dashed border-navy/20 px-2 py-1 text-navy/40">
              <Upload size={12} /> Upload .docx / .pdf
            </button>
          </div>
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
    </>
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
