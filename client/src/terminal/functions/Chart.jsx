import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// GP — price graph. Modeled on Bloomberg's GP <Go>: a filled close line
// over a selectable window, a session header (headline last/change plus
// the latest bar's O/H/L/Vol/Val), a floating Last/High/Average/Low
// legend, and a studies rail for overlaying moving averages. History is
// daily, served from the NASDAQ-backed PriceBar cache (/terminal/chart);
// the live last/change is overlaid off /terminal/quotes through the
// shared poller, exactly like DES and CMP. Intraday windows (1D/3D) are
// shown for fidelity to GP but disabled — the cache is end-of-day only.

const RANGES = [
  { id: '1D', range: null }, // intraday — no source yet, button disabled
  { id: '3D', range: null },
  { id: '1M', range: '1mo' },
  { id: '6M', range: '6mo' },
  { id: 'YTD', range: 'ytd' },
  { id: '1Y', range: '1y' },
  { id: '5Y', range: '5y' },
  { id: 'Max', range: 'max' },
];

// Overlay colors, handed out in order. Deliberately off the white price
// line and the navy fill so each study reads as its own series.
const STUDY_COLORS = [
  'var(--term-fg)',
  'var(--term-cyan)',
  'var(--term-magenta)',
  'var(--term-blue)',
  'var(--term-positive)',
];
const MAX_STUDIES = 5;

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  signed: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`,
  pct: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
  big: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  },
  date: (t) =>
    t == null
      ? '—'
      : new Date(t).toLocaleDateString('en', {
          month: '2-digit',
          day: '2-digit',
          year: 'numeric',
        }),
};

// Simple and exponential moving averages over the close series. Both
// return an array aligned to the input, null until enough lookback has
// accumulated, so an overlay never draws a misleading early stub.
function sma(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period < 1 || closes.length === 0) return out;
  const k = 2 / (period + 1);
  // Seed on the first full window's SMA so the curve starts on a real
  // average rather than the opening print, then roll it forward.
  let prev = null;
  let seed = 0;
  for (let i = 0; i < closes.length; i += 1) {
    if (i < period) {
      seed += closes[i];
      if (i === period - 1) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export default function Chart({ ticker }) {
  const [rangeId, setRangeId] = useState('1Y');
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [studies, setStudies] = useState([]);
  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState('SMA');
  const [draftPeriod, setDraftPeriod] = useState('50');

  const sym = ticker ? ticker.toUpperCase() : '';

  // History fetch — re-runs on ticker / range. Intraday ranges carry a
  // null backend bucket and their button is disabled, so we bail before
  // firing rather than letting a stray request 400 the route.
  useEffect(() => {
    if (!sym) return;
    const sel = RANGES.find((r) => r.id === rangeId);
    if (!sel || !sel.range) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get(`/terminal/chart/${encodeURIComponent(sym)}`, {
        params: { range: sel.range },
      })
      .then(({ data }) => {
        if (!cancelled) setPoints(Array.isArray(data?.points) ? data.points : []);
      })
      .catch((e) => {
        if (!cancelled)
          setErr(e.response?.data?.error || e.message || 'Chart failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sym, rangeId]);

  // Live last/change overlaid on the EOD series while GP is open — the
  // same shared ~20s poll the other quote panels use. The historical
  // tail still owns the line; this only freshens the headline number.
  const { data: liveQuotes } = useLiveRefresh(
    async () => {
      if (!sym) return {};
      const { data } = await api.get('/terminal/quotes', {
        params: { tickers: sym },
      });
      return data;
    },
    { enabled: !!sym }
  );
  const live = liveQuotes ? liveQuotes[sym] : null;

  // Header + legend readouts, all derived from the loaded window plus the
  // live tap. prevClose is the prior bar so the change reads yesterday→
  // now even while the live last is mid-session.
  const stats = useMemo(() => {
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2] : null;
    const lastClose = last.close;
    const liveLast = live && live.last != null ? live.last : lastClose;
    const prevClose = prev ? prev.close : null;
    const changeAbs = prevClose != null ? liveLast - prevClose : null;
    const changePct = prevClose ? changeAbs / prevClose : null;

    let hi = -Infinity;
    let lo = Infinity;
    let sum = 0;
    let hiT = null;
    let loT = null;
    for (const p of points) {
      if (p.close > hi) {
        hi = p.close;
        hiT = p.t;
      }
      if (p.close < lo) {
        lo = p.close;
        loT = p.t;
      }
      sum += p.close;
    }
    return {
      bar: last,
      liveLast,
      changeAbs,
      changePct,
      high: hi,
      highT: hiT,
      low: lo,
      lowT: loT,
      avg: sum / points.length,
      val:
        last.close != null && last.volume != null
          ? last.close * last.volume
          : null,
    };
  }, [points, live]);

  // Augment each plotted point with the active studies' values under a
  // stable per-study key so the overlay <Line>s can read them.
  const chartData = useMemo(() => {
    if (points.length === 0) return [];
    const closes = points.map((p) => p.close);
    const cols = studies.map((st) => ({
      id: st.id,
      vals: st.type === 'EMA' ? ema(closes, st.period) : sma(closes, st.period),
    }));
    return points.map((p, i) => {
      const row = { ...p };
      for (const c of cols) row[`s_${c.id}`] = c.vals[i];
      return row;
    });
  }, [points, studies]);

  const formatTick = useMemo(
    () => (t) => {
      const d = new Date(t);
      if (rangeId === '1M') return `${d.getMonth() + 1}/${d.getDate()}`;
      if (rangeId === '5Y' || rangeId === 'Max') return String(d.getFullYear());
      return d.toLocaleString('en', { month: 'short' });
    },
    [rangeId]
  );

  const addStudy = () => {
    const period = Math.max(1, Math.min(400, parseInt(draftPeriod, 10) || 0));
    if (!period) return;
    setStudies((prev) => {
      if (prev.length >= MAX_STUDIES) return prev;
      const id = `${draftType}${period}-${Date.now().toString(36)}`;
      const color = STUDY_COLORS[prev.length % STUDY_COLORS.length];
      return [...prev, { id, type: draftType, period, color }];
    });
    setAdding(false);
  };
  const removeStudy = (id) =>
    setStudies((prev) => prev.filter((s) => s.id !== id));

  if (!sym) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load GP.</div>
      </div>
    );
  }

  const up = stats?.changeAbs != null && stats.changeAbs >= 0;
  const dateSpan =
    points.length > 0
      ? `${fmt.date(points[0].t)} – ${fmt.date(points[points.length - 1].t)}`
      : '';

  return (
    <div className="term-panel term-gp" style={{ height: '100%' }}>
      {/* Session header — the GP quote block: headline last + change,
          then the latest bar's O/H/L/Vol/Val. */}
      <div className="term-gp-header">
        <div className="term-gp-quote">
          <span className="ticker">{sym}</span>
          <span className="equity">Equity · GP</span>
          {stats ? (
            <>
              <span className={`last ${up ? 'pos' : 'neg'}`}>
                <span className="arrow">{up ? '▲' : '▼'}</span>
                <FlashPrice value={stats.liveLast}>
                  {fmt.px(stats.liveLast)}
                </FlashPrice>
              </span>
              <span className={up ? 'pos' : 'neg'}>
                {fmt.signed(stats.changeAbs)}
              </span>
              <span className={up ? 'pos' : 'neg'}>
                {fmt.pct(stats.changePct)}
              </span>
            </>
          ) : null}
        </div>
        {stats ? (
          <div className="term-gp-session">
            <span>
              O <b>{fmt.px(stats.bar.open)}</b>
            </span>
            <span>
              H <b>{fmt.px(stats.bar.high)}</b>
            </span>
            <span>
              L <b>{fmt.px(stats.bar.low)}</b>
            </span>
            <span>
              Vol <b>{fmt.big(stats.bar.volume)}</b>
            </span>
            <span>
              Val <b>{fmt.big(stats.val)}</b>
            </span>
            <span className="muted">Latest session · daily</span>
          </div>
        ) : null}
      </div>

      {/* Toolbar — range row + (daily) interval + the loaded date span. */}
      <div className="term-gp-toolbar">
        <div className="term-gp-ranges">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={!r.range}
              title={
                !r.range
                  ? 'Intraday not available — daily history only'
                  : undefined
              }
              className={`term-gp-btn${r.id === rangeId ? ' active' : ''}`}
              onClick={() => r.range && setRangeId(r.id)}
            >
              {r.id}
            </button>
          ))}
          <span className="term-gp-interval">Daily ▾</span>
        </div>
        {dateSpan ? <span className="term-gp-span">{dateSpan}</span> : null}
      </div>

      {/* Studies rail — GP's "Mov Avgs", generalized: add SMA/EMA overlays
          at a chosen period, each a removable chip. */}
      <div className="term-gp-studies">
        <span className="label">STUDIES</span>
        {studies.map((s) => (
          <span
            key={s.id}
            className="term-gp-chip"
            style={{ borderColor: s.color }}
          >
            <span className="swatch" style={{ background: s.color }} />
            {s.type} {s.period}
            <button type="button" onClick={() => removeStudy(s.id)} title="Remove">
              ×
            </button>
          </span>
        ))}
        {adding ? (
          <span className="term-gp-add">
            <select
              value={draftType}
              onChange={(e) => setDraftType(e.target.value)}
            >
              <option value="SMA">SMA</option>
              <option value="EMA">EMA</option>
            </select>
            <input
              type="number"
              min="1"
              max="400"
              value={draftPeriod}
              onChange={(e) => setDraftPeriod(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addStudy()}
            />
            <button type="button" onClick={addStudy}>
              Add
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              ×
            </button>
          </span>
        ) : studies.length < MAX_STUDIES ? (
          <button
            type="button"
            className="term-gp-addbtn"
            onClick={() => setAdding(true)}
          >
            + indicator
          </button>
        ) : null}
      </div>

      {loading && points.length === 0 ? (
        <div className="term-loading">Loading history…</div>
      ) : err ? (
        <div className="term-error">Error: {err}</div>
      ) : points.length === 0 ? (
        <div className="term-loading">No history.</div>
      ) : (
        <div className="term-gp-chartwrap">
          {/* Floating legend — GP's top-left readout. */}
          {stats ? (
            <div className="term-gp-legend">
              <div>
                <span className="k">Last Price</span>
                <span className="v">{fmt.px(stats.liveLast)}</span>
              </div>
              <div>
                <span className="k">High on {fmt.date(stats.highT)}</span>
                <span className="v">{fmt.px(stats.high)}</span>
              </div>
              <div>
                <span className="k">Average</span>
                <span className="v">{fmt.px(stats.avg)}</span>
              </div>
              <div>
                <span className="k">Low on {fmt.date(stats.lowT)}</span>
                <span className="v">{fmt.px(stats.low)}</span>
              </div>
            </div>
          ) : null}

          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="gpFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--gp-area)" stopOpacity={0.45} />
                  <stop
                    offset="100%"
                    stopColor="var(--gp-area)"
                    stopOpacity={0.02}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="var(--term-border)"
                strokeOpacity={0.5}
                vertical={false}
              />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={formatTick}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                minTickGap={48}
              />
              <YAxis
                orientation="right"
                domain={['auto', 'auto']}
                tick={{ fill: 'var(--term-fg-dim)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--term-border)' }}
                tickLine={{ stroke: 'var(--term-border)' }}
                width={54}
                tickFormatter={(v) => Number(v).toFixed(0)}
              />
              <Tooltip content={<GpTooltip studies={studies} />} />
              <Area
                type="monotone"
                dataKey="close"
                name="Price"
                stroke="var(--gp-line)"
                strokeWidth={1.4}
                fill="url(#gpFill)"
                dot={false}
                isAnimationActive={false}
                activeDot={{ r: 2.5, fill: 'var(--gp-line)' }}
              />
              {studies.map((s) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={`s_${s.id}`}
                  name={`${s.type} ${s.period}`}
                  stroke={s.color}
                  strokeWidth={1}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
              {stats ? (
                <ReferenceLine
                  y={stats.liveLast}
                  stroke="var(--gp-line)"
                  strokeDasharray="2 3"
                  strokeOpacity={0.6}
                  label={<PriceTag value={fmt.px(stats.liveLast)} />}
                />
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Hover readout: the full bar (O/H/L/C + Vol) plus any active studies,
// reading straight off the augmented point in the tooltip payload.
function GpTooltip({ active, payload, label, studies = [] }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="term-gp-tip">
      <div className="d">{fmt.date(label)}</div>
      <div className="ohlc">
        <span>O {fmt.px(p.open)}</span>
        <span>H {fmt.px(p.high)}</span>
        <span>L {fmt.px(p.low)}</span>
        <span>C {fmt.px(p.close)}</span>
      </div>
      {p.volume != null ? <div className="vol">Vol {fmt.big(p.volume)}</div> : null}
      {studies.map((s) => (
        <div key={s.id} className="st" style={{ color: s.color }}>
          {s.type} {s.period}: {fmt.px(p[`s_${s.id}`])}
        </div>
      ))}
    </div>
  );
}

// The right-edge price flag on the last-price reference line. Recharts
// hands the line's plot-area viewBox; we hug the right edge and center
// the label on the line so it reads like GP's white price tab.
function PriceTag({ viewBox, value }) {
  if (!viewBox) return null;
  const { x, y, width } = viewBox;
  const w = 50;
  const h = 15;
  const tx = x + width - w;
  return (
    <g>
      <rect x={tx} y={y - h / 2} width={w} height={h} fill="var(--gp-line)" />
      <text
        x={tx + w / 2}
        y={y + 3.5}
        textAnchor="middle"
        fontSize="10"
        fontWeight="700"
        fill="#0a0a08"
      >
        {value}
      </text>
    </g>
  );
}
