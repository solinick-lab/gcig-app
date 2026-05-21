import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// WX — Weather Impact. The historical playbook for US-landfall named
// storms vs. two curated baskets (Gulf O&G, P&C insurers), plus the
// best-effort NHC active-storm feed. The output is a historical
// playbook, not a forecast: forward returns are SPY-relative, the
// archive runs 2020-present, n is what it is. Mirrors EARN/FIL/CON:
// fetch, render the cards, hand the loaded data to /annotate for the
// AI brief — but skip the brief when there's nothing to read
// (confab-safe).

// Render a fraction as a signed percent with two decimals — the same
// quiet convention the other panels use. mean/median are tiny numbers
// (5d abnormal returns usually run in tens of bps), so the second
// decimal is the readable resolution.
const fmtPct = (v) =>
  v == null || Number.isNaN(v)
    ? '—'
    : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
const fmtTStat = (v) =>
  v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2);

// NHC's lastUpdate is an ISO timestamp; a compact MM/DD HH:mm reads
// well in a tight card without throwing on a missing string.
function fmtUpdated(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function WeatherImpact({ onOpen }) {
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
      .get('/terminal/weather-impact')
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

  // Confab-safe: no active storms AND every exposure with zero
  // observations means there's nothing for the model to ground on, so
  // we never call /annotate — the panel renders the historical-empty
  // states stand instead of inviting a fabricated brief. The same
  // posture EARN/FIL/CON take when their data set is empty.
  useEffect(() => {
    if (!data) return;
    const activeStorms = Array.isArray(data.activeStorms) ? data.activeStorms : [];
    const exposures = Array.isArray(data.exposures) ? data.exposures : [];
    const hasActive = activeStorms.length > 0;
    const hasStudy = exposures.some(
      (e) => (e.study?.perWindow?.['5d']?.n || 0) > 0
    );
    if (!hasActive && !hasStudy) return;
    let cancelled = false;
    setBriefLoading(true);
    const lines = [];
    if (hasActive) {
      lines.push('Active NHC storms:');
      activeStorms.forEach((s) => {
        lines.push(
          `  ${s.name || '—'} · ${s.classification || '—'} · ${
            s.intensity != null ? `${s.intensity} kt` : '—'
          } · updated ${fmtUpdated(s.lastUpdate)}`
        );
      });
    } else {
      lines.push('No active US-affecting tropical storms in the NHC feed.');
    }
    lines.push('');
    lines.push(
      'Historical playbook (US-landfall named storms 2020-present, SPY-relative forward returns):'
    );
    exposures.forEach((e) => {
      const w5 = e.study?.perWindow?.['5d'];
      if (!w5 || (w5.n || 0) === 0) {
        lines.push(`  ${e.exposure.label}: no observations in archive.`);
        return;
      }
      lines.push(
        `  ${e.exposure.label} · n=${w5.n} · 5d mean ${fmtPct(w5.mean)} ` +
          `(median ${fmtPct(w5.median)}, std ${fmtPct(w5.std)}, t=${fmtTStat(w5.tStat)})`
      );
      if (e.holdingsOverlap && e.holdingsOverlap.length > 0) {
        lines.push(`    your holdings: ${e.holdingsOverlap.join(', ')}`);
      }
    });
    api
      .post('/terminal/annotate', {
        function: 'WX',
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

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading weather impact…</div>
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

  const activeStorms = Array.isArray(data.activeStorms) ? data.activeStorms : [];
  const exposures = Array.isArray(data.exposures) ? data.exposures : [];

  // Total n across the archive, used in the footer. The fixture is
  // identical across baskets in v1 (one event type), so any exposure's
  // 5d n is the archive count after price-cache coverage; we surface
  // the gulf basket's n since it has the most price-history depth.
  const archiveN = exposures.reduce((max, e) => {
    const n = e.study?.perWindow?.['5d']?.n || 0;
    return Math.max(max, n);
  }, 0);

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">WX</span>
        <span className="name">Weather Impact · historical playbook</span>
      </div>

      {/* Section 1 — active storms. Compact card list, muted empty
          state when the NHC feed is dry (the common state outside of
          hurricane season). */}
      <div
        style={{
          border: '1px solid var(--term-border)',
          padding: '10px 12px',
        }}
      >
        <div
          style={{
            color: 'var(--term-fg-dim)',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 8,
          }}
        >
          Active Storms · NHC feed
        </div>
        {activeStorms.length === 0 ? (
          <div style={{ color: 'var(--term-fg-muted)', fontSize: 13 }}>
            No active US-affecting tropical activity in the NHC feed right now.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activeStorms.map((s, i) => (
              <div
                key={`${s.name || 'storm'}-${i}`}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  flexWrap: 'wrap',
                  fontSize: 13,
                }}
              >
                <span style={{ color: 'var(--term-white)' }}>{s.name || '—'}</span>
                <span style={{ color: 'var(--term-fg-dim)' }}>{s.classification || '—'}</span>
                <span style={{ color: 'var(--term-fg-dim)' }}>
                  {s.intensity != null ? `${s.intensity} kt` : '—'}
                </span>
                <span style={{ marginLeft: 'auto', color: 'var(--term-fg-muted)', fontSize: 11 }}>
                  updated {fmtUpdated(s.lastUpdate)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {/* Section 2 — historical playbook per exposure. One card per
          basket: heading, stats row (1d / 5d / 20d compactly), the
          rationale, and the user's holdings overlap as clickable
          chips. A chip click opens that ticker's DES. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {exposures.map((e) => {
          const w1 = e.study?.perWindow?.['1d'] || {};
          const w5 = e.study?.perWindow?.['5d'] || {};
          const w20 = e.study?.perWindow?.['20d'] || {};
          const overlap = Array.isArray(e.holdingsOverlap) ? e.holdingsOverlap : [];
          const tickers = Array.isArray(e.exposure?.tickers) ? e.exposure.tickers : [];
          return (
            <div
              key={e.exposure.id}
              style={{
                border: '1px solid var(--term-border)',
                padding: '10px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  marginBottom: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ color: 'var(--term-white)', fontSize: 14 }}>
                  {e.exposure.label}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    color: 'var(--term-fg-muted)',
                    fontSize: 11,
                  }}
                >
                  n={w5.n || 0} events
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px 18px',
                  marginBottom: 8,
                  fontSize: 12,
                }}
              >
                <span>
                  <span style={{ color: 'var(--term-fg-dim)' }}>1d </span>
                  <span
                    className={
                      (w1.mean || 0) >= 0 ? 'pos' : 'neg'
                    }
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {fmtPct(w1.mean)}
                  </span>
                </span>
                <span>
                  <span style={{ color: 'var(--term-fg-dim)' }}>5d </span>
                  <span
                    className={(w5.mean || 0) >= 0 ? 'pos' : 'neg'}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {fmtPct(w5.mean)}
                  </span>
                  <span style={{ color: 'var(--term-fg-muted)' }}>
                    {' '}
                    (med {fmtPct(w5.median)}, std {fmtPct(w5.std)}, t={fmtTStat(w5.tStat)})
                  </span>
                </span>
                <span>
                  <span style={{ color: 'var(--term-fg-dim)' }}>20d </span>
                  <span
                    className={(w20.mean || 0) >= 0 ? 'pos' : 'neg'}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {fmtPct(w20.mean)}
                  </span>
                </span>
              </div>

              {e.exposure.rationale ? (
                <div
                  style={{
                    color: 'var(--term-fg-muted)',
                    fontSize: 11,
                    marginBottom: 8,
                  }}
                >
                  {e.exposure.rationale}
                </div>
              ) : null}

              <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ color: 'var(--term-fg-dim)' }}>
                  Basket ({tickers.length}):
                </span>
                {tickers.map((t) => {
                  const held = overlap.includes(t.toUpperCase());
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => onOpen?.({ ticker: t, fn: 'DES' })}
                      title={`Open ${t} DES`}
                      style={{
                        background: 'transparent',
                        border: `1px solid ${
                          held ? 'var(--term-positive)' : 'var(--term-border)'
                        }`,
                        color: held ? 'var(--term-positive)' : 'var(--term-fg-dim)',
                        padding: '2px 6px',
                        fontSize: 11,
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        letterSpacing: 0.5,
                      }}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                <span style={{ color: 'var(--term-fg-dim)' }}>
                  Your holdings in this basket:{' '}
                </span>
                {overlap.length === 0 ? (
                  <span style={{ color: 'var(--term-fg-muted)' }}>
                    (none of your current holdings)
                  </span>
                ) : (
                  <span style={{ color: 'var(--term-positive)' }}>
                    {overlap.join(', ')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Archive: NHC HURDAT2 US-landfall named storms (2020-present, n=
        {archiveN}). Baskets curated in-repo (Gulf O&G: XOM/OXY/MRO/ET/EPD/KMI/CTRA;
        P&C: HIG/TRV/ALL/PGR/CB) with rationale. Forward returns are
        SPY-relative (sector-neutral). Window bounded by 5y price-bar
        cache. Historical playbook, not a forecast. Use as evidence
        within a thesis, not a standalone trade trigger.
      </div>
    </div>
  );
}
