import { useEffect, useState } from 'react';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import {
  Plus,
  TrendingUp,
  Minus,
  TrendingDown,
  Clock,
  CheckCircle2,
  ChevronRight,
  ArrowLeft,
  Trash2,
} from 'lucide-react';
import api from '../api/client.js';
import { openOrPreview } from '../api/fileHelpers.js';
import FilePreviewModal from '../components/FilePreviewModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import AdminOnly from '../components/AdminOnly.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

const ACTION_META = {
  Buy: { icon: TrendingUp, badge: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  Hold: { icon: Minus, badge: 'bg-gold-100 text-gold-800 border-gold-300' },
  Sell: { icon: TrendingDown, badge: 'bg-red-100 text-red-800 border-red-200' },
};

function ActionBadge({ action, large }) {
  const meta = ACTION_META[action] || ACTION_META.Hold;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-bold uppercase ${meta.badge} ${
        large ? 'px-4 py-1.5 text-base' : 'px-2.5 py-0.5 text-xs'
      }`}
    >
      <Icon className={large ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
      {action}
    </span>
  );
}

function emptyForm() {
  return { ticker: '', title: '', pitchId: '', deadline: '' };
}

export default function Votes() {
  const { isAdmin } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [pitches, setPitches] = useState([]);
  const [detail, setDetail] = useState(null); // full session detail
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);

  async function loadSessions() {
    const { data } = await api.get('/votes');
    setSessions(data);
  }

  async function loadPitches() {
    const { data } = await api.get('/pitches');
    setPitches(data);
  }

  useEffect(() => {
    loadSessions();
    loadPitches();
  }, []);

  async function openDetail(id) {
    const { data } = await api.get(`/votes/${id}`);
    setDetail(data);
  }

  async function handleCreateSession(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/votes', {
        ticker: form.ticker,
        title: form.title || null,
        pitchId: form.pitchId ? Number(form.pitchId) : null,
        deadline: new Date(form.deadline).toISOString(),
      });
      setModalOpen(false);
      setForm(emptyForm());
      loadSessions();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCloseSession(id) {
    if (!confirm('Close voting early?')) return;
    await api.post(`/votes/${id}/close`);
    loadSessions();
    if (detail?.id === id) openDetail(id);
  }

  async function handleDeleteSession(id) {
    if (!confirm('Delete this voting session and all ballots?')) return;
    await api.delete(`/votes/${id}`);
    setSessions((s) => s.filter((x) => x.id !== id));
    if (detail?.id === id) setDetail(null);
  }

  // Detail view
  if (detail) {
    return (
      <SessionDetail
        session={detail}
        onBack={() => {
          setDetail(null);
          loadSessions();
        }}
        onRefresh={() => openDetail(detail.id)}
        onClose={handleCloseSession}
        onDelete={handleDeleteSession}
      />
    );
  }

  const openSessions = sessions.filter((s) => s.status === 'open');
  const closedSessions = sessions.filter((s) => s.status !== 'open');

  return (
    <>
      <PageHeader
        kicker="Decisions"
        title="Voting"
        subtitle="Vote on pitches — general body (3 votes) + leadership (Presidents & CIO, 1 each)."
        actions={
          <AdminOnly>
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Start Vote
            </Button>
          </AdminOnly>
        }
      />

      {/* Editorial masthead: session counts + next deadline */}
      <VotesMasthead
        openSessions={openSessions}
        closedSessions={closedSessions}
      />

      {openSessions.length > 0 && (
        <div className="mt-6 mb-8">
          <SectionKicker
            label="Live Now"
            count={openSessions.length}
            accent="emerald"
          />
          <div className="mt-3 space-y-3">
            {openSessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                onClick={() => openDetail(s.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionKicker label="Past Sessions" count={closedSessions.length} />
        {closedSessions.length === 0 ? (
          <Card>
            <div className="py-8 text-center text-navy-400">
              No past voting sessions.
            </div>
          </Card>
        ) : (
          <div className="mt-3 space-y-3">
            {closedSessions.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                onClick={() => openDetail(s.id)}
              />
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Start Voting Session" size="md">
        <form onSubmit={handleCreateSession} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-navy">Ticker</label>
            <input
              required
              value={form.ticker}
              onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
              placeholder="AAPL"
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Title / Question (optional)</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Q2 decision on AAPL"
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Attach Pitch (optional)</label>
            <select
              value={form.pitchId}
              onChange={(e) => setForm({ ...form, pitchId: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {pitches.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.ticker} — {p.pitcherName} ({format(new Date(p.date), 'MMM d, yyyy')})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Voting Deadline</label>
            <input
              type="datetime-local"
              required
              value={form.deadline}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating…' : 'Start Vote'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── Session card (used in the list) ──────────────────────────────────

function SessionCard({ session: s, onClick }) {
  const isOpen = s.status === 'open';
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-4 rounded-xl border bg-white p-4 text-left shadow-card transition hover:shadow-md ${
        isOpen ? 'border-emerald-200 ring-1 ring-emerald-100' : 'border-navy-100'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-bold text-navy">{s.ticker}</span>
          {isOpen ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
              LIVE
            </span>
          ) : (
            <span className="rounded-full bg-navy-50 px-2 py-0.5 text-xs font-bold text-navy-400">
              CLOSED
            </span>
          )}
          {s._count && (
            <span className="text-xs text-navy-400">{s._count.ballots} ballot(s)</span>
          )}
        </div>
        {s.title && <div className="mt-1 text-sm text-navy">{s.title}</div>}
        <div className="mt-1 text-xs text-navy-400">
          by {s.creator?.name} • {format(new Date(s.createdAt), 'MMM d, yyyy')}
          {isOpen && (
            <span className="ml-2 font-semibold text-emerald-700">
              Closes {formatDistanceToNow(new Date(s.deadline), { addSuffix: true })}
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="h-5 w-5 text-navy-400" />
    </button>
  );
}

// ── Session detail view ──────────────────────────────────────────────

const BUY_MIN = 1500;
const BUY_MAX = 10000;

function SessionDetail({ session, onBack, onRefresh, onClose, onDelete }) {
  const { user, isAdmin } = useAuth();
  const [ballotAction, setBallotAction] = useState('');
  const [ballotNote, setBallotNote] = useState('');
  const [ballotAmount, setBallotAmount] = useState('');
  const [ballotError, setBallotError] = useState('');
  const [casting, setCasting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [sendingDocusign, setSendingDocusign] = useState(false);
  const [docusignError, setDocusignError] = useState('');
  const isOpen = session.status === 'open' && !isPast(new Date(session.deadline));
  const tally = session.tally;

  async function sendDocusign() {
    setDocusignError('');
    setSendingDocusign(true);
    try {
      await api.post(`/docusign/sessions/${session.id}/send`);
      onRefresh();
    } catch (err) {
      setDocusignError(
        err.response?.data?.error || 'Failed to send trade confirmation'
      );
    } finally {
      setSendingDocusign(false);
    }
  }

  useEffect(() => {
    if (session.myBallot) {
      setBallotAction(session.myBallot.action);
      setBallotNote(session.myBallot.note || '');
      setBallotAmount(
        session.myBallot.investmentAmount != null
          ? String(session.myBallot.investmentAmount)
          : ''
      );
    }
  }, [session.myBallot]);

  async function castBallot(e) {
    e.preventDefault();
    setBallotError('');
    // Client-side guard mirrors the server. The server is still the source
    // of truth and will reject anything out of range.
    if (ballotAction === 'Buy') {
      const n = Number(ballotAmount);
      if (!Number.isFinite(n) || n < BUY_MIN || n > BUY_MAX) {
        setBallotError(`Enter a Buy amount between $${BUY_MIN.toLocaleString()} and $${BUY_MAX.toLocaleString()}`);
        return;
      }
    }
    setCasting(true);
    try {
      await api.post(`/votes/${session.id}/ballot`, {
        action: ballotAction,
        note: ballotNote || null,
        investmentAmount: ballotAction === 'Buy' ? Number(ballotAmount) : null,
      });
      onRefresh();
    } catch (err) {
      setBallotError(err.response?.data?.error || 'Failed to submit ballot');
    } finally {
      setCasting(false);
    }
  }

  return (
    <>
      <button onClick={onBack} className="mb-4 flex items-center gap-1 text-sm font-semibold text-navy-400 hover:text-navy">
        <ArrowLeft className="h-4 w-4" />
        Back to all sessions
      </button>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-navy md:text-3xl">{session.ticker}</h1>
            {isOpen ? (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
                LIVE — closes {formatDistanceToNow(new Date(session.deadline), { addSuffix: true })}
              </span>
            ) : (
              <span className="rounded-full bg-navy-50 px-3 py-1 text-xs font-bold text-navy-400">
                CLOSED
              </span>
            )}
          </div>
          {session.title && <p className="mt-1 text-sm text-navy-400">{session.title}</p>}
          <div className="mt-1 text-xs text-navy-400">
            Started by {session.creator?.name} • {format(new Date(session.createdAt), 'MMM d, yyyy h:mm a')}
          </div>
        </div>
        <AdminOnly>
          <div className="flex gap-2">
            {isOpen && (
              <Button variant="outline" onClick={() => onClose(session.id)}>
                Close Early
              </Button>
            )}
            <Button variant="danger" onClick={() => { onDelete(session.id); onBack(); }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </AdminOnly>
      </div>

      {session.pitch && (
        <Card className="mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase text-navy-400">Attached Pitch</div>
              <div className="mt-1 font-bold text-navy">{session.pitch.ticker} — {session.pitch.pitcherName}</div>
              <div className="text-xs text-navy-400">
                {format(new Date(session.pitch.date), 'MMM d, yyyy')}
              </div>
            </div>
            {session.pitch.slideshowUrl && (
              <button
                type="button"
                onClick={() =>
                  openOrPreview(
                    {
                      url: session.pitch.slideshowUrl,
                      title: `${session.pitch.ticker} slideshow`,
                      filename: `${session.pitch.ticker}-pitch.pdf`,
                    },
                    setPreview
                  )
                }
                className="text-sm font-semibold text-gold-700 underline"
              >
                View Slideshow →
              </button>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Tally */}
        <Card title="Weighted Tally">
          <TallyDisplay tally={tally} isOpen={isOpen} ticker={session.ticker} />
        </Card>

        {/* Cast ballot (if open) */}
        {isOpen && (
          <Card title={session.myBallot ? 'Change Your Vote' : 'Cast Your Vote'}>
            <form onSubmit={castBallot} className="space-y-4">
              <div className="grid grid-cols-3 gap-2">
                {Object.keys(ACTION_META).map((a) => {
                  const meta = ACTION_META[a];
                  const Icon = meta.icon;
                  const selected = ballotAction === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => {
                        setBallotAction(a);
                        setBallotError('');
                      }}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-3 py-3 text-sm font-semibold transition ${
                        selected
                          ? `${meta.badge} ring-2`
                          : 'border-navy-100 bg-white text-navy hover:bg-navy-50'
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                      {a}
                    </button>
                  );
                })}
              </div>

              {/* Amount input only appears when Buy is selected. Required field,
                  constrained to the server's accepted band. */}
              {ballotAction === 'Buy' && (
                <div>
                  <label className="block text-sm font-medium text-navy">
                    Proposed allocation <span className="text-red-600">*</span>
                  </label>
                  <div className="mt-1 flex items-center">
                    <span className="rounded-l-lg border border-r-0 border-navy-100 bg-navy-50 px-3 py-2 text-sm font-semibold text-navy-400">
                      $
                    </span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={BUY_MIN}
                      max={BUY_MAX}
                      step={100}
                      required
                      value={ballotAmount}
                      onChange={(e) => {
                        setBallotAmount(e.target.value);
                        setBallotError('');
                      }}
                      placeholder={`${BUY_MIN.toLocaleString()} – ${BUY_MAX.toLocaleString()}`}
                      className="w-full rounded-r-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                    />
                  </div>
                  <p className="mt-1 text-xs text-navy-400">
                    How much should the club allocate? Enter a whole dollar
                    amount between ${BUY_MIN.toLocaleString()} and ${BUY_MAX.toLocaleString()}.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-navy">Note (optional)</label>
                <textarea
                  rows={3}
                  value={ballotNote}
                  onChange={(e) => setBallotNote(e.target.value)}
                  placeholder="Why this decision?"
                  className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                />
              </div>

              {ballotError && (
                <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
                  {ballotError}
                </div>
              )}

              <Button type="submit" disabled={!ballotAction || casting} className="w-full">
                {casting ? 'Submitting…' : session.myBallot ? 'Update Vote' : 'Submit Vote'}
              </Button>
            </form>
          </Card>
        )}

        {/* Final decision (if closed) */}
        {!isOpen && tally && (
          <Card title="Final Decision">
            <div className="flex flex-col items-center py-6">
              <ActionBadge action={tally.finalDecision} large />
              {tally.isTied && (
                <div className="mt-2 text-xs text-gold-700 font-semibold">
                  Tied — defaulted to Hold
                </div>
              )}
              <div className="mt-3 text-sm text-navy-400">
                {tally.totalWeightedVotes} of {tally.maxWeightedVotes} weighted votes cast
              </div>
            </div>
            {/* AI recap of the session. Generated server-side the first
                time someone opens the session after it closed. */}
            {session.synthesis && (
              <div className="mt-2 rounded-lg border border-gold-200 bg-gold-100/30 p-3">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gold-800">
                  AI Recap
                </div>
                <p className="text-sm leading-relaxed text-navy">
                  {session.synthesis}
                </p>
              </div>
            )}

            {/* DocuSign trade-confirmation panel — only shown when the
                club actually voted Buy. The admin sends the envelope;
                the rest of the membership just sees the status. */}
            {tally.finalDecision === 'Buy' && (
              <DocusignPanel
                session={session}
                canSend={isAdmin}
                sending={sendingDocusign}
                error={docusignError}
                onSend={sendDocusign}
                onRefresh={onRefresh}
              />
            )}
          </Card>
        )}
      </div>

      {/* Ballots list — live visibility */}
      <div className="mt-4">
        <Card title={`Ballots (${session.ballots.length})`}>
          {session.ballots.length === 0 ? (
            <div className="py-6 text-center text-navy-400">No ballots cast yet.</div>
          ) : (
            <ul className="divide-y divide-navy-50">
              {session.ballots.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-navy">{b.user.name}</span>
                      <RoleBadge role={b.user.role} />
                      {(b.user.role === 'President' || b.user.role === 'CIO') && (
                        <span className="text-[10px] text-navy-400">(1 vote)</span>
                      )}
                      {b.action === 'Buy' && b.investmentAmount != null && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                          ${b.investmentAmount.toLocaleString()}
                        </span>
                      )}
                    </div>
                    {b.note && <p className="mt-1 text-sm text-navy-400">{b.note}</p>}
                  </div>
                  <ActionBadge action={b.action} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {preview && (
        <FilePreviewModal
          url={preview.url}
          title={preview.title}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

// ── DocuSign trade-confirmation panel ────────────────────────────────

// Renders inside the Final Decision card when the club voted Buy. Three
// states: no envelope (admin sees a Send button, others see nothing yet),
// envelope sent (everyone sees a status pill + frozen trade context), or
// envelope completed (signed pill + completion date).
function DocusignPanel({ session, canSend, sending, error, onSend, onRefresh }) {
  const status = session.docusignStatus;
  const ctx = session.docusignTradeContext;
  const [diag, setDiag] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function runDiagnose() {
    setDiagLoading(true);
    try {
      const { data } = await api.get('/docusign/diagnose');
      setDiag(data);
    } catch (err) {
      setDiag({ error: err.response?.data?.error || err.message });
    } finally {
      setDiagLoading(false);
    }
  }

  async function refreshEnvelopeStatus() {
    setRefreshing(true);
    try {
      await api.get(`/docusign/sessions/${session.id}/refresh`);
      onRefresh?.();
    } catch (err) {
      // Swallow — server-side error already logged; UI just doesn't update.
      console.warn('docusign refresh failed:', err.message);
    } finally {
      setRefreshing(false);
    }
  }

  if (!session.docusignEnvelopeId) {
    if (!canSend) return null;
    return (
      <div className="mt-3 rounded-lg border border-navy-100 bg-white p-3">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-navy-400">
          Trade confirmation
        </div>
        <p className="mb-3 text-xs text-navy-400">
          Sends a DocuSign envelope to the configured signer with the
          ticker, share count, and live quote pre-filled.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSend} disabled={sending}>
            {sending ? 'Sending…' : 'Send trade confirmation'}
          </Button>
          <button
            type="button"
            onClick={runDiagnose}
            disabled={diagLoading}
            className="text-xs font-semibold text-navy-400 underline hover:text-navy"
          >
            {diagLoading ? 'Checking…' : 'Run diagnose'}
          </button>
        </div>
        {error && (
          <div className="mt-2 text-xs font-semibold text-red-700">{error}</div>
        )}
        {diag && (
          <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-navy-50 p-2 text-[11px] leading-snug text-navy">
            {JSON.stringify(diag, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  const pillTone =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : status === 'declined' || status === 'voided'
      ? 'bg-red-100 text-red-800 border-red-200'
      : 'bg-gold-100 text-gold-800 border-gold-300';
  const pillLabel =
    status === 'completed'
      ? 'Signed'
      : status === 'declined'
      ? 'Declined'
      : status === 'voided'
      ? 'Voided'
      : 'Awaiting signature';

  return (
    <div className="mt-3 rounded-lg border border-navy-100 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-navy-400">
          Trade confirmation
        </div>
        <div className="flex items-center gap-2">
          {canSend && (
            <button
              type="button"
              onClick={refreshEnvelopeStatus}
              disabled={refreshing}
              className="text-[10px] font-semibold text-navy-400 underline hover:text-navy"
            >
              {refreshing ? 'Refreshing…' : 'Refresh status'}
            </button>
          )}
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${pillTone}`}
          >
            {pillLabel}
          </span>
        </div>
      </div>
      {ctx && (
        <div className="mt-2 text-xs text-navy-400">
          {ctx.shares} share{ctx.shares === 1 ? '' : 's'} of {ctx.ticker} at $
          {Number(ctx.pricePerShare).toFixed(2)} · $
          {Number(ctx.totalCost).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{' '}
          total
        </div>
      )}
      {session.docusignSentAt && (
        <div className="mt-1 text-xs text-navy-400">
          Sent {format(new Date(session.docusignSentAt), 'MMM d, yyyy h:mm a')}
          {' '}to the template signatories
          {status === 'completed' && session.docusignCompletedAt && (
            <>
              {' '}
              · signed{' '}
              {format(
                new Date(session.docusignCompletedAt),
                'MMM d, yyyy h:mm a'
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tally display ────────────────────────────────────────────────────

function TallyDisplay({ tally, isOpen, ticker }) {
  // Live quote for the share-count math in the Proposed Buy block. We
  // keep this hook unconditional so it runs in stable order; the body
  // bails out if there's no ticker or no Buy ballots to size.
  const [quote, setQuote] = useState({ status: 'idle', price: null });
  useEffect(() => {
    const t = (ticker || '').trim().toUpperCase();
    if (!t || !tally?.buyAmountStats) {
      setQuote({ status: 'idle', price: null });
      return;
    }
    let cancelled = false;
    setQuote({ status: 'loading', price: null });
    api
      .get(`/holdings/info/${encodeURIComponent(t)}`)
      .then((res) => {
        if (cancelled) return;
        const p = Number(res.data?.price);
        setQuote(
          Number.isFinite(p) && p > 0
            ? { status: 'ok', price: p }
            : { status: 'error', price: null }
        );
      })
      .catch(() => {
        if (!cancelled) setQuote({ status: 'error', price: null });
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, tally?.buyAmountStats]);

  if (!tally) return null;
  const {
    memberCounts,
    memberTotal,
    generalBodyDecision,
    generalBodyWeight,
    generalBodyBlocWeight = 3,
    leadershipVotes = [],
    maxWeightedVotes = generalBodyBlocWeight + 2,
    weights,
    buyAmountStats,
  } = tally;

  const barTotal = Math.max(weights.Buy + weights.Hold + weights.Sell, 1);

  return (
    <div className="space-y-4">
      {/* Weight bar */}
      <div>
        <div className="mb-1 text-xs uppercase text-navy-400">
          Weighted Votes (max {maxWeightedVotes})
        </div>
        <div className="flex h-8 overflow-hidden rounded-lg border border-navy-100">
          {weights.Buy > 0 && (
            <div
              className="flex items-center justify-center bg-emerald-500 text-xs font-bold text-white"
              style={{ width: `${(weights.Buy / barTotal) * 100}%` }}
            >
              Buy {weights.Buy}
            </div>
          )}
          {weights.Hold > 0 && (
            <div
              className="flex items-center justify-center bg-gold text-xs font-bold text-navy"
              style={{ width: `${(weights.Hold / barTotal) * 100}%` }}
            >
              Hold {weights.Hold}
            </div>
          )}
          {weights.Sell > 0 && (
            <div
              className="flex items-center justify-center bg-red-500 text-xs font-bold text-white"
              style={{ width: `${(weights.Sell / barTotal) * 100}%` }}
            >
              Sell {weights.Sell}
            </div>
          )}
          {barTotal === 0 && (
            <div className="flex flex-1 items-center justify-center bg-navy-50 text-xs text-navy-400">
              No votes yet
            </div>
          )}
        </div>
      </div>

      {/* General body */}
      <div className="rounded-lg border border-navy-100 p-3">
        <div className="text-xs font-semibold uppercase text-navy-400">
          General Body (worth {generalBodyBlocWeight} votes)
        </div>
        <div className="mt-2 flex gap-4 text-sm">
          <span className="text-emerald-700 font-semibold">Buy {memberCounts.Buy}</span>
          <span className="text-gold-700 font-semibold">Hold {memberCounts.Hold}</span>
          <span className="text-red-700 font-semibold">Sell {memberCounts.Sell}</span>
        </div>
        <div className="mt-1 text-xs text-navy-400">
          {memberTotal} member(s) voted →{' '}
          {generalBodyDecision ? (
            <span className="font-bold">
              Majority: {generalBodyDecision} ({generalBodyWeight} votes)
            </span>
          ) : memberTotal === 0 ? (
            'Awaiting votes'
          ) : (
            <span className="font-bold text-gold-700">Tied — 0 votes contributed</span>
          )}
        </div>
      </div>

      {/* Leadership — Presidents & CIO */}
      <div className="rounded-lg border border-navy-100 p-3">
        <div className="text-xs font-semibold uppercase text-navy-400">
          Leadership (1 vote each · Presidents & CIO)
        </div>
        {leadershipVotes.length === 0 ? (
          <div className="mt-2 text-xs text-navy-400">
            {isOpen ? 'No leadership votes yet' : 'No leadership votes cast'}
          </div>
        ) : (
          <ul className="mt-2 space-y-1">
            {leadershipVotes.map((lv) => (
              <li key={lv.userId} className="flex items-center justify-between text-sm">
                <span className="text-navy">
                  {lv.name}
                  {lv.role && (
                    <span className="ml-1 text-[10px] uppercase text-navy-400">
                      · {lv.role}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {lv.action === 'Buy' && lv.investmentAmount != null && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                      ${lv.investmentAmount.toLocaleString()}
                    </span>
                  )}
                  <ActionBadge action={lv.action} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Proposed Buy allocation — average / range from Buy ballots,
          plus a live share-count sizing against the current quote. */}
      {buyAmountStats && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
          <div className="text-xs font-semibold uppercase text-emerald-800">
            Proposed Buy allocation
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <div className="text-2xl font-bold tabular-nums text-emerald-800">
              ${Math.round(buyAmountStats.avg).toLocaleString()}
            </div>
            <div className="text-xs text-navy-400">
              average across {buyAmountStats.count} Buy ballot
              {buyAmountStats.count === 1 ? '' : 's'}
            </div>
          </div>
          <div className="mt-1 text-xs text-navy-400">
            Range: ${buyAmountStats.min.toLocaleString()} – ${buyAmountStats.max.toLocaleString()}
          </div>

          {/* Share sizing — rounds to the nearest whole share at the
              live quote and shows the resulting dollar cost so any
              over/underrun vs. the proposed buy is visible. */}
          <div className="mt-3 border-t border-emerald-200 pt-3">
            {quote.status === 'loading' && (
              <div className="text-xs text-navy-400">
                Pulling {ticker} quote…
              </div>
            )}
            {quote.status === 'error' && (
              <div className="text-xs text-navy-400">
                Couldn't pull a live quote for {ticker}.
              </div>
            )}
            {quote.status === 'ok' && (() => {
              const shares = Math.round(buyAmountStats.avg / quote.price);
              const cost = shares * quote.price;
              const delta = cost - buyAmountStats.avg;
              return (
                <>
                  <div className="flex items-baseline gap-3">
                    <div className="text-lg font-bold tabular-nums text-emerald-800">
                      {shares.toLocaleString()} share{shares === 1 ? '' : 's'}
                    </div>
                    <div className="text-xs text-navy-400">
                      at ${quote.price.toFixed(2)} / share
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-navy-400">
                    ≈ ${cost.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    ({delta >= 0 ? '+' : '−'}$
                    {Math.abs(delta).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    vs. proposed)
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Editorial helpers (masthead + section kicker) ─────────────────────

function VotesMasthead({ openSessions, closedSessions }) {
  const totalThisMonth = closedSessions.filter((s) => {
    const d = new Date(s.closedAt || s.createdAt);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const nextDeadline = openSessions[0]?.deadline
    ? new Date(openSessions[0].deadline)
    : null;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy-700 to-navy-800 text-white shadow-xl">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #C9A84C 1px, transparent 1px), linear-gradient(to bottom, #C9A84C 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="relative grid gap-4 p-6 md:grid-cols-3 md:gap-8 md:p-8">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
            <span className="h-px w-5 bg-gold" />
            Open Now
          </div>
          <div className="mt-3 font-serif text-5xl font-semibold tabular-nums md:text-6xl">
            {openSessions.length}
          </div>
          <div className="mt-2 text-xs text-navy-100">
            {openSessions.length === 0
              ? 'No votes in progress'
              : `Active voting session${openSessions.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
            <span className="h-px w-5 bg-gold" />
            This Month
          </div>
          <div className="mt-3 font-serif text-5xl font-semibold tabular-nums md:text-6xl">
            {totalThisMonth}
          </div>
          <div className="mt-2 text-xs text-navy-100">
            Decisions recorded in {format(new Date(), 'MMMM')}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
            <span className="h-px w-5 bg-gold" />
            Next Deadline
          </div>
          <div className="mt-3 font-serif text-2xl font-semibold leading-tight md:text-3xl">
            {nextDeadline
              ? formatDistanceToNow(nextDeadline, { addSuffix: true })
              : '—'}
          </div>
          <div className="mt-2 text-xs text-navy-100">
            {nextDeadline
              ? `${openSessions[0].ticker} · ${format(nextDeadline, 'MMM d, h:mm a')}`
              : 'Nothing scheduled'}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionKicker({ label, count, accent }) {
  const toneClass =
    accent === 'emerald' ? 'text-emerald-700' : 'text-gold-700';
  const ruleClass =
    accent === 'emerald' ? 'bg-emerald-500' : 'bg-gold';
  return (
    <div className="flex items-end justify-between border-b border-navy-100 pb-2">
      <div className="flex items-center gap-2">
        <span className={`h-px w-6 ${ruleClass}`} />
        <h2 className={`text-[10px] font-semibold uppercase tracking-[0.25em] ${toneClass}`}>
          {label}
        </h2>
      </div>
      {count != null && count > 0 && (
        <span className="font-serif text-sm font-semibold text-navy tabular-nums">
          {count}
        </span>
      )}
    </div>
  );
}
