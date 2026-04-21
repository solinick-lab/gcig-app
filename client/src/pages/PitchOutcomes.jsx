import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Trophy, TrendingUp, TrendingDown, Target, FileText, BookOpen } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export default function PitchOutcomes() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    api
      .get('/pitches/outcomes/all')
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.response?.data?.error || 'Failed to load outcomes'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <>
        <PageHeader title="Pitch Outcomes" subtitle="Loading…" />
      </>
    );
  }

  if (err) {
    return (
      <>
        <PageHeader title="Pitch Outcomes" />
        <Card>
          <div className="py-8 text-center text-red-600">{err}</div>
        </Card>
      </>
    );
  }

  const { results = [], leaderboard = [], clubAvg = 0, clubHitRate = 0, trackedCount = 0 } = data || {};
  // "Tracked" = either a current position OR a recorded vote outcome. Those
  // belong in the main table so NoBuy decisions show up alongside returns.
  const tracked = results.filter((r) => r.hasOutcome);
  const notTracked = results.filter((r) => !r.hasOutcome);

  return (
    <>
      <PageHeader
        kicker="Performance"
        title="Coverage Outcomes"
        subtitle="How pitches and research reports that became positions have performed."
      />

      {/* Editorial masthead — three hero stats in navy gradient. */}
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
        <div className="relative grid gap-6 p-6 md:grid-cols-3 md:gap-10 md:p-8">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
              <span className="h-px w-5 bg-gold" />
              Club Avg Return
            </div>
            <div
              className={`mt-3 font-serif text-5xl font-semibold leading-none tabular-nums md:text-6xl ${
                clubAvg >= 0 ? 'text-emerald-300' : 'text-red-300'
              }`}
            >
              {fmtPct(clubAvg)}
            </div>
            <div className="mt-3 text-xs text-navy-100">
              Weighted across tracked pitches & reports
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
              <span className="h-px w-5 bg-gold" />
              Hit Rate
            </div>
            <div className="mt-3 font-serif text-5xl font-semibold leading-none tabular-nums md:text-6xl">
              {(clubHitRate * 100).toFixed(0)}%
            </div>
            <div className="mt-3 text-xs text-navy-100">
              Pitches voted Buy (vs. voted No)
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
              <span className="h-px w-5 bg-gold" />
              Tracked
            </div>
            <div className="mt-3 font-serif text-5xl font-semibold leading-none tabular-nums md:text-6xl">
              {trackedCount}
            </div>
            <div className="mt-3 text-xs text-navy-100">
              Pitches + reports tied to current holdings
            </div>
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <div className="mt-6">
        <Card title="Leaderboard">
          {leaderboard.length === 0 ? (
            <div className="py-8 text-center text-navy-400">
              No presenter has a tracked pitch yet.
            </div>
          ) : (
            <>
            {/* Mobile leaderboard */}
            <ol className="space-y-2 md:hidden">
              {leaderboard.map((row, i) => (
                <li
                  key={`${row.id ?? 'anon'}-${row.name}`}
                  className="flex items-center gap-3 rounded-lg border border-navy-100 px-3 py-2"
                >
                  <div className="w-6 shrink-0 text-lg font-bold text-gold-700">{i + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-navy">{row.name}</div>
                    <div className="text-[11px] text-navy-400">
                      {row.pitches} pitches · {(row.hitRate * 100).toFixed(0)}% hit rate
                    </div>
                  </div>
                  <div
                    className={`shrink-0 text-right font-bold tabular-nums ${
                      row.avgReturn >= 0 ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {fmtPct(row.avgReturn)}
                  </div>
                </li>
              ))}
            </ol>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="py-2 pr-4">#</th>
                    <th className="py-2 pr-4">Presenter</th>
                    <th className="py-2 pr-4 text-right">Pitches</th>
                    <th className="py-2 pr-4 text-right">Avg Return</th>
                    <th className="py-2 pr-4 text-right">Hit Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {leaderboard.map((row, i) => (
                    <tr key={`${row.id ?? 'anon'}-${row.name}`}>
                      <td className="py-3 pr-4 font-bold text-gold-700">
                        {i + 1}
                      </td>
                      <td className="py-3 pr-4 font-semibold text-navy">
                        {row.name}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        {row.pitches}
                      </td>
                      <td
                        className={`py-3 pr-4 text-right tabular-nums font-bold ${
                          row.avgReturn >= 0 ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      >
                        {fmtPct(row.avgReturn)}
                      </td>
                      <td className="py-3 pr-4 text-right tabular-nums">
                        {(row.hitRate * 100).toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>
      </div>

      {/* Every pitch / report with a recorded outcome: bought (returns shown)
          or voted no (no return but still tracked). */}
      <div className="mt-6">
        <Card title="Tracked outcomes">
          {tracked.length === 0 ? (
            <div className="py-8 text-center text-navy-400">
              No pitches or reports have recorded outcomes yet.
            </div>
          ) : (
            <>
            {/* Mobile: card list */}
            <ul className="space-y-2 md:hidden">
              {tracked.map((r) => {
                const up = (r.percent ?? 0) >= 0;
                const isNoBuy = r.votedOutcome === 'NoBuy';
                return (
                  <li key={r.id} className="rounded-lg border border-navy-100 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-navy">{r.ticker}</span>
                          <span
                            className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                              r.type === 'report'
                                ? 'bg-navy-50 text-navy'
                                : 'bg-gold-100 text-gold-800'
                            }`}
                          >
                            {r.type}
                          </span>
                        </div>
                        {r.title && (
                          <div className="truncate text-xs text-navy-400">{r.title}</div>
                        )}
                        <div className="mt-0.5 text-[11px] text-navy-400">
                          {format(new Date(r.date), 'MMM d, yyyy')} · {r.presenters.map((p) => p.name).join(', ')}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        {isNoBuy ? (
                          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                            Voted No
                          </span>
                        ) : r.percent != null ? (
                          <div
                            className={`font-bold tabular-nums ${
                              up ? 'text-emerald-600' : 'text-red-600'
                            }`}
                          >
                            {fmtPct(r.percent)}
                          </div>
                        ) : (
                          <span className="text-navy-400">—</span>
                        )}
                      </div>
                    </div>
                    {!isNoBuy && r.buyPrice != null && (
                      <div className="mt-1 flex justify-between border-t border-navy-50 pt-1 text-[11px] text-navy-400">
                        <span>Buy {fmtMoney(r.buyPrice)}</span>
                        <span>Now {fmtMoney(r.currentPrice)}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Ticker</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">By</th>
                    <th className="py-2 pr-4 text-right">Buy Price</th>
                    <th className="py-2 pr-4 text-right">Now</th>
                    <th className="py-2 pr-4 text-right">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {tracked.map((r) => {
                    const up = (r.percent ?? 0) >= 0;
                    const isNoBuy = r.votedOutcome === 'NoBuy';
                    return (
                      <tr key={r.id}>
                        <td className="py-3 pr-4">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                              r.type === 'report'
                                ? 'bg-navy-50 text-navy'
                                : 'bg-gold-100 text-gold-800'
                            }`}
                          >
                            {r.type === 'report' ? (
                              <BookOpen className="h-3 w-3" />
                            ) : (
                              <FileText className="h-3 w-3" />
                            )}
                            {r.type}
                          </span>
                        </td>
                        <td className="py-3 pr-4 font-bold text-navy">
                          {r.ticker}
                          {r.title && (
                            <div className="truncate max-w-[220px] text-xs font-normal text-navy-400">
                              {r.title}
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-xs text-navy-400">
                          {format(new Date(r.date), 'MMM d, yyyy')}
                        </td>
                        <td className="py-3 pr-4 text-sm text-navy">
                          {r.presenters.map((p) => p.name).join(', ')}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {isNoBuy ? '—' : fmtMoney(r.buyPrice)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {isNoBuy ? '—' : fmtMoney(r.currentPrice)}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right tabular-nums font-bold ${
                            isNoBuy
                              ? ''
                              : r.percent == null
                              ? 'text-navy-400'
                              : up
                              ? 'text-emerald-600'
                              : 'text-red-600'
                          }`}
                        >
                          {isNoBuy ? (
                            <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                              Voted No
                            </span>
                          ) : r.percent != null ? (
                            <span className="inline-flex items-center gap-1 justify-end">
                              {up ? (
                                <TrendingUp className="h-3.5 w-3.5" />
                              ) : (
                                <TrendingDown className="h-3.5 w-3.5" />
                              )}
                              {fmtPct(r.percent)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </Card>
      </div>

      {/* Pitches / reports not currently held — still useful context */}
      {notTracked.length > 0 && (
        <div className="mt-6">
          <Card title="Coverage not tied to current holdings">
            <div className="mb-3 text-xs text-navy-400">
              No decision recorded yet — either the pitch hasn't been voted
              on, the ticker on the pitch doesn't match a current holding,
              or we sold the position.
            </div>
            {/* Mobile */}
            <ul className="space-y-2 md:hidden">
              {notTracked.map((r) => (
                <li key={r.id} className="rounded-lg border border-navy-100 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-navy">{r.ticker}</span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                            r.type === 'report' ? 'bg-navy-50 text-navy' : 'bg-gold-100 text-gold-800'
                          }`}
                        >
                          {r.type}
                        </span>
                      </div>
                      {r.title && <div className="truncate text-xs text-navy-400">{r.title}</div>}
                      <div className="mt-0.5 text-[11px] text-navy-400">
                        {format(new Date(r.date), 'MMM d, yyyy')} · {r.presenters.map((p) => p.name).join(', ')}
                      </div>
                    </div>
                    <div className="shrink-0">
                      {r.votedOutcome === 'NoBuy' ? (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                          Voted No
                        </span>
                      ) : r.votedOutcome === 'Buy' ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                          Voted Buy
                        </span>
                      ) : (
                        <span className="text-[10px] text-navy-400">—</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Ticker</th>
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">By</th>
                    <th className="py-2 pr-4">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {notTracked.map((r) => (
                    <tr key={r.id}>
                      <td className="py-3 pr-4">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            r.type === 'report'
                              ? 'bg-navy-50 text-navy'
                              : 'bg-gold-100 text-gold-800'
                          }`}
                        >
                          {r.type}
                        </span>
                      </td>
                      <td className="py-3 pr-4 font-bold text-navy">
                        {r.ticker}
                        {r.title && (
                          <div className="truncate max-w-[220px] text-xs font-normal text-navy-400">
                            {r.title}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-xs text-navy-400">
                        {format(new Date(r.date), 'MMM d, yyyy')}
                      </td>
                      <td className="py-3 pr-4 text-sm text-navy">
                        {r.presenters.map((p) => p.name).join(', ')}
                      </td>
                      <td className="py-3 pr-4">
                        {r.votedOutcome === 'NoBuy' ? (
                          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                            Voted No
                          </span>
                        ) : r.votedOutcome === 'Buy' ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                            Voted Buy
                          </span>
                        ) : (
                          <span className="text-[10px] text-navy-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
