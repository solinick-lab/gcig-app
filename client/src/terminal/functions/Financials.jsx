import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';

// FA — the three financial statements line by line, fiscal periods as
// columns, the way Bloomberg's FA lays them out. The numbers are SEC
// XBRL (same source as GF); the panel adds the statement/frequency
// switches, the derived margin and ratio block beneath each statement,
// and a CSV export of whatever's on screen.

const STATEMENTS = [
  { id: 'balance', label: 'Balance Sheet' },
  { id: 'income', label: 'Income' },
  { id: 'cashflow', label: 'Cash Flow' },
];

const fmt = {
  mm: (v) => (v == null || Number.isNaN(v) ? '—' : (v / 1e6).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })),
  eps: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`),
  growth: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`),
  x: (v) => (v == null || Number.isNaN(v) ? '—' : `${v.toFixed(2)}x`),
};

// Format a line-item cell by its XBRL unit: per-share stays as dollars,
// share counts and dollar lines both render in millions.
function cell(unit, v) {
  if (unit === 'USD/shares') return fmt.eps(v);
  return fmt.mm(v);
}

const ratio = (a, b) => (a != null && b != null && b !== 0 ? a / b : null);
const growthAt = (arr, i) => (i > 0 && arr[i - 1] != null && arr[i] != null && arr[i - 1] !== 0 ? (arr[i] - arr[i - 1]) / Math.abs(arr[i - 1]) : null);

export default function Financials({ ticker, freq: _freq }) {
  const [statement, setStatement] = useState('income');
  const [freq, setFreq] = useState('annual');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get(`/terminal/statements/${encodeURIComponent(ticker)}`, { params: { freq } })
      .then(({ data }) => {
        if (!cancelled) setData(data);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, freq]);

  // Line items for the active statement, plus the derived ratio rows.
  const { rows, ratios, periods } = useMemo(() => {
    if (!data) return { rows: [], ratios: [], periods: [] };
    const rows = data[statement] || [];
    const periods = data.periods || [];
    const at = (key) => (rows.find((r) => r.key === key) || {}).values || [];
    const rev = (data.income.find((r) => r.key === 'revenue') || {}).values || [];

    const byPeriod = (fn, kind) =>
      ({ kind, values: periods.map((_, i) => fn(i)) });

    let ratios = [];
    if (statement === 'income') {
      const g = at('grossProfit'), op = at('operatingIncome'), ni = at('netIncome'), rnd = at('rnd'), sga = at('sga');
      ratios = [
        { label: 'Gross Profit Margin', ...byPeriod((i) => ratio(g[i], rev[i]), 'pct') },
        { label: 'Operating Profit Margin', ...byPeriod((i) => ratio(op[i], rev[i]), 'pct') },
        { label: 'Net Profit Margin', ...byPeriod((i) => ratio(ni[i], rev[i]), 'pct') },
        { label: 'R&D as % of Revenue', ...byPeriod((i) => ratio(rnd[i], rev[i]), 'pct') },
        { label: 'SG&A as % of Revenue', ...byPeriod((i) => ratio(sga[i], rev[i]), 'pct') },
        { label: freq === 'quarterly' ? 'Revenue QoQ Growth' : 'Revenue YoY Growth', ...byPeriod((i) => growthAt(rev, i), 'growth') },
      ];
    } else if (statement === 'cashflow') {
      const cfo = at('cfo'), capex = at('capex');
      const fcf = (i) => (cfo[i] != null && capex[i] != null ? cfo[i] - capex[i] : null);
      ratios = [
        { label: 'Free Cash Flow', ...byPeriod((i) => fcf(i), 'mm') },
        { label: 'FCF Margin', ...byPeriod((i) => ratio(fcf(i), rev[i]), 'pct') },
        { label: 'CapEx as % of Revenue', ...byPeriod((i) => ratio(capex[i], rev[i]), 'pct') },
      ];
    } else {
      const ca = at('currentAssets'), cl = at('currentLiabilities'), debt = at('longTermDebt'), eq = at('equity'), cash = at('cash'), ta = at('totalAssets');
      ratios = [
        { label: 'Current Ratio', ...byPeriod((i) => ratio(ca[i], cl[i]), 'x') },
        { label: 'Debt / Equity', ...byPeriod((i) => ratio(debt[i], eq[i]), 'x') },
        { label: 'Cash as % of Assets', ...byPeriod((i) => ratio(cash[i], ta[i]), 'pct') },
      ];
    }
    return { rows, ratios, periods };
  }, [data, statement, freq]);

  function fmtRatio(kind, v) {
    if (kind === 'pct') return fmt.pct(v);
    if (kind === 'growth') return fmt.growth(v);
    if (kind === 'x') return fmt.x(v);
    return fmt.mm(v);
  }

  function exportCsv() {
    if (!data) return;
    const head = ['', ...periods.map((p) => p.label)];
    const lines = [head];
    for (const r of rows) lines.push([r.label, ...r.values.map((v) => cell(r.unit, v))]);
    lines.push([]);
    for (const r of ratios) lines.push([r.label, ...r.values.map((v) => fmtRatio(r.kind, v))]);
    const csv = lines.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ticker}_${statement}_${freq}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!ticker) {
    return <div className="term-panel"><div className="term-loading">Enter a ticker to load FA.</div></div>;
  }

  const empty = !loading && data && periods.length === 0;

  return (
    <div className="term-panel term-fa">
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="equity">US Equity</span>
        <span className="name">Financial Statements{data?.name ? ` · ${data.name}` : ''}</span>
      </div>

      <div className="term-fa-controls">
        <div className="term-tabs">
          {STATEMENTS.map((s) => (
            <button key={s.id} className={`term-tab${statement === s.id ? ' active' : ''}`} onClick={() => setStatement(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="term-tabs">
          {['quarterly', 'annual'].map((f) => (
            <button key={f} className={`term-tab${freq === f ? ' active' : ''}`} onClick={() => setFreq(f)}>
              {f === 'quarterly' ? 'Quarterly' : 'Yearly'}
            </button>
          ))}
        </div>
        <span className="term-fa-caption">In Millions · except per-share</span>
        <button className="term-fa-export" onClick={exportCsv} disabled={!data || empty} title="Download CSV">
          ↓ CSV
        </button>
      </div>

      {loading ? (
        <div className="term-loading">Loading {ticker.toUpperCase()} {statement}…</div>
      ) : err ? (
        <div className="term-error">Error: {err}</div>
      ) : empty ? (
        <div className="term-loading">
          SEC tags no {freq} statement data for {ticker.toUpperCase()} — common for foreign filers (20-F),
          funds, and ADRs that don't report in us-gaap XBRL.
        </div>
      ) : (
        <div className="term-fa-scroll">
          <table className="term-table term-fa-table">
            <thead>
              <tr>
                <th className="term-fa-stub">{statement === 'balance' ? 'Balance Sheet' : statement === 'income' ? 'Income Statement' : 'Cash Flow'}</th>
                {periods.map((p) => (
                  <th key={p.period} className="num">{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="term-fa-stub">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className="num">{cell(r.unit, v)}</td>
                  ))}
                </tr>
              ))}
              <tr className="term-fa-gap"><td colSpan={periods.length + 1} /></tr>
              {ratios.map((r) => (
                <tr key={r.label} className="term-fa-ratio">
                  <td className="term-fa-stub">{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className="num">{fmtRatio(r.kind, v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="term-fa-source">
        SEC XBRL companyfacts · fiscal periods, latest filing per period (restatements win).
        Quarterly Q4 is derived as FY minus Q1–Q3 for flow lines.
      </div>
    </div>
  );
}
