import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// ICLUSTER — multi-insider open-market buy clusters across the book.
// No ticker input; the server builds the universe (holdings + an
// optional watchlist) and the scanner ranks the qualifying clusters
// (≥3 distinct insiders, 60d, code P, role-weighted score, into-
// weakness flag). The panel renders the ranked candidates, hands the
// list to /annotate for the AI brief (confab-safe: empty results
// suppresses the call), and always shows the methodology footer.
//
// This is the analytic-layer panel: it stands or falls on the
// honesty framing. The footer below carries the spec's "screen, not
// a backtested signal" line so the surface never overstates itself.

const fmt = {
  // Compact dollar bucket: 1.2K / 4.6M / 230K, with no decimals on
  // the lower buckets — clutters the column otherwise.
  dollars: (v) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
    return `${sign}$${a.toFixed(0)}`;
  },
  // Score is dollar-weighted by role bucket; same compact bucket. It
  // isn't dollars per se, but the magnitude is dollar-scaled.
  score: (v) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
  },
  // ISO yyyy-mm-dd → MM/DD/YY. Pin to local midnight so we don't
  // slip a day west of UTC; same guard the sibling panels use.
  date: (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return '—';
    return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
  },
};

export default function InsiderClusters({ onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setBrief('');
    api
      .get('/terminal/insider-clusters')
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

  // Confab-safe guard: with zero qualifying clusters there is nothing
  // for the model to ground on, so we never call /annotate — the
  // empty-state line below stands alone. Mirrors the empty-data
  // guards on Filings/Earnings/Consensus.
  useEffect(() => {
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) return;
    let cancelled = false;
    setBriefLoading(true);
    const lines = [
      `Universe: ${data.universe?.length ?? 0} tickers · window: 60d`,
      'Ranked clusters (score = Σ role-weight × $; descending):',
      ...results.slice(0, 20).map(
        (r) =>
          `${r.ticker} — ${r.insiderCount} insiders, ${fmt.dollars(r.totalDollars)} total ` +
          `(score ${fmt.score(r.score)}), top: ${r.topInsider || 'n/a'}, ` +
          `latest ${fmt.date(r.latestBuyAt)}, ` +
          `into-weakness: ${r.intoWeakness === true ? 'yes' : r.intoWeakness === false ? 'no' : 'unknown'}`
      ),
    ];
    api
      .post('/terminal/annotate', {
        function: 'ICLUSTER',
        context: lines.join('\n'),
      })
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

  // Enter/Space activate the clickable row, matching the role="button"
  // rows in Movers/Peers. Space is preventDefault'd so the panel
  // doesn't scroll out from under the opening DES pane.
  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Scanning the book for insider clusters…</div>
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

  const results = Array.isArray(data.results) ? data.results : [];
  const universe = Array.isArray(data.universe) ? data.universe : [];

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">ICLUSTER</span>
        <span className="name">
          Insider Clusters · n={universe.length}
          {results.length ? ` · ${results.length} hit${results.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {results.length === 0 ? (
        <div className="term-loading">
          No qualifying clusters in the current universe (n={universe.length} holdings, last 60d).
          Threshold is ≥3 distinct insider open-market purchases per name;
          single-insider accumulation and option exercises don't count.
        </div>
      ) : (
        <>
          <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
            <span className="label">◢ AI BRIEF</span>
            {briefLoading ? 'Generating…' : brief || 'No brief available.'}
          </div>

          <table className="term-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th className="num">#Insiders</th>
                <th className="num">Total $</th>
                <th className="num">Score</th>
                <th>Latest Buy</th>
                <th>Into Weakness?</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr
                  key={r.ticker}
                  className="term-row-link"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen?.({ ticker: r.ticker, fn: 'DES' })}
                  onKeyDown={rowKey(() => onOpen?.({ ticker: r.ticker, fn: 'DES' }))}
                  title={`Open ${r.ticker} DES`}
                >
                  <td className="sym" title={r.topInsider || ''}>{r.ticker}</td>
                  <td className="num">{r.insiderCount}</td>
                  <td className="num">{fmt.dollars(r.totalDollars)}</td>
                  <td className="num">{fmt.score(r.score)}</td>
                  <td>{fmt.date(r.latestBuyAt)}</td>
                  <td className={r.intoWeakness === true ? 'pos' : ''}>
                    {r.intoWeakness === true ? 'yes' : r.intoWeakness === false ? 'no' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Universe: your holdings (n={universe.length}). Window: 60d.
        Threshold: ≥3 distinct insider open-market purchases (Form 4
        code P; exercises excluded). Weights: Officer 1.0 · Director
        0.6 · 10%-Owner 0.3. Source: SEC Form 4 via the existing
        Finnhub-primary / SEC-fallback fetcher.{' '}
        <strong>
          Screen, not a backtested signal — use as evidence within a
          fundamentals thesis, not a standalone trade trigger.
        </strong>
      </div>
    </div>
  );
}
