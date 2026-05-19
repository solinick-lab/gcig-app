import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// EARN — a ticker's next scheduled report (date + EPS estimate) and a
// trailing EPS beat/miss record (estimate vs. actual + surprise %),
// off the same Finnhub /calendar/earnings feed PEER/holdings use.
// Requires a ticker. Mirrors DES/PEER/INSDR: fetch, then hand the
// loaded data to the shared /annotate AI brief — but skip the brief
// entirely when there's nothing to read (confab-safe).

// Earnings dates arrive as bare ISO days (YYYY-MM-DD). Parsing that
// straight through Date() reads it as UTC midnight, which slips a day
// back in any timezone west of UTC; pinning T00:00:00 (local) keeps
// the calendar day the panel shows the day Finnhub meant. Same guard
// the server's earningsPeriod uses.
function parseISODay(s) {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtDate = (s) => {
  const d = parseISODay(s);
  return d
    ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
    : '—';
};
const fmtLongDate = (s) => {
  const d = parseISODay(s);
  return d
    ? d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
};
// Whole calendar days from today to an ISO day, both pinned to local
// midnight so a partial day never reads as one off.
function daysUntil(s) {
  const d = parseISODay(s);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}
const fmtEps = (v) =>
  v == null || Number.isNaN(v) ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toFixed(2)}`;
const fmtSurprise = (v) =>
  v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

export default function Earnings({ ticker }) {
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
      .get(`/terminal/earnings/${encodeURIComponent(ticker)}`)
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

  // Confab-safe: with neither an upcoming report nor any history there
  // is nothing for the model to ground on, so we never call /annotate —
  // an honest "no earnings data" line stands instead of an invented
  // read. Mirrors the empty-data guards on the sibling panels.
  useEffect(() => {
    if (!data || !ticker) return;
    const hasData = data.upcoming || (data.history && data.history.length > 0);
    if (!hasData) return;
    let cancelled = false;
    setBriefLoading(true);
    const lines = [];
    if (data.upcoming) {
      const dleft = daysUntil(data.upcoming.date);
      lines.push(
        `Next report: ${fmtLongDate(data.upcoming.date)}` +
          (dleft != null && dleft >= 0 ? ` (in ${dleft} day${dleft === 1 ? '' : 's'})` : '') +
          ` · EPS est ${fmtEps(data.upcoming.epsEstimate)}`
      );
    } else {
      lines.push('Next report: not yet scheduled / no estimate.');
    }
    if (data.history && data.history.length) {
      lines.push('Trailing reports (newest first):');
      data.history.forEach((h) => {
        lines.push(
          `${h.period} (${fmtDate(h.date)}): est ${fmtEps(h.epsEstimate)}, ` +
            `act ${fmtEps(h.epsActual)}, surprise ${fmtSurprise(h.surprisePct)}`
        );
      });
    }
    api
      .post('/terminal/annotate', {
        ticker,
        function: 'EARN',
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
  }, [data, ticker]);

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load earnings.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading earnings for {ticker.toUpperCase()}…</div>
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

  const upcoming = data.upcoming || null;
  const history = Array.isArray(data.history) ? data.history : [];
  const hasData = upcoming || history.length > 0;
  const dleft = upcoming ? daysUntil(upcoming.date) : null;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{(data.ticker || ticker).toUpperCase()}</span>
        <span className="name">Earnings</span>
      </div>

      {!hasData ? (
        <div className="term-loading">
          No earnings data for {(data.ticker || ticker).toUpperCase()} — common
          for ETFs, funds, and thinly-covered names.
        </div>
      ) : (
        <>
          <div
            style={{
              border: '1px solid var(--term-border)',
              padding: '10px 12px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: 12,
            }}
          >
            <span style={{ color: 'var(--term-fg-dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Next Report
            </span>
            {upcoming ? (
              <>
                <span style={{ color: 'var(--term-white)', fontSize: 16 }}>
                  {fmtLongDate(upcoming.date)}
                </span>
                {dleft != null && dleft >= 0 ? (
                  <span style={{ color: 'var(--term-fg-dim)', fontSize: 12 }}>
                    in {dleft} day{dleft === 1 ? '' : 's'}
                  </span>
                ) : null}
                <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                  <span style={{ color: 'var(--term-fg-dim)' }}>EPS est </span>
                  <span style={{ color: 'var(--term-white)' }}>{fmtEps(upcoming.epsEstimate)}</span>
                </span>
              </>
            ) : (
              <span style={{ color: 'var(--term-fg-muted)', fontSize: 13 }}>
                Not yet scheduled.
              </span>
            )}
          </div>

          <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
            <span className="label">◢ AI BRIEF</span>
            {briefLoading ? 'Generating…' : brief || 'No brief available.'}
          </div>

          {history.length === 0 ? (
            <div className="term-loading">No reported quarters on file yet.</div>
          ) : (
            <table className="term-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Reported</th>
                  <th className="num">EPS Est</th>
                  <th className="num">EPS Act</th>
                  <th className="num">Surprise</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={`${h.date}-${i}`}>
                    <td className="sym">{h.period}</td>
                    <td>{fmtDate(h.date)}</td>
                    <td className="num">{fmtEps(h.epsEstimate)}</td>
                    <td className="num">{fmtEps(h.epsActual)}</td>
                    <td
                      className={`num ${
                        h.surprisePct == null ? '' : h.surprisePct >= 0 ? 'pos' : 'neg'
                      }`}
                    >
                      {fmtSurprise(h.surprisePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Finnhub earnings calendar · estimates vs. actuals, newest first ·
        12h cache. A green surprise is a beat, red a miss.
      </div>
    </div>
  );
}
