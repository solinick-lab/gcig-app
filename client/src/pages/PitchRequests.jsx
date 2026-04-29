import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, XCircle, Clock, Eye, Send } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import RequestPitchModal from '../components/RequestPitchModal.jsx';
import FilePreviewModal from '../components/FilePreviewModal.jsx';
import { openOrPreview } from '../api/fileHelpers.js';
import { formatStartTime, ROOM_LABELS } from '../lib/lunchSlots.js';

const PM_RANKED = [
  'PortfolioManager',
  'SeniorPortfolioManager',
  'CIO',
  'President',
];
const PRESIDENT_ROLE = 'President';

function lunchSummary(v) {
  if (v === 'Both') return 'Either lunch';
  if (v === 'First') return 'First lunch';
  if (v === 'Second') return 'Second lunch';
  return null;
}

function statusPill(status) {
  if (status === 'Approved')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Approved
      </span>
    );
  if (status === 'Declined')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700">
        <XCircle className="h-3 w-3" /> Declined
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gold-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold-800">
      <Clock className="h-3 w-3" /> Pending
    </span>
  );
}

export default function PitchRequests() {
  const { user } = useAuth();
  const isPresident = user?.role === PRESIDENT_ROLE;
  const isPM = PM_RANKED.includes(user?.role);

  const [mine, setMine] = useState([]);
  const [pendingPresident, setPendingPresident] = useState([]);
  const [pendingPM, setPendingPM] = useState([]);
  const [requestOpen, setRequestOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function loadAll() {
    const tasks = [api.get('/pitch-requests/mine').then((r) => setMine(r.data)).catch(() => {})];
    if (isPresident) {
      tasks.push(
        api
          .get('/pitch-requests/pending-for-president')
          .then((r) => setPendingPresident(r.data))
          .catch(() => {})
      );
    }
    if (isPM) {
      tasks.push(
        api
          .get('/pitch-requests/pending-for-pm')
          .then((r) => setPendingPM(r.data))
          .catch(() => {})
      );
    }
    await Promise.all(tasks);
  }

  useEffect(() => {
    loadAll();
    // Mark un-seen decisions as seen so the dashboard badge clears.
    api
      .get('/pitch-requests/mine')
      .then((r) => {
        const undismissed = r.data.filter(
          (req) =>
            req.status !== 'Pending' && !req.requesterSeenAt
        );
        return Promise.all(
          undismissed.map((req) =>
            api.post(`/pitch-requests/mine/${req.id}/seen`).catch(() => {})
          )
        );
      })
      .catch(() => {});
  }, [isPresident, isPM]);

  async function decide(row, role, approved) {
    let reason = null;
    if (!approved) {
      reason = window.prompt(
        approved
          ? ''
          : 'Optional — share why you can\'t make this meeting (the requester will see this):'
      );
      if (reason === null) return; // cancelled
    }
    setBusyId(`${role}-${row.id}`);
    try {
      const path =
        role === 'President'
          ? `/pitch-requests/${row.id}/president-decision`
          : `/pitch-requests/${row.id}/pm-decision`;
      await api.post(path, { approved, reason });
      await loadAll();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to record decision.');
    } finally {
      setBusyId(null);
    }
  }

  const presidentSection = useMemo(() => {
    if (!isPresident) return null;
    return (
      <Card
        kicker="Inbox"
        title={`Awaiting your decision (${pendingPresident.length})`}
      >
        {pendingPresident.length === 0 ? (
          <p className="text-sm text-navy-400">
            No pending requests right now.
          </p>
        ) : (
          <div className="space-y-3">
            {pendingPresident.map((row) => (
              <RequestRow
                key={row.id}
                row={row}
                showPresidentActions
                busy={busyId}
                onDecide={(approved) => decide(row, 'President', approved)}
              />
            ))}
          </div>
        )}
      </Card>
    );
  }, [isPresident, pendingPresident, busyId]);

  const pmSection = useMemo(() => {
    if (!isPM) return null;
    if (isPresident && pendingPM.length === 0) return null;
    return (
      <Card
        kicker="For your awareness"
        title={`Pitch requests in your sectors (${pendingPM.length})`}
      >
        {pendingPM.length === 0 ? (
          <p className="text-sm text-navy-400">
            No pending requests in your sectors.
          </p>
        ) : (
          <div className="space-y-3">
            {pendingPM.map((row) => (
              <RequestRow
                key={row.id}
                row={row}
                showPMActions
                busy={busyId}
                onDecide={(approved) => decide(row, 'PM', approved)}
              />
            ))}
          </div>
        )}
      </Card>
    );
  }, [isPM, isPresident, pendingPM, busyId]);

  return (
    <>
      <PageHeader
        kicker="Pitch Pipeline"
        title="Pitch Requests"
        subtitle="Member-initiated pitch meetings with the President."
        actions={
          <Button onClick={() => setRequestOpen(true)} variant="gold">
            <Send className="h-4 w-4" />
            New request
          </Button>
        }
      />

      <div className="space-y-4">
        {presidentSection}
        {pmSection}

        <Card kicker="Yours" title={`My requests (${mine.length})`}>
          {mine.length === 0 ? (
            <p className="text-sm text-navy-400">
              You haven't submitted any pitch requests yet. Use the button above
              to request a meeting with the President.
            </p>
          ) : (
            <div className="space-y-3">
              {mine.map((row) => (
                <RequestRow key={row.id} row={row} mine />
              ))}
            </div>
          )}
        </Card>
      </div>

      <RequestPitchModal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        onSubmitted={loadAll}
      />
    </>
  );
}

function RequestRow({
  row,
  showPresidentActions,
  showPMActions,
  mine,
  busy,
  onDecide,
}) {
  const lunch = lunchSummary(row.proposedLunch);
  const proposed = row.proposedDate
    ? format(new Date(row.proposedDate), 'EEE, MMM d, yyyy')
    : 'No date proposed';
  const [preview, setPreview] = useState(null);

  return (
    <div className="rounded-lg border border-navy-100 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <div className="font-serif text-lg font-semibold text-navy">
              {row.ticker}
              {row.companyName ? (
                <span className="ml-2 text-sm font-normal text-navy-400">
                  {row.companyName}
                </span>
              ) : null}
            </div>
            {statusPill(row.status)}
          </div>
          <div className="mt-1 text-xs text-navy-400">
            {mine ? 'You · ' : `${row.requester?.name || 'Member'} · `}
            requested {format(new Date(row.createdAt), 'MMM d, yyyy')}
            {row.industry?.name ? ` · ${row.industry.name}` : ''}
          </div>
        </div>
        <div className="text-right text-xs text-navy-400">
          <div>{proposed}</div>
          {lunch && <div>{lunch}</div>}
          {(row.proposedStartTime || row.room) && (
            <div className="font-semibold text-navy">
              {row.proposedStartTime ? formatStartTime(row.proposedStartTime) : ''}
              {row.proposedStartTime && row.room ? ' · ' : ''}
              {row.room ? ROOM_LABELS[row.room] || row.room : ''}
            </div>
          )}
        </div>
      </div>

      {row.thesis && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-navy">
          {row.thesis}
        </p>
      )}
      {row.notes && (
        <p className="mt-2 whitespace-pre-wrap rounded-lg bg-navy-50/60 px-3 py-2 text-xs text-navy">
          <span className="font-semibold">Notes:</span> {row.notes}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {row.deckRef ? (
          <button
            type="button"
            onClick={() =>
              openOrPreview(
                {
                  url: row.deckRef,
                  title: `${row.ticker} pitch deck`,
                  filename: `${row.ticker}-deck.pdf`,
                },
                setPreview
              )
            }
            className="inline-flex items-center gap-1 text-xs font-semibold text-gold-700 underline"
          >
            <Eye className="h-3.5 w-3.5" />
            View deck
          </button>
        ) : null}
        {row.pm?.name && (
          <span className="text-[11px] text-navy-400">
            PM: {row.pm.name}
            {row.pmDecidedAt ? (
              row.pmApproved ? (
                <span className="ml-1 text-emerald-700">· available</span>
              ) : (
                <span className="ml-1 text-red-700">
                  · can't make it{row.pmDeclineReason ? ` (${row.pmDeclineReason})` : ''}
                </span>
              )
            ) : null}
          </span>
        )}
      </div>

      {row.status === 'Declined' && row.presidentDeclineReason && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <span className="font-semibold">Reason:</span> {row.presidentDeclineReason}
        </div>
      )}

      {(showPresidentActions || showPMActions) && row.status === 'Pending' && (
        <div className="mt-3 flex gap-2 border-t border-navy-50 pt-3">
          <Button
            variant="gold"
            disabled={busy?.startsWith(showPresidentActions ? 'President-' : 'PM-')}
            onClick={() => onDecide(true)}
          >
            <CheckCircle2 className="h-4 w-4" />
            {showPresidentActions ? 'Approve meeting' : "I'm available"}
          </Button>
          <Button
            variant="danger"
            disabled={busy?.startsWith(showPresidentActions ? 'President-' : 'PM-')}
            onClick={() => onDecide(false)}
          >
            <XCircle className="h-4 w-4" />
            {showPresidentActions ? 'Decline' : "Can't make it"}
          </Button>
        </div>
      )}
      {preview && (
        <FilePreviewModal
          url={preview.url}
          title={preview.title}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
