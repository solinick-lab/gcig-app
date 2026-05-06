// Sandbox — full-screen scratchpad page for super-admin work in
// progress. Lives outside the Layout wrapper so it gets the entire
// viewport, free of the sidebar and page chrome that would distract
// from whatever's being prototyped here. Currently the home of the
// Grade Predictor project.
//
// The Grade Predictor API is a separate FastAPI service running on
// the Windows server (sandbox/grade_predictor/). This page talks to
// it directly via VITE_GP_API_URL — by default localhost:8001 in
// dev. For prod it should point at a Cloudflare-tunneled hostname
// like grade.thegriffinfund.org.

import { Navigate, useNavigate } from 'react-router-dom';
import { X, Upload, FileText, Sparkles, BookOpen, GraduationCap, Loader2, AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

const GP_API_URL = (import.meta.env.VITE_GP_API_URL || 'http://localhost:8001').replace(/\/$/, '');

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
  const [mode, setMode] = useState('predict'); // 'predict' | 'train'
  const [teachers, setTeachers] = useState([]);
  const [healthError, setHealthError] = useState(null);

  // Probe /health on mount + load teacher list. If the API is
  // unreachable the panel renders a friendly explainer instead of
  // making the buttons silently fail.
  useEffect(() => {
    let alive = true;
    fetch(`${GP_API_URL}/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(() => fetch(`${GP_API_URL}/teachers`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (alive) { setTeachers(data); setHealthError(null); } })
      .catch((err) => { if (alive) setHealthError(err.message || String(err)); });
    return () => { alive = false; };
  }, []);

  function refreshTeachers() {
    fetch(`${GP_API_URL}/teachers`)
      .then((r) => r.json())
      .then(setTeachers)
      .catch(() => {});
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {healthError && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Grade Predictor API not reachable</div>
            <div className="mt-1 text-xs">
              Tried <code>{GP_API_URL}/health</code> — {healthError}.<br />
              Make sure the FastAPI service is running on the Windows server.
              Set <code>VITE_GP_API_URL</code> at build time to point at the
              tunneled hostname for production.
            </div>
          </div>
        </div>
      )}
      {teachers.length > 0 && (
        <div className="rounded-xl border border-navy/10 bg-white p-3 text-xs text-navy/70">
          <span className="font-semibold text-navy">Corpus:</span>{' '}
          {teachers.map((t) => `${t.name} (${t.examples})`).join(' · ')}
        </div>
      )}
      <div className="flex items-center gap-1 rounded-xl border border-navy/10 bg-white p-1 text-sm">
        <ModeButton active={mode === 'predict'} onClick={() => setMode('predict')} icon={Sparkles}>
          Predict a grade
        </ModeButton>
        <ModeButton active={mode === 'train'} onClick={() => setMode('train')} icon={GraduationCap}>
          Train with teacher feedback
        </ModeButton>
      </div>
      {mode === 'predict'
        ? <PredictPanel teachers={teachers} />
        : <TrainPanel onSaved={refreshTeachers} />}
    </div>
  );
}

function ModeButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 font-medium transition ${
        active ? 'bg-navy text-white shadow-sm' : 'text-navy/60 hover:bg-navy/5'
      }`}
    >
      <Icon size={16} />
      {children}
    </button>
  );
}

function PredictPanel({ teachers }) {
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
      const resp = await fetch(`${GP_API_URL}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacher: teacher.trim(),
          essay,
          rubric: rubric.trim() || null,
          top_k: 3,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
      setResult(data.result);
      setMeta({
        examples_used: data.examples_used,
        examples_available: data.examples_available,
      });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const known = teachers.find((t) => t.name.toLowerCase() === teacher.trim().toLowerCase());

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
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Teacher</label>
            <input
              value={teacher}
              onChange={(e) => setTeacher(e.target.value)}
              placeholder="e.g. Dr. Hsu"
              list="known-teachers"
              className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
            <datalist id="known-teachers">
              {teachers.map((t) => <option key={t.name} value={t.name} />)}
            </datalist>
            {teacher && (
              <p className="mt-1 text-[11px] text-navy/50">
                {known
                  ? `${known.examples} prior example${known.examples === 1 ? '' : 's'} from this teacher — used as RAG context.`
                  : "No prior examples for this teacher yet — cold-start prediction will be rubric-only."}
              </p>
            )}
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
            disabled={!essay || !teacher || loading}
            onClick={runPredict}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Generating… (can take 1–5 min)' : 'Predict grade & generate line-by-line comments'}
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
          <span className="font-medium">qwen3.6:27b is thinking…</span>
        </div>
        <p className="mt-2 text-xs text-navy/50">
          Long essays + rubric + retrieved examples make this a heavy prompt.
          Expect a 1–5 minute wall-clock at this VRAM tier.
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
        {meta && (
          <div className="text-[11px] text-navy/50">
            grounded in {meta.examples_used} of {meta.examples_available} prior examples
          </div>
        )}
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

function TrainPanel({ onSaved }) {
  const [essay, setEssay] = useState('');
  const [feedback, setFeedback] = useState('');
  const [grade, setGrade] = useState('');
  const [teacher, setTeacher] = useState('');
  const [rubric, setRubric] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedId, setSavedId] = useState(null);

  async function save() {
    setSaving(true); setError(null); setSavedId(null);
    try {
      const resp = await fetch(`${GP_API_URL}/train`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teacher: teacher.trim(),
          essay,
          feedback,
          grade: grade.trim(),
          rubric: rubric.trim() || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
      setSavedId(data.id);
      setEssay(''); setFeedback(''); setGrade(''); setRubric('');
      // Keep teacher set so back-to-back uploads for the same
      // teacher don't require retyping the name.
      onSaved && onSaved();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
        <header className="flex items-start gap-3">
          <FileText className="mt-1 shrink-0 text-gold" size={20} />
          <div>
            <h2 className="text-base font-semibold text-navy">Original essay</h2>
            <p className="text-xs text-navy/60">The version you submitted to the teacher.</p>
          </div>
        </header>
        <textarea
          value={essay}
          onChange={(e) => setEssay(e.target.value)}
          placeholder="Paste the original essay…"
          className="h-64 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
        />
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Rubric (optional)</label>
          <textarea
            value={rubric}
            onChange={(e) => setRubric(e.target.value)}
            placeholder="If the assignment had a rubric, paste it here so future predictions can break out criteria."
            className="mt-1 h-24 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
          />
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-navy/10 bg-white p-6 shadow-sm">
        <header className="flex items-start gap-3">
          <GraduationCap className="mt-1 shrink-0 text-gold" size={20} />
          <div>
            <h2 className="text-base font-semibold text-navy">What the teacher said</h2>
            <p className="text-xs text-navy/60">Both the line-by-line comments and the final grade.</p>
          </div>
        </header>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Teacher</label>
            <input
              value={teacher}
              onChange={(e) => setTeacher(e.target.value)}
              placeholder="e.g. Dr. Hsu"
              className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Final grade</label>
            <input
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="e.g. 92, A-, 4/5"
              className="mt-1 w-full rounded-lg border border-navy/15 px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wider text-navy/60">Comments / feedback</label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Paste every margin note, end-comment, rubric scoring…"
            className="mt-1 h-40 w-full resize-none rounded-lg border border-navy/15 px-3 py-2 text-sm leading-relaxed focus:border-gold focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={!essay || !feedback || !grade || !teacher || saving}
          onClick={save}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? 'Saving…' : 'Save training example'}
        </button>
        {error && (
          <p className="text-[11px] text-red-700">{error}</p>
        )}
        {savedId !== null && !error && (
          <p className="text-[11px] text-emerald-700">
            Saved as example #{savedId}. Form cleared (teacher kept). Add another?
          </p>
        )}
        <p className="text-[11px] text-navy/40">
          Saved examples accumulate per teacher in the local SQLite at sandbox/data/grade_predictor.db.
        </p>
      </section>
    </div>
  );
}

function countWords(s) {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
