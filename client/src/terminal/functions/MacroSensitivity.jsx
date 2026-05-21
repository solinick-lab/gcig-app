import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';

// MACRO — portfolio sensitivity to the five macro factors (10Y yield,
// WTI oil, USD index, VIX, SPY) over a 252-trading-day OLS. Five
// factor cards stacked vertically: per-factor portfolio β with sign,
// the default-shock scenario preview, top-3 contributing holdings as
// clickable chips (open the ticker's DES), and the muted-text
// methodology footer the design doc locks. Mirrors the WeatherImpact
// analytics-panel shape sub-project 2 shipped — methodology footer +
// confab-safe AI brief + ticker chips. No chart in v1; the panel is
// information-dense without one.

// Sign-aware percent / number formatters.
const signed = (n, opts = {}) => {
  if (n == null || Number.isNaN(n)) return '—';
  const { digits = 2, suffix = '' } = opts;
  const sign = n > 0 ? '+' : n < 0 ? '' : ''; // negative carries its own '-'
  return `${sign}${n.toFixed(digits)}${suffix}`;
};
const fmtBeta = (b) => (b == null || Number.isNaN(b) ? '—' : signed(b, { digits: 2 }));
const fmtPct = (n) => (n == null || Number.isNaN(n) ? '—' : signed(n * 100, { digits: 2, suffix: '%' }));
const fmtR2 = (r) => (r == null || Number.isNaN(r) ? '—' : r.toFixed(2));
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString());

// Render a factor's default-shock cue in the right unit. Yields move
// in basis points (Δ in pp × 100 = bps); VIX moves in points; prices
// move in percent. The expected book move is always a relative %.
function formatShock(factor) {
  const s = factor.defaultShock;
  if (!Number.isFinite(s)) return '—';
  if (factor.unit === 'bps') return `+${Math.round(s * 100)}bps`;
  if (factor.unit === 'pts') return `+${s.toFixed(0)}pts`;
  // 'percent' unit — defaultShock is the fractional move (0.10 = +10%).
  return `+${(s * 100).toFixed(0)}%`;
}

// expectedMove is the unitless relative book move (β × shock, where
// β has units of "book return per shock unit"). Render as a signed %.
function formatExpectedMove(factor) {
  const m = factor.scenario?.expectedMove;
  if (m == null || Number.isNaN(m)) return '—';
  return fmtPct(m);
}

export default function MacroSensitivity({ onOpen }) {
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
      .get('/terminal/macro-sensitivity')
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

  // anyData = at least one factor has a non-empty surviving set. If
  // nothing survives across all factors (typically the FRED_API_KEY-
  // unset case where every factor returns n=0), the AI brief would
  // have nothing to summarize — and the grounding rule would fire
  // "Data unavailable" — so we suppress the LLM call and surface the
  // honest empty-state line instead. Same confab-safe pattern Governance
  // uses when the proxy parse returns zero rows.
  const anyData = useMemo(() => {
    if (!data?.factors?.length) return false;
    return data.factors.some((f) => (f.surviving || []).length > 0);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    if (!anyData) {
      // FRED data unavailable or no holding has enough overlap — skip
      // annotate, render the honest empty-state line.
      setBriefLoading(false);
      setBrief(
        'FRED data unavailable (no FRED_API_KEY?) or no holding has 60 ' +
          'aligned observations — re-check after configuring or backfilling ' +
          'price bars.'
      );
      return;
    }
    let cancelled = false;
    setBriefLoading(true);
    // Build a compact, factual context for the model. Lead with the
    // portfolio β + signed scenario per factor, then the top 1–3
    // contributors. The grounding rule will keep the model from
    // inventing numbers we didn't send.
    const lines = [];
    lines.push(
      `Portfolio macro sensitivity (252-day OLS, ${data.holdings.length} non-cash holdings).`
    );
    for (const f of data.factors) {
      if (!f.surviving?.length) {
        lines.push(
          `${f.label}: insufficient overlap (no holding cleared n≥60).`
        );
        continue;
      }
      const shock = formatShock(f);
      const move = formatExpectedMove(f);
      const contrib = (f.topContributors || [])
        .slice(0, 3)
        .map((c) => `${c.ticker} β=${fmtBeta(c.beta)}`)
        .join(', ');
      // Average R² across surviving tickers is a useful single number
      // for "how predictive past sensitivity has been"; the model
      // doesn't need every per-ticker R² to talk usefully about the
      // factor.
      const survRows = f.perTicker.filter((p) => p.n >= 60);
      const avgR2 =
        survRows.length === 0
          ? null
          : survRows.reduce((s, r) => s + (r.rSquared || 0), 0) / survRows.length;
      const nUniverse = survRows.length;
      lines.push(
        `${f.label}: portfolio β = ${fmtBeta(f.portfolioBeta)} · scenario ` +
          `${shock} → book ${move} · top contributors ${contrib || '—'} · ` +
          `avg R² ${fmtR2(avgR2)} · n=${nUniverse} survivors`
      );
    }
    const context = lines.join('\n');
    api
      .post('/terminal/annotate', { function: 'MACRO', context })
      .then(({ data: r }) => {
        if (!cancelled) setBrief(r.brief || '');
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
  }, [data, anyData]);

  // Enter/Space activate a chip, matching the app's role="button"
  // rows convention.
  const chipKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Computing portfolio sensitivities…</div>
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

  const holdingsCount = data.holdings?.length || 0;
  const factors = data.factors || [];

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">MACRO</span>
        <span className="name">
          Portfolio factor sensitivity · 252-day OLS · {holdingsCount} non-cash holdings
        </span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {factors.length === 0 ? (
        <div className="term-loading">
          No factor data — FRED may be unconfigured, or the portfolio could not be read.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {factors.map((f) => {
            const survCount = (f.surviving || []).length;
            const excluded = holdingsCount - survCount;
            const pb = f.portfolioBeta;
            const move = f.scenario?.expectedMove ?? 0;
            const moveColor =
              move > 0 ? 'var(--term-positive)' : move < 0 ? 'var(--term-negative)' : 'var(--term-fg-dim)';
            return (
              <div
                key={f.id}
                style={{
                  border: '1px solid var(--term-border)',
                  background: 'var(--term-bg-panel)',
                  padding: '8px 10px',
                }}
              >
                {/* Header row: label · scenario cue (colored, signed) */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 12,
                  }}
                >
                  <span style={{ color: 'var(--term-fg)', fontSize: 13 }}>
                    {f.label}
                  </span>
                  <span style={{ fontSize: 11 }}>
                    <span style={{ color: 'var(--term-fg-dim)' }}>{formatShock(f)} → </span>
                    <span style={{ color: moveColor }}>
                      book {formatExpectedMove(f)}
                    </span>
                  </span>
                </div>

                {/* Stats line: portfolio β · n survivors · default shock */}
                <div
                  style={{
                    color: 'var(--term-fg-dim)',
                    fontSize: 11,
                    marginTop: 4,
                  }}
                >
                  portfolio β = {fmtBeta(pb)} · n survivors = {survCount} ·{' '}
                  shock = {formatShock(f)}
                </div>

                {/* Top 3 contributors as clickable chips. Each chip
                    shows the ticker; β + R² ride underneath in muted
                    text so the analytical reader has the per-row
                    diagnostics without crowding the chip face. */}
                {(f.topContributors || []).length === 0 ? (
                  <div
                    style={{
                      color: 'var(--term-fg-muted)',
                      fontSize: 11,
                      marginTop: 6,
                    }}
                  >
                    No surviving contributors (every holding under n≥60).
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      marginTop: 6,
                    }}
                  >
                    {f.topContributors.map((c) => {
                      // Per-ticker R² lives in perTicker, not in the
                      // contributor record — pull it for the chip
                      // detail line.
                      const row = (f.perTicker || []).find(
                        (p) => p.ticker === c.ticker
                      );
                      const r2 = row?.rSquared;
                      const n = row?.n;
                      return (
                        <div
                          key={c.ticker}
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            onOpen?.({ ticker: c.ticker, fn: 'DES' })
                          }
                          onKeyDown={chipKey(() =>
                            onOpen?.({ ticker: c.ticker, fn: 'DES' })
                          )}
                          title={`Open ${c.ticker} DES`}
                          style={{
                            border: '1px solid var(--term-border)',
                            padding: '4px 8px',
                            cursor: 'pointer',
                            minWidth: 80,
                          }}
                        >
                          <div style={{ color: 'var(--term-fg)', fontSize: 12 }}>
                            {c.ticker}
                          </div>
                          <div
                            style={{
                              color: 'var(--term-fg-muted)',
                              fontSize: 10,
                              marginTop: 2,
                            }}
                          >
                            β {fmtBeta(c.beta)} · R² {fmtR2(r2)} · n={fmtN(n)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Excluded count: how many holdings dropped out of the
                    portfolio aggregate because they lacked 60 aligned
                    observations against this factor. Muted text — a
                    diagnostic, not a primary number. */}
                {excluded > 0 && (
                  <div
                    style={{
                      color: 'var(--term-fg-muted)',
                      fontSize: 10,
                      marginTop: 6,
                    }}
                  >
                    {excluded} {excluded === 1 ? 'holding' : 'holdings'} excluded
                    (insufficient overlap with factor data).
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Methodology footer — always visible, muted, editorial voice,
          ~70-col prose. The yield-vs-price kind distinction is the
          most-confused methodological choice and is disclosed here in
          plain English; the "past sensitivity, not forecast" line is
          mandatory per the design doc. */}
      <div
        style={{
          color: 'var(--term-fg-muted)',
          fontSize: 11,
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        Lookback: 252 trading days. Factors: 10Y / WTI / USD index / VIX
        (FRED) + S&amp;P 500 (price-bar cache). Returns: daily Δ in pp
        for yields &amp; VIX (levels, not prices); daily relative for
        oil / USD / SPY. Regression: simple OLS; standard errors
        unadjusted (no HAC/Newey-West). Portfolio β = Σ weight × β over
        tickers with n ≥ 60. Past sensitivity, not forecast. Rolling
        betas drift across regimes — refresh and re-read after major
        regime shifts.
      </div>
    </div>
  );
}
