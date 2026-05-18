import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// DES — company description: live quote + fundamentals + business summary + AI brief.
// Reuses /api/holdings/info/:ticker (already exists, finnhub-shaped).

const fmt = {
  price: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`),
  abs: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`),
  bigMoney: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    return n.toLocaleString();
  },
  ratio: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  range: (lo, hi) => {
    if (lo == null && hi == null) return '—';
    return `${fmt.price(lo)} – ${fmt.price(hi)}`;
  },
};

export default function Description({ ticker }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setInfo(null);
    setBrief('');
    api
      .get(`/holdings/info/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        if (cancelled) return;
        setInfo(data);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  // LAST goes live while DES is open. The on-mount /holdings/info call
  // above still owns name, fundamentals, the 52w range and the summary
  // (it's also what paints the price on the very first frame, before
  // this poller's first tick lands); here we just keep the quote fresh.
  // Same source as DES has always used — Finnhub's real-time /quote —
  // but refreshed on the shared while-visible cadence instead of once.
  const sym = ticker ? ticker.toUpperCase() : '';
  const { data: liveQuotes } = useLiveRefresh(
    async () => {
      const { data } = await api.get('/terminal/quotes', {
        params: { tickers: sym },
      });
      return data;
    },
    { enabled: !!sym }
  );

  useEffect(() => {
    if (!info || !ticker) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = [
      `Name: ${info.name || ticker}`,
      info.sector ? `Sector: ${info.sector}` : null,
      info.price != null ? `Price: $${fmt.price(info.price)}` : null,
      info.previousClose != null ? `Prev close: $${fmt.price(info.previousClose)}` : null,
      info.marketCap != null ? `Market cap: $${fmt.bigMoney(info.marketCap)}` : null,
      info.trailingPE != null ? `P/E: ${fmt.ratio(info.trailingPE)}` : null,
      info.dividendYield != null ? `Dividend yield: ${(info.dividendYield * 100).toFixed(2)}%` : null,
      info.fiftyTwoWeekLow != null ? `52w range: $${fmt.price(info.fiftyTwoWeekLow)} – $${fmt.price(info.fiftyTwoWeekHigh)}` : null,
      info.summary ? `Business: ${info.summary.slice(0, 1200)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'DES', context })
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
  }, [info, ticker]);

  if (!ticker) {
    return <div className="term-panel"><div className="term-loading">Enter a ticker to load DES.</div></div>;
  }
  if (loading) {
    return <div className="term-panel"><div className="term-loading">Loading {ticker}…</div></div>;
  }
  if (err) {
    return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  }
  if (!info) return null;

  // Prefer the live quote, fall back to the on-mount snapshot. The hook
  // keeps the last good payload across a failed poll, so a dropped
  // refresh leaves the panel on its last fresh number rather than
  // snapping back; until the first tick lands we show the mount price,
  // never a blank. A null entry (Finnhub miss for this name) also falls
  // through to the snapshot. prevClose comes live too so Chg / Chg %
  // stay internally consistent with whichever LAST we're showing.
  const liveQ = sym && liveQuotes ? liveQuotes[sym] : null;
  const last = liveQ?.last != null ? liveQ.last : info.price;
  const prev = liveQ?.prevClose != null ? liveQ.prevClose : info.previousClose;
  const chg = last != null && prev != null ? last - prev : null;
  const chgPct = chg != null && prev ? chg / prev : null;
  const chgClass = chg == null ? '' : chg >= 0 ? 'pos' : 'neg';

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">{info.name || '—'}</span>
      </div>

      <div className="term-stat-grid">
        <Stat label="Last" value={fmt.price(last)} cls="" flashValue={last} />
        <Stat label="Chg" value={fmt.abs(chg)} cls={chgClass} />
        <Stat label="Chg %" value={fmt.pct(chgPct)} cls={chgClass} />
        <Stat label="Prev Close" value={fmt.price(prev)} />
        <Stat label="Day Range" value={fmt.range(info.dayLow, info.dayHigh)} />
        <Stat label="52W Range" value={fmt.range(info.fiftyTwoWeekLow, info.fiftyTwoWeekHigh)} />
        <Stat label="Mkt Cap" value={fmt.bigMoney(info.marketCap)} />
        <Stat label="P/E" value={fmt.ratio(info.trailingPE)} />
        <Stat label="Fwd P/E" value={fmt.ratio(info.forwardPE)} />
        <Stat label="Div Yield" value={info.dividendYield != null ? fmt.pct(info.dividendYield) : '—'} />
        <Stat label="Beta" value={fmt.ratio(info.beta)} />
        <Stat label="Sector" value={info.sector || '—'} />
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {info.summary ? (
        <div style={{ fontSize: 12, color: 'var(--term-white)', lineHeight: 1.5 }}>
          {info.summary}
        </div>
      ) : null}
    </div>
  );
}

// `flashValue`, when passed, is the live numeric this stat should
// tick-flash on (only the Last stat opts in — the rest render exactly
// as before). The flash wraps the already-formatted value *inside* the
// term-stat-value span, so the label/value layout, the pos/neg color
// class and the text itself are all undisturbed; it just adds the
// transient background pulse around the same number. `flashValue ===
// undefined` is the no-flash path, distinct from a real but null price
// (FlashPrice/usePriceFlash treat non-finite as "no tick" anyway).
function Stat({ label, value, cls = '', flashValue }) {
  return (
    <div className="term-stat">
      <span className="term-stat-label">{label}</span>
      <span className={`term-stat-value ${cls}`}>
        {flashValue === undefined ? (
          value
        ) : (
          <FlashPrice value={flashValue}>{value}</FlashPrice>
        )}
      </span>
    </div>
  );
}
