import { useEffect, useMemo, useState } from 'react';
import { format, subDays, subMonths, subYears, startOfYear } from 'date-fns';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, TrendingDown, RefreshCw, ExternalLink } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import HoldingDetailModal from '../components/HoldingDetailModal.jsx';

const RANGES = [
  { key: '1W', label: '1W', days: 7 },
  { key: '1M', label: '1M', days: 30 },
  { key: '3M', label: '3M', days: 90 },
  { key: '6M', label: '6M', days: 180 },
  { key: 'YTD', label: 'YTD' },
  { key: '1Y', label: '1Y', days: 365 },
  { key: 'ALL', label: 'All' },
];

// Starting capital the club was founded with. The sheet's per-position cost
// basis sometimes drifts by a few dollars from rounding — anchoring Total
// Gain/Loss to the actual dollar amount we began with avoids that error.
const INITIAL_CAPITAL = 100000;

// Capital infusions/withdrawals — subtracted from performance calcs so the
// return % reflects actual market movement, not money added.
// Positive = money in, negative = money out.
const CASH_FLOWS = [
  { date: new Date('2026-01-29T12:00:00Z'), amount: 25000, label: 'Capital infusion' },
];

// Everything we've put in: the starting $100k + every cash flow since.
// Used as the denominator for the Total Gain/Loss card.
const TOTAL_INVESTED =
  INITIAL_CAPITAL + CASH_FLOWS.reduce((sum, cf) => sum + cf.amount, 0);

// Annualized risk-free rate used in the Sharpe calculation.
// Currently set to the 3-month US Treasury yield (~4.25% as of Apr 2026).
// Update this constant if T-bill rates shift meaningfully.
const RISK_FREE_RATE = 0.0425;

function fmtMoney(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export default function Portfolio() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [quotes, hist] = await Promise.all([
        api.get('/holdings/quotes'),
        api.get('/holdings/history'),
      ]);
      setData(quotes.data);
      setHistory(hist.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load portfolio');
      setData({ holdings: [], totals: {} });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const totals = data?.totals || {};
  const holdings = data?.holdings || [];

  // Recompute Total Gain/Loss against the actual capital invested (starting
  // $100k + every infusion) so per-position cost-basis rounding in the sheet
  // doesn't throw off the top-line number.
  const lifetimeGainLoss =
    totals.totalValue != null ? totals.totalValue - TOTAL_INVESTED : null;
  const lifetimeGainLossPct =
    lifetimeGainLoss != null ? (lifetimeGainLoss / TOTAL_INVESTED) * 100 : null;
  const isUp = (lifetimeGainLoss ?? 0) >= 0;

  const [range, setRange] = useState('6M');
  const [selectedHolding, setSelectedHolding] = useState(null);

  // Normalize history (with real Date objects) once.
  // equity = totalValue - cashValue (falls back to total if cash is unknown).
  const fullHistory = useMemo(
    () =>
      history.map((s) => {
        const total = Number(s.totalValue.toFixed(2));
        const cash = s.cashValue != null ? Number(s.cashValue.toFixed(2)) : 0;
        return {
          date: new Date(s.date),
          value: total,
          cash,
          equity: Math.max(total - cash, 0),
        };
      }),
    [history]
  );

  // Filter by selected range.
  const chartData = useMemo(() => {
    if (fullHistory.length === 0) return [];
    const now = new Date();
    let cutoff;
    if (range === 'ALL') return fullHistory;
    if (range === 'YTD') cutoff = startOfYear(now);
    else {
      const r = RANGES.find((x) => x.key === range);
      cutoff = r?.days ? subDays(now, r.days) : null;
    }
    return cutoff ? fullHistory.filter((d) => d.date >= cutoff) : fullHistory;
  }, [fullHistory, range]);

  // Chart series.
  //
  // For the ALL range we anchor to TOTAL_INVESTED (starting capital + all
  // infusions to date) so the right edge of the chart matches the Total
  // Gain/Loss card exactly. At each point:
  //     running_invested(t) = INITIAL_CAPITAL + sum of infusions ≤ t
  //     pct(t) = (value(t) - running_invested(t)) / running_invested(t)
  //
  // For every other range (1W, 1M, YTD, …) we keep the "change since start of
  // range" model, subtracting infusions that landed inside the range so they
  // don't fake-inflate the return.
  const percentSeries = useMemo(() => {
    if (chartData.length === 0) return [];

    if (range === 'ALL') {
      return chartData.map((d) => {
        const runningInvested =
          INITIAL_CAPITAL +
          CASH_FLOWS.filter((cf) => cf.date <= d.date).reduce(
            (s, cf) => s + cf.amount,
            0
          );
        const dollarDelta = d.value - runningInvested;
        const percent = runningInvested > 0 ? (dollarDelta / runningInvested) * 100 : 0;
        return { ...d, dollarDelta, percent };
      });
    }

    const start = chartData[0];
    const base = start.equity > 0 ? start.equity : start.value;
    if (base <= 0) return [];
    return chartData.map((d) => {
      const cfSoFar = CASH_FLOWS.filter(
        (cf) => cf.date > start.date && cf.date <= d.date
      ).reduce((s, cf) => s + cf.amount, 0);
      const dollarDelta = d.value - cfSoFar - start.value;
      const percent = (dollarDelta / base) * 100;
      return { ...d, dollarDelta, percent };
    });
  }, [chartData, range]);

  // Tight y-axis domain in percent — pad slightly so the line doesn't kiss
  // the top / bottom of the chart.
  const yDomain = useMemo(() => {
    if (percentSeries.length === 0) return [0, 1];
    const values = percentSeries.map((d) => d.percent);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const pad = Math.max(range * 0.1, 0.5);
    return [Number((min - pad).toFixed(2)), Number((max + pad).toFixed(2))];
  }, [percentSeries]);

  // Daily change on equity (invested capital) — cash parked isn't "performance."
  // Dollar change = total change (cash contributes ~0 to day-over-day movement).
  // Percent = dollar change / yesterday's equity base.
  const dailyChange = useMemo(() => {
    if (!data || fullHistory.length < 2) return null;
    const todayTotal = data.totals?.totalValue;
    if (todayTotal == null) return null;
    const todayIso = new Date().toISOString().slice(0, 10);
    for (let i = fullHistory.length - 1; i >= 0; i--) {
      const snap = fullHistory[i];
      const snapIso = snap.date.toISOString().slice(0, 10);
      if (snapIso === todayIso) continue;
      const day = snap.date.getDay();
      if (day === 0 || day === 6) continue;
      const diff = todayTotal - snap.value;
      const base = snap.equity;
      const pct = base > 0 ? (diff / base) * 100 : 0;
      return { diff, pct };
    }
    return null;
  }, [data, fullHistory]);

  // Annualized Sharpe on equity returns.
  // Daily equity return = (Δ total − cash flow) / equity_yesterday
  //   - Δ total captures market movement of the equity holdings (cash is flat).
  //   - Dividing by equity isolates invested-capital performance.
  //   - Cash flows (infusions / withdrawals) are subtracted so they don't
  //     look like gains.
  const sharpe = useMemo(() => {
    if (fullHistory.length < 20) return null;
    const returns = [];
    for (let i = 1; i < fullHistory.length; i++) {
      const prev = fullHistory[i - 1];
      const curr = fullHistory[i];
      const day = curr.date.getDay();
      if (day === 0 || day === 6) continue;
      const cfOnDay = CASH_FLOWS.filter(
        (cf) => cf.date.toISOString().slice(0, 10) === curr.date.toISOString().slice(0, 10)
      ).reduce((s, cf) => s + cf.amount, 0);
      const dollarChange = curr.value - cfOnDay - prev.value;
      const base = prev.equity;
      if (base <= 0) continue;
      returns.push(dollarChange / base);
    }
    if (returns.length < 10) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    const annualReturn = mean * 252;
    const annualStd = std * Math.sqrt(252);
    return (annualReturn - RISK_FREE_RATE) / annualStd;
  }, [fullHistory]);

  // Change between first and last point in the visible range, on equity base.
  // Dollar change = total change minus any capital infusions in range.
  // Percent = dollar change / equity at start of range.
  const rangeChange = useMemo(() => {
    if (chartData.length < 2) return null;
    const end = chartData[chartData.length - 1];

    // ALL range: the header should match the Total Gain/Loss card.
    if (range === 'ALL') {
      const diff = end.value - TOTAL_INVESTED;
      const pct = TOTAL_INVESTED > 0 ? (diff / TOTAL_INVESTED) * 100 : 0;
      return { diff, pct, cashFlowInRange: 0 };
    }

    const start = chartData[0];
    const cashFlowInRange = CASH_FLOWS.filter(
      (cf) => cf.date > start.date && cf.date <= end.date
    ).reduce((sum, cf) => sum + cf.amount, 0);
    const rawDiff = end.value - start.value;
    const diff = rawDiff - cashFlowInRange;
    const base = start.equity > 0 ? start.equity : start.value;
    const pct = base > 0 ? (diff / base) * 100 : 0;
    return { diff, pct, cashFlowInRange };
  }, [chartData, range]);

  // Build display data with a short date label. For long ranges we thin labels out.
  const displayData = percentSeries.map((d) => ({
    ...d,
    label: format(d.date, percentSeries.length > 90 ? 'MMM yyyy' : 'MMM d'),
    tooltipLabel: format(d.date, 'MMM d, yyyy'),
  }));

  return (
    <>
      <PageHeader
        title="Live Portfolio"
        subtitle={
          data?.fetchedAt
            ? `Live from Google Sheets • fetched ${format(new Date(data.fetchedAt), 'h:mm:ss a')}`
            : 'Live from Google Sheets'
        }
        actions={
          <div className="flex gap-2">
            <a
              href={`https://docs.google.com/spreadsheets/d/${import.meta.env.VITE_SHEET_ID || '10b43Ry4YBfY_Uk_8nIlJLjmfNgzzjAm6BjN7UewSdRQ'}/edit`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open Sheet
            </a>
            <Button onClick={load} variant="gold" disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Couldn't load the sheet.</strong> {error}
          <div className="mt-2 text-xs">
            Make sure the sheet is shared as "Anyone with the link can view".
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">Total Value</div>
          <div className="mt-2 text-3xl font-bold text-navy">
            {fmtMoney(totals.totalValue)}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">Daily Change</div>
          {dailyChange ? (
            <>
              <div
                className={`mt-2 flex items-center gap-2 text-3xl font-bold ${
                  dailyChange.diff >= 0 ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {dailyChange.diff >= 0 ? (
                  <TrendingUp className="h-7 w-7" />
                ) : (
                  <TrendingDown className="h-7 w-7" />
                )}
                {fmtMoney(dailyChange.diff)}
              </div>
              <div
                className={`mt-1 text-sm font-semibold ${
                  dailyChange.diff >= 0 ? 'text-emerald-600' : 'text-red-600'
                }`}
              >
                {fmtPct(dailyChange.pct)}
              </div>
            </>
          ) : (
            <div className="mt-2 text-3xl font-bold text-navy-400">—</div>
          )}
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">Total Gain/Loss</div>
          <div
            className={`mt-2 flex items-center gap-2 text-3xl font-bold ${
              isUp ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {isUp ? <TrendingUp className="h-7 w-7" /> : <TrendingDown className="h-7 w-7" />}
            {fmtMoney(lifetimeGainLoss)}
          </div>
          <div
            className={`mt-1 text-sm font-semibold ${
              isUp ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {fmtPct(lifetimeGainLossPct)}
          </div>
          <div className="mt-1 text-[10px] text-navy-400">
            vs. {fmtMoney(TOTAL_INVESTED)} invested
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">
            Sharpe Ratio
          </div>
          {sharpe != null ? (
            <>
              <div
                className={`mt-2 text-3xl font-bold ${
                  sharpe >= 1 ? 'text-emerald-600' : sharpe >= 0 ? 'text-navy' : 'text-red-600'
                }`}
              >
                {sharpe.toFixed(2)}
              </div>
              <div className="mt-1 text-xs text-navy-400">
                Equity only • Rf = {(RISK_FREE_RATE * 100).toFixed(2)}%
              </div>
            </>
          ) : (
            <div className="mt-2 text-3xl font-bold text-navy-400">—</div>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-navy">Performance Over Time</div>
              {rangeChange && (
                <>
                  <div
                    className={`mt-1 text-sm font-semibold ${
                      rangeChange.diff >= 0 ? 'text-emerald-600' : 'text-red-600'
                    }`}
                  >
                    {rangeChange.diff >= 0 ? '+' : ''}
                    {fmtMoney(rangeChange.diff)} ({rangeChange.diff >= 0 ? '+' : ''}
                    {rangeChange.pct.toFixed(2)}%){' '}
                    <span className="text-navy-400 font-normal">
                      in {RANGES.find((r) => r.key === range)?.label}
                    </span>
                  </div>
                  {range === 'ALL' ? (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      vs. {fmtMoney(TOTAL_INVESTED)} invested
                    </div>
                  ) : rangeChange.cashFlowInRange > 0 ? (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      Excludes {fmtMoney(rangeChange.cashFlowInRange)} capital infusion
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex rounded-lg border border-navy-100 bg-white p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                    range === r.key
                      ? 'bg-navy text-white'
                      : 'text-navy-400 hover:text-navy'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {displayData.length > 1 ? (
            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer>
                <AreaChart data={displayData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="navyFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1B2A4A" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#1B2A4A" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#E8EBF2" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    stroke="#8C99BB"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke="#8C99BB"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    domain={yDomain}
                    tickFormatter={(v) =>
                      `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 1 ? 2 : 1)}%`
                    }
                    width={55}
                  />
                  <Tooltip
                    formatter={(v, _name, entry) => [
                      `${v >= 0 ? '+' : ''}${v.toFixed(2)}% (${fmtMoney(entry?.payload?.dollarDelta)})`,
                      'Return',
                    ]}
                    labelFormatter={(_, payload) => payload?.[0]?.payload?.tooltipLabel || ''}
                    contentStyle={{
                      borderRadius: 8,
                      borderColor: '#C9A84C',
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="percent"
                    stroke="#1B2A4A"
                    strokeWidth={2.5}
                    fill="url(#navyFill)"
                    dot={false}
                    activeDot={{ r: 5, fill: '#C9A84C', stroke: '#1B2A4A', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-navy-400">
              Not enough data in this range.
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Holdings">
          {loading && !holdings.length ? (
            <div className="py-8 text-center text-navy-400">Loading from Google Sheets…</div>
          ) : holdings.length === 0 ? (
            <div className="py-8 text-center text-navy-400">
              No positions found in the sheet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="py-2 pr-4">Ticker</th>
                    <th className="py-2 pr-4">Sector</th>
                    <th className="py-2 pr-4 text-right">Shares</th>
                    <th className="py-2 pr-4 text-right">Avg Cost</th>
                    <th className="py-2 pr-4 text-right">Price</th>
                    <th className="py-2 pr-4 text-right">Value</th>
                    <th className="py-2 pr-4 text-right">Weight</th>
                    <th className="py-2 pr-4 text-right">Return $</th>
                    <th className="py-2 pr-4 text-right">Return %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {holdings.map((h) => {
                    const up = (h.dollarReturn ?? 0) >= 0;
                    const marketValue =
                      h.marketValue ??
                      (h.shares != null && h.price != null ? h.shares * h.price : null);
                    return (
                      <tr
                        key={h.ticker}
                        onClick={() => !h.isCash && setSelectedHolding(h)}
                        className={`${h.isCash ? 'bg-gold-100/40' : 'cursor-pointer hover:bg-navy-50/60'}`}
                      >
                        <td className="py-3 pr-4">
                          <div className="font-bold text-navy">{h.ticker}</div>
                          <div className="text-xs text-navy-400 truncate max-w-[220px]">
                            {h.name}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-xs text-navy-400">
                          {h.sector || '—'}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {h.isCash ? '—' : h.shares ?? '—'}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {h.isCash ? '—' : fmtMoney(h.costBasis)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {h.isCash ? '—' : fmtMoney(h.price)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums font-semibold">
                          {fmtMoney(marketValue)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums text-navy-400">
                          {h.portfolioPct != null ? `${h.portfolioPct.toFixed(2)}%` : '—'}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right tabular-nums font-semibold ${
                            h.isCash
                              ? 'text-navy-400'
                              : up
                              ? 'text-emerald-600'
                              : 'text-red-600'
                          }`}
                        >
                          {h.isCash ? '—' : fmtMoney(h.dollarReturn)}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right tabular-nums font-semibold ${
                            h.isCash
                              ? 'text-navy-400'
                              : up
                              ? 'text-emerald-600'
                              : 'text-red-600'
                          }`}
                        >
                          {h.isCash ? '—' : fmtPct(h.percentReturn)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-navy-100">
                    <td colSpan={5} className="py-3 pr-4 font-bold text-navy">
                      Total ({holdings.length} positions)
                    </td>
                    <td className="py-3 pr-4 text-right font-bold text-navy tabular-nums">
                      {fmtMoney(totals.totalValue)}
                    </td>
                    <td />
                    <td
                      className={`py-3 pr-4 text-right font-bold tabular-nums ${
                        isUp ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {fmtMoney(lifetimeGainLoss)}
                    </td>
                    <td
                      className={`py-3 pr-4 text-right font-bold tabular-nums ${
                        isUp ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {fmtPct(lifetimeGainLossPct)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="mt-4 text-xs text-navy-400">
            Positions and prices are read live from the club's Google Sheet. To
            add or remove a position, edit the sheet directly. Click any
            holding to see company details.
          </div>
        </Card>
      </div>

      <HoldingDetailModal
        holding={selectedHolding}
        onClose={() => setSelectedHolding(null)}
      />
    </>
  );
}
