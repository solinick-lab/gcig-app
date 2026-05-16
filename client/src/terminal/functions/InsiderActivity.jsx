import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '../../api/client.js';

// INSDR — insider Form 4 activity overlaid on the 1y price line.
// Only open-market P (buy) / S (sell) are plotted; the table can show
// every code via the toggle. Reuses /terminal/chart for the price line.

const fmtMoney = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtNum = (v) =>
  v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString();
const fmtDate = (d) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? '—'
    : `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${String(dt.getFullYear()).slice(2)}`;
};

// Snap a transaction date to the close of the nearest prior trading
// day in the price series so the marker sits on the line.
function priceAt(points, ts) {
  if (!points.length) return null;
  let best = null;
  for (const p of points) {
    if (p.t <= ts) best = p;
    else break;
  }
  return (best || points[0]).close;
}

const Triangle = ({ cx, cy, fill, up }) => {
  if (cx == null || cy == null) return null;
  const s = 5;
  const pts = up
    ? `${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}`
    : `${cx},${cy + s} ${cx - s},${cy - s} ${cx + s},${cy - s}`;
  return <polygon points={pts} fill={fill} stroke="#000" strokeWidth={0.5} />;
};

const BuyShape = (p) => <Triangle {...p} up fill="var(--term-positive)" />;
const SellShape = (p) => <Triangle {...p} fill="var(--term-negative)" />;

const TxTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const t = payload[0]?.payload?._tx;
  if (!t) return null;
  return (
    <div
      style={{
        background: 'var(--term-bg-panel)',
        border: '1px solid var(--term-border)',
        color: 'var(--term-fg)',
        fontSize: 11,
        padding: '6px 8px',
      }}
    >
      <div>{fmtDate(t.date)} · {t.code} {t.isBuy ? 'BUY' : 'SELL'}</div>
      <div>{t.name}{t.role ? ` · ${t.role}` : ''}</div>
      <div>{fmtNum(t.shares)} @ {t.price ?? '—'} = {fmtMoney(t.value)}</div>
    </div>
  );
};

export default function InsiderActivity({ ticker }) {
  const [points, setPoints] = useState([]);
  const [tx, setTx] = useState([]);
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setPoints([]);
    setTx([]);
    setBrief('');
    Promise.allSettled([
      api.get(`/terminal/chart/${encodeURIComponent(ticker)}`, {
        params: { range: '1y', interval: '1d' },
      }),
      api.get(`/terminal/insiders/${encodeURIComponent(ticker)}`),
    ])
      .then(([chartRes, insRes]) => {
        if (cancelled) return;
        if (chartRes.status === 'fulfilled') {
          setPoints(
            Array.isArray(chartRes.value.data?.points)
              ? chartRes.value.data.points
              : []
          );
        }
        if (insRes.status === 'fulfilled') {
          setTx(insRes.value.data?.transactions || []);
          setSource(insRes.value.data?._source || null);
        } else {
          setErr('Insider data unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const { buys, sells } = useMemo(() => {
    const b = [];
    const s = [];
    for (const t of tx) {
      const ts = new Date(t.date).getTime();
      if (Number.isNaN(ts)) continue;
      const y = priceAt(points, ts);
      if (y == null) continue;
      if (t.isBuy) b.push({ t: ts, y, _tx: t });
      else if (t.isSell) s.push({ t: ts, y, _tx: t });
    }
    return { buys: b, sells: s };
  }, [tx, points]);

  const tableRows = useMemo(
    () => (openOnly ? tx.filter((t) => t.isBuy || t.isSell) : tx),
    [tx, openOnly]
  );

  const xDomain = useMemo(
    () =>
      points.length
        ? [points[0].t, points[points.length - 1].t]
        : ['dataMin', 'dataMax'],
    [points]
  );
  const yDomain = useMemo(() => {
    if (!points.length) return ['auto', 'auto'];
    const closes = points.map((p) => p.close);
    return [Math.min(...closes), Math.max(...closes)];
  }, [points]);

  useEffect(() => {
    if (!ticker || tx.length === 0) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = tx
      .slice(0, 15)
      .map(
        (t) =>
          `${fmtDate(t.date)} ${t.name} (${t.role || '—'}) ${t.code} ` +
          `${fmtNum(t.shares)} @ ${t.price ?? '—'} = ${fmtMoney(t.value)}`
      )
      .join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'INSDR', context })
      .then(({ data }) => {
        if (!cancelled) setBrief(data.brief || '');
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
  }, [tx, ticker]);

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load insider activity.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading insider activity…</div>
      </div>
    );
  }
  if (err && !points.length) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }

  return (
    <div className="term-panel" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Insider Activity · Form 4</span>
        {source && (
          <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
            {source === 'sec' ? 'SEC EDGAR' : 'Finnhub'}
          </span>
        )}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {points.length === 0 ? (
        <div className="term-loading">Price history unavailable — table only.</div>
      ) : (
        <div className="term-chart" style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="t"
                type="number"
                domain={xDomain}
                tickFormatter={(t) => new Date(t).toLocaleString('en', { month: 'short' })}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
              />
              <YAxis
                domain={yDomain}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                width={48}
              />
              <Tooltip content={<TxTooltip />} />
              <Line
                type="monotone"
                dataKey="close"
                stroke="var(--term-fg)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Scatter
                data={buys}
                dataKey="y"
                isAnimationActive={false}
                shape={BuyShape}
              />
              <Scatter
                data={sells}
                dataKey="y"
                isAnimationActive={false}
                shape={SellShape}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11 }}>
        <span style={{ color: 'var(--term-positive)' }}>▲ buy</span>
        <span style={{ color: 'var(--term-negative)' }}>▼ sell</span>
        <button
          onClick={() => setOpenOnly((v) => !v)}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            color: 'var(--term-fg-dim)',
            border: '1px solid var(--term-border)',
            font: 'inherit',
            fontSize: 11,
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          {openOnly ? 'Open-market only' : 'All codes'}
        </button>
      </div>

      {tableRows.length === 0 ? (
        <div className="term-loading">No Form 4 activity in the last 24 months.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Insider</th>
              <th>Role</th>
              <th>TX</th>
              <th className="num">Shares</th>
              <th className="num">Price</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((t, i) => (
              <tr key={`${t.date}-${t.name}-${i}`}>
                <td>{fmtDate(t.date)}</td>
                <td className="sym">{t.name}</td>
                <td>{t.role || '—'}</td>
                <td className={t.isBuy ? 'num pos' : t.isSell ? 'num neg' : 'num'}>
                  {t.code}
                </td>
                <td className="num">{fmtNum(t.shares)}</td>
                <td className="num">{t.price == null ? '—' : Number(t.price).toFixed(2)}</td>
                <td className="num">{fmtMoney(t.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Open-market P/S plotted; M/A/F/G shown in the table only. 20-min cache.
      </div>
    </div>
  );
}
