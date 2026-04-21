import { useEffect, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ExternalLink,
  TrendingUp,
  TrendingDown,
  FileText,
  BookOpen,
  Plus,
  Trash2,
  Newspaper,
} from 'lucide-react';
import api from '../api/client.js';
import { safeHref } from '../api/safeUrl.js';
import { useAuth } from '../context/AuthContext.jsx';
import Modal from './Modal.jsx';

function fmtMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });
}

// Compact dollar for large numbers — $2.14T / $812.4B / $1.23M.
function fmtBig(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function fmtNum(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

export default function HoldingDetailModal({ holding, onClose }) {
  const ticker = holding?.ticker;
  const { isSuperAdmin } = useAuth();
  const [info, setInfo] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [lots, setLots] = useState([]);
  const [news, setNews] = useState(null);
  const [newsError, setNewsError] = useState('');
  const [thesis, setThesis] = useState(null);
  const [thesisEditing, setThesisEditing] = useState(false);
  const [thesisDraft, setThesisDraft] = useState('');
  const [thesisSaving, setThesisSaving] = useState(false);
  const [thesisError, setThesisError] = useState('');
  const [newsLoading, setNewsLoading] = useState(false);
  const [readerArticle, setReaderArticle] = useState(null); // article passed to ArticleReaderModal
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function loadLots() {
    if (!ticker) return Promise.resolve([]);
    return api
      .get(`/holdings/lots/${encodeURIComponent(ticker)}`)
      .then(({ data }) => data)
      .catch(() => []);
  }

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setInfo(null);
    setCoverage(null);
    setLots([]);
    setNews(null);
    setNewsError('');
    setThesis(null);
    setThesisEditing(false);
    setThesisDraft('');
    setThesisError('');
    api
      .get(`/holdings/${encodeURIComponent(ticker)}/thesis`)
      .then(({ data }) => {
        if (!cancelled) setThesis(data);
      })
      .catch(() => {
        /* thesis is optional — swallow */
      });
    Promise.all([
      api
        .get(`/holdings/info/${encodeURIComponent(ticker)}`)
        .then(({ data }) => data)
        .catch((err) => {
          setError(err.response?.data?.error || 'Failed to load ticker info');
          return null;
        }),
      api
        .get(`/holdings/coverage/${encodeURIComponent(ticker)}`)
        .then(({ data }) => data)
        .catch(() => ({ pitches: [], reports: [] })),
      loadLots(),
    ]).then(([infoData, coverageData, lotsData]) => {
      if (cancelled) return;
      setInfo(infoData);
      setCoverage(coverageData);
      setLots(lotsData);
      setLoading(false);

      // News is fired AFTER the info call resolves so we can pass the
      // company name along — that gives dramatically cleaner results than
      // querying by ticker alone (e.g. "AAPL" → apple orchards).
      setNewsLoading(true);
      const name = infoData?.name || '';
      api
        .get(`/holdings/news/${encodeURIComponent(ticker)}`, {
          params: name ? { name } : {},
        })
        .then(({ data }) => {
          if (!cancelled) setNews(data);
        })
        .catch((err) => {
          if (!cancelled) setNewsError(err.response?.data?.error || 'News unavailable');
        })
        .finally(() => {
          if (!cancelled) setNewsLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  async function refreshLots() {
    const data = await loadLots();
    setLots(data);
  }

  async function handleDeleteLot(id) {
    if (!confirm('Delete this lot?')) return;
    await api.delete(`/holdings/lots/${id}`);
    refreshLots();
  }

  function beginThesisEdit() {
    setThesisDraft(thesis?.thesis || '');
    setThesisEditing(true);
    setThesisError('');
  }

  async function handleSaveThesis() {
    const trimmed = thesisDraft.trim();
    if (!trimmed) {
      setThesisError('Thesis cannot be empty — use Delete to clear it.');
      return;
    }
    setThesisSaving(true);
    setThesisError('');
    try {
      const { data } = await api.put(
        `/holdings/${encodeURIComponent(ticker)}/thesis`,
        { thesis: trimmed }
      );
      setThesis(data);
      setThesisEditing(false);
    } catch (err) {
      setThesisError(err.response?.data?.error || 'Failed to save thesis');
    } finally {
      setThesisSaving(false);
    }
  }

  async function handleDeleteThesis() {
    if (!confirm('Delete the investment thesis for this ticker?')) return;
    setThesisSaving(true);
    try {
      await api.delete(`/holdings/${encodeURIComponent(ticker)}/thesis`);
      setThesis({ ticker, thesis: null });
      setThesisEditing(false);
    } catch (err) {
      setThesisError(err.response?.data?.error || 'Failed to delete thesis');
    } finally {
      setThesisSaving(false);
    }
  }

  // Our position math — pulled from the sheet-derived holding object.
  const ourMarketValue =
    holding?.marketValue ??
    (holding?.shares != null && holding?.price != null
      ? holding.shares * holding.price
      : null);
  const ourReturnUp = (holding?.dollarReturn ?? 0) >= 0;

  const dayChange =
    info?.price != null && info?.previousClose != null
      ? info.price - info.previousClose
      : null;
  const dayChangePct =
    dayChange != null && info?.previousClose
      ? (dayChange / info.previousClose) * 100
      : null;
  const up = dayChange != null && dayChange >= 0;

  return (
    <Modal
      open={!!holding}
      onClose={onClose}
      title={info ? `${info.ticker} — ${info.name}` : ticker || ''}
      size="lg"
    >
      {loading ? (
        <div className="py-12 text-center text-sm text-navy-400">Loading ticker info…</div>
      ) : error ? (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : info ? (
        <div className="space-y-5">
          {/* Price block */}
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-navy-50 pb-4">
            <div>
              <div className="text-3xl font-bold text-navy">
                {fmtMoney(info.price, info.currency)}
              </div>
              {dayChange != null && (
                <div
                  className={`mt-1 flex items-center gap-1 text-sm font-semibold ${
                    up ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {up ? (
                    <TrendingUp className="h-4 w-4" />
                  ) : (
                    <TrendingDown className="h-4 w-4" />
                  )}
                  {up ? '+' : ''}
                  {fmtMoney(dayChange, info.currency)} ({up ? '+' : ''}
                  {dayChangePct?.toFixed(2)}%) today
                </div>
              )}
              {(info.sector || info.industry) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {info.sector && (
                    <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[11px] font-semibold text-navy">
                      {info.sector}
                    </span>
                  )}
                  {info.industry && info.industry !== info.sector && (
                    <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[11px] font-semibold text-gold-800">
                      {info.industry}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="text-right text-xs text-navy-400">
              {info.exchange && <div>{info.exchange}</div>}
              {info.country && <div>{info.country}</div>}
            </div>
          </div>

          {/* Our Position — data from the club's Google Sheet */}
          {holding && !holding.isCash && (
            <div className="rounded-lg border border-gold-300 bg-gold-100/40 p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-bold uppercase tracking-wider text-gold-800">
                  Our Position
                </div>
                {holding.portfolioPct != null && (
                  <div className="text-xs font-semibold text-navy">
                    {holding.portfolioPct.toFixed(2)}% of portfolio
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                <Stat
                  label="Shares"
                  value={holding.shares != null ? holding.shares.toLocaleString('en-US') : '—'}
                />
                <Stat
                  label="Avg Cost"
                  value={fmtMoney(holding.costBasis, info.currency)}
                />
                <Stat
                  label="Market Value"
                  value={fmtMoney(ourMarketValue, info.currency)}
                />
                <Stat
                  label="Return"
                  value={
                    <span
                      className={
                        ourReturnUp ? 'text-emerald-600' : 'text-red-600'
                      }
                    >
                      {fmtMoney(holding.dollarReturn, info.currency)}
                      {holding.percentReturn != null && (
                        <span className="ml-1 text-xs">
                          ({ourReturnUp ? '+' : ''}
                          {holding.percentReturn.toFixed(2)}%)
                        </span>
                      )}
                    </span>
                  }
                />
              </div>
            </div>
          )}

          {/* Purchase Lots — exact per-buy cost basis */}
          {holding && !holding.isCash && (
            <LotSection
              ticker={ticker}
              lots={lots}
              currentPrice={info.price}
              currency={info.currency}
              canEdit={isSuperAdmin}
              onChange={refreshLots}
              onDelete={handleDeleteLot}
            />
          )}

          {/* Our Coverage — pitches and reports authored by the club */}
          {coverage &&
            (coverage.pitches.length > 0 || coverage.reports.length > 0) && (
              <div>
                <div className="mb-2 text-xs font-bold uppercase tracking-wider text-navy-400">
                  Our Coverage
                </div>
                <div className="space-y-2">
                  {coverage.pitches.map((p) => (
                    <div
                      key={`pitch-${p.id}`}
                      className="flex items-start gap-3 rounded-lg border border-navy-100 bg-white p-3"
                    >
                      <div className="mt-0.5 rounded-lg bg-gold-100 p-1.5 text-gold-700">
                        <FileText className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold uppercase tracking-wider text-gold-800">
                            Pitch
                          </span>
                          {p.industry && (
                            <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[10px] font-semibold text-gold-800">
                              {p.industry.name}
                            </span>
                          )}
                          <span className="text-xs text-navy-400">
                            {format(new Date(p.date), 'MMM d, yyyy')}
                          </span>
                        </div>
                        <div className="mt-1 text-sm font-semibold text-navy">
                          By {p.presenters.join(', ')}
                        </div>
                      </div>
                      {p.slideshowUrl && (
                        <a
                          href={safeHref(p.slideshowUrl)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-2 py-1 text-[11px] font-semibold text-navy hover:bg-navy-50"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Slides
                        </a>
                      )}
                    </div>
                  ))}
                  {coverage.reports.map((r) => (
                    <div
                      key={`report-${r.id}`}
                      className="flex items-start gap-3 rounded-lg border border-navy-100 bg-white p-3"
                    >
                      <div className="mt-0.5 rounded-lg bg-navy-50 p-1.5 text-navy">
                        <BookOpen className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold uppercase tracking-wider text-navy">
                            Report
                          </span>
                          <span className="text-xs text-navy-400">
                            {format(new Date(r.date), 'MMM d, yyyy')}
                          </span>
                        </div>
                        <div className="mt-1 text-sm font-semibold text-navy truncate">
                          {r.title}
                        </div>
                        <div className="text-xs text-navy-400">By {r.author}</div>
                        {r.description && (
                          <p className="mt-1 text-xs text-navy line-clamp-2">
                            {r.description}
                          </p>
                        )}
                      </div>
                      <a
                        href={safeHref(r.fileUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-2 py-1 text-[11px] font-semibold text-navy hover:bg-navy-50"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

          {/* Investment thesis — editable by super-admin, visible to all */}
          <ThesisSection
            ticker={ticker}
            thesis={thesis}
            isSuperAdmin={isSuperAdmin}
            editing={thesisEditing}
            draft={thesisDraft}
            onDraftChange={setThesisDraft}
            onBeginEdit={beginThesisEdit}
            onCancelEdit={() => {
              setThesisEditing(false);
              setThesisError('');
            }}
            onSave={handleSaveThesis}
            onDelete={handleDeleteThesis}
            saving={thesisSaving}
            error={thesisError}
          />

          {/* Recent news — from newsapi.org, cached 15 min server-side */}
          <NewsSection
            loading={newsLoading}
            error={newsError}
            articles={news?.articles || []}
            topic={news?.topic || null}
            narrative={news?.narrative || null}
            onOpen={(article) => setReaderArticle(article)}
          />
          <ArticleReaderModal
            article={readerArticle}
            onClose={() => setReaderArticle(null)}
          />

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Stat label="Previous Close" value={fmtMoney(info.previousClose, info.currency)} />
            <Stat
              label="Day Range"
              value={
                info.dayLow != null && info.dayHigh != null
                  ? `${fmtMoney(info.dayLow, info.currency)} – ${fmtMoney(info.dayHigh, info.currency)}`
                  : '—'
              }
            />
            <Stat
              label="52-Week Range"
              value={
                info.fiftyTwoWeekLow != null && info.fiftyTwoWeekHigh != null
                  ? `${fmtMoney(info.fiftyTwoWeekLow, info.currency)} – ${fmtMoney(info.fiftyTwoWeekHigh, info.currency)}`
                  : '—'
              }
            />
            <Stat label="Market Cap" value={fmtBig(info.marketCap)} />
            <Stat label="P/E (Trailing)" value={fmtNum(info.trailingPE)} />
            <Stat label="P/E (Forward)" value={fmtNum(info.forwardPE)} />
            <Stat label="Dividend Yield" value={fmtPct(info.dividendYield)} />
            <Stat label="Beta" value={fmtNum(info.beta)} />
            <Stat label="Volume" value={fmtInt(info.volume)} />
            <Stat label="Avg Volume (3M)" value={fmtInt(info.avgVolume)} />
            {info.employees != null && (
              <Stat label="Employees" value={fmtInt(info.employees)} />
            )}
          </div>

          {/* Business summary */}
          {info.summary && (
            <div>
              <div className="mb-1 text-xs font-bold uppercase tracking-wider text-navy-400">
                About
              </div>
              <p className="text-sm leading-relaxed text-navy">{info.summary}</p>
            </div>
          )}

          {/* Links */}
          <div className="flex flex-wrap gap-2 border-t border-navy-50 pt-4 text-xs">
            <a
              href={`https://finance.yahoo.com/quote/${encodeURIComponent(info.ticker)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-3 w-3" />
              Yahoo Finance
            </a>
            <a
              href={`https://www.google.com/finance/quote/${encodeURIComponent(info.ticker)}:${encodeURIComponent(info.exchange || 'NASDAQ')}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-3 w-3" />
              Google Finance
            </a>
            {info.website && (
              <a
                href={safeHref(info.website)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 font-semibold text-navy hover:bg-navy-50"
              >
                <ExternalLink className="h-3 w-3" />
                Company Site
              </a>
            )}
          </div>
          <div className="text-[10px] text-navy-400">
            Market data from {info._source === 'finnhub' ? 'Finnhub' : 'Yahoo Finance'}.
            Position data from the club's Google Sheet.
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-navy-400">
        {label}
      </div>
      <div className="text-sm font-semibold text-navy tabular-nums">
        {value ?? '—'}
      </div>
    </div>
  );
}

function LotSection({ ticker, lots, currentPrice, currency, canEdit, onChange, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ shares: '', pricePerShare: '', buyDate: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Lot-level totals.
  const totals = lots.reduce(
    (acc, l) => {
      const cost = l.shares * l.pricePerShare;
      const mv = currentPrice != null ? l.shares * currentPrice : null;
      acc.shares += l.shares;
      acc.cost += cost;
      if (mv != null) acc.mv = (acc.mv ?? 0) + mv;
      return acc;
    },
    { shares: 0, cost: 0, mv: null }
  );
  const avgCost = totals.shares > 0 ? totals.cost / totals.shares : null;
  const gainDollar = totals.mv != null ? totals.mv - totals.cost : null;
  const gainPct = gainDollar != null && totals.cost > 0 ? (gainDollar / totals.cost) * 100 : null;

  async function handleAdd(e) {
    e.preventDefault();
    setErr('');
    setSaving(true);
    try {
      await api.post('/holdings/lots', {
        ticker,
        shares: Number(form.shares),
        pricePerShare: Number(form.pricePerShare),
        buyDate: new Date(form.buyDate).toISOString(),
      });
      setForm({ shares: '', pricePerShare: '', buyDate: '' });
      setAdding(false);
      onChange();
    } catch (e2) {
      setErr(e2.response?.data?.error || 'Failed to save lot');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-bold uppercase tracking-wider text-navy-400">
          Purchase Lots
        </div>
        {canEdit && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-2 py-1 text-[11px] font-semibold text-navy hover:bg-navy-50"
          >
            <Plus className="h-3 w-3" />
            Add Lot
          </button>
        )}
      </div>

      {lots.length === 0 && !adding ? (
        <div className="rounded-lg border border-dashed border-navy-100 bg-navy-50/40 p-3 text-center text-xs text-navy-400">
          No lots recorded yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-navy-100">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-navy-50 text-left text-[10px] uppercase tracking-wider text-navy-400">
                <th className="px-3 py-2">Buy Date</th>
                <th className="px-3 py-2 text-right">Shares</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Market Value</th>
                <th className="px-3 py-2 text-right">Return</th>
                {canEdit && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-50">
              {lots.map((l) => {
                const cost = l.shares * l.pricePerShare;
                const mv = currentPrice != null ? l.shares * currentPrice : null;
                const gDollar = mv != null ? mv - cost : null;
                const gPct = gDollar != null && cost > 0 ? (gDollar / cost) * 100 : null;
                const up = (gDollar ?? 0) >= 0;
                return (
                  <tr key={l.id}>
                    <td className="px-3 py-2 text-navy">
                      {format(new Date(l.buyDate), 'MMM d, yyyy')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-navy">
                      {l.shares.toLocaleString('en-US')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-navy">
                      {fmtMoney(l.pricePerShare, currency)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-navy">
                      {fmtMoney(cost, currency)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-navy">
                      {mv != null ? fmtMoney(mv, currency) : '—'}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums font-semibold ${
                        gDollar == null ? 'text-navy-400' : up ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {gDollar != null ? (
                        <>
                          {fmtMoney(gDollar, currency)}
                          {gPct != null && (
                            <span className="ml-1 text-[10px]">
                              ({up ? '+' : ''}
                              {gPct.toFixed(2)}%)
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => onDelete(l.id)}
                          className="rounded p-1 text-red-600 hover:bg-red-50"
                          aria-label="Delete lot"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {lots.length > 0 && (
                <tr className="bg-navy-50/50 font-semibold">
                  <td className="px-3 py-2 text-navy">Total</td>
                  <td className="px-3 py-2 text-right tabular-nums text-navy">
                    {totals.shares.toLocaleString('en-US')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-navy-400">
                    avg {avgCost != null ? fmtMoney(avgCost, currency) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-navy">
                    {fmtMoney(totals.cost, currency)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-navy">
                    {totals.mv != null ? fmtMoney(totals.mv, currency) : '—'}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      gainDollar == null
                        ? 'text-navy-400'
                        : gainDollar >= 0
                        ? 'text-emerald-600'
                        : 'text-red-600'
                    }`}
                  >
                    {gainDollar != null ? (
                      <>
                        {fmtMoney(gainDollar, currency)}
                        {gainPct != null && (
                          <span className="ml-1 text-[10px]">
                            ({gainDollar >= 0 ? '+' : ''}
                            {gainPct.toFixed(2)}%)
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  {canEdit && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && adding && (
        <form
          onSubmit={handleAdd}
          className="mt-2 space-y-2 rounded-lg border border-navy-100 bg-navy-50/40 p-3"
        >
          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-navy-400">
                Shares
              </span>
              <input
                type="number"
                step="any"
                required
                value={form.shares}
                onChange={(e) => setForm({ ...form, shares: e.target.value })}
                className="mt-1 w-full rounded-md border border-navy-100 px-2 py-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-navy-400">
                Price / share
              </span>
              <input
                type="number"
                step="any"
                required
                value={form.pricePerShare}
                onChange={(e) => setForm({ ...form, pricePerShare: e.target.value })}
                className="mt-1 w-full rounded-md border border-navy-100 px-2 py-1 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-navy-400">
                Buy date
              </span>
              <input
                type="date"
                required
                value={form.buyDate}
                onChange={(e) => setForm({ ...form, buyDate: e.target.value })}
                className="mt-1 w-full rounded-md border border-navy-100 px-2 py-1 text-sm"
              />
            </label>
          </div>
          {err && <div className="text-xs text-red-600">{err}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setErr('');
              }}
              className="rounded border border-navy-100 px-3 py-1 text-xs font-semibold text-navy"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-navy px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Add Lot'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// Investment thesis display + super-admin edit. Collapsed by default when
// no thesis exists and the viewer can't write one.
function ThesisSection({
  ticker,
  thesis,
  isSuperAdmin,
  editing,
  draft,
  onDraftChange,
  onBeginEdit,
  onCancelEdit,
  onSave,
  onDelete,
  saving,
  error,
}) {
  const hasThesis = !!thesis?.thesis;
  if (!hasThesis && !isSuperAdmin) return null;

  const updatedStamp =
    thesis?.updatedAt && hasThesis
      ? formatDistanceToNow(new Date(thesis.updatedAt), { addSuffix: true })
      : null;

  return (
    <div className="mt-6 rounded-lg border border-navy-100 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-navy-400">
          <BookOpen className="h-3.5 w-3.5" />
          Investment Thesis · {ticker}
        </div>
        {!editing && isSuperAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={onBeginEdit}
              className="text-xs font-semibold text-gold-700 underline"
            >
              {hasThesis ? 'Edit' : 'Add thesis'}
            </button>
            {hasThesis && (
              <button
                onClick={onDelete}
                disabled={saving}
                className="text-xs font-semibold text-red-600 underline disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            rows={8}
            maxLength={5000}
            placeholder="Why we own this. Key drivers, valuation anchor, what would change the thesis."
            className="w-full rounded-lg border border-navy-100 px-3 py-2 text-sm text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          <div className="flex items-center justify-between text-[11px] text-navy-400">
            <span>{draft.length} / 5000</span>
          </div>
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={saving}
              className="rounded border border-navy-100 px-3 py-1 text-xs font-semibold text-navy disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !draft.trim()}
              className="rounded bg-navy px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : hasThesis ? (
        <>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-navy">
            {thesis.thesis}
          </p>
          {(updatedStamp || thesis.updatedByName) && (
            <div className="mt-3 text-[11px] text-navy-400">
              Updated {updatedStamp}
              {thesis.updatedByName ? ` by ${thesis.updatedByName}` : ''}
            </div>
          )}
        </>
      ) : (
        <p className="mt-3 text-xs italic text-navy-400">
          No thesis yet. Click "Add thesis" to write one.
        </p>
      )}
    </div>
  );
}

// Compact headline feed for the modal. Pulls from /api/holdings/news/:ticker
// which hits newsapi.org server-side (cached 15 min). Returns null when there
// are no articles and no error — we don't want a dead "Recent News" header
// for obscure tickers newsapi has nothing on.
//
// Each card is a button that opens ArticleReaderModal in-app instead of
// leaving for the publisher's site. The reader falls back to a clean link to
// the original if extraction fails.
function NewsSection({ loading, error, articles, topic, narrative, onOpen }) {
  if (!loading && !error && (!articles || articles.length === 0)) return null;
  // For broad-market / sector ETFs the server swaps in curated category
  // headlines; `topic` tells the UI what to advertise instead of the default.
  const heading = topic || 'Recent News';
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-navy-400">
          <Newspaper className="h-3.5 w-3.5" />
          {heading}
        </div>
        {articles.length > 0 && (
          <span className="text-[10px] text-navy-400">
            via newsapi.org · {articles.length} stories
          </span>
        )}
      </div>

      {/* Ticker-level narrative synthesized from the headlines. Shown above
          the article list so members see the overall vibe before diving in. */}
      {narrative && (
        <div className="mb-3 rounded-lg border border-gold-200 bg-gold-100/30 px-3 py-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gold-800">
            AI News Summary
          </div>
          <p className="text-sm leading-relaxed text-navy">{narrative}</p>
        </div>
      )}
      {loading ? (
        <div className="rounded-lg border border-navy-100 bg-white p-3 text-xs text-navy-400">
          Loading headlines…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-navy-100 bg-navy-50/40 p-3 text-xs text-navy-400">
          {error}
        </div>
      ) : (
        <ul className="space-y-2">
          {articles.map((a, i) => (
            <li key={i} className="rounded-lg border border-navy-100 bg-white">
              <button
                type="button"
                onClick={() => onOpen?.(a)}
                className="flex w-full items-start gap-3 p-3 text-left transition hover:bg-navy-50/40"
              >
                {/* Left rail: numeric score tile. Shown on every screen size
                    so mobile users still get the color-coded priority at a
                    glance. Non-ranked articles show a neutral newsapi icon. */}
                {typeof a.score === 'number' ? (
                  <ScoreTile score={a.score} />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-navy-50 text-navy-400 sm:h-14 sm:w-14">
                    <Newspaper className="h-5 w-5" />
                  </div>
                )}
                {a.imageUrl && typeof a.score !== 'number' ? (
                  <img
                    src={a.imageUrl}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                    className="hidden h-14 w-14 shrink-0 rounded-md object-cover sm:block"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <div className="text-sm font-semibold leading-snug text-navy line-clamp-2 flex-1">
                      {a.title}
                    </div>
                  </div>
                  {a.reason ? (
                    <div className="mt-1 text-xs italic text-navy-500 line-clamp-2">
                      Why it matters: {a.reason}
                    </div>
                  ) : a.description ? (
                    <div className="mt-1 line-clamp-2 text-xs text-navy-400">
                      {a.description}
                    </div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-navy-400">
                    {a.source && (
                      <span className="font-semibold uppercase tracking-wider text-navy">
                        {a.source}
                      </span>
                    )}
                    {a.publishedAt && (
                      <span>
                        {formatDistanceToNow(new Date(a.publishedAt), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Colored tile showing the article's 0-10 materiality score. Responsive
// size: 44×44 on phones, 56×56 on desktop. Color shifts from grey (low)
// to red (high) through gold so members can triage a batch at a glance.
function ScoreTile({ score }) {
  // Clamp into [0, 10] so weird inputs don't break color math.
  const s = Math.max(0, Math.min(10, score));
  const tone =
    s >= 8.5
      ? 'bg-red-600 text-white'
      : s >= 7
      ? 'bg-red-500 text-white'
      : s >= 5.5
      ? 'bg-gold text-navy'
      : s >= 4
      ? 'bg-gold-200 text-navy'
      : 'bg-navy-50 text-navy-400';
  return (
    <div
      className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-md sm:h-14 sm:w-14 ${tone}`}
      title={`Materiality ${s.toFixed(1)} / 10`}
    >
      <span className="text-sm font-bold leading-none tabular-nums sm:text-lg">
        {s.toFixed(1)}
      </span>
      <span className="mt-0.5 text-[7px] uppercase tracking-widest opacity-70 sm:text-[8px]">
        / 10
      </span>
    </div>
  );
}

// In-app reader for a news article. On open, fetches the extracted content
// from /api/holdings/news/article?url= and renders sanitized HTML. A "Open
// original" link is always offered as a fallback if extraction fails or the
// user wants the publisher's full page.
function ArticleReaderModal({ article, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!article?.url) return;
    let cancelled = false;
    setData(null);
    setError('');
    setLoading(true);
    api
      .get('/holdings/news/article', { params: { url: article.url } })
      .then(({ data: d }) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Failed to load article');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [article?.url]);

  if (!article) return null;

  return (
    <Modal
      open={!!article}
      onClose={onClose}
      title={data?.siteName || article.source || 'Article'}
      size="xl"
    >
      <div className="space-y-4">
        {/* Header */}
        <div>
          <h1 className="font-serif text-2xl font-semibold leading-snug text-navy md:text-3xl">
            {data?.title || article.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-navy-400">
            {(data?.byline || article.author) && (
              <span>By {data?.byline || article.author}</span>
            )}
            {article.publishedAt && (
              <span>
                · {format(new Date(article.publishedAt), 'MMM d, yyyy')}
              </span>
            )}
            {article.source && <span>· {article.source}</span>}
          </div>
        </div>

        {/* Hero image if present */}
        {article.imageUrl && (
          <img
            src={article.imageUrl}
            alt=""
            className="w-full rounded-lg object-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        )}

        {/* AI summary of the article body, generated server-side the first
            time this URL is opened and persisted for subsequent readers. */}
        {data?.summary && (
          <aside className="rounded-lg border border-gold-200 bg-gold-100/30 p-4">
            <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-gold-800">
              <Newspaper className="h-3 w-3" />
              AI Summary
            </div>
            <p className="text-sm leading-relaxed text-navy">{data.summary}</p>
          </aside>
        )}

        {/* Body */}
        {loading ? (
          <div className="py-8 text-center text-sm text-navy-400">
            Loading article…
          </div>
        ) : error ? (
          <div className="space-y-2 rounded-lg border border-gold-300 bg-gold-100/40 p-4 text-sm">
            <div className="font-semibold text-navy">Couldn't read this one inline.</div>
            <div className="text-xs text-navy-400">
              {error}. Some publisher pages block extraction (paywalls,
              JavaScript-only content). You can still open the original:
            </div>
            <a
              href={safeHref(article.url)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-navy bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:bg-navy hover:text-white"
            >
              <ExternalLink className="h-3 w-3" />
              Open original
            </a>
          </div>
        ) : data?.contentHtml ? (
          <article
            className="article-reader text-navy"
            // Server sanitized via sanitize-html with a tight allowlist.
            dangerouslySetInnerHTML={{ __html: data.contentHtml }}
          />
        ) : null}

        {/* Footer link to original */}
        {!error && data && (
          <div className="border-t border-navy-50 pt-3">
            <a
              href={safeHref(article.url)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-navy-400 hover:text-navy"
            >
              <ExternalLink className="h-3 w-3" />
              Continue on {article.source || 'publisher site'}
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}
