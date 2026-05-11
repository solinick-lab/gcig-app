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

export default function TradeRequests() {
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

  if (!isExecutive) {
    return (
      <>
        <PageHeader
          kicker="Trading"
          title="Trade Requests"
          subtitle="Bundled DocuSign envelopes for executed votes."
        />
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
      <PageHeader
        kicker="Trading"
        title="Trade Requests"
        subtitle="Bundle multiple closed Buy votes (and an optional Sell-to-cover) into a single DocuSign envelope."
        actions={
          <AdminOnly>
            <Button onClick={() => setComposerOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              New Trade Request
            </Button>
          </AdminOnly>
        }
      />

      <div className="mt-6 space-y-3">
        {requests.length === 0 ? (
          <Card>
            <div className="py-8 text-center text-navy-400">
              No trade requests yet. Click "New Trade Request" to bundle some
              closed Buy votes into an envelope.
            </div>
          </Card>
        ) : (
          requests.map((tr) => (
            <RequestRow
              key={tr.id}
              tr={tr}
              refreshing={refreshing === tr.id}
              onRefresh={() => refreshOne(tr.id)}
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

function RequestRow({ tr, refreshing, onRefresh }) {
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
              Request #{tr.id}
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
        {tr.docusignEnvelopeId && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="flex shrink-0 items-center gap-1 text-xs font-semibold text-navy-400 underline hover:text-navy"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        )}
      </div>
    </Card>
  );
}

// ── Composer ──────────────────────────────────────────────────────────

const DEFAULT_SELL_TICKER = 'SPY';

function Composer({ open, onClose, onCreated }) {
  const [eligible, setEligible] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
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
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setSelectedIds(new Set());
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
  }, [open]);

  // Fetch quotes for every selected session's ticker + the sell ticker.
  useEffect(() => {
    const tickers = new Set();
    for (const id of selectedIds) {
      const s = eligible.find((e) => e.id === id);
      if (s) tickers.add(s.ticker);
    }
    if (sellEnabled && sellTicker) tickers.add(sellTicker.toUpperCase());

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
  }, [selectedIds, eligible, sellEnabled, sellTicker]);

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
        // If the user typed a cover amount, use it; otherwise default to the
        // current buy total so the preview shows a sensible Sell.
        const amt = Number(sellCoverAmount) || buyTotal;
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

    return { buys, sellLine };
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
  ]);

  const buyTotal = lines.buys.reduce((s, b) => s + (b.totalCost || 0), 0);
  const sellTotal = lines.sellLine?.totalCost || 0;
  const netCash = sellTotal - buyTotal;
  const allLinesReady =
    lines.buys.length > 0 &&
    lines.buys.every((b) => b.shares != null && b.totalCost != null) &&
    (!sellEnabled ||
      (lines.sellLine?.shares != null && lines.sellLine?.totalCost != null));

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
          sellItem.coverAmount = Number(sellCoverAmount) || buyTotal;
        }
        items.push(sellItem);
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
    <Modal open={open} onClose={onClose} title="New Trade Request" size="xl">
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
                          ? Math.ceil(buyTotal).toLocaleString()
                          : '—'
                      }
                      className="mt-1 w-32 rounded border border-navy-100 px-2 py-1 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                    />
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
        {(lines.buys.length > 0 || lines.sellLine) && (
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
