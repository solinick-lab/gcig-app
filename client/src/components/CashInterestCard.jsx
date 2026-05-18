import { useState } from 'react';
import { format } from 'date-fns';
import api from '../api/client.js';

// Standalone tile for the club's two cash sleeves. Shows the REAL
// current balances — BDA was drawn down to $0 buying stocks, FGTXX is
// whatever cash is left (the same dollars the brokerage sheet's CASH
// line reports) — plus a rough, clearly-labelled estimate of the
// interest the sleeves threw off while they were funded.
//
// That interest is context only. It is NOT added to the portfolio
// total or return anywhere: every dollar of it either reinvested into
// the FGTXX balance or was spent on stock the sheet already prices, so
// the sheet's total already carries it. Lives under the Holdings table
// on the Portfolio page.
function fmtMoney(n, opts = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

export default function CashInterestCard({
  data,
  canRefresh = false,
  canBackfill = false,
  onReload,
}) {
  const {
    estimatedInterestEarned,
    bdaEstimatedInterest,
    fgtxxEstimatedInterest,
    fgtxxBalance,
    bdaBalance,
    fgtxxLatestYield,
    fgtxxLatestYieldDate,
    bdaApy,
  } = data || {};

  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  async function runAction(kind, path, successText) {
    setBusy(kind);
    setMsg(null);
    try {
      const { data: result } = await api.post(path);
      const detail =
        kind === 'backfill'
          ? ` — ${result?.yieldsStored ?? 0} yields stored from ${result?.matched ?? 0} filing(s)`
          : result?.latest?.sevenDayCurrentYield != null
          ? ` — latest 7-day net ${Number(result.latest.sevenDayCurrentYield).toFixed(2)}%`
          : '';
      setMsg({ kind: 'success', text: successText + detail });
      if (typeof onReload === 'function') onReload();
    } catch (err) {
      setMsg({
        kind: 'error',
        text: err?.response?.data?.error || err.message || 'Action failed',
      });
    } finally {
      setBusy(null);
    }
  }

  const yieldDateLabel = fgtxxLatestYieldDate
    ? format(new Date(fgtxxLatestYieldDate), 'MMM d')
    : null;

  return (
    <div className="rounded-2xl border border-navy-100 bg-white p-5 shadow-card md:p-7">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
            Cash sleeves
          </div>
          <div className="mt-1 font-serif text-2xl font-semibold text-navy">
            Interest earned · estimated
          </div>
          <div className="mt-1 text-[11px] text-navy-300">
            $40k seeded FGTXX, $60k seeded BDA in Oct 2025. BDA was drawn
            down to zero buying stocks, then FGTXX. Already inside the
            portfolio total — shown here for context.
          </div>
        </div>
        <div className="text-right">
          <div className="font-serif text-3xl font-semibold text-navy tabular-nums">
            ≈{fmtMoney(estimatedInterestEarned, { cents: true })}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-wider text-navy-300">
            estimate · not additive
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SleeveTile
          accent="gold"
          label="FGTXX · GS Government MMF"
          interest={fgtxxEstimatedInterest}
          balance={fgtxxBalance}
          rate={
            fgtxxLatestYield != null
              ? `${fgtxxLatestYield.toFixed(2)}% · 7-day net`
              : '—'
          }
          asOf={
            yieldDateLabel
              ? `current balance · yield as of ${yieldDateLabel}`
              : 'current balance (= sheet cash)'
          }
        />
        <SleeveTile
          accent="navy"
          label="BDA · GS Bank USA Deposit"
          interest={bdaEstimatedInterest}
          balance={bdaBalance}
          rate={bdaApy != null ? `${(bdaApy * 100).toFixed(2)}% · APY` : '—'}
          asOf="drawn down to $0 — funded the positions above"
        />
      </div>

      {(canRefresh || canBackfill) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-navy-50 pt-3">
          <div className="flex flex-wrap gap-2">
            {canRefresh && (
              <button
                type="button"
                onClick={() =>
                  runAction(
                    'refresh',
                    '/holdings/cash-yield/refresh',
                    "Pulled today's FGTXX yield"
                  )
                }
                disabled={busy != null}
                className="rounded-md border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy transition hover:border-navy hover:bg-navy hover:text-white disabled:opacity-50"
              >
                {busy === 'refresh' ? 'Refreshing…' : "Refresh today's yield"}
              </button>
            )}
            {canBackfill && (
              <button
                type="button"
                onClick={() =>
                  runAction(
                    'backfill',
                    '/holdings/cash-yield/backfill',
                    'Backfill complete'
                  )
                }
                disabled={busy != null}
                className="rounded-md border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy transition hover:border-navy hover:bg-navy hover:text-white disabled:opacity-50"
              >
                {busy === 'backfill' ? 'Backfilling…' : 'Backfill from SEC'}
              </button>
            )}
          </div>
          {msg && (
            <div
              className={`text-[11px] ${
                msg.kind === 'success' ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {msg.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SleeveTile({ accent, label, interest, balance, rate, asOf }) {
  const dot = accent === 'gold' ? 'bg-gold' : 'bg-navy';
  return (
    <div className="rounded-xl border border-navy-100 bg-[#FAFBFE] px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-navy-400">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <div className="font-serif text-xl font-semibold text-navy tabular-nums">
          {fmtMoney(balance, { cents: true })}
        </div>
        <div className="text-right text-[11px] tabular-nums text-navy-400">
          <div>est. interest ≈{fmtMoney(interest, { cents: true })}</div>
          <div>{rate}</div>
        </div>
      </div>
      <div className="mt-1 text-[10px] text-navy-300">{asOf}</div>
    </div>
  );
}
