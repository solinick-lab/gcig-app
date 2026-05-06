// Grade Predictor — full-screen page rendered outside the Layout wrapper
// so the editor + result panel get the whole viewport. Open to every
// logged-in member of the club; reachable from the sidebar.
//
// The chrome is a port of HenriFiszel1/ot-ai's Optimize-Teacher-AI design
// language — dark #141414 surface, #6398FF accent, GPTZero-style split
// editor with a context sidebar. The wire is unchanged: gcig-api at
// /api/sandbox/grade-predictor/*, which fans out to the shared LLM client
// (qwen2.5:7b on the Cloudflare-tunneled local Ollama, with OpenAI
// fallback). Per-teacher RAG over (essay, real teacher feedback, real
// grade) tuples stored in Postgres; .docx upload archives the original
// to OneDrive and pre-extracts review comments into the training panel.

import { Navigate, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Brain,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Lightbulb,
  Loader2,
  MessageSquare,
  PenLine,
  Plus,
  Send,
  Star,
  Target,
  Upload,
  User,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';

// Palette pulled from the ot-ai reference. Inline rather than threaded
// into Tailwind config because this page is the only surface that wears
// it — the rest of gcig stays navy/gold.
const C = {
  bg: '#141414',
  surface: 'rgba(255,255,255,0.03)',
  surfaceHover: 'rgba(255,255,255,0.05)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.18)',
  text: '#F2F2FF',
  textMute: 'rgba(255,255,255,0.55)',
  textFaint: 'rgba(255,255,255,0.30)',
  accent: '#6398FF',
  accentSoft: 'rgba(99,152,255,0.10)',
  accentBorder: 'rgba(99,152,255,0.30)',
};

export default function Sandbox() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: C.bg, color: C.text }}>
      <GradePredictor onClose={() => navigate('/dashboard')} />
    </div>
  );
}

// ─── Top-level shell ──────────────────────────────────────────────────
//
// The shape of the project as Thomas described it:
//
//   1. Student submits an essay (paste text or upload .docx) and
//      optionally an assignment rubric.
//   2. Once the teacher returns the essay graded, the student feeds
//      the teacher's feedback + final grade back in. That tuple
//      (essay, feedback, grade, teacher) is training data.
//   3. As the corpus grows, the model learns each teacher's grading
//      style and rubric weighting. A per-teacher profile builds up.
//   4. For new essays, the model produces line-by-line comments in
//      the style of the named teacher, plus a grade prediction.

function GradePredictor({ onClose }) {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [teachers, setTeachers] = useState([]);

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

  const refreshTeachers = useCallback(() => {
    api
      .get('/sandbox/grade-predictor/teachers')
      .then((r) => setTeachers(Array.isArray(r.data) ? r.data : []))
      .catch(() => setTeachers([]));
  }, []);
  useEffect(() => { refreshTeachers(); }, [refreshTeachers]);

  const llmDown = health && !health.active;

  return (
    <>
      <Header health={health} onClose={onClose} />
      {(healthError || llmDown) && (
        <div
          className="px-6 py-2.5 text-xs flex items-center gap-2 flex-shrink-0"
          style={{ background: 'rgba(239,68,68,0.08)', color: '#fca5a5', borderBottom: '1px solid rgba(239,68,68,0.15)' }}
        >
          <AlertCircle size={14} />
          <span>
            <span className="font-semibold">LLM unreachable.</span>{' '}
            {healthError
              ? <>Health check failed — {healthError}.</>
              : <>Both the local Ollama tunnel and the OpenAI fallback are unavailable.</>}
          </span>
        </div>
      )}
      <PredictPanel teachers={teachers} onSaved={refreshTeachers} />
    </>
  );
}

function Header({ health, onClose }) {
  return (
    <header
      className="flex items-center justify-between px-6 h-14 flex-shrink-0"
      style={{ borderBottom: `1px solid ${C.border}` }}
    >
      <div className="flex items-center gap-3">
        <span
          className="text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-md"
          style={{ background: C.accentSoft, color: C.accent }}
        >
          Beta
        </span>
        <span className="text-sm font-semibold" style={{ color: C.text }}>
          Grade Predictor
        </span>
      </div>

      {health?.active && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
          style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMute }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: health.active === 'local' ? '#4ade80' : '#fbbf24' }}
          />
          {health.active === 'local'
            ? <>local · <code style={{ color: C.text }}>{health.local?.model}</code> · {health.local?.latencyMs}ms</>
            : <>openai · <code style={{ color: C.text }}>{health.openai?.model}</code> · {health.openai?.latencyMs}ms</>}
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        className="rounded-full p-2 transition-colors"
        style={{ color: C.textFaint }}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.surfaceHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        aria-label="Close"
        title="Close"
      >
        <X size={18} />
      </button>
    </header>
  );
}

function PredictPanel({ teachers, onSaved }) {
  // 'recent' (default landing) | 'editor' (compose new) | a result is
  // shown when `result` is set regardless of view.
  const [view, setView] = useState('recent');
  const [essay, setEssay] = useState('');
  const [rubric, setRubric] = useState('');
  const [teacher, setTeacher] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [meta, setMeta] = useState(null);

  // Recent essays (own analyses) — landing view.
  const [recent, setRecent] = useState(null); // null = not loaded yet
  const [recentError, setRecentError] = useState(null);
  const [openingId, setOpeningId] = useState(null);

  // Comments extracted from an uploaded .docx (Word review comments).
  // Surfaced as a chip on the upload bar and pre-fed into the
  // SaveActualFeedback panel once the prediction renders.
  const [docComments, setDocComments] = useState([]);
  const [uploading, setUploading] = useState(false);
  // OneDrive item ID + webUrl for the just-uploaded .docx, threaded
  // through to the training-data save so the corpus row points at
  // the original file.
  const [docFileRef, setDocFileRef] = useState(null);
  const [docFileUrl, setDocFileUrl] = useState(null);

  const known = teachers?.find(
    (t) => t.name.toLowerCase() === teacher.trim().toLowerCase()
  );

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
      setDocFileRef(data.fileRef || null);
      setDocFileUrl(data.fileUrl || null);
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

  function startNew() {
    setEssay('');
    setRubric('');
    setResult(null);
    setMeta(null);
    setDocComments([]);
    setDocFileRef(null);
    setDocFileUrl(null);
    setError(null);
    setView('editor');
  }

  function backToRecent() {
    setEssay('');
    setRubric('');
    setResult(null);
    setMeta(null);
    setDocComments([]);
    setDocFileRef(null);
    setDocFileUrl(null);
    setError(null);
    setView('recent');
    refreshRecent();
  }

  const refreshRecent = useCallback(() => {
    setRecentError(null);
    api
      .get('/sandbox/grade-predictor/analyses?limit=30')
      .then((r) => setRecent(Array.isArray(r.data) ? r.data : []))
      .catch((err) => {
        setRecent([]);
        setRecentError(err.response?.data?.error || err.message || String(err));
      });
  }, []);

  useEffect(() => { refreshRecent(); }, [refreshRecent]);

  async function openAnalysis(id) {
    setOpeningId(id);
    setError(null);
    try {
      const { data } = await api.get(`/sandbox/grade-predictor/analyses/${id}`);
      setEssay(data.essay || '');
      setRubric(data.rubric || '');
      setTeacher(data.teacher || '');
      setResult(data.result || null);
      setMeta({
        examples_used: data.examples_used,
        examples_available: data.examples_available,
      });
      setDocFileUrl(data.essay_file_url || null);
      setDocFileRef(null);
      setDocComments([]);
    } catch (e) {
      setError(e.response?.data?.error || e.message || String(e));
    } finally {
      setOpeningId(null);
    }
  }

  if (loading) {
    return <SubmittingOverlay teacher={teacher} known={known} />;
  }

  if (result) {
    return (
      <ResultView
        result={result}
        meta={meta}
        teacher={teacher}
        rubric={rubric}
        essay={essay}
        docComments={docComments}
        docFileRef={docFileRef}
        docFileUrl={docFileUrl}
        onNew={startNew}
        onBack={backToRecent}
        onSaved={() => { onSaved?.(); refreshRecent(); }}
      />
    );
  }

  if (view === 'recent') {
    return (
      <RecentEssaysView
        recent={recent}
        recentError={recentError}
        openingId={openingId}
        onOpen={openAnalysis}
        onNew={() => setView('editor')}
      />
    );
  }

  return (
    <EditorView
      essay={essay}
      setEssay={setEssay}
      rubric={rubric}
      setRubric={setRubric}
      teacher={teacher}
      setTeacher={setTeacher}
      teachers={teachers}
      known={known}
      uploading={uploading}
      onUpload={handleDocxUpload}
      docComments={docComments}
      docFileUrl={docFileUrl}
      onSubmit={runPredict}
      onBack={() => setView('recent')}
      error={error}
    />
  );
}

// ─── Editor view (split panel) ────────────────────────────────────────

function EditorView({
  essay, setEssay, rubric, setRubric, teacher, setTeacher, teachers, known,
  uploading, onUpload, docComments, docFileUrl, onSubmit, onBack, error,
}) {
  const [rubricExpanded, setRubricExpanded] = useState(false);
  const fileInputRef = useRef(null);

  const wordCount = useMemo(() => (essay.trim() ? essay.trim().split(/\s+/).length : 0), [essay]);
  const canSubmit = essay.trim().length > 50;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Left: editor ─────────────────────────────────────────── */}
      <div
        className="flex flex-col flex-1 min-w-0"
        style={{ borderRight: `1px solid ${C.border}` }}
      >
        {error && (
          <div
            className="px-6 py-2.5 text-sm flex-shrink-0"
            style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
          >
            {error}
          </div>
        )}

        {/* Rubric collapsible */}
        <div style={{ borderBottom: `1px solid ${C.border}` }}>
          <CollapseHeader
            label="Assignment rubric"
            preview={rubric && !rubricExpanded ? rubric.slice(0, 80) + (rubric.length > 80 ? '…' : '') : null}
            badge={!rubric ? { text: 'optional', tone: 'mute' } : null}
            expanded={rubricExpanded}
            onToggle={() => setRubricExpanded(!rubricExpanded)}
          />
          {rubricExpanded && (
            <div className="px-5 pb-4">
              <textarea
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                placeholder="Paste the rubric so the prediction can break out by criterion. Optional."
                className="w-full p-3 rounded-lg text-sm bg-transparent focus:outline-none resize-none transition-colors"
                style={{ border: `1px solid ${C.border}`, color: C.text, minHeight: 80 }}
                onFocus={(e) => (e.target.style.borderColor = C.borderStrong)}
                onBlur={(e) => (e.target.style.borderColor = C.border)}
              />
            </div>
          )}
        </div>

        {/* Essay textarea fills the rest */}
        <div className="flex-1 overflow-hidden">
          <textarea
            value={essay}
            onChange={(e) => setEssay(e.target.value)}
            placeholder="Paste the essay here, or upload a .docx in the bottom bar →"
            className="w-full h-full p-6 bg-transparent text-sm leading-7 focus:outline-none resize-none"
            style={{ color: '#E8E8F0' }}
          />
        </div>

        {/* Bottom action bar */}
        <div
          className="px-6 py-3 flex items-center justify-between flex-shrink-0 gap-4"
          style={{ borderTop: `1px solid ${C.border}` }}
        >
          <div className="flex items-center gap-3 text-xs flex-wrap" style={{ color: C.textFaint }}>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="flex items-center gap-1.5 transition-opacity hover:opacity-100"
                style={{ color: C.textMute }}
              >
                <ArrowLeft size={12} /> Recent essays
              </button>
            )}
            {onBack && <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>}
            <span className="tabular-nums">
              {wordCount.toLocaleString()} {wordCount === 1 ? 'word' : 'words'}
            </span>
            {wordCount > 0 && wordCount < 100 && (
              <span style={{ color: '#fbbf24' }}>· short essays may be less accurate</span>
            )}
            {docComments.length > 0 && (
              <span style={{ color: '#4ade80' }}>
                · {docComments.length} comment{docComments.length === 1 ? '' : 's'} extracted
              </span>
            )}
            {docFileUrl && (
              <a
                href={docFileUrl}
                target="_blank"
                rel="noreferrer"
                className="underline transition-opacity hover:opacity-80"
                style={{ color: C.textMute }}
              >
                · view original on OneDrive
              </a>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Upload control. Using a button + ref + truly hidden input
                rather than the label-wraps-input pattern; on macOS Safari
                the latter sometimes leaves the native picker's Upload
                button disabled even after a file is selected. The
                accept filter is a single extension token for the same
                reason — adding the MIME type alongside .docx made the
                picker pickier in practice, not more permissive. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="h-9 px-3 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: C.surface, color: C.textMute, border: `1px solid ${C.border}` }}
              onMouseEnter={(e) => !uploading && (e.currentTarget.style.background = C.surfaceHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = C.surface)}
            >
              {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {uploading ? 'Parsing…' : 'Upload .docx'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              onChange={onUpload}
              style={{ display: 'none' }}
            />
            <button
              type="button"
              disabled={!canSubmit}
              onClick={onSubmit}
              className="h-9 px-5 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: C.text, color: C.bg }}
            >
              <Send size={13} /> Analyze
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: context sidebar ─────────────────────────────── */}
      <aside className="w-[320px] flex-shrink-0 overflow-y-auto" style={{ background: 'rgba(255,255,255,0.012)' }}>
        <div className="p-6 space-y-6">
          <SidebarSection label="Grading Model">
            <div
              className="p-4 rounded-xl space-y-3"
              style={{ background: C.surface, border: `1px solid ${C.border}` }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: C.accentSoft }}
                >
                  <User size={14} style={{ color: C.accent }} />
                </div>
                <div className="min-w-0 flex-1">
                  <input
                    value={teacher}
                    onChange={(e) => setTeacher(e.target.value)}
                    placeholder="Teacher name (optional)"
                    list="known-teachers"
                    className="w-full bg-transparent text-sm font-medium focus:outline-none"
                    style={{ color: C.text }}
                  />
                  <datalist id="known-teachers">
                    {teachers?.map((t) => <option key={t.name} value={t.name} />)}
                  </datalist>
                  <div className="text-[11px] mt-0.5" style={{ color: C.textFaint }}>
                    {teacher.trim()
                      ? known
                        ? <>
                            <FileText size={10} className="inline -mt-0.5 mr-0.5" />
                            {known.examples} prior {known.examples === 1 ? 'essay' : 'essays'} — RAG uses all of them (oldest dropped only if the prompt would overflow)
                          </>
                        : <span style={{ color: '#fbbf24' }}>Cold start — no prior examples for {teacher.trim()}</span>
                      : 'Leave empty for an untagged cold-start prediction'}
                  </div>
                </div>
              </div>
            </div>
            {teachers.length > 0 && (
              <div className="mt-3 text-[11px]" style={{ color: C.textFaint }}>
                <span className="font-semibold" style={{ color: C.textMute }}>Corpus:</span>{' '}
                {teachers.map((t) => `${t.name} (${t.examples})`).join(' · ')}
              </div>
            )}
          </SidebarSection>

          <SidebarSection label="Ready to analyze">
            <div
              className="p-4 rounded-xl space-y-2.5"
              style={{ background: C.surface, border: `1px solid ${C.border}` }}
            >
              <ChecklistRow ok={essay.trim().length > 50} label="Essay text pasted" />
              <ChecklistRow ok={!!teacher.trim() && !!known} label={`Teacher matched in corpus`} optional />
              <ChecklistRow ok={!!rubric.trim()} label="Rubric added" optional />
            </div>
          </SidebarSection>

          <SidebarSection label="What you'll get">
            <div className="space-y-2.5 text-xs" style={{ color: C.textMute }}>
              <BulletRow color="#4ade80" label="Predicted grade" />
              <BulletRow color={C.accent} label="Line-by-line comments throughout the essay" />
              <BulletRow color="#fbbf24" label="End comment in the teacher's voice" />
              {rubric && <BulletRow color="rgba(255,255,255,0.4)" label="Rubric breakdown by criterion" />}
            </div>
          </SidebarSection>

          <p className="text-[11px] leading-relaxed" style={{ color: C.textFaint }}>
            After the prediction renders, paste the real grade + feedback when
            your teacher returns the paper. That tuple becomes training data
            and tightens the next prediction for this teacher.
          </p>
        </div>
      </aside>
    </div>
  );
}

function CollapseHeader({ label, badge, preview, expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full px-5 py-3 flex items-center justify-between transition-colors"
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.015)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span className="flex items-center gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.textMute }}>
          {label}
        </span>
        {badge && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{
              background: badge.tone === 'warn' ? 'rgba(251,191,36,0.10)' : 'rgba(255,255,255,0.06)',
              color: badge.tone === 'warn' ? 'rgba(251,191,36,0.7)' : C.textFaint,
            }}
          >
            {badge.text}
          </span>
        )}
        {preview && (
          <span className="text-xs truncate max-w-[360px]" style={{ color: C.textFaint }}>
            {preview}
          </span>
        )}
      </span>
      <ChevronDown
        size={13}
        style={{
          color: C.textFaint,
          transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
        }}
      />
    </button>
  );
}

function SidebarSection({ label, children }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: C.textFaint }}>
        {label}
      </p>
      {children}
    </div>
  );
}

function ChecklistRow({ ok, label, optional }) {
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: ok ? '#4ade80' : 'rgba(255,255,255,0.15)' }}
      />
      <span style={{ color: ok ? C.textMute : C.textFaint }}>
        {label}{optional && <span style={{ color: C.textFaint }}> · optional</span>}
      </span>
    </div>
  );
}

function BulletRow({ color, label }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function SubmittingOverlay({ teacher, known }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div
          className="w-12 h-12 mx-auto rounded-full flex items-center justify-center animate-pulse"
          style={{ background: 'rgba(255,255,255,0.06)' }}
        >
          <Brain size={22} style={{ color: 'rgba(255,255,255,0.6)' }} />
        </div>
        <div>
          <div className="text-base font-medium" style={{ color: C.text }}>
            Analyzing essay…
          </div>
          <p className="mt-2 text-xs" style={{ color: C.textMute }}>
            {teacher.trim() && known
              ? <>Building feedback in {teacher.trim()}&apos;s style. </>
              : 'Cold-start prediction — no prior examples for this teacher. '}
            Calls the shared local LLM (with OpenAI fallback). Usually 10–60s.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Result view ──────────────────────────────────────────────────────

function ResultView({
  result, meta, teacher, rubric, essay, docComments, docFileRef, docFileUrl,
  onNew, onBack, onSaved,
}) {
  if (result?._parse_error) {
    return (
      <div className="flex-1 overflow-auto px-6 py-10">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-xl p-5"
            style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.20)' }}
          >
            <div className="font-semibold text-sm" style={{ color: '#fbbf24' }}>
              Couldn&apos;t parse the model&apos;s response as JSON
            </div>
            <div className="mt-1 text-xs" style={{ color: 'rgba(251,191,36,0.7)' }}>
              {result._parse_error}
            </div>
            <pre
              className="mt-3 max-h-[400px] overflow-auto rounded p-3 text-xs"
              style={{ background: 'rgba(0,0,0,0.3)', color: C.textMute }}
            >{result._raw}</pre>
            <button
              type="button"
              onClick={onNew}
              className="mt-4 h-9 px-4 rounded-lg text-xs font-semibold"
              style={{ background: C.text, color: C.bg }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const lineByLine = Array.isArray(result?.line_by_line) ? result.line_by_line : [];
  const counts = lineByLine.reduce(
    (acc, c) => {
      const sev = (c.severity || 'suggestion').toLowerCase();
      if (sev in acc) acc[sev]++;
      else acc.suggestion++;
      return acc;
    },
    { praise: 0, suggestion: 0, concern: 0 },
  );
  const wordCount = essay.trim() ? essay.trim().split(/\s+/).length : 0;
  const paragraphs = essay.split('\n\n').filter((p) => p.trim());
  const conf = (result?.confidence || '').toLowerCase();
  const letter = result?.letter_grade || result?.grade || '—';
  const numeric = result?.numeric_grade ?? null;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Back / new-essay links */}
        <div className="flex items-center gap-4 text-xs">
          <button
            type="button"
            onClick={onBack || onNew}
            className="flex items-center gap-1.5 transition-opacity hover:opacity-80"
            style={{ color: C.textMute }}
          >
            <ArrowLeft size={12} /> {onBack ? 'Recent essays' : 'Back'}
          </button>
          {onBack && (
            <button
              type="button"
              onClick={onNew}
              className="flex items-center gap-1.5 transition-opacity hover:opacity-80"
              style={{ color: C.textMute }}
            >
              <Plus size={12} /> New essay
            </button>
          )}
        </div>

        {/* Grade hero */}
        <div className="rounded-2xl p-7" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="flex items-center gap-6">
              <div className="text-center">
                <div className="text-5xl font-semibold tracking-tight" style={{ color: C.text }}>
                  {letter}
                </div>
                {numeric != null && (
                  <div className="text-base mt-1" style={{ color: C.textMute }}>
                    {numeric}/100
                  </div>
                )}
              </div>
              <div className="w-px h-14 hidden lg:block" style={{ background: C.border }} />
              <div>
                <div className="text-sm" style={{ color: C.textMute }}>
                  Predicted grade{teacher.trim() && <> — in <span className="font-medium" style={{ color: C.text }}>{teacher.trim()}</span>&apos;s style</>}
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {conf && (
                    <span
                      className="text-[11px] px-2 py-0.5 rounded-full font-medium capitalize"
                      style={confidenceStyle(conf)}
                    >
                      {conf} confidence
                    </span>
                  )}
                  {meta && (
                    <span className="text-[11px]" style={{ color: C.textFaint }}>
                      {meta.examples_used > 0
                        ? <>RAG · grounded in {meta.examples_used} of {meta.examples_available} prior {meta.examples_available === 1 ? 'example' : 'examples'}</>
                        : 'Cold-start prediction'}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {(counts.praise + counts.suggestion + counts.concern) > 0 && (
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="flex items-center gap-1.5" style={{ color: '#4ade80' }}>
                  <Star size={14} /> {counts.praise} {counts.praise === 1 ? 'strength' : 'strengths'}
                </span>
                <span className="flex items-center gap-1.5" style={{ color: '#fbbf24' }}>
                  <Lightbulb size={14} /> {counts.suggestion} {counts.suggestion === 1 ? 'suggestion' : 'suggestions'}
                </span>
                <span className="flex items-center gap-1.5" style={{ color: '#f87171' }}>
                  <AlertTriangle size={14} /> {counts.concern} {counts.concern === 1 ? 'concern' : 'concerns'}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Essay */}
          <div className="lg:col-span-3">
            <div className="rounded-2xl" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <div
                className="px-6 py-4 flex items-center justify-between"
                style={{ borderBottom: `1px solid ${C.border}` }}
              >
                <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: C.text }}>
                  <FileText size={14} style={{ color: C.textFaint }} /> Your essay
                </h2>
                <span className="text-xs" style={{ color: C.textFaint }}>
                  {wordCount.toLocaleString()} words
                </span>
              </div>
              <div className="p-6">
                {paragraphs.length > 0 ? paragraphs.map((p, i) => (
                  <p key={i} className="mb-4 text-sm leading-[1.8]" style={{ color: 'rgba(255,255,255,0.75)' }}>
                    {p}
                  </p>
                )) : (
                  <p className="text-sm" style={{ color: C.textFaint }}>(empty)</p>
                )}
              </div>
            </div>
          </div>

          {/* Sidebar: end comment + comments + rubric */}
          <div className="lg:col-span-2 space-y-4">
            {result?.overall_feedback && (
              <div className="rounded-xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: C.textFaint }}>
                  End comment
                </h3>
                {String(result.overall_feedback).split('\n\n').map((p, i) => (
                  <p key={i} className="text-xs leading-relaxed mb-2" style={{ color: 'rgba(255,255,255,0.70)' }}>
                    {p}
                  </p>
                ))}
              </div>
            )}

            {lineByLine.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5" style={{ color: C.textFaint }}>
                  <MessageSquare size={12} /> Line-by-line comments
                </h3>
                <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                  {lineByLine.map((c, i) => <CommentCard key={i} comment={c} />)}
                </div>
              </div>
            )}

            {Array.isArray(result?.reasoning) && result.reasoning.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: C.text }}>
                  Grade reasoning
                </h3>
                <div className="space-y-2">
                  {result.reasoning.map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs" style={{ color: C.textMute }}>
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5"
                        style={{ background: 'rgba(255,255,255,0.05)', color: C.textFaint }}
                      >
                        {i + 1}
                      </span>
                      <span className="leading-relaxed">{r}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Array.isArray(result?.strengths) && result.strengths.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: 'rgba(74,222,128,0.04)', border: '1px solid rgba(74,222,128,0.15)' }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5" style={{ color: '#4ade80' }}>
                  <Star size={12} /> Strengths
                </h3>
                {result.strengths.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs mb-1.5" style={{ color: 'rgba(74,222,128,0.85)' }}>
                    <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
                    <span className="leading-relaxed">{s}</span>
                  </div>
                ))}
              </div>
            )}

            {Array.isArray(result?.weaknesses) && result.weaknesses.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: 'rgba(251,191,36,0.04)', border: '1px solid rgba(251,191,36,0.15)' }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5" style={{ color: '#fbbf24' }}>
                  <AlertTriangle size={12} /> Areas for improvement
                </h3>
                {result.weaknesses.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs mb-1.5" style={{ color: 'rgba(251,191,36,0.85)' }}>
                    <Lightbulb size={12} className="mt-0.5 flex-shrink-0" />
                    <span className="leading-relaxed">{w}</span>
                  </div>
                ))}
              </div>
            )}

            {Array.isArray(result?.next_steps) && result.next_steps.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5" style={{ color: C.text }}>
                  <Target size={12} style={{ color: C.accent }} /> Revision priorities
                </h3>
                <div className="space-y-2">
                  {result.next_steps.map((step, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 p-3 rounded-xl"
                      style={{ background: 'rgba(0,0,0,0.25)' }}
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
                        style={{
                          background: i === 0 ? 'rgba(99,152,255,0.15)' : 'rgba(255,255,255,0.05)',
                          color: i === 0 ? C.accent : C.textFaint,
                        }}
                      >
                        {i + 1}
                      </span>
                      <p className="text-xs leading-relaxed" style={{ color: C.textMute }}>{step}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result?.rubric_breakdown && typeof result.rubric_breakdown === 'object' && (
              <div className="rounded-xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: C.text }}>
                  Rubric breakdown
                </h3>
                <div className="space-y-2">
                  {Object.entries(result.rubric_breakdown).map(([k, v]) => (
                    <div key={k} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.20)' }}>
                      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.textFaint }}>{k}</div>
                      <div className="mt-0.5 text-xs" style={{ color: C.textMute }}>{String(v)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Save-actual feedback panel */}
        <SaveActualFeedback
          essay={essay}
          rubric={rubric}
          teacher={teacher}
          predictedGrade={result?.grade || ''}
          predictedFeedback={result?.overall_feedback || ''}
          initialFeedback={formatExtractedComments(docComments)}
          fileRef={docFileRef}
          fileUrl={docFileUrl}
          onSaved={onSaved}
        />
      </div>
    </div>
  );
}

// Data-collection panel. Shown below the prediction so the student can
// come back when their teacher returns the paper, paste the real grade
// + comments, and have it land in the training corpus alongside the
// prediction the model originally made. Reuses the essay + teacher +
// rubric the student typed in above so they don't have to retype them.

function SaveActualFeedback({
  essay,
  rubric,
  teacher,
  predictedGrade,
  predictedFeedback,
  initialFeedback,
  fileRef,
  fileUrl,
  onSaved,
}) {
  const [feedback, setFeedback] = useState(initialFeedback || '');
  const [grade, setGrade] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [savedFileUrl, setSavedFileUrl] = useState(null);

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
        fileRef: fileRef || null,
        fileUrl: fileUrl || null,
      });
      setSavedId(data.id);
      setSavedFileUrl(data.essayFileUrl || null);
      setFeedback('');
      setGrade('');
      onSaved?.();
    } catch (e) {
      setError(e.response?.data?.error || e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  if (savedId !== null) {
    return (
      <section
        className="flex items-start gap-3 rounded-2xl p-6 text-sm"
        style={{
          background: 'rgba(74,222,128,0.06)',
          border: '1px solid rgba(74,222,128,0.20)',
          color: 'rgba(74,222,128,0.85)',
        }}
      >
        <Check size={18} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold" style={{ color: '#4ade80' }}>
            Saved to the training corpus
          </div>
          <div className="mt-1 text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>
            Example #{savedId}. The next iteration of the predictor will use
            this {teacher ? `as ${teacher}'s grading style` : 'as cold-start training data'}.
            {savedFileUrl && (
              <>
                {' '}Original essay archived to{' '}
                <a href={savedFileUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: C.accent }}>
                  OneDrive
                </a>.
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className="space-y-4 rounded-2xl p-6"
      style={{ background: C.surface, border: `1px solid ${C.border}` }}
    >
      <header className="flex items-start gap-3">
        <PenLine size={18} className="mt-0.5 flex-shrink-0" style={{ color: C.accent }} />
        <div>
          <h2 className="text-sm font-semibold" style={{ color: C.text }}>
            Got the paper back? Save the actual feedback
          </h2>
          <p className="text-xs mt-0.5" style={{ color: C.textMute }}>
            Optional, but it builds the per-teacher training corpus the next
            iteration of the predictor will use.
          </p>
        </div>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.textFaint }}>
            Final grade
          </label>
          <input
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            placeholder="e.g. A-, 92, 4/5"
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm bg-transparent focus:outline-none transition-colors"
            style={{ border: `1px solid ${C.border}`, color: C.text }}
            onFocus={(e) => (e.target.style.borderColor = C.borderStrong)}
            onBlur={(e) => (e.target.style.borderColor = C.border)}
          />
        </div>
        <div className="flex items-end text-[11px]" style={{ color: C.textFaint }}>
          {teacher
            ? <>Saving under <code className="ml-1" style={{ color: C.textMute }}>{teacher}</code></>
            : 'No teacher set — saved as untagged'}
        </div>
      </div>
      <div>
        <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.textFaint }}>
          Teacher&apos;s comments
        </label>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Paste every margin note, end-comment, rubric scoring…"
          className="mt-1 h-40 w-full rounded-lg px-3 py-2 text-sm leading-relaxed bg-transparent focus:outline-none resize-none transition-colors"
          style={{ border: `1px solid ${C.border}`, color: C.text }}
          onFocus={(e) => (e.target.style.borderColor = C.borderStrong)}
          onBlur={(e) => (e.target.style.borderColor = C.border)}
        />
      </div>
      <button
        type="button"
        disabled={!feedback || !grade || saving}
        onClick={save}
        className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        style={{ background: C.text, color: C.bg }}
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {saving ? 'Saving…' : 'Save as training example'}
      </button>
      {error && <p className="text-[11px]" style={{ color: '#f87171' }}>{error}</p>}
    </section>
  );
}

function CommentCard({ comment }) {
  const sev = (comment.severity || 'suggestion').toLowerCase();
  const style = severityStyle(sev);
  return (
    <div
      className="rounded-xl p-3.5"
      style={{ background: style.bg, border: `1px solid ${style.border}` }}
    >
      <div className="flex items-start gap-2">
        <span style={{ color: style.text, marginTop: 2 }}>
          {sev === 'praise' ? <Star size={13} /> : sev === 'concern' ? <AlertTriangle size={13} /> : <Lightbulb size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: style.text }}>
              {style.label}{comment.category ? ` — ${comment.category}` : ''}
            </span>
          </div>
          {comment.quote && (
            <p className="text-[11px] italic mb-1" style={{ color: C.textFaint }}>
              &ldquo;{comment.quote}&rdquo;
            </p>
          )}
          <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.75)' }}>
            {comment.comment}
          </p>
        </div>
      </div>
    </div>
  );
}

function severityStyle(sev) {
  if (sev === 'praise') return {
    bg: 'rgba(74,222,128,0.07)',
    border: 'rgba(74,222,128,0.18)',
    text: '#4ade80',
    label: 'Strength',
  };
  if (sev === 'concern') return {
    bg: 'rgba(239,68,68,0.07)',
    border: 'rgba(239,68,68,0.18)',
    text: '#f87171',
    label: 'Needs work',
  };
  return {
    bg: 'rgba(251,191,36,0.07)',
    border: 'rgba(251,191,36,0.18)',
    text: '#fbbf24',
    label: 'Suggestion',
  };
}

function confidenceStyle(conf) {
  if (conf === 'high') return { background: 'rgba(74,222,128,0.10)', color: '#4ade80' };
  if (conf === 'low') return { background: 'rgba(239,68,68,0.10)', color: '#f87171' };
  return { background: 'rgba(251,191,36,0.10)', color: '#fbbf24' };
}

// ─── Recent essays (landing) ──────────────────────────────────────────
//
// First thing a member sees on /sandbox: a list of their own past
// predictions, most recent first. Click a card to re-open the result
// panel populated from the persisted JSON; click "New essay" up top
// to drop into the editor for a fresh prediction.

function RecentEssaysView({ recent, recentError, openingId, onOpen, onNew }) {
  return (
    <div className="flex-1 overflow-auto px-6 py-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8 gap-4">
          <div>
            <h1 className="text-2xl font-semibold" style={{ color: C.text }}>Your essays</h1>
            <p className="text-sm mt-1" style={{ color: C.textMute }}>
              Past grade predictions you&apos;ve run. Open one to revisit the
              feedback, or start a new analysis.
            </p>
          </div>
          <button
            type="button"
            onClick={onNew}
            className="h-10 px-4 rounded-lg text-sm font-semibold flex items-center gap-2 flex-shrink-0"
            style={{ background: C.text, color: C.bg }}
          >
            <Plus size={14} /> New essay
          </button>
        </div>

        {recent === null ? (
          <div className="py-8 flex items-center gap-2 justify-center text-sm" style={{ color: C.textMute }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : recentError ? (
          <div
            className="rounded-xl p-5 text-sm"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.20)', color: '#fca5a5' }}
          >
            <div className="font-semibold">Couldn&apos;t load past essays</div>
            <div className="mt-1 text-xs">{recentError}</div>
          </div>
        ) : recent.length === 0 ? (
          <div
            className="rounded-xl p-8 text-sm text-center"
            style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textMute }}
          >
            <FileText size={20} className="mx-auto mb-3" style={{ color: C.textFaint }} />
            <div className="font-medium" style={{ color: C.text }}>No essays yet</div>
            <p className="mt-1 text-xs" style={{ color: C.textFaint }}>
              Start by clicking <span style={{ color: C.text }}>New essay</span> up top.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {recent.map((a) => (
              <RecentCard
                key={a.id}
                a={a}
                opening={openingId === a.id}
                onClick={() => onOpen(a.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecentCard({ a, opening, onClick }) {
  const conf = (a.confidence || '').toLowerCase();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={opening}
      className="w-full text-left p-4 rounded-xl transition-all flex items-start gap-4 disabled:opacity-50"
      style={{ background: C.surface, border: `1px solid ${C.border}` }}
      onMouseEnter={(e) => !opening && (e.currentTarget.style.background = C.surfaceHover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = C.surface)}
    >
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: C.accentSoft }}
      >
        <span className="text-sm font-semibold" style={{ color: C.accent }}>
          {a.grade || '—'}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium" style={{ color: C.text }}>
            {a.teacher || <span style={{ color: C.textFaint }}>untagged</span>}
          </span>
          {conf && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-medium capitalize"
              style={confidenceStyle(conf)}
            >
              {conf}
            </span>
          )}
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wider"
            style={{
              background: a.mode === 'rag' ? C.accentSoft : 'rgba(255,255,255,0.05)',
              color: a.mode === 'rag' ? C.accent : C.textFaint,
            }}
          >
            {a.mode === 'rag' ? `rag · ${a.examples_used}` : 'cold start'}
          </span>
        </div>
        {a.preview && (
          <p className="mt-1 text-xs leading-relaxed line-clamp-2" style={{ color: C.textMute }}>
            {a.preview}
            {a.preview.length >= 160 && '…'}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-1 text-[11px]" style={{ color: C.textFaint }}>
          <Clock size={10} />
          {fmtAgo(a.created_at)}
        </div>
      </div>
      {opening
        ? <Loader2 size={14} className="animate-spin mt-1.5 flex-shrink-0" style={{ color: C.textFaint }} />
        : <ChevronRight size={16} className="mt-1.5 flex-shrink-0" style={{ color: 'rgba(255,255,255,0.20)' }} />}
    </button>
  );
}

function fmtAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
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
