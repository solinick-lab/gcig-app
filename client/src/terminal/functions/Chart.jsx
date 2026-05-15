import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../api/client.js';

// GP — price chart. Pulls daily history from /api/holdings/info path's
// underlying chart endpoint via the public Yahoo v8 chart API on the server
// side. For v0 we keep it simple: fetch 6 months of daily closes from a
// thin Yahoo chart URL and render with Recharts.

const RANGES = [
  { id: '1M', range: '1mo', interval: '1d' },
  { id: '6M', range: '6mo', interval: '1d' },
  { id: '1Y', range: '1y', interval: '1d' },
  { id: '5Y', range: '5y', interval: '1wk' },
];

export default function Chart({ ticker }) {
  const [range, setRange] = useState('6M');
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    const sel = RANGES.find((r) => r.id === range) || RANGES[1];
    setLoading(true);
    setErr(null);
    setData([]);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${sel.range}&interval=${sel.interval}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const result = json?.chart?.result?.[0];
        const ts = result?.timestamp || [];
        const closes = result?.indicators?.quote?.[0]?.close || [];
        const points = ts
          .map((t, i) => ({ t: t * 1000, close: closes[i] }))
          .filter((p) => p.close != null);
        setData(points);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message || 'Chart failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, range]);

  const formatTick = useMemo(() => {
    const sel = RANGES.find((r) => r.id === range) || RANGES[1];
    return (t) => {
      const d = new Date(t);
      if (sel.id === '1M') return `${d.getMonth() + 1}/${d.getDate()}`;
      if (sel.id === '6M' || sel.id === '1Y')
        return d.toLocaleString('en', { month: 'short' });
      return String(d.getFullYear()).slice(2);
    };
  }, [range]);

  if (!ticker) {
    return <div className="term-panel"><div className="term-loading">Enter a ticker to load chart.</div></div>;
  }

  return (
    <div className="term-panel" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Price · {range}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              style={{
                background: r.id === range ? 'var(--term-fg)' : 'transparent',
                color: r.id === range ? '#000' : 'var(--term-fg-dim)',
                border: '1px solid var(--term-border)',
                padding: '2px 8px',
                font: 'inherit',
                fontSize: 11,
                cursor: 'pointer',
                letterSpacing: '0.06em',
              }}
            >
              {r.id}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="term-loading">Loading history…</div>
      ) : err ? (
        <div className="term-error">Error: {err}</div>
      ) : data.length === 0 ? (
        <div className="term-loading">No history.</div>
      ) : (
        <div className="term-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={formatTick}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                width={48}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--term-bg-panel)',
                  border: '1px solid var(--term-border)',
                  color: 'var(--term-fg)',
                  fontFamily: 'inherit',
                  fontSize: 11,
                }}
                labelFormatter={(t) => new Date(t).toLocaleDateString()}
                formatter={(v) => [Number(v).toFixed(2), 'Close']}
              />
              <Line
                type="monotone"
                dataKey="close"
                stroke="var(--term-fg)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
