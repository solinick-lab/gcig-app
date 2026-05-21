import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import api from '../../api/client.js';

// GF — graph fundamentals. SEC XBRL income-statement / cash-flow figures
// over time (/terminal/fundamentals), the surface Bloomberg's GF plots:
// dollar metrics as grouped bars on the left axis, a margin or EPS line
// on the right. Annual or quarterly; the data is whatever the filer
// actually tagged, so a metric a company never reported just drops out
// rather than drawing a zero.

const BAR_METRICS = [
  { key: 'revenue', label: 'Revenue', color: 'var(--term-fg)' },
  { key: 'grossProfit', label: 'Gross Profit', color: 'var(--term-blue)' },
  { key: 'operatingIncome', label: 'Op Income', color: 'var(--term-magenta)' },
  { key: 'netIncome', label: 'Net Income', color: 'var(--term-cyan)' },
  { key: 'cfo', label: 'Op Cash Flow', color: 'var(--term-positive)' },
];

const LINE_METRICS = [
  { key: 'none', label: 'None' },
  { key: 'grossMargin', label: 'Gross Margin', kind: 'pct' },
  { key: 'operatingMargin', label: 'Op Margin', kind: 'pct' },
  { key: 'netMargin', label: 'Net Margin', kind: 'pct' },
  { key: 'epsDiluted', label: 'Diluted EPS', kind: 'eps' },
];

const fmt = {
  usd: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
    return `${sign}$${a.toFixed(0)}`;
  },
  axisUsd: (v) => {
    const a = Math.abs(Number(v));
    if (a >= 1e9) return `${(v / 1e9).toFixed(0)}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return String(v);
  },
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`),
  eps: (v) => (v == null || Number.isNaN(v) ? '—' : `$${Number(v).toFixed(2)}`),
};

export default function Fundamentals({ ticker }) {
  const sym = ticker ? ticker.toUpperCase() : '';
  const [freq, setFreq] = useState('annual');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [bars, setBars] = useState({
    revenue: true,
    netIncome: true,
    grossProfit: false,
    operatingIncome: false,
    cfo: false,
  });
  const [lineKey, setLineKey] = useState('netMargin');
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!sym) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get(`/terminal/fundamentals/${encodeURIComponent(sym)}`, {
        params: { freq },
      })
      .then(({ data: payload }) => {
        if (!cancelled) setData(payload);
      })
      .catch((e) => {
        if (!cancelled)
          setErr(e.response?.data?.error || e.message || 'Fundamentals failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sym, freq]);

  const rows = data?.rows || [];
  const activeBars = BAR_METRICS.filter((m) => bars[m.key]);
  const line = LINE_METRICS.find((l) => l.key === lineKey) || LINE_METRICS[0];
  // Category axis shows every label by default; thin them once a
  // quarterly series gets long so the axis doesn't turn to mush.
  const tickInterval = rows.length > 14 ? Math.ceil(rows.length / 10) : 0;

  // AI brief once the series resolves (≥2 periods) — confab-safe, keyed
  // off the loaded data so it fires once per ticker/freq, like CMP.
  useEffect(() => {
    if (!data || rows.length < 2) {
      setBrief('');
      return;
    }
    let cancelled = false;
    setBriefLoading(true);
    const last = rows[rows.length - 1];
    const first = rows[0];
    const growth =
      first.revenue && last.revenue ? last.revenue / first.revenue - 1 : null;
    const context = [
      `${data.name || sym} — ${freq} fundamentals, ${rows.length} periods (${first.period} → ${last.period}).`,
      `Latest: revenue ${fmt.usd(last.revenue)}, net income ${fmt.usd(
        last.netIncome
      )}, net margin ${fmt.pct(last.netMargin)}, diluted EPS ${fmt.eps(
        last.epsDiluted
      )}.`,
      growth != null
        ? `Revenue ${growth >= 0 ? 'up' : 'down'} ${fmt.pct(
            Math.abs(growth)
          )} across the window.`
        : null,
    ]
      .filter(Boolean)
      .join('\n');
    api
      .post('/terminal/annotate', { ticker: sym, function: 'GF', context })
      .then(({ data: d }) => {
        if (!cancelled) setBrief(d.brief || '');
      })
      .catch(() => {
        if (!cancelled) setBrief('');
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sym) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load GF.</div>
      </div>
    );
  }

  return (
    <div className="term-panel term-gf" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">{sym}</span>
        <span className="name">
          {data?.name ? `${data.name} · ` : ''}Graph Fundamentals
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {['annual', 'quarterly'].map((f) => (
            <button
              key={f}
              type="button"
              className={`term-gp-btn${freq === f ? ' active' : ''}`}
              onClick={() => setFreq(f)}
            >
              {f === 'annual' ? 'Annual' : 'Quarterly'}
            </button>
          ))}
        </div>
      </div>

      {/* Metric pickers — toggle the dollar bars, choose one overlay line. */}
      <div className="term-gf-controls">
        <div className="term-gf-metrics">
          {BAR_METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`term-gf-metric${bars[m.key] ? ' on' : ''}`}
              style={bars[m.key] ? { borderColor: m.color } : undefined}
              onClick={() => setBars((p) => ({ ...p, [m.key]: !p[m.key] }))}
            >
              <span
                className="swatch"
                style={{ background: m.color, opacity: bars[m.key] ? 1 : 0.3 }}
              />
              {m.label}
            </button>
          ))}
        </div>
        <label className="term-gf-line">
          overlay
          <select value={lineKey} onChange={(e) => setLineKey(e.target.value)}>
            {LINE_METRICS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && !data ? (
        <div className="term-loading">Loading fundamentals…</div>
      ) : err ? (
        <div className="term-error">Error: {err}</div>
      ) : rows.length === 0 ? (
        <div className="term-loading">
          No tagged fundamentals for {sym}. SEC XBRL covers US filers — ADRs
          and funds often tag none.
        </div>
      ) : (
        <>
          {rows.length >= 2 ? (
            <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
              <span className="label">◢ AI BRIEF</span>
              {briefLoading ? 'Generating…' : brief || 'No brief available.'}
            </div>
          ) : null}

          <div className="term-gp-chartwrap">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={rows}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  stroke="var(--term-border)"
                  strokeOpacity={0.5}
                  vertical={false}
                />
                <XAxis
                  dataKey="period"
                  interval={tickInterval}
                  tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                  axisLine={{ stroke: 'var(--term-border)' }}
                  tickLine={{ stroke: 'var(--term-border)' }}
                />
                <YAxis
                  yAxisId="usd"
                  tickFormatter={fmt.axisUsd}
                  tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                  axisLine={{ stroke: 'var(--term-border)' }}
                  tickLine={{ stroke: 'var(--term-border)' }}
                  width={46}
                />
                {line.key !== 'none' ? (
                  <YAxis
                    yAxisId="line"
                    orientation="right"
                    tickFormatter={
                      line.kind === 'pct'
                        ? (v) => `${(v * 100).toFixed(0)}%`
                        : (v) => `$${Number(v).toFixed(0)}`
                    }
                    tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                    axisLine={{ stroke: 'var(--term-border)' }}
                    tickLine={{ stroke: 'var(--term-border)' }}
                    width={44}
                  />
                ) : null}
                <Tooltip
                  content={<GfTooltip activeBars={activeBars} line={line} />}
                />
                {activeBars.map((m) => (
                  <Bar
                    key={m.key}
                    yAxisId="usd"
                    dataKey={m.key}
                    name={m.label}
                    fill={m.color}
                    isAnimationActive={false}
                  />
                ))}
                {line.key !== 'none' ? (
                  <Line
                    yAxisId="line"
                    type="monotone"
                    dataKey={line.key}
                    name={line.label}
                    stroke="var(--term-white)"
                    strokeWidth={1.4}
                    dot={{ r: 2, fill: 'var(--term-white)' }}
                    isAnimationActive={false}
                    connectNulls
                  />
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

// Hover readout: each selected dollar bar plus the overlay line for the
// period, read off the row in the tooltip payload.
function GfTooltip({ active, payload, label, activeBars = [], line }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="term-gp-tip">
      <div className="d">{label}</div>
      {activeBars.map((m) => (
        <div key={m.key} style={{ color: m.color }}>
          {m.label}: {fmt.usd(p[m.key])}
        </div>
      ))}
      {line && line.key !== 'none' ? (
        <div className="st">
          {line.label}:{' '}
          {line.kind === 'pct' ? fmt.pct(p[line.key]) : fmt.eps(p[line.key])}
        </div>
      ) : null}
    </div>
  );
}
