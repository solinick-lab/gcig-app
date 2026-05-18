import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';

// WEI — world equity indices. No ticker; the basket is fixed server-side
// (GET /api/terminal/indices) and grouped by region. Same shape as the
// other panels: load data, then ask the AI layer for a one-paragraph
// read of the tape.
//
// The endpoint, the basket, the row model and the rendering are all
// unchanged — the one difference from before is that the fetch is no
// longer mount-only. It now rides the shared while-visible poller, so
// the tape refreshes on the same ~20s cadence as the quote panels
// while WEI is open, and pauses the moment the pane is closed or the
// tab is hidden. WEI's source (Stooq + a Finnhub ETF proxy) is a
// free, delayed feed, so this is "refreshes while open", not real
// time — the footer says exactly that rather than claiming "LIVE".

const fmt = {
  level: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : Number(v).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
  chg: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`,
  pct: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
};

export default function WorldIndices() {
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  // Same /terminal/indices fetch as before, now on the shared poller.
  // The hook owns the immediate-then-interval run, the visibility
  // pause/resume, the unmount cancel, and keeping the last good tape
  // across a failed poll — so a dropped refresh leaves WEI on its
  // last numbers instead of blanking. enabled is always true: WEI has
  // no ticker gate, the visibility gate alone bounds the source.
  const {
    data,
    loading,
    error,
    lastUpdated,
  } = useLiveRefresh(async () => {
    const { data: payload } = await api.get('/terminal/indices');
    return payload;
  });

  // Surface an error only on a true first-paint failure (nothing good
  // ever loaded). Once a tape has rendered, the hook holds it and a
  // later failed poll must not flip the whole panel to an error state
  // — it just keeps showing the last good levels, same best-effort
  // contract as the rest of the terminal.
  const err =
    error && !data
      ? error.response?.data?.error || error.message || 'Failed to load'
      : null;

  // The AI brief is a one-shot read of the tape, not a per-tick
  // commentary. With the fetch now on the poller, `data` gets a fresh
  // identity every ~20s refresh; keying the brief off that alone
  // would re-hit /terminal/annotate (an LLM call) every cycle for the
  // life of the open pane. So we generate it once, on the first
  // non-empty tape — exactly the single call the old mount-only fetch
  // made — and let the price columns be what actually goes live. The
  // ref survives the poll-driven re-renders; it resets only on a true
  // remount (a fresh open of the pane).
  const briefDoneRef = useRef(false);
  useEffect(() => {
    if (!data?.rows?.length || briefDoneRef.current) return;
    briefDoneRef.current = true;
    let cancelled = false;
    setBriefLoading(true);
    const context = data.rows
      .map(
        (r) =>
          `${r.name} (${r.symbol}): ${fmt.level(r.last)} ${fmt.chg(r.change)} ${fmt.pct(r.changePercent)}`
      )
      .join('\n');
    api
      .post('/terminal/annotate', { function: 'WEI', context })
      .then(({ data: res }) => {
        if (!cancelled) setBrief(res.brief || '');
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

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading world indices…</div>
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

  const regions = (data.regions || []).filter((region) =>
    data.rows.some((r) => r.region === region)
  );
  const asOf = data.asOf ? new Date(data.asOf) : null;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">WEI</span>
        <span className="name">World Equity Indices</span>
        {asOf ? (
          <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
            {asOf.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        ) : null}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div>
        <div className="term-idx-head">
          <span>Index</span>
          <span>Last</span>
          <span>Chg</span>
          <span>Chg %</span>
        </div>
        {regions.map((region) => (
          <div key={region}>
            <div className="term-idx-region">{region}</div>
            {data.rows
              .filter((r) => r.region === region)
              .map((r) => {
                const cls =
                  r.change == null
                    ? ''
                    : r.change >= 0
                      ? 'pos'
                      : 'neg';
                return (
                  <div className="term-idx-row" key={r.name}>
                    <span className="name">
                      {r.name}
                      <span
                        className="sym"
                        title={
                          r.approx
                            ? `ETF proxy (${r.symbol}) — %-move tracks the index, level differs`
                            : r.symbol
                        }
                      >
                        {r.approx ? '≈ ' : ''}
                        {r.symbol}
                      </span>
                    </span>
                    <span className="num">{fmt.level(r.last)}</span>
                    <span className={`num ${cls}`}>{fmt.chg(r.change)}</span>
                    <span className={`num ${cls}`}>
                      {fmt.pct(r.changePercent)}
                    </span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Indices refresh while this panel is open (~20s); data is
        delayed by the free source (Stooq · Finnhub ETF proxy), not
        true real-time.
        {lastUpdated
          ? ` Updated ${new Date(lastUpdated).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}.`
          : ''}
      </div>
    </div>
  );
}
