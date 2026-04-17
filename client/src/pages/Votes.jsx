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
import { safeHref } from '../api/safeUrl.js';
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
        title="Voting"
        subtitle="Vote on pitches — general body (2 votes) + presidents (1 each)."
        actions={
          <AdminOnly>
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Start Vote
            </Button>
          </AdminOnly>
        }
      />

      {openSessions.length > 0 && (
        <div className="mb-6 space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-emerald-700">
            <Clock className="h-4 w-4" />
            Live Now
          </h2>
          {openSessions.map((s) => (
            <SessionCard key={s.id} session={s} onClick={() => openDetail(s.id)} />
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-navy-400">
          <CheckCircle2 className="h-4 w-4" />
          Past Sessions
        </h2>
        {closedSessions.length === 0 ? (
          <Card>
            <div className="py-8 text-center text-navy-400">No past voting sessions.</div>
          </Card>
        ) : (
          closedSessions.map((s) => (
            <SessionCard key={s.id} session={s} onClick={() => openDetail(s.id)} />
          ))
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

function SessionDetail({ session, onBack, onRefresh, onClose, onDelete }) {
  const { user, isAdmin } = useAuth();
  const [ballotAction, setBallotAction] = useState('');
  const [ballotNote, setBallotNote] = useState('');
  const [casting, setCasting] = useState(false);
  const isOpen = session.status === 'open' && !isPast(new Date(session.deadline));
  const tally = session.tally;

  useEffect(() => {
    if (session.myBallot) {
      setBallotAction(session.myBallot.action);
      setBallotNote(session.myBallot.note || '');
    }
  }, [session.myBallot]);

  async function castBallot(e) {
    e.preventDefault();
    setCasting(true);
    try {
      await api.post(`/votes/${session.id}/ballot`, {
        action: ballotAction,
        note: ballotNote || null,
      });
      onRefresh();
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
              <a
                href={safeHref(session.pitch.slideshowUrl)}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-gold-700 underline"
              >
                View Slideshow →
              </a>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Tally */}
        <Card title="Weighted Tally">
          <TallyDisplay tally={tally} isOpen={isOpen} />
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
                      onClick={() => setBallotAction(a)}
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
                {tally.totalWeightedVotes} of 6 weighted votes cast
              </div>
            </div>
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
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-navy">{b.user.name}</span>
                      <RoleBadge role={b.user.role} />
                      {b.user.role === 'President' && (
                        <span className="text-[10px] text-navy-400">(1 vote)</span>
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
    </>
  );
}

// ── Tally display ────────────────────────────────────────────────────

function TallyDisplay({ tally, isOpen }) {
  if (!tally) return null;
  const { memberCounts, memberTotal, generalBodyDecision, generalBodyWeight, presidentVotes, weights } = tally;

  const barTotal = Math.max(weights.Buy + weights.Hold + weights.Sell, 1);

  return (
    <div className="space-y-4">
      {/* Weight bar */}
      <div>
        <div className="mb-1 text-xs uppercase text-navy-400">Weighted Votes (max 6)</div>
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
          General Body (worth {2} votes)
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

      {/* Presidents */}
      <div className="rounded-lg border border-navy-100 p-3">
        <div className="text-xs font-semibold uppercase text-navy-400">
          Presidents (1 vote each)
        </div>
        {presidentVotes.length === 0 ? (
          <div className="mt-2 text-xs text-navy-400">
            {isOpen ? 'No presidents have voted yet' : 'No presidents voted'}
          </div>
        ) : (
          <ul className="mt-2 space-y-1">
            {presidentVotes.map((pv) => (
              <li key={pv.userId} className="flex items-center justify-between text-sm">
                <span className="text-navy">{pv.name}</span>
                <ActionBadge action={pv.action} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
