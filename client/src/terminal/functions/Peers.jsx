import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// PEER — sector peer comparison. Finnhub's peer set for the focused
// ticker plus a compact fundamentals snapshot per name, with the
// focus row pinned on top and highlighted. Requires a ticker. Mirrors
// DES/CN: fetch, then hand the grid to the shared /annotate AI brief.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
  ratio: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(1)),
  cap: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
    return n.toLocaleString();
  },
};

export default function Peers({ ticker, onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setBrief('');
    api
      .get(`/terminal/peers/${encodeURIComponent(ticker)}`)
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
  }, [ticker]);

  useEffect(() => {
    if (!data?.rows?.length) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = [
      `Peer comparison for ${data.ticker} (${data.count} peers):`,
      ...data.rows.map(
        (r) =>
          `${r.ticker}${r.isFocus ? ' [focus]' : ''}: px ${fmt.px(r.price)} ` +
          `(${fmt.pct(r.changePct)}), mktcap ${fmt.cap(r.marketCap)}, ` +
          `P/E ${fmt.ratio(r.trailingPE)}, fwd ${fmt.ratio(r.forwardPE)}, ` +
          `div ${fmt.pct(r.dividendYield)}, beta ${fmt.ratio(r.beta)}`
      ),
    ].join('\n');
    api
      .post('/terminal/annotate', { ticker: data.ticker, function: 'PEER', context })
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
  }, [data]);

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load peers.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading peers for {ticker.toUpperCase()}…</div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }
  if (!data) return null;

  const rows = data.rows || [];

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{data.ticker}</span>
        <span className="name">
          Peers{data.count ? ` · ${data.count} comparables` : ''}
        </span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {data.count === 0 ? (
        <div className="term-loading">
          Finnhub has no peer set for {data.ticker} — common for ETFs, funds,
          and thinly-covered names. Showing {data.ticker} alone.
        </div>
      ) : null}

      {rows.length === 0 ? null : (
        <table className="term-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th className="num">Last</th>
              <th className="num">Chg %</th>
              <th className="num">Mkt Cap</th>
              <th className="num">P/E</th>
              <th className="num">Fwd P/E</th>
              <th className="num">Div</th>
              <th className="num">Beta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.ticker}
                className={`term-row-link${r.isFocus ? ' focus' : ''}`}
                onClick={() => onOpen?.({ ticker: r.ticker, fn: 'DES' })}
                title={`Open ${r.ticker} DES`}
              >
                <td className="sym">
                  {r.ticker}
                  {r.name ? <span className="peer-name">{r.name}</span> : null}
                </td>
                <td className="num">{fmt.px(r.price)}</td>
                <td className={`num ${r.changePct == null ? '' : r.changePct >= 0 ? 'pos' : 'neg'}`}>
                  {fmt.pct(r.changePct)}
                </td>
                <td className="num">{fmt.cap(r.marketCap)}</td>
                <td className="num">{fmt.ratio(r.trailingPE)}</td>
                <td className="num">{fmt.ratio(r.forwardPE)}</td>
                <td className="num">{fmt.pct(r.dividendYield)}</td>
                <td className="num">{fmt.ratio(r.beta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Finnhub peer set · fundamentals snapshot, 15m cache. Focus row
        highlighted · click any row to open its DES.
      </div>
    </div>
  );
}
