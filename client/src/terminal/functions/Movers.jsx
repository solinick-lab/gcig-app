import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// MOVR — every holding in the book and how much it's up or down today.
// The holdings *list* (which tickers, the order, cash-exclusion, the
// "N holdings" header) is the positions sheet's call and stays that
// way — it's the system of record. Only the price columns go live:
// LAST and DAY % refresh off Finnhub's real-time /quote while the
// panel is open, so the prices aren't the sheet's 20–40m-stale
// GOOGLEFINANCE read. No ticker input. Mirrors DES/CN: fetch, then
// hand the list to the shared /annotate AI brief.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
};

export default function Movers({ onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get('/terminal/movers')
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
  }, []);

  useEffect(() => {
    if (!data?.rows?.length) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = [
      `Griffin Fund portfolio, as of ${data.asOf || 'n/a'} — ${data.count} holdings, today's move:`,
      ...data.rows.map((m) => `${m.ticker} ${fmt.pct(m.changePct)}`),
    ].join('\n');
    api
      .post('/terminal/annotate', { function: 'MOVR', context })
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

  // The held set: every ticker the sheet returned, upper-cased and
  // de-duped into a stable comma list so the poll only re-keys when
  // the book actually changes, not on every parent re-render. This is
  // strictly the price tap — it does not touch which names are in the
  // list or their order; that stays the sheet's.
  const liveTickers = useMemo(
    () => [
      ...new Set(
        (data?.rows || []).map((m) => String(m.ticker).toUpperCase())
      ),
    ],
    [data]
  );
  const liveKey = liveTickers.join(',');

  // LAST and DAY % go live for the held names while MOVR is open.
  // Disabled until the sheet has handed us a non-empty book, and (via
  // the hook) only polling while the pane is mounted and the tab is
  // visible. A failed poll keeps the last good quotes rather than
  // wiping the panel back to nothing.
  const { data: liveQuotes } = useLiveRefresh(
    async () => {
      if (!liveKey) return {};
      const { data: q } = await api.get('/terminal/quotes', {
        params: { tickers: liveKey },
      });
      return q;
    },
    { enabled: liveTickers.length > 0 }
  );

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading portfolio…</div>
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

  // Overlay the live tap onto the sheet rows in place — the array
  // order, the rank/# column, and cash-exclusion are all the sheet's
  // and are left exactly as they came. For each held name, the live
  // LAST and DAY % win when we have a quote; the sheet's value stands
  // in when there's no live tick yet or Finnhub missed the symbol, so
  // a price cell never blanks something it was already showing.
  //
  // Units: /terminal/quotes' changePct is Finnhub's `dp`, already a
  // percent (1.23 == +1.23%), while the row model and fmt.pct here
  // speak the sheet's fraction convention (0.0123 == +1.23%, fmt.pct
  // does the ×100). We use the live changePct directly — just divided
  // by 100 to land in that convention — never recomputed from the
  // stale sheet move.
  const rows = (data.rows || []).map((m) => {
    const q = liveQuotes ? liveQuotes[String(m.ticker).toUpperCase()] : null;
    if (!q) return m;
    return {
      ...m,
      last: q.last != null ? q.last : m.last,
      changePct: q.changePct != null ? q.changePct / 100 : m.changePct,
    };
  });

  // Enter/Space activate a clickable row, matching the app's existing
  // role="button" rows (see AiChat). Space is preventDefault'd so the
  // panel doesn't scroll out from under the opening DES pane.
  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">MOVR</span>
        <span className="name">
          Portfolio{data.asOf ? ` · as of ${data.asOf}` : ''}
          {data.count ? ` · ${data.count} holdings` : ''}
        </span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {rows.length === 0 ? (
        <div className="term-loading">
          No daily moves on the book — the positions sheet returned no non-cash
          holdings with a day change.
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th style={{ width: 22 }}>#</th>
              <th>Ticker</th>
              <th className="num">Last</th>
              <th className="num">Day %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr
                key={m.ticker}
                className="term-row-link"
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.({ ticker: m.ticker, fn: 'DES' })}
                onKeyDown={rowKey(() => onOpen?.({ ticker: m.ticker, fn: 'DES' }))}
                title={`Open ${m.ticker} DES`}
              >
                <td className="rank">{i + 1}</td>
                <td className="sym" title={m.name}>{m.ticker}</td>
                <td className="num">
                  <FlashPrice value={m.last}>{fmt.px(m.last)}</FlashPrice>
                </td>
                <td className={`num ${m.changePct >= 0 ? 'pos' : 'neg'}`}>
                  {fmt.pct(m.changePct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Griffin Fund holdings · list from the positions sheet, prices live (~20s)
        while this panel is open. Cash excluded · click any row to open
        its DES.
      </div>
    </div>
  );
}
