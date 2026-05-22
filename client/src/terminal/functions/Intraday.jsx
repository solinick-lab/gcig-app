import { useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';

// GIP — today's intraday price line, the way Bloomberg's GIP reads: the
// session plotted against the prior close, colored by the day's
// direction, with pre- and post-market included. Data is NASDAQ's chart
// endpoint (~1-minute points), the same Render-friendly upstream the
// daily GP cache uses, refreshed on the shared while-visible cadence so
// an open panel keeps ticking.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  abs: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`),
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`),
  time: (t) =>
    new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }),
};

export default function Intraday({ ticker }) {
  const sym = ticker ? ticker.toUpperCase() : '';
  const { data, loading, error } = useLiveRefresh(
    async () => {
      const { data } = await api.get(`/terminal/intraday/${encodeURIComponent(sym)}`);
      return data;
    },
    { enabled: !!sym, intervalMs: 30000 }
  );

  const up = data?.pctChange == null ? true : data.pctChange >= 0;
  const color = up ? 'var(--term-positive)' : 'var(--term-negative)';
  const points = data?.points || [];

  // A touch of vertical headroom around the line and the prior-close
  // baseline so neither rides the panel edge.
  const yDomain = useMemo(() => {
    if (!points.length) return ['auto', 'auto'];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (p.price < lo) lo = p.price;
      if (p.price > hi) hi = p.price;
    }
    if (data?.prevClose != null) {
      lo = Math.min(lo, data.prevClose);
      hi = Math.max(hi, data.prevClose);
    }
    const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
    return [lo - pad, hi + pad];
  }, [points, data]);

  if (!ticker) {
    return <div className="term-panel"><div className="term-loading">Enter a ticker to load GIP.</div></div>;
  }
  if (loading && !data) {
    return <div className="term-panel"><div className="term-loading">Loading {sym} intraday…</div></div>;
  }
  if (error && !data) {
    return <div className="term-panel"><div className="term-error">Error: {error.response?.data?.error || error.message || 'Failed to load'}</div></div>;
  }
  if (!data) return null;

  return (
    <div className="term-panel term-gp term-gip" style={{ height: '100%' }}>
      <div className="term-gp-header">
        <div className="term-gp-quote">
          <span className="ticker">{sym}</span>
          <span className="equity">{data.exchange || 'Intraday'}</span>
          <span className={`last ${up ? 'pos' : 'neg'}`}>
            <span className="arrow">{up ? '▲' : '▼'}</span>
            {fmt.px(data.last)}
          </span>
          <span className={up ? 'pos' : 'neg'}>{fmt.abs(data.netChange)}</span>
          <span className={up ? 'pos' : 'neg'}>{fmt.pct(data.pctChange)}</span>
        </div>
        <div className="term-gp-session">
          <span>Prev Close <b>{fmt.px(data.prevClose)}</b></span>
          {data.volume != null ? <span>Vol <b>{Number(data.volume).toLocaleString('en-US')}</b></span> : null}
          {data.asOf ? <span className="muted">{data.asOf}</span> : null}
        </div>
      </div>

      {points.length === 0 ? (
        <div className="term-loading">No intraday prints yet — the session may not have opened.</div>
      ) : (
        <div className="term-gp-chartwrap">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="gipFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--term-border)" strokeOpacity={0.5} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={fmt.time}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                minTickGap={56}
              />
              <YAxis
                orientation="right"
                domain={yDomain}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                width={54}
                tickFormatter={(v) => Number(v).toFixed(2)}
              />
              <Tooltip content={<GipTooltip prevClose={data.prevClose} />} />
              {data.prevClose != null ? (
                <ReferenceLine
                  y={data.prevClose}
                  stroke="var(--term-fg-muted)"
                  strokeDasharray="2 3"
                  strokeOpacity={0.8}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey="price"
                name="Price"
                stroke={color}
                strokeWidth={1.4}
                fill="url(#gipFill)"
                dot={false}
                isAnimationActive={false}
                activeDot={{ r: 2.5, fill: color }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Intraday line vs prior close · NASDAQ ~1-min prints, pre/post-market included ·
        refreshes ~30s while open.
      </div>
    </div>
  );
}

function GipTooltip({ active, payload, prevClose }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const chg = prevClose != null ? p.price - prevClose : null;
  const pct = prevClose ? chg / prevClose : null;
  const cls = chg == null ? '' : chg >= 0 ? 'pos' : 'neg';
  return (
    <div className="term-gp-tip">
      <div className="d">{fmt.time(p.t)}</div>
      <div className="ohlc">
        <span>{fmt.px(p.price)}</span>
        {chg != null ? <span className={cls}>{fmt.abs(chg)} ({fmt.pct(pct)})</span> : null}
      </div>
    </div>
  );
}
