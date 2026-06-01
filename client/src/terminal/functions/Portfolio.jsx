import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';
import useLiveRefresh from '../hooks/useLiveRefresh.js';
import FlashPrice from '../components/FlashPrice.jsx';

// PM — the portfolio-manager workstation, modeled on Bloomberg's PORT.
// The book itself (which names are held, shares, average cost, sector)
// is the positions sheet's call and stays that way; it's the system of
// record. On top we overlay /terminal/quotes for live price — plus SPY
// as the benchmark — and recompute every mark that moves with price:
// market value, weight, day P&L, unrealized P&L. Three tabs mirror
// PORT's layout: Holdings (a sector-grouped tree grid with subtotal
// rows), Characteristics (allocation + concentration), and Attribution
// (today's P&L contribution and since-purchase leaders). The summary
// band rides above all three.

const BENCH = 'SPY';

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  qty: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })),
  pct: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`),
  wt: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`),
  bps: (v) => (v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v * 10000)} bps`),
  money: (v) => (v == null || Number.isNaN(v) ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`),
  signed: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  },
};

const sign = (v) => (v == null || Number.isNaN(v) ? '' : v >= 0 ? 'pos' : 'neg');

// Fold the sheet row and any live quote into one mark. The sheet's
// day-change column is per-share dollars; with a live quote present we
// trust its dp (percent) and back out the per-share move, otherwise we
// fall back to the sheet so a cell never blanks.
function buildRow(h, q) {
  if (h.isCash) {
    return { ...h, last: null, mv: h.marketValue ?? 0, dayPL: 0, dayPct: null, uplDollar: null, uplPct: null };
  }
  const last = q?.last != null ? q.last : h.price;
  const shares = h.shares;
  const mv = shares != null && last != null ? shares * last : h.marketValue != null ? h.marketValue : 0;

  let dayPct = null;
  let perShareDay = null;
  if (q?.last != null && q?.changePct != null) {
    perShareDay = q.last - q.last / (1 + q.changePct / 100);
    dayPct = q.changePct / 100;
  } else if (h.price != null && h.dayChange != null && h.price - h.dayChange > 0) {
    perShareDay = h.dayChange;
    dayPct = h.dayChange / (h.price - h.dayChange);
  }
  const dayPL =
    shares != null && perShareDay != null ? shares * perShareDay : dayPct != null ? mv - mv / (1 + dayPct) : 0;

  let uplDollar = null;
  let uplPct = null;
  if (shares != null && h.costBasis != null && last != null) {
    uplDollar = (last - h.costBasis) * shares;
    uplPct = h.costBasis > 0 ? (last - h.costBasis) / h.costBasis : null;
  } else {
    uplDollar = h.dollarReturn != null ? h.dollarReturn : null;
    uplPct = h.percentReturn != null ? h.percentReturn / 100 : null;
  }
  return { ...h, last, mv, dayPL, dayPct, uplDollar, uplPct };
}

const TABS = [
  { id: 'holdings', label: 'Holdings' },
  { id: 'chars', label: 'Characteristics' },
  { id: 'attrib', label: 'Attribution' },
];

export default function Portfolio({ onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);
  const [tab, setTab] = useState('holdings');
  const [collapsed, setCollapsed] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get('/terminal/portfolio')
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

  // Live tap for the held names plus the benchmark — same source and
  // while-visible cadence as MOVR/DES. Re-keys only when the book
  // changes; a failed poll keeps the last good marks.
  const liveTickers = useMemo(
    () => [
      ...new Set([
        ...(data?.holdings || []).filter((h) => !h.isCash).map((h) => String(h.ticker).toUpperCase()),
        BENCH,
      ]),
    ],
    [data]
  );
  const liveKey = liveTickers.join(',');

  const { data: liveQuotes } = useLiveRefresh(
    async () => {
      if (!liveKey) return {};
      const { data: q } = await api.get('/terminal/quotes', { params: { tickers: liveKey } });
      return q;
    },
    { enabled: liveTickers.length > 0 }
  );

  // Marks + fund aggregates, recomputed on any sheet or live change.
  // Weights foot against live NAV; concentration is measured against
  // long market value so cash doesn't distort it.
  const view = useMemo(() => {
    if (!data?.holdings) return null;
    const rows = data.holdings.map((h) =>
      buildRow(h, liveQuotes ? liveQuotes[String(h.ticker).toUpperCase()] : null)
    );
    const nav = rows.reduce((s, r) => s + (r.mv || 0), 0);
    for (const r of rows) r.weight = nav > 0 ? r.mv / nav : null;

    const positions = rows.filter((r) => !r.isCash);
    const longMV = positions.reduce((s, r) => s + (r.mv || 0), 0);
    const cash = rows.filter((r) => r.isCash).reduce((s, r) => s + (r.mv || 0), 0);
    const dayPL = rows.reduce((s, r) => s + (r.dayPL || 0), 0);
    const priorNav = nav - dayPL;
    const dayPct = priorNav > 0 ? dayPL / priorNav : null;
    const uplDollar = positions.reduce((s, r) => s + (r.uplDollar || 0), 0);
    const costNonCash = positions.reduce((s, r) => {
      if (r.shares != null && r.costBasis != null) return s + r.shares * r.costBasis;
      if (r.mv != null && r.uplDollar != null) return s + (r.mv - r.uplDollar);
      return s;
    }, 0);
    const uplPct = costNonCash > 0 ? uplDollar / costNonCash : null;

    // Per-position contribution to the portfolio's day move and its
    // total unrealized P&L — the raw material of the Attribution tab.
    for (const r of positions) {
      r.dayContrib = priorNav > 0 ? r.dayPL / priorNav : null;
      r.uplShare = uplDollar !== 0 ? (r.uplDollar || 0) / uplDollar : null;
    }

    // Sector groups (positions only), each carrying its own subtotals.
    const byKey = new Map();
    for (const r of positions) {
      const k = r.sector || 'Unclassified';
      if (!byKey.has(k)) byKey.set(k, { name: k, rows: [], mv: 0, dayPL: 0, uplDollar: 0 });
      const g = byKey.get(k);
      g.rows.push(r);
      g.mv += r.mv || 0;
      g.dayPL += r.dayPL || 0;
      g.uplDollar += r.uplDollar || 0;
    }
    const sectors = [...byKey.values()]
      .map((g) => {
        g.rows.sort((a, b) => (b.mv || 0) - (a.mv || 0));
        g.weight = nav > 0 ? g.mv / nav : 0;
        const prior = g.mv - g.dayPL;
        g.dayPct = prior > 0 ? g.dayPL / prior : null;
        return g;
      })
      .sort((a, b) => b.mv - a.mv);

    // Concentration, measured on long market value.
    const byWeight = [...positions].sort((a, b) => (b.mv || 0) - (a.mv || 0));
    const w = (r) => (longMV > 0 ? (r.mv || 0) / longMV : 0);
    const sumW = (n) => byWeight.slice(0, n).reduce((s, r) => s + w(r), 0);
    const herf = byWeight.reduce((s, r) => s + w(r) * w(r), 0);
    const concentration = {
      largest: byWeight[0] || null,
      top5: sumW(5),
      top10: sumW(10),
      effectiveN: herf > 0 ? 1 / herf : null,
      numSectors: sectors.length,
    };

    const benchDay = liveQuotes && liveQuotes[BENCH]?.changePct != null ? liveQuotes[BENCH].changePct / 100 : null;

    return {
      rows,
      positions,
      sectors,
      concentration,
      summary: {
        nav,
        longMV,
        cash,
        cashPct: nav > 0 ? cash / nav : null,
        dayPL,
        dayPct,
        uplDollar,
        uplPct,
        count: positions.length,
        benchDay,
        activeDay: dayPct != null && benchDay != null ? dayPct - benchDay : null,
      },
    };
  }, [data, liveQuotes]);

  useEffect(() => {
    if (!view?.rows?.length) return;
    let cancelled = false;
    setBriefLoading(true);
    const s = view.summary;
    const top = view.positions.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 5);
    const context = [
      `Griffin Fund book, as of ${data.fetchedAt ? String(data.fetchedAt).slice(0, 10) : 'n/a'}:`,
      `NAV ${fmt.money(s.nav)} · day P&L ${fmt.signed(s.dayPL)} (${fmt.pct(s.dayPct)}) vs SPY ${fmt.pct(s.benchDay)} · unrealized ${fmt.signed(s.uplDollar)} (${fmt.pct(s.uplPct)}) · cash ${fmt.money(s.cash)} (${fmt.wt(s.cashPct)}) · ${s.count} positions across ${view.concentration.numSectors} sectors`,
      `Concentration: largest ${view.concentration.largest?.ticker || '—'} ${fmt.wt(view.concentration.largest ? view.concentration.largest.mv / s.longMV : null)}, top 5 ${fmt.wt(view.concentration.top5)}, effective N ${view.concentration.effectiveN?.toFixed(1) || '—'}`,
      'Top positions by weight:',
      ...top.map((r) => `${r.ticker} ${fmt.wt(r.weight)} · day ${fmt.pct(r.dayPct)} · unreal ${fmt.pct(r.uplPct)}`),
    ].join('\n');
    api
      .post('/terminal/annotate', { function: 'PM', context })
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
    // Re-brief on a fresh sheet load, not on every live tick.
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="term-panel"><div className="term-loading">Loading the book…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  if (!view) return null;

  const s = view.summary;

  function toggleSector(name) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const openDes = (ticker) => () => onOpen?.({ ticker, fn: 'DES' });
  const rowKey = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="term-panel term-pm">
      <div className="term-panel-header">
        <span className="ticker">PM</span>
        <span className="equity">Portfolio</span>
        <span className="name">
          The Griffin Fund{data.fetchedAt ? ` · as of ${String(data.fetchedAt).slice(0, 10)}` : ''}
        </span>
      </div>

      <div className="term-pm-summary">
        <PmStat label="Net Asset Value" value={fmt.money(s.nav)} />
        <PmStat label="Day P&L" value={fmt.signed(s.dayPL)} sub={fmt.pct(s.dayPct)} cls={sign(s.dayPL)} />
        <PmStat label="vs SPY" value={fmt.pct(s.activeDay)} sub={`SPY ${fmt.pct(s.benchDay)}`} cls={sign(s.activeDay)} />
        <PmStat label="Unrealized P&L" value={fmt.signed(s.uplDollar)} sub={fmt.pct(s.uplPct)} cls={sign(s.uplDollar)} />
        <PmStat label="Cash" value={fmt.money(s.cash)} sub={fmt.wt(s.cashPct)} />
        <PmStat label="Positions" value={String(s.count)} sub={`${view.concentration.numSectors} sectors`} />
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div className="term-tabs">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            className={`term-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="term-tab-n">{i + 1})</span> {t.label}
          </button>
        ))}
      </div>

      {tab === 'holdings' ? (
        <Holdings view={view} collapsed={collapsed} toggleSector={toggleSector} openDes={openDes} rowKey={rowKey} />
      ) : tab === 'chars' ? (
        <Characteristics view={view} />
      ) : (
        <Attribution view={view} openDes={openDes} rowKey={rowKey} />
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Book from the positions sheet; price, value, weight and P&L recomputed live
        (~20s) while open, benchmarked to {BENCH}. Click any position to open its DES.
      </div>
    </div>
  );
}

// ── Holdings: sector-grouped tree grid with collapsible subtotal rows ──
function Holdings({ view, collapsed, toggleSector, openDes, rowKey }) {
  let rank = 0;
  return (
    <table className="term-table term-pm-table">
      <thead>
        <tr>
          <th style={{ width: 20 }}>#</th>
          <th>Ticker</th>
          <th className="num">Pos</th>
          <th className="num">Avg Cost</th>
          <th className="num">Last</th>
          <th className="num">Mkt Val</th>
          <th className="num">Wt%</th>
          <th className="num">Day%</th>
          <th className="num">Day P&L</th>
          <th className="num">Unreal P&L</th>
          <th className="num">%</th>
        </tr>
      </thead>
      <tbody>
        {view.sectors.map((g) => {
          const open = !collapsed.has(g.name);
          return (
            <Fragmentish key={g.name}>
              <tr className="term-pm-sector" onClick={() => toggleSector(g.name)}>
                <td colSpan={5}>
                  <span className="caret">{open ? '▾' : '▸'}</span> {g.name}
                  <span className="ct"> · {g.rows.length}</span>
                </td>
                <td className="num">{fmt.money(g.mv)}</td>
                <td className="num">{fmt.wt(g.weight)}</td>
                <td className={`num ${sign(g.dayPct)}`}>{fmt.pct(g.dayPct)}</td>
                <td className={`num ${sign(g.dayPL)}`}>{fmt.signed(g.dayPL)}</td>
                <td className={`num ${sign(g.uplDollar)}`}>{fmt.signed(g.uplDollar)}</td>
                <td className="num" />
              </tr>
              {open
                ? g.rows.map((r) => {
                    rank += 1;
                    return (
                      <tr
                        key={r.ticker}
                        className="term-row-link"
                        role="button"
                        tabIndex={0}
                        onClick={openDes(r.ticker)}
                        onKeyDown={rowKey(openDes(r.ticker))}
                        title={`Open ${r.ticker} DES`}
                      >
                        <td className="rank">{rank}</td>
                        <td className="sym">
                          {r.ticker}
                          {r.name && r.name !== r.ticker ? <span className="peer-name">{r.name}</span> : null}
                        </td>
                        <td className="num">{fmt.qty(r.shares)}</td>
                        <td className="num">{fmt.px(r.costBasis)}</td>
                        <td className="num"><FlashPrice value={r.last}>{fmt.px(r.last)}</FlashPrice></td>
                        <td className="num">{fmt.money(r.mv)}</td>
                        <td className="num">{fmt.wt(r.weight)}</td>
                        <td className={`num ${sign(r.dayPct)}`}>{fmt.pct(r.dayPct)}</td>
                        <td className={`num ${sign(r.dayPL)}`}>{fmt.signed(r.dayPL)}</td>
                        <td className={`num ${sign(r.uplDollar)}`}>{fmt.signed(r.uplDollar)}</td>
                        <td className={`num ${sign(r.uplPct)}`}>{fmt.pct(r.uplPct)}</td>
                      </tr>
                    );
                  })
                : null}
            </Fragmentish>
          );
        })}
        {view.summary.cash > 0 ? (
          <tr className="term-pm-cash">
            <td className="rank" />
            <td className="sym">CASH</td>
            <td className="num">—</td>
            <td className="num">—</td>
            <td className="num">—</td>
            <td className="num">{fmt.money(view.summary.cash)}</td>
            <td className="num">{fmt.wt(view.summary.cashPct)}</td>
            <td className="num">—</td>
            <td className="num">—</td>
            <td className="num">—</td>
            <td className="num">—</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

// ── Characteristics: allocation rail + concentration analytics ────────
function Characteristics({ view }) {
  const c = view.concentration;
  const longMV = view.summary.longMV;
  return (
    <div className="term-pm-chars">
      <div className="term-stat-grid">
        <CharStat label="Long Mkt Value" value={fmt.money(longMV)} />
        <CharStat label="Largest Position" value={c.largest ? `${c.largest.ticker} ${fmt.wt(longMV > 0 ? c.largest.mv / longMV : null)}` : '—'} />
        <CharStat label="Top 5 Weight" value={fmt.wt(c.top5)} />
        <CharStat label="Top 10 Weight" value={fmt.wt(c.top10)} />
        <CharStat label="Effective N" value={c.effectiveN != null ? c.effectiveN.toFixed(1) : '—'} />
        <CharStat label="Sectors" value={String(c.numSectors)} />
      </div>

      <div className="term-pm-alloc">
        <div className="term-pm-alloc-title">Sector Allocation</div>
        {view.sectors.map((g) => (
          <div className="term-pm-bar" key={g.name}>
            <span className="lbl" title={g.name}>{g.name}</span>
            <span className="track">
              <span className="fill" style={{ width: `${Math.min(100, g.weight * 100).toFixed(1)}%` }} />
            </span>
            <span className="val">{fmt.wt(g.weight)}</span>
          </div>
        ))}
        {view.summary.cashPct > 0 ? (
          <div className="term-pm-bar">
            <span className="lbl">Cash</span>
            <span className="track">
              <span className="fill cash" style={{ width: `${Math.min(100, view.summary.cashPct * 100).toFixed(1)}%` }} />
            </span>
            <span className="val">{fmt.wt(view.summary.cashPct)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Attribution: today's contribution + since-purchase leaders ────────
function Attribution({ view, openDes, rowKey }) {
  const byDay = view.positions.slice().sort((a, b) => (b.dayPL || 0) - (a.dayPL || 0));
  const byUpl = view.positions.slice().sort((a, b) => (b.uplDollar || 0) - (a.uplDollar || 0));
  const leaders = byUpl.slice(0, 5);
  const laggards = byUpl.slice(-5).reverse();

  const linkRow = (r, cols) => (
    <tr
      key={r.ticker}
      className="term-row-link"
      role="button"
      tabIndex={0}
      onClick={openDes(r.ticker)}
      onKeyDown={rowKey(openDes(r.ticker))}
      title={`Open ${r.ticker} DES`}
    >
      {cols}
    </tr>
  );

  return (
    <div className="term-pm-attrib">
      <div className="term-pm-alloc-title">Today's P&amp;L Attribution</div>
      <table className="term-table term-pm-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th className="num">Wt%</th>
            <th className="num">Day%</th>
            <th className="num">Day P&L</th>
            <th className="num">Contrib</th>
          </tr>
        </thead>
        <tbody>
          {byDay.map((r) =>
            linkRow(r, [
              <td className="sym" key="t">{r.ticker}</td>,
              <td className="num" key="w">{fmt.wt(r.weight)}</td>,
              <td className={`num ${sign(r.dayPct)}`} key="d">{fmt.pct(r.dayPct)}</td>,
              <td className={`num ${sign(r.dayPL)}`} key="p">{fmt.signed(r.dayPL)}</td>,
              <td className={`num ${sign(r.dayContrib)}`} key="c">{fmt.bps(r.dayContrib)}</td>,
            ])
          )}
        </tbody>
      </table>

      <div className="term-pm-attrib-cols">
        <div>
          <div className="term-pm-alloc-title">Unrealized Leaders</div>
          <table className="term-table term-pm-table">
            <tbody>
              {leaders.map((r) =>
                linkRow(r, [
                  <td className="sym" key="t">{r.ticker}</td>,
                  <td className={`num ${sign(r.uplDollar)}`} key="p">{fmt.signed(r.uplDollar)}</td>,
                  <td className={`num ${sign(r.uplPct)}`} key="q">{fmt.pct(r.uplPct)}</td>,
                ])
              )}
            </tbody>
          </table>
        </div>
        <div>
          <div className="term-pm-alloc-title">Unrealized Laggards</div>
          <table className="term-table term-pm-table">
            <tbody>
              {laggards.map((r) =>
                linkRow(r, [
                  <td className="sym" key="t">{r.ticker}</td>,
                  <td className={`num ${sign(r.uplDollar)}`} key="p">{fmt.signed(r.uplDollar)}</td>,
                  <td className={`num ${sign(r.uplPct)}`} key="q">{fmt.pct(r.uplPct)}</td>,
                ])
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PmStat({ label, value, sub, cls = '' }) {
  return (
    <div className="term-pm-stat">
      <span className="lbl">{label}</span>
      <span className={`val ${cls}`}>
        {value}
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
    </div>
  );
}

function CharStat({ label, value }) {
  return (
    <div className="term-stat">
      <span className="term-stat-label">{label}</span>
      <span className="term-stat-value">{value}</span>
    </div>
  );
}

// A keyless grouping wrapper so each sector can emit its header row plus
// its position rows without an extra DOM node inside <tbody>.
function Fragmentish({ children }) {
  return <>{children}</>;
}
