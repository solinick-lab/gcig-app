// Bundled trade-confirmation envelopes.
//
// Composer flow: pick one or more closed Buy sessions → optionally add a
// Sell line (typically SPY to free up cash) → preview totals → send. One
// DocuSign envelope per request, regardless of how many tickers.
//
// Quotes are pulled client-side for the preview, then re-pulled server-side
// at send time (source of truth). The composer is meant to surface "what
// would this look like if I sent it right now" without writing anything.

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Plus, Trash2, TrendingUp, TrendingDown, FileText, RefreshCw } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import AdminOnly from '../components/AdminOnly.jsx';

export default function TradeRequests({ embedded = false } = {}) {
  const { isExecutive } = useAuth();
  const [requests, setRequests] = useState([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(null);

  async function loadRequests() {
    const { data } = await api.get('/trade-requests');
    setRequests(data);
  }

  useEffect(() => {
    if (isExecutive) loadRequests();
  }, [isExecutive]);

  async function refreshOne(id) {
    setRefreshing(id);
    try {
      await api.get(`/trade-requests/${id}/refresh`);
      await loadRequests();
    } finally {
      setRefreshing(null);
    }
  }

  async function deleteOne(tr) {
    const warning = tr.docusignEnvelopeId
      ? `Delete Approval #${tr.id}? The DocuSign envelope was already sent — ` +
        `deleting it here only removes the record on this site. Void the ` +
        `envelope itself in DocuSign if it shouldn't sit in signers' inboxes.`
      : `Delete Approval #${tr.id}?`;
    if (!window.confirm(warning)) return;
    await api.delete(`/trade-requests/${tr.id}`);
    await loadRequests();
  }

  if (!isExecutive) {
    return (
      <>
        {!embedded && (
          <PageHeader
            kicker="Trading"
            title="Trade Approval"
            subtitle="Bundled DocuSign envelopes for executed votes."
          />
        )}
        <Card>
          <div className="py-8 text-center text-navy-400">
            Visible to executive officers only.
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      {!embedded && (
        <PageHeader
          kicker="Trading"
          title="Trade Approval"
          subtitle="Bundle multiple closed Buy votes (and an optional Sell-to-cover) into a single DocuSign envelope."
          actions={
            <AdminOnly>
              <Button onClick={() => setComposerOpen(true)} variant="gold">
                <Plus className="h-4 w-4" />
                New Trade Approval
              </Button>
            </AdminOnly>
          }
        />
      )}
      {embedded && (
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-navy-400">
            Bundle multiple closed Buy votes (and an optional Sell-to-cover)
            into a single DocuSign envelope.
          </p>
          <AdminOnly>
            <Button onClick={() => setComposerOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              New Trade Approval
            </Button>
          </AdminOnly>
        </div>
      )}

      <div className={embedded ? 'space-y-3' : 'mt-6 space-y-3'}>
        {requests.length === 0 ? (
          <Card>
            <div className="py-8 text-center text-navy-400">
              No trade approvals yet. Click "New Trade Approval" to bundle
              some closed Buy votes into an envelope.
            </div>
          </Card>
        ) : (
          requests.map((tr) => (
            <RequestRow
              key={tr.id}
              tr={tr}
              refreshing={refreshing === tr.id}
              onRefresh={() => refreshOne(tr.id)}
              onDelete={() => deleteOne(tr)}
            />
          ))
        )}
      </div>

      <Composer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreated={() => {
          setComposerOpen(false);
          loadRequests();
        }}
      />
    </>
  );
}

// ── List row ──────────────────────────────────────────────────────────

function RequestRow({ tr, refreshing, onRefresh, onDelete }) {
  const status = tr.docusignStatus || 'draft';
  const tone =
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : status === 'declined' || status === 'voided'
      ? 'bg-red-100 text-red-800 border-red-200'
      : 'bg-gold-100 text-gold-800 border-gold-300';
  const label =
    status === 'completed'
      ? 'Signed'
      : status === 'declined'
      ? 'Declined'
      : status === 'voided'
      ? 'Voided'
      : status === 'delivered'
      ? 'Awaiting signature'
      : status === 'sent'
      ? 'Sent'
      : 'Draft';

  const buyTotal = tr.items
    .filter((i) => i.kind === 'Buy')
    .reduce((s, i) => s + i.totalCost, 0);
  const sellTotal = tr.items
    .filter((i) => i.kind === 'Sell')
    .reduce((s, i) => s + i.totalCost, 0);

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="h-4 w-4 text-navy-400" />
            <span className="font-semibold text-navy">
              Approval #{tr.id}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}
            >
              {label}
            </span>
          </div>
          <div className="mt-1 text-xs text-navy-400">
            by {tr.creator?.name} •{' '}
            {format(new Date(tr.createdAt), 'MMM d, yyyy h:mm a')}
            {tr.docusignSentAt && (
              <>
                {' '}
                · sent {format(new Date(tr.docusignSentAt), 'MMM d, h:mm a')}
              </>
            )}
          </div>

          <ul className="mt-3 divide-y divide-navy-50 rounded-lg border border-navy-100">
            {tr.items.map((i) => (
              <li
                key={i.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  {i.kind === 'Buy' ? (
                    <TrendingUp className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-red-600" />
                  )}
                  <span className="font-semibold text-navy">
                    {i.kind} {i.shares} {i.ticker}
                  </span>
                  <span className="text-xs text-navy-400">
                    @ ${i.pricePerShare.toFixed(2)}
                  </span>
                </div>
                <span className="text-sm font-semibold tabular-nums text-navy">
                  ${i.totalCost.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-2 flex flex-wrap gap-4 text-xs text-navy-400">
            <span>
              Buys:{' '}
              <span className="font-semibold text-navy">
                ${buyTotal.toFixed(2)}
              </span>
            </span>
            {sellTotal > 0 && (
              <span>
                Sells:{' '}
                <span className="font-semibold text-navy">
                  ${sellTotal.toFixed(2)}
                </span>
              </span>
            )}
            <span>
              Net cash:{' '}
              <span
                className={`font-semibold ${
                  sellTotal - buyTotal >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {sellTotal - buyTotal >= 0 ? '+' : '−'}$
                {Math.abs(sellTotal - buyTotal).toFixed(2)}
              </span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {tr.docusignEnvelopeId && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="flex items-center gap-1 text-xs font-semibold text-navy-400 underline hover:text-navy"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1 text-xs font-semibold text-red-600 underline hover:text-red-800"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        </div>
      </div>
    </Card>
  );
}

// ── Composer ──────────────────────────────────────────────────────────

const DEFAULT_SELL_TICKER = 'VOO';
// Cushion added to the default cover amount. Trades aren't instant — by the
// time the broker fills, both the Buy legs and the SPY sell can drift on
// us, so we ask for a bit more than the bare buy total. $1,000 has been
// enough headroom historically.
const COVER_BUFFER = 1000;

function Composer({ open, onClose, onCreated }) {
  const [eligible, setEligible] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Passed sell votes (closed kind:sell, finalDecision Sell) the exec can
  // bundle as Sell lines, each sized to the whole held position.
  const [eligibleSells, setEligibleSells] = useState([]);
  const [selectedSellIds, setSelectedSellIds] = useState(new Set());
  // Per-session live quote, keyed by ticker so two sessions of the same
  // ticker share a fetch.
  const [quotes, setQuotes] = useState({});
  // Optional per-session share override (otherwise round(avg / quote)).
  const [shareOverrides, setShareOverrides] = useState({});
  // Sell-to-cover line state. `mode = 'shares' | 'cover'`. When the user
  // toggles it on, shares default to whatever covers the buy total.
  const [sellEnabled, setSellEnabled] = useState(false);
  const [sellTicker, setSellTicker] = useState(DEFAULT_SELL_TICKER);
  const [sellMode, setSellMode] = useState('cover');
  const [sellShares, setSellShares] = useState('');
  const [sellCoverAmount, setSellCoverAmount] = useState('');
  // Current shares held of `sellTicker`, read from the portfolio sheet. We
  // pull it whenever Sell-to-cover is enabled so the exec can see the
  // VOO/SPY/etc. position and we can warn before the envelope goes out.
  const [sellPosition, setSellPosition] = useState({ status: 'idle' });
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setSelectedIds(new Set());
    setSelectedSellIds(new Set());
    setShareOverrides({});
    setSellEnabled(false);
    setSellTicker(DEFAULT_SELL_TICKER);
    setSellMode('cover');
    setSellShares('');
    setSellCoverAmount('');
    setNote('');
    api
      .get('/trade-requests/eligible-buys')
      .then((res) => setEligible(res.data))
      .catch((err) =>
        setError(err.response?.data?.error || 'Failed to load eligible sessions')
      );
    api
      .get('/trade-requests/eligible-sells')
      .then((res) => setEligibleSells(res.data))
      .catch(() => setEligibleSells([]));
  }, [open]);

  // Fetch quotes for every selected session's ticker + the sell ticker.
  useEffect(() => {
    const tickers = new Set();
    for (const id of selectedIds) {
      const s = eligible.find((e) => e.id === id);
      if (s) tickers.add(s.ticker);
    }
    if (sellEnabled && sellTicker) tickers.add(sellTicker.toUpperCase());
    for (const id of selectedSellIds) {
      const s = eligibleSells.find((e) => e.id === id);
      if (s) tickers.add(String(s.ticker).toUpperCase());
    }

    tickers.forEach((t) => {
      if (quotes[t]?.status === 'ok' || quotes[t]?.status === 'loading') return;
      setQuotes((q) => ({ ...q, [t]: { status: 'loading' } }));
      api
        .get(`/holdings/info/${encodeURIComponent(t)}`)
        .then((res) => {
          const p = Number(res.data?.price);
          setQuotes((q) => ({
            ...q,
            [t]: Number.isFinite(p) && p > 0
              ? { status: 'ok', price: p }
              : { status: 'error' },
          }));
        })
        .catch(() => setQuotes((q) => ({ ...q, [t]: { status: 'error' } })));
    });
    // We intentionally only depend on the membership of selected tickers,
    // not on the quotes map — otherwise the effect would re-run after every
    // successful fetch and re-fire for every still-loading entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, eligible, sellEnabled, sellTicker, selectedSellIds, eligibleSells]);

  // Read the current Sell-ticker position from the portfolio sheet so the
  // exec can see what's held + we can warn before the envelope goes out
  // for more shares than we own. Re-fires on ticker change.
  useEffect(() => {
    if (!sellEnabled || !sellTicker) {
      setSellPosition({ status: 'idle' });
      return;
    }
    const t = sellTicker.toUpperCase();
    setSellPosition({ status: 'loading', ticker: t });
    let cancelled = false;
    api
      .get(`/trade-requests/position/${encodeURIComponent(t)}`)
      .then((res) => {
        if (cancelled) return;
        setSellPosition({
          status: 'ok',
          ticker: t,
          shares: Number(res.data?.shares) || 0,
          price: res.data?.price ?? null,
          marketValue: res.data?.marketValue ?? null,
          held: !!res.data?.held,
        });
      })
      .catch(() => {
        if (!cancelled) setSellPosition({ status: 'error', ticker: t });
      });
    return () => {
      cancelled = true;
    };
  }, [sellEnabled, sellTicker]);

  // Compute per-line preview rows.
  const lines = useMemo(() => {
    const buys = [];
    for (const id of selectedIds) {
      const s = eligible.find((e) => e.id === id);
      if (!s) continue;
      const quote = quotes[s.ticker];
      const overridden = shareOverrides[id];
      let shares = null;
      if (overridden != null && overridden !== '') {
        const n = Math.round(Number(overridden));
        if (Number.isFinite(n) && n > 0) shares = n;
      } else if (quote?.status === 'ok') {
        shares = Math.max(1, Math.round(s.buyAmountStats.avg / quote.price));
      }
      buys.push({
        kind: 'Buy',
        sessionId: s.id,
        ticker: s.ticker,
        proposedAvg: s.buyAmountStats.avg,
        quote,
        shares,
        totalCost: quote?.status === 'ok' && shares ? shares * quote.price : null,
      });
    }

    let sellLine = null;
    if (sellEnabled && sellTicker) {
      const t = sellTicker.toUpperCase();
      const quote = quotes[t];
      const buyTotal = buys.reduce(
        (s, b) => s + (b.totalCost || 0),
        0
      );
      let shares = null;
      if (sellMode === 'shares') {
        const n = Math.round(Number(sellShares));
        if (Number.isFinite(n) && n > 0) shares = n;
      } else if (sellMode === 'cover') {
        // If the user typed a cover amount, use it; otherwise default to
        // the buy total + a small buffer so a price drift between sending
        // the envelope and the broker filling doesn't leave us short on
        // cash.
        const amt =
          Number(sellCoverAmount) || (buyTotal > 0 ? buyTotal + COVER_BUFFER : 0);
        if (amt > 0 && quote?.status === 'ok') {
          shares = Math.ceil(amt / quote.price);
        }
      }
      sellLine = {
        kind: 'Sell',
        ticker: t,
        quote,
        shares,
        totalCost:
          quote?.status === 'ok' && shares ? shares * quote.price : null,
        // Surface the assumed cover amount so the user can see what the
        // default reflects.
        coverDefault: buyTotal,
      };
    }

    // Vote-driven Sell lines: one per selected passed sell vote, sized to
    // the whole position the sheet says we hold.
    const voteSells = [];
    for (const id of selectedSellIds) {
      const s = eligibleSells.find((e) => e.id === id);
      if (!s) continue;
      const t = String(s.ticker).toUpperCase();
      const quote = quotes[t];
      const shares = s.heldShares != null ? Math.round(s.heldShares) : null;
      voteSells.push({
        kind: 'Sell',
        votingSessionId: s.id,
        ticker: t,
        quote,
        shares,
        heldShares: s.heldShares ?? null,
        totalCost: quote?.status === 'ok' && shares ? shares * quote.price : null,
      });
    }

    return { buys, sellLine, voteSells };
  }, [
    selectedIds,
    eligible,
    quotes,
    shareOverrides,
    sellEnabled,
    sellTicker,
    sellMode,
    sellShares,
    sellCoverAmount,
    selectedSellIds,
    eligibleSells,
  ]);

  const buyTotal = lines.buys.reduce((s, b) => s + (b.totalCost || 0), 0);
  const voteSellTotal = lines.voteSells.reduce((s, v) => s + (v.totalCost || 0), 0);
  const sellTotal = (lines.sellLine?.totalCost || 0) + voteSellTotal;
  const netCash = sellTotal - buyTotal;

  // Over-sell guard. If we'd be selling more shares than the sheet says we
  // own, block the send and surface the gap. Only kicks in once both the
  // intended sell shares and the held position are known.
  const heldShares =
    sellPosition.status === 'ok' &&
    sellPosition.ticker === (sellTicker || '').toUpperCase()
      ? sellPosition.shares
      : null;
  const oversell =
    sellEnabled &&
    lines.sellLine?.shares != null &&
    heldShares != null &&
    lines.sellLine.shares > heldShares;

  // A vote-driven sell line can't be sent if the sheet doesn't tell us how
  // many shares we hold (heldShares null), so require a positive size.
  const voteSellsReady = lines.voteSells.every(
    (v) => v.shares != null && v.shares > 0 && v.totalCost != null
  );

  const allLinesReady =
    (lines.buys.length > 0 || lines.voteSells.length > 0 || sellEnabled) &&
    lines.buys.every((b) => b.shares != null && b.totalCost != null) &&
    (!sellEnabled ||
      (lines.sellLine?.shares != null && lines.sellLine?.totalCost != null)) &&
    voteSellsReady &&
    !oversell;

  function toggleSession(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    setError('');
    setSubmitting(true);
    try {
      const items = [];
      for (const b of lines.buys) {
        const override = shareOverrides[b.sessionId];
        items.push({
          kind: 'Buy',
          votingSessionId: b.sessionId,
          ...(override != null && override !== ''
            ? { shares: Math.round(Number(override)) }
            : {}),
        });
      }
      if (sellEnabled && lines.sellLine) {
        const sellItem = { kind: 'Sell', ticker: lines.sellLine.ticker };
        if (sellMode === 'shares') {
          sellItem.shares = Math.round(Number(sellShares));
        } else {
          sellItem.coverAmount =
            Number(sellCoverAmount) || buyTotal + COVER_BUFFER;
        }
        items.push(sellItem);
      }
      for (const v of lines.voteSells) {
        // Server re-validates the session and sizes to the held position.
        items.push({ kind: 'Sell', votingSessionId: v.votingSessionId });
      }
      await api.post('/trade-requests', { items, note: note || null });
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send envelope');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New Trade Approval" size="xl">
      <div className="space-y-5">
        {/* ── Eligible Buy sessions ── */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-navy-400">
            Closed Buy votes to include
          </div>
          {eligible.length === 0 ? (
            <div className="rounded-lg border border-navy-100 bg-navy-50 px-3 py-4 text-center text-xs text-navy-400">
              No closed Buy votes are waiting on a trade confirmation.
            </div>
          ) : (
            <ul className="space-y-2">
              {eligible.map((s) => {
                const checked = selectedIds.has(s.id);
                const quote = quotes[s.ticker];
                const proposed = Math.round(s.buyAmountStats.avg);
                const autoShares =
                  quote?.status === 'ok'
                    ? Math.max(1, Math.round(s.buyAmountStats.avg / quote.price))
                    : null;
                return (
                  <li
                    key={s.id}
                    className={`rounded-lg border px-3 py-2 ${
                      checked
                        ? 'border-emerald-200 bg-emerald-50/40'
                        : 'border-navy-100 bg-white'
                    }`}
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSession(s.id)}
                        className="mt-1 h-4 w-4 rounded border-navy-200 text-emerald-600 focus:ring-emerald-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-navy">
                            {s.ticker}
                          </span>
                          <span className="text-xs text-navy-400">
                            avg ${proposed.toLocaleString()}
                          </span>
                          {quote?.status === 'ok' && (
                            <span className="text-xs text-navy-400">
                              · ${quote.price.toFixed(2)} / share
                            </span>
                          )}
                          {quote?.status === 'loading' && (
                            <span className="text-xs text-navy-400">
                              · pulling quote…
                            </span>
                          )}
                          {quote?.status === 'error' && (
                            <span className="text-xs text-red-700">
                              · quote unavailable
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-navy-400">
                          Closed{' '}
                          {s.closedAt
                            ? format(new Date(s.closedAt), 'MMM d, yyyy')
                            : '—'}{' '}
                          · {s.ballotCount} ballot
                          {s.ballotCount === 1 ? '' : 's'}
                        </div>
                        {checked && (
                          <div className="mt-2 flex items-center gap-2 text-xs">
                            <span className="text-navy-400">Shares:</span>
                            <input
                              type="number"
                              min={1}
                              value={shareOverrides[s.id] ?? ''}
                              onChange={(e) =>
                                setShareOverrides((o) => ({
                                  ...o,
                                  [s.id]: e.target.value,
                                }))
                              }
                              placeholder={autoShares?.toString() || '—'}
                              className="w-24 rounded border border-navy-100 px-2 py-1 text-xs focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                            />
                            {quote?.status === 'ok' && autoShares != null && (
                              <span className="text-navy-400">
                                (auto = {autoShares})
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ── Passed sell votes ── */}
        {eligibleSells.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-navy-400">
              Passed sell votes
            </div>
            <div className="mt-2 space-y-2">
              {eligibleSells.map((s) => {
                const checked = selectedSellIds.has(s.id);
                return (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                      checked ? 'border-red-300 bg-red-50/50' : 'border-navy-100 bg-white'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedSellIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(s.id)) next.delete(s.id);
                            else next.add(s.id);
                            return next;
                          })
                        }
                        className="h-4 w-4 rounded border-navy-200 text-red-600 focus:ring-red-500"
                      />
                      <TrendingDown className="h-4 w-4 text-red-700" />
                      <span className="font-bold text-navy">{s.ticker}</span>
                      <span className="text-xs text-navy-400">
                        {s.heldShares != null
                          ? `sell all ${s.heldShares} sh`
                          : 'no position on sheet'}
                      </span>
                    </span>
                    {s.heldShares == null && (
                      <span className="text-[10px] font-semibold text-red-700">
                        unavailable
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Sell-to-cover ── */}
        <div className="rounded-lg border border-navy-100 bg-white p-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sellEnabled}
              onChange={(e) => setSellEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-navy-200 text-red-600 focus:ring-red-500"
            />
            <span className="text-sm font-semibold text-navy">
              Sell to cover
            </span>
            <span className="text-xs text-navy-400">
              (free up cash to fund the buys)
            </span>
          </label>
          {sellEnabled && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs text-navy-400">Ticker</label>
                  <input
                    value={sellTicker}
                    onChange={(e) => setSellTicker(e.target.value.toUpperCase())}
                    className="mt-1 w-24 rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                  />
                </div>
                <div>
                  <label className="block text-xs text-navy-400">Size by</label>
                  <select
                    value={sellMode}
                    onChange={(e) => setSellMode(e.target.value)}
                    className="mt-1 rounded border border-navy-100 px-2 py-1 text-sm"
                  >
                    <option value="cover">Cover amount</option>
                    <option value="shares">Specific shares</option>
                  </select>
                </div>
                {sellMode === 'shares' ? (
                  <div>
                    <label className="block text-xs text-navy-400">Shares</label>
                    <input
                      type="number"
                      min={1}
                      value={sellShares}
                      onChange={(e) => setSellShares(e.target.value)}
                      className="mt-1 w-24 rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-navy-400">
                      Cover amount ($)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={sellCoverAmount}
                      onChange={(e) => setSellCoverAmount(e.target.value)}
                      placeholder={
                        buyTotal > 0
                          ? Math.ceil(buyTotal + COVER_BUFFER).toLocaleString()
                          : '—'
                      }
                      className="mt-1 w-32 rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                    />
                    <p className="mt-1 text-[10px] text-navy-400">
                      Default = buys + ${COVER_BUFFER.toLocaleString()} buffer for price drift
                    </p>
                  </div>
                )}
              </div>
              {lines.sellLine && lines.sellLine.quote?.status === 'ok' && (
                <div className="text-xs text-navy-400">
                  At ${lines.sellLine.quote.price.toFixed(2)} / share
                  {lines.sellLine.shares != null && (
                    <>
                      {' '}
                      → sell{' '}
                      <span className="font-semibold text-navy">
                        {lines.sellLine.shares} share
                        {lines.sellLine.shares === 1 ? '' : 's'}
                      </span>{' '}
                      = ${lines.sellLine.totalCost?.toFixed(2)}
                    </>
                  )}
                </div>
              )}
              {/* Sheet-portfolio position readout. Lets the exec eyeball
                  what's owned vs. what we're about to sell, and hard-stops
                  the send if shares-to-sell would go negative. */}
              {sellPosition.status === 'loading' && (
                <div className="text-xs text-navy-400">
                  Pulling current {sellPosition.ticker} position…
                </div>
              )}
              {sellPosition.status === 'error' && (
                <div className="text-xs text-red-700">
                  Couldn't pull current position from the portfolio sheet.
                </div>
              )}
              {sellPosition.status === 'ok' && (
                <div
                  className={`rounded-md border px-2 py-1.5 text-xs ${
                    oversell
                      ? 'border-red-200 bg-red-50 text-red-800'
                      : 'border-navy-100 bg-navy-50 text-navy'
                  }`}
                >
                  {sellPosition.held ? (
                    <>
                      Current position:{' '}
                      <span className="font-semibold">
                        {Number(sellPosition.shares).toLocaleString()} share
                        {sellPosition.shares === 1 ? '' : 's'}
                      </span>{' '}
                      of {sellPosition.ticker}
                      {sellPosition.marketValue != null && (
                        <>
                          {' '}
                          (≈ $
                          {Number(sellPosition.marketValue).toLocaleString(
                            undefined,
                            { maximumFractionDigits: 0 }
                          )}
                          )
                        </>
                      )}
                      {lines.sellLine?.shares != null && (
                        <>
                          {' '}
                          · after sell:{' '}
                          <span className="font-semibold">
                            {Math.max(
                              0,
                              sellPosition.shares - lines.sellLine.shares
                            ).toLocaleString()}
                          </span>
                        </>
                      )}
                      {oversell && (
                        <div className="mt-1 font-semibold">
                          ⚠ This would sell{' '}
                          {(
                            lines.sellLine.shares - sellPosition.shares
                          ).toLocaleString()}{' '}
                          more share
                          {lines.sellLine.shares - sellPosition.shares === 1
                            ? ''
                            : 's'}{' '}
                          than we own. Lower the cover amount or pick a
                          different ticker.
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="font-semibold text-red-700">
                      ⚠ The portfolio sheet doesn't show a {sellPosition.ticker}{' '}
                      position. Double-check the ticker.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Note ── */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-navy-400">
            Note (optional)
          </label>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything to flag to the signer — e.g. 'execute Monday open'"
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>

        {/* ── Preview ── */}
        {(lines.buys.length > 0 || lines.sellLine || lines.voteSells.length > 0) && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-emerald-800">
              Preview
            </div>
            <ul className="divide-y divide-emerald-200">
              {lines.buys.map((b) => (
                <li
                  key={b.sessionId}
                  className="flex items-center justify-between gap-3 py-1.5 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-emerald-700" />
                    <span className="font-semibold text-navy">
                      Buy {b.shares ?? '—'} {b.ticker}
                    </span>
                    {b.quote?.status === 'ok' && (
                      <span className="text-xs text-navy-400">
                        @ ${b.quote.price.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <span className="font-semibold tabular-nums text-navy">
                    {b.totalCost != null
                      ? `$${b.totalCost.toFixed(2)}`
                      : '—'}
                  </span>
                </li>
              ))}
              {lines.sellLine && (
                <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-red-700" />
                    <span className="font-semibold text-navy">
                      Sell {lines.sellLine.shares ?? '—'}{' '}
                      {lines.sellLine.ticker}
                    </span>
                    {lines.sellLine.quote?.status === 'ok' && (
                      <span className="text-xs text-navy-400">
                        @ ${lines.sellLine.quote.price.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <span className="font-semibold tabular-nums text-navy">
                    {lines.sellLine.totalCost != null
                      ? `$${lines.sellLine.totalCost.toFixed(2)}`
                      : '—'}
                  </span>
                </li>
              )}
              {lines.voteSells.map((v) => (
                <li
                  key={`vs-${v.votingSessionId}`}
                  className="flex items-center justify-between gap-3 py-1.5 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-red-700" />
                    <span className="font-semibold text-navy">
                      Sell {v.shares ?? '—'} {v.ticker}
                    </span>
                    {v.quote?.status === 'ok' && (
                      <span className="text-xs text-navy-400">
                        @ ${v.quote.price.toFixed(2)}
                      </span>
                    )}
                    <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                      voted
                    </span>
                  </div>
                  <span className="font-semibold tabular-nums text-navy">
                    {v.totalCost != null ? `$${v.totalCost.toFixed(2)}` : '—'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-4 border-t border-emerald-200 pt-2 text-xs">
              <span className="text-navy-400">
                Buys:{' '}
                <span className="font-semibold text-navy">
                  ${buyTotal.toFixed(2)}
                </span>
              </span>
              {sellTotal > 0 && (
                <span className="text-navy-400">
                  Sells:{' '}
                  <span className="font-semibold text-navy">
                    ${sellTotal.toFixed(2)}
                  </span>
                </span>
              )}
              <span className="text-navy-400">
                Net cash:{' '}
                <span
                  className={`font-semibold ${
                    netCash >= 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {netCash >= 0 ? '+' : '−'}$
                  {Math.abs(netCash).toFixed(2)}
                </span>
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!allLinesReady || submitting}
          >
            {submitting ? 'Sending…' : 'Send envelope'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
