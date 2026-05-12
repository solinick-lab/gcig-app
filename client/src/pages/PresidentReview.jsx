import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, AlertCircle, ClipboardList, BarChart3 } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';

const SCALE = [
  { value: 1, label: 'Strongly disagree' },
  { value: 2, label: 'Disagree' },
  { value: 3, label: 'Neutral' },
  { value: 4, label: 'Agree' },
  { value: 5, label: 'Strongly agree' },
];

// First name only when listing, plus a fallback for one-word names.
function firstName(full) {
  if (!full) return '';
  return full.trim().split(/\s+/)[0];
}

export default function PresidentReview() {
  const { user, isSuperAdmin } = useAuth();

  const [view, setView] = useState('submit'); // 'submit' | 'results'
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null); // { cycle, questions, presidents }
  const [submissions, setSubmissions] = useState({}); // presidentId -> submission
  const [drafts, setDrafts] = useState({}); // presidentId -> { ratings: {q1..q9}, comment }
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null); // { kind, text }
  const [results, setResults] = useState(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cfg, mine] = await Promise.all([
        api.get('/president-review/config'),
        api.get('/president-review/mine'),
      ]);
      setConfig(cfg.data);
      const map = {};
      for (const s of mine.data.submissions || []) {
        map[s.presidentId] = s;
      }
      setSubmissions(map);

      const initialDrafts = {};
      for (const p of cfg.data.presidents || []) {
        const existing = map[p.id];
        initialDrafts[p.id] = {
          ratings: existing?.ratings ? { ...existing.ratings } : {},
          comment: existing?.comment || '',
        };
      }
      setDrafts(initialDrafts);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load review form');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadResults() {
    setResultsLoading(true);
    setResultsError(null);
    try {
      const { data } = await api.get('/president-review/results');
      setResults(data);
    } catch (err) {
      setResultsError(err.response?.data?.error || 'Failed to load results');
    } finally {
      setResultsLoading(false);
    }
  }

  useEffect(() => {
    if (view === 'results' && isSuperAdmin && !results && !resultsLoading) {
      loadResults();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, isSuperAdmin]);

  function setRating(presidentId, questionId, value) {
    setDrafts((prev) => ({
      ...prev,
      [presidentId]: {
        ...prev[presidentId],
        ratings: { ...prev[presidentId]?.ratings, [questionId]: value },
      },
    }));
  }

  function setComment(presidentId, value) {
    setDrafts((prev) => ({
      ...prev,
      [presidentId]: {
        ...prev[presidentId],
        comment: value,
      },
    }));
  }

  function isComplete(presidentId) {
    if (!config) return false;
    const draft = drafts[presidentId];
    if (!draft) return false;
    return config.questions.every((q) => Number.isInteger(draft.ratings?.[q.id]));
  }

  async function submit(presidentId) {
    const draft = drafts[presidentId];
    if (!draft) return;
    if (!isComplete(presidentId)) {
      setToast({ kind: 'error', text: 'Please answer all nine questions before submitting.' });
      return;
    }
    setSavingId(presidentId);
    setToast(null);
    try {
      const { data } = await api.post('/president-review', {
        presidentId,
        ratings: draft.ratings,
        comment: draft.comment || null,
      });
      setSubmissions((prev) => ({ ...prev, [presidentId]: data.submission }));
      setToast({ kind: 'success', text: 'Review submitted. Thank you for the feedback.' });
    } catch (err) {
      setToast({
        kind: 'error',
        text: err.response?.data?.error || 'Failed to submit. Try again in a moment.',
      });
    } finally {
      setSavingId(null);
    }
  }

  const visiblePresidents = useMemo(() => {
    if (!config) return [];
    // Don't show a self-review card. If a President opens the page they
    // see everyone else.
    return config.presidents.filter((p) => p.id !== user?.id);
  }, [config, user]);

  if (loading) {
    return (
      <div>
        <PageHeader
          kicker="End of year"
          title="President Review"
          subtitle="Rate each president 1-5 on the statements below."
        />
        <div className="text-sm text-navy-400">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader kicker="End of year" title="President Review" />
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        kicker={`Cycle ${config?.cycle || ''}`}
        title="President Review"
        subtitle="Honest, constructive feedback on each president's year. Responses are anonymous in the results view; only the super-admin can see them, and reviewer identity is never shown in the aggregate."
        actions={
          isSuperAdmin ? (
            <div className="inline-flex overflow-hidden rounded-lg border border-navy-100 bg-white">
              <button
                type="button"
                onClick={() => setView('submit')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition ${
                  view === 'submit'
                    ? 'bg-navy text-white'
                    : 'text-navy hover:bg-navy-50'
                }`}
              >
                <ClipboardList className="h-3.5 w-3.5" />
                Form
              </button>
              <button
                type="button"
                onClick={() => setView('results')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition ${
                  view === 'results'
                    ? 'bg-navy text-white'
                    : 'text-navy hover:bg-navy-50'
                }`}
              >
                <BarChart3 className="h-3.5 w-3.5" />
                Results
              </button>
            </div>
          ) : null
        }
      />

      {view === 'results' && isSuperAdmin && (
        <ResultsView
          results={results}
          loading={resultsLoading}
          error={resultsError}
          onRefresh={loadResults}
        />
      )}

      {view === 'submit' && toast && (
        <div
          className={`mb-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {toast.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{toast.text}</span>
        </div>
      )}

      {view === 'submit' && (visiblePresidents.length === 0 ? (
        <Card>
          <p className="text-sm text-navy-400">
            There are no presidents to review right now.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {visiblePresidents.map((p) => {
            const draft = drafts[p.id] || { ratings: {}, comment: '' };
            const submitted = submissions[p.id];
            const complete = isComplete(p.id);
            const saving = savingId === p.id;
            return (
              <Card
                key={p.id}
                kicker={submitted ? 'Submitted — you can resubmit to update' : 'Awaiting your response'}
                title={firstName(p.name)}
                action={
                  submitted ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" /> Submitted
                    </span>
                  ) : null
                }
              >
                <div className="space-y-5">
                  {config.questions.map((q, idx) => (
                    <div
                      key={q.id}
                      className="border-b border-navy-50 pb-4 last:border-b-0 last:pb-0"
                    >
                      <div className="mb-2 flex items-baseline gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-700">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <p className="text-sm font-medium text-navy">{q.text}</p>
                      </div>
                      <fieldset>
                        <legend className="sr-only">{q.text}</legend>
                        <div className="grid grid-cols-5 gap-2">
                          {SCALE.map((s) => {
                            const active = draft.ratings?.[q.id] === s.value;
                            return (
                              <button
                                type="button"
                                key={s.value}
                                onClick={() => setRating(p.id, q.id, s.value)}
                                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs transition ${
                                  active
                                    ? 'border-navy bg-navy text-white shadow-sm'
                                    : 'border-navy-100 bg-white text-navy hover:border-navy-300 hover:bg-navy-50'
                                }`}
                                aria-pressed={active}
                                aria-label={`${q.text} — ${s.label}`}
                              >
                                <span className="text-base font-semibold leading-none">
                                  {s.value}
                                </span>
                                <span className="text-[10px] leading-tight">
                                  {s.label}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </fieldset>
                    </div>
                  ))}

                  <div>
                    <label
                      htmlFor={`comment-${p.id}`}
                      className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.18em] text-navy-400"
                    >
                      Anything else (optional)
                    </label>
                    <textarea
                      id={`comment-${p.id}`}
                      rows={3}
                      maxLength={4000}
                      value={draft.comment}
                      onChange={(e) => setComment(p.id, e.target.value)}
                      placeholder="A specific moment that stood out, something you'd want to see more of next year, etc."
                      className="w-full resize-y rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm text-navy placeholder:text-navy-300 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    {!complete && (
                      <span className="text-xs text-navy-400">
                        Answer all nine to submit
                      </span>
                    )}
                    <Button
                      variant="primary"
                      onClick={() => submit(p.id)}
                      disabled={!complete || saving}
                    >
                      {saving
                        ? 'Submitting…'
                        : submitted
                        ? 'Update review'
                        : 'Submit review'}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Aggregated, anonymized results. One card per president showing the
// overall mean, per-question mean with a 1-5 bar, and the list of
// free-form comments. Super-admin only — gating happens at the API.
function ResultsView({ results, loading, error, onRefresh }) {
  if (loading) {
    return <div className="text-sm text-navy-400">Loading results…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (!results || !results.results || results.results.length === 0) {
    return (
      <Card>
        <p className="text-sm text-navy-400">No reviews submitted yet for {results?.cycle}.</p>
      </Card>
    );
  }

  const questions = results.questions || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between text-xs text-navy-400">
        <span>
          Cycle {results.cycle} · {results.results.reduce((s, r) => s + (r.responseCount || 0), 0)} total responses
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="font-semibold text-navy hover:underline"
        >
          Refresh
        </button>
      </div>

      {results.results
        .slice()
        .sort((a, b) => (b.overallAvg || 0) - (a.overallAvg || 0))
        .map((row) => {
          const name = row.president?.name || `User ${row.president?.id}`;
          const overall = row.overallAvg != null ? row.overallAvg.toFixed(2) : '—';
          return (
            <Card
              key={row.president?.id}
              kicker={`${row.responseCount} ${row.responseCount === 1 ? 'response' : 'responses'}`}
              title={name}
              action={
                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-navy-400">
                    Overall avg
                  </div>
                  <div className="font-serif text-2xl font-semibold text-navy">
                    {overall}
                  </div>
                </div>
              }
            >
              {row.responseCount === 0 ? (
                <p className="text-sm text-navy-400">No reviews submitted yet.</p>
              ) : (
                <>
                  <div className="space-y-3">
                    {questions.map((q, idx) => {
                      const stats = row.perQuestion?.[q.id];
                      const avg = stats?.avg;
                      const n = stats?.n || 0;
                      const pct = avg != null ? ((avg - 1) / 4) * 100 : 0;
                      return (
                        <div key={q.id}>
                          <div className="mb-1 flex items-baseline justify-between gap-3">
                            <div className="flex items-baseline gap-2 text-sm text-navy">
                              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold-700">
                                {String(idx + 1).padStart(2, '0')}
                              </span>
                              <span className="font-medium">{q.text}</span>
                            </div>
                            <div className="shrink-0 text-xs tabular-nums text-navy-400">
                              {avg != null ? avg.toFixed(2) : '—'}{' '}
                              <span className="text-navy-300">({n})</span>
                            </div>
                          </div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-navy-50">
                            <div
                              className="h-full rounded-full bg-gold"
                              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                            />
                          </div>
                          {stats?.dist && (
                            <div className="mt-1 flex justify-between text-[10px] text-navy-300">
                              {stats.dist.map((c, i) => (
                                <span key={i}>
                                  {i + 1}: <span className="text-navy-400">{c}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {row.comments && row.comments.length > 0 && (
                    <div className="mt-6 border-t border-navy-50 pt-4">
                      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.2em] text-navy-400">
                        Comments ({row.comments.length})
                      </div>
                      <div className="space-y-2">
                        {row.comments.map((c, i) => (
                          <blockquote
                            key={i}
                            className="rounded-lg border border-navy-100 bg-navy-50/30 px-3 py-2 text-sm text-navy"
                          >
                            "{c.comment}"
                          </blockquote>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </Card>
          );
        })}
    </div>
  );
}
