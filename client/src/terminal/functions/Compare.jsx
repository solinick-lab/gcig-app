import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// CMP — 2–4 tickers side by side. The panel owns its own ticker set
// (an input + removable chips, deduped/uppercased, capped at 4); slot
// one is seeded from the workspace ticker when the pane is opened on a
// focused name, otherwise the set starts empty. Fundamentals come from
// /terminal/compare (one getPeerSnapshot per ticker — the same bundle
// PEER shows); LAST and DAY % go live off /terminal/quotes via the
// shared poller, rendered through FlashPrice exactly like Peers/Movers.
// Mirrors the sibling panels: fetch, then hand the loaded grid to the
// shared /annotate AI brief — but only once at least two tickers
// actually resolve, so the model is never asked to compare a single
// name or thin air (confab-safe).

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

// The metric rows, top to bottom: the live pair first (Price flashes,
// Day % colours pos/neg), then the ~15m fundamentals snapshot. `live`
// marks the two cells the quote poll overlays so the rest can render
// straight from the snapshot row.
const ROWS = [
  { key: 'price', label: 'Price', live: true },
  { key: 'changePct', label: 'Day %', live: true },
  { key: 'marketCap', label: 'Mkt Cap' },
  { key: 'peRatio', label: 'P/E' },
  { key: 'forwardPE', label: 'Fwd P/E' },
  { key: 'dividendYield', label: 'Div' },
  { key: 'beta', label: 'Beta' },
];

const MAX_TICKERS = 4;
const isTicker = (s) => /^[A-Z][A-Z0-9.\-]{0,11}$/.test(s);

export default function Compare({ ticker, onOpen }) {
  // Seed slot one from the workspace ticker when the pane opened on a
  // focused name; otherwise the user builds the set from empty. This
  // is an initial-state seed only — later changes to the set are the
  // user's, the workspace ticker does not keep reaching in.
  const [tickers, setTickers] = useState(() => {
    const seed = String(ticker || '').trim().toUpperCase();
    return seed && isTicker(seed) ? [seed] : [];
  });
  const [input, setInput] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  // A stable comma key so effects and the live poll only re-fire when
  // the set actually changes, not on every parent re-render.
  const setKey = tickers.join(',');

  const addTicker = () => {
    const t = input.trim().toUpperCase();
    setInput('');
    if (!t || !isTicker(t)) return;
    setTickers((prev) =>
      prev.includes(t) || prev.length >= MAX_TICKERS ? prev : [...prev, t]
    );
  };
  const removeTicker = (t) =>
    setTickers((prev) => prev.filter((x) => x !== t));

  // Fundamentals snapshot for the whole set in one call. Re-fetched
  // whenever the set changes; the cancelled guard drops a response
  // that lands after the set moved on (or the pane unmounted) so a
  // stale set never paints over a newer one.
  useEffect(() => {
    if (tickers.length === 0) {
      setData(null);
      setErr(null);
      setBrief('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get('/terminal/compare', { params: { tickers: setKey } })
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
  }, [setKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // LAST and DAY % go live for the whole set while CMP is open; every
  // other row stays the snapshot the rows loaded with. The set is
  // already stored upper-cased and deduped on every add, so setKey is
  // itself the comma list the quote tap wants — no second normalize.
  // Disabled until the set is non-empty, and (via the hook) only
  // polling while mounted and the tab is visible. A failed poll keeps
  // the last good quotes rather than wiping the columns.
  const { data: liveQuotes } = useLiveRefresh(
    async () => {
      if (!setKey) return {};
      const { data: q } = await api.get('/terminal/quotes', {
        params: { tickers: setKey },
      });
      return q;
    },
    { enabled: tickers.length > 0 }
  );

  // Overlay the live tap onto the snapshot rows: live LAST and DAY %
  // win when present, the snapshot/null value stands in otherwise (no
  // live tick yet, or a Finnhub miss) so a cell never blanks something
  // it was already showing. Everything else on the column is left
  // exactly as the fundamentals snapshot loaded it. One column object
  // per requested ticker — a snapshot miss is a column of "—", not a
  // dropped name (the server already returns a null-field row).
  //
  // Units: /terminal/quotes' changePct is Finnhub's `dp`, already a
  // percent (1.23 == +1.23%), while the snapshot row and fmt.pct here
  // speak the fraction convention (0.0123 == +1.23%, fmt.pct does the
  // ×100). We divide the live changePct by 100 to land in that
  // convention; there is no snapshot fallback for these two cells
  // (/compare carries only the slow fundamentals) so a name shows "—"
  // until its first live tick. Mirrors MOVR/PEER exactly.
  const cols = useMemo(() => {
    const rowByTicker = new Map(
      (data?.rows || []).map((r) => [String(r.ticker).toUpperCase(), r])
    );
    return tickers.map((t) => {
      const r = rowByTicker.get(t) || { ticker: t };
      const q = liveQuotes ? liveQuotes[t] : null;
      return {
        ticker: t,
        name: r.name ?? null,
        price: q && q.last != null ? q.last : null,
        changePct: q && q.changePct != null ? q.changePct / 100 : null,
        marketCap: r.marketCap ?? null,
        peRatio: r.peRatio ?? null,
        forwardPE: r.forwardPE ?? null,
        dividendYield: r.dividendYield ?? null,
        beta: r.beta ?? null,
      };
    });
  }, [tickers, data, liveQuotes]);

  // A column is "resolvable" once its snapshot row carried any
  // fundamental or a name — i.e. the server didn't hand back an
  // all-null miss. The AI brief only fires with two or more such
  // columns; one (or none) is nothing to compare and would invite a
  // fabricated read. Mirrors the empty-data guards on EARN/CON/FIL.
  const resolvable = useMemo(
    () =>
      cols.filter(
        (c) =>
          c.name != null ||
          c.marketCap != null ||
          c.peRatio != null ||
          c.forwardPE != null ||
          c.dividendYield != null ||
          c.beta != null
      ),
    [cols]
  );

  // Confab-safe brief: only when the loaded snapshot resolves ≥2
  // tickers. Keyed off the snapshot (`data`), not the live quotes, so
  // it fires once per set load rather than on every 20s price tick.
  const briefRanForRef = useRef('');
  useEffect(() => {
    if (!data || resolvable.length < 2) {
      setBrief('');
      return;
    }
    if (briefRanForRef.current === setKey) return;
    briefRanForRef.current = setKey;
    let cancelled = false;
    setBriefLoading(true);
    const context = [
      `Head-to-head comparison of ${resolvable.length} tickers:`,
      ...resolvable.map(
        (c) =>
          `${c.ticker}${c.name ? ` (${c.name})` : ''}: ` +
          `mktcap ${fmt.cap(c.marketCap)}, P/E ${fmt.ratio(c.peRatio)}, ` +
          `fwd P/E ${fmt.ratio(c.forwardPE)}, div ${fmt.pct(c.dividendYield)}, ` +
          `beta ${fmt.ratio(c.beta)}`
      ),
    ].join('\n');
    api
      .post('/terminal/annotate', { function: 'CMP', context })
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
  }, [data, resolvable, setKey]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTicker();
    }
  };

  const cell = (c, row) => {
    if (row.key === 'price') {
      return (
        <FlashPrice value={c.price}>{fmt.px(c.price)}</FlashPrice>
      );
    }
    if (row.key === 'changePct') {
      return fmt.pct(c.changePct);
    }
    if (row.key === 'marketCap') return fmt.cap(c.marketCap);
    if (row.key === 'dividendYield') return fmt.pct(c.dividendYield);
    return fmt.ratio(c[row.key]);
  };

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">CMP</span>
        <span className="name">
          Compare{tickers.length ? ` · ${tickers.length} of ${MAX_TICKERS}` : ''}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {tickers.map((t) => (
          <span
            key={t}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: '1px solid var(--term-border)',
              padding: '2px 6px',
              fontSize: 12,
            }}
          >
            <span style={{ color: 'var(--term-white)' }}>{t}</span>
            <button
              type="button"
              onClick={() => removeTicker(t)}
              title={`Remove ${t}`}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--term-fg-muted)',
                cursor: 'pointer',
                padding: 0,
                fontSize: 12,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {tickers.length < MAX_TICKERS ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Add ticker"
              maxLength={12}
              style={{
                background: 'var(--term-bg)',
                border: '1px solid var(--term-border)',
                color: 'var(--term-fg)',
                padding: '2px 6px',
                fontSize: 12,
                width: 100,
                fontFamily: 'inherit',
              }}
            />
            <button
              type="button"
              onClick={addTicker}
              style={{
                background: 'none',
                border: '1px solid var(--term-border)',
                color: 'var(--term-fg)',
                cursor: 'pointer',
                padding: '2px 8px',
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            >
              Add
            </button>
          </span>
        ) : null}
      </div>

      {tickers.length === 0 ? (
        <div className="term-loading">
          Add 2–4 tickers to compare them side by side.
        </div>
      ) : null}

      {tickers.length > 0 && loading && !data ? (
        <div className="term-loading">
          Loading fundamentals for {tickers.join(', ')}…
        </div>
      ) : null}

      {err ? <div className="term-error">Error: {err}</div> : null}

      {tickers.length > 0 ? (
        <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
          <span className="label">◢ AI BRIEF</span>
          {briefLoading
            ? 'Generating…'
            : resolvable.length >= 2
            ? brief || 'No brief available.'
            : 'Add 2–4 tickers to compare.'}
        </div>
      ) : null}

      {tickers.length > 0 && (data || !loading) ? (
        <table className="term-table">
          <thead>
            <tr>
              <th>Metric</th>
              {cols.map((c) => (
                <th
                  key={c.ticker}
                  className="num term-row-link"
                  onClick={() => onOpen?.({ ticker: c.ticker, fn: 'DES' })}
                  title={`Open ${c.ticker} DES`}
                  style={{ cursor: 'pointer' }}
                >
                  {c.ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.key}>
                <td className="sym">{row.label}</td>
                {cols.map((c) => {
                  const neg =
                    row.key === 'changePct' &&
                    c.changePct != null &&
                    c.changePct < 0;
                  const pos =
                    row.key === 'changePct' &&
                    c.changePct != null &&
                    c.changePct >= 0;
                  return (
                    <td
                      key={c.ticker}
                      className={`num ${pos ? 'pos' : ''} ${neg ? 'neg' : ''}`.trim()}
                    >
                      {cell(c, row)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Up to 4 tickers · Price & Day % refresh live (~20s) while this
        panel is open; Mkt Cap / P/E / Div / Beta are a ~15m
        fundamentals snapshot. Click any ticker header to open its DES.
      </div>
    </div>
  );
}
