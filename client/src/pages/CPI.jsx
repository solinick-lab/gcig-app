import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  ComposedChart,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';

// CPI forecast page. Reads from /api/cpi/forecast (latest run) and
// /api/cpi/history (recent runs for the backtest panel). Numbers are
// computed monthly by the Python forecaster on the club's local server
// and POSTed here — this page never runs models, just reads + charts.

function formatPct(n, signed = true) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n.toFixed(2);
  return signed && n > 0 ? `+${s}%` : `${s}%`;
}

function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function CPI() {
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [forecastRes, historyRes] = await Promise.all([
          api.get('/cpi/forecast'),
          api.get('/cpi/history?limit=24'),
        ]);
        if (cancelled) return;
        setLatest(forecastRes.data);
        setHistory(historyRes.data?.runs || []);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e?.response?.data?.error || e.message || 'Failed to load forecast');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const forecast = latest?.latest;
  const fanChartData = useMemo(() => {
    if (!forecast) return [];
    // Synthesize a "history" series from the most recent runs that share
    // the same source month — but for the chart we want a proper history.
    // Use the lastReleasedYoy as the anchor at asOfMonth, then the
    // forecasts as the next 3 months.
    const rows = [];
    rows.push({
      month: monthLabel(forecast.asOfMonth),
      yoy: forecast.lastReleasedYoy,
      forecast: null,
      lo: null,
      hi: null,
    });
    for (const f of forecast.forecasts) {
      rows.push({
        month: monthLabel(f.month),
        yoy: null,
        forecast: f.yoy,
        lo: f.yoyLo80,
        hi: f.yoyHi80,
      });
    }
    return rows;
  }, [forecast]);

  if (loading) {
    return (
      <div>
        <PageHeader kicker="Macro" title="CPI Forecast" />
        <Card>
          <div className="py-10 text-center text-sm text-navy-400">Loading forecast…</div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader kicker="Macro" title="CPI Forecast" />
        <Card>
          <div className="py-10 text-center text-sm text-red-600">{error}</div>
        </Card>
      </div>
    );
  }

  if (!latest?.configured || !forecast) {
    return (
      <div>
        <PageHeader kicker="Macro" title="CPI Forecast" />
        <Card>
          <div className="py-10 text-center text-sm text-navy-400">
            No forecast yet. The forecaster runs monthly after BLS releases CPI
            (typically mid-month). Once it has POSTed a run, it'll appear here.
          </div>
        </Card>
      </div>
    );
  }

  const direction =
    forecast.forecasts[2]?.yoy > forecast.lastReleasedYoy
      ? 'up'
      : forecast.forecasts[2]?.yoy < forecast.lastReleasedYoy
        ? 'down'
        : 'flat';
  const DirectionIcon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Macro"
        title="CPI Forecast"
        subtitle={`3-month-ahead headline CPI, ensemble of SARIMA + Ridge + XGBoost. Forecast generated ${new Date(
          forecast.runAt
        ).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`}
      />

      {/* Headline cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
            Last Released
          </div>
          <div className="mt-2 font-serif text-3xl font-semibold text-navy">
            {formatPct(forecast.lastReleasedYoy, false)}
          </div>
          <div className="mt-1 text-xs text-navy-400">
            {monthLabel(forecast.asOfMonth)} (YoY)
          </div>
        </Card>
        {forecast.forecasts.map((f, i) => (
          <Card key={f.month}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
              Forecast +{i + 1} mo
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-serif text-3xl font-semibold text-navy">
                {formatPct(f.yoy, false)}
              </span>
              {i === 2 && <DirectionIcon className="h-5 w-5 text-navy-400" />}
            </div>
            <div className="mt-1 text-xs text-navy-400">
              {monthLabel(f.month)} • 80% band {formatPct(f.yoyLo80, false)} →{' '}
              {formatPct(f.yoyHi80, false)}
            </div>
          </Card>
        ))}
      </div>

      {/* Fan chart */}
      <Card kicker="Path" title="Anchor + 3-month forecast">
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={fanChartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="bandFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#C9A84C" stopOpacity={0.32} />
                  <stop offset="100%" stopColor="#C9A84C" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748B' }} />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748B' }}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                domain={['auto', 'auto']}
              />
              <Tooltip
                formatter={(v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`)}
                contentStyle={{ fontSize: 12 }}
              />
              {/* 80% band as area between lo and hi */}
              <Area
                type="monotone"
                dataKey="hi"
                stroke="none"
                fill="url(#bandFill)"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="lo"
                stroke="none"
                fill="#FFFFFF"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="yoy"
                stroke="#1B2A4A"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#1B2A4A' }}
                isAnimationActive={false}
                name="Released"
              />
              <Line
                type="monotone"
                dataKey="forecast"
                stroke="#C9A84C"
                strokeWidth={2.5}
                strokeDasharray="5 4"
                dot={{ r: 4, fill: '#C9A84C' }}
                isAnimationActive={false}
                name="Forecast"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex items-center gap-4 text-xs text-navy-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-navy" /> Released
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 bg-gold" style={{ borderTop: '1.5px dashed' }} />{' '}
            Forecast
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-4 bg-gold/30" /> 80% band
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Per-model breakdown */}
        <Card kicker="Inside the ensemble" title="Per-model contributions">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-navy-400">
                <tr>
                  <th className="py-2">Month</th>
                  <th className="py-2">SARIMA</th>
                  <th className="py-2">Ridge</th>
                  <th className="py-2">XGBoost</th>
                  <th className="py-2 font-semibold">Ensemble</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-50">
                {forecast.forecasts.map((f) => (
                  <tr key={f.month}>
                    <td className="py-2.5 text-navy">{monthLabel(f.month)}</td>
                    <td className="py-2.5 tabular-nums text-navy-500">
                      {formatPct(f.modelContributions.sarima, false)}
                    </td>
                    <td className="py-2.5 tabular-nums text-navy-500">
                      {formatPct(f.modelContributions.ridge, false)}
                    </td>
                    <td className="py-2.5 tabular-nums text-navy-500">
                      {formatPct(f.modelContributions.xgb, false)}
                    </td>
                    <td className="py-2.5 font-semibold tabular-nums text-navy">
                      {formatPct(f.yoy, false)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-navy-400">
            <span className="font-semibold uppercase tracking-wider text-navy-500">Weights</span>
            {Object.entries(forecast.weights || {}).map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-md bg-navy-50 px-2 py-1 font-medium text-navy"
              >
                {k}: {(v * 100).toFixed(1)}%
              </span>
            ))}
          </div>
        </Card>

        {/* Backtest stats */}
        <Card kicker="Track record" title="Rolling 24-month backtest">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
                Ensemble RMSE
              </div>
              <div className="mt-1 font-serif text-2xl font-semibold text-navy">
                {forecast.backtest?.ensembleRmseMom?.toFixed(3) ?? '—'}%
              </div>
              <div className="text-xs text-navy-400">MoM error</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-700">
                Naive baseline
              </div>
              <div className="mt-1 font-serif text-2xl font-semibold text-navy-400">
                {forecast.backtest?.naiveRmseMom?.toFixed(3) ?? '—'}%
              </div>
              <div className="text-xs text-navy-400">For comparison</div>
            </div>
          </div>
          <div className="mt-4 space-y-2 text-sm">
            {Object.entries(forecast.backtest?.perModelRmseMom || {}).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="capitalize text-navy">{k}</span>
                <span className="tabular-nums text-navy-500">{v.toFixed(3)}%</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-navy-400">
            Each month over the last {forecast.backtest?.windowMonths || 24}, we re-fit every model
            on data available at that point and predicted the next 3 months. RMSE is the
            root-mean-squared MoM error. Lower is better.
          </p>
        </Card>
      </div>

      {history.length > 1 && (
        <Card kicker="Prediction history" title="Past forecasts vs. actuals">
          <p className="mb-3 text-xs text-navy-400">
            Showing the last {history.length} monthly runs. As new CPI prints come out, you'll be
            able to see how the forecast compared to reality in the chart below.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-navy-400">
                <tr>
                  <th className="py-2">Run as-of</th>
                  <th className="py-2">+1 mo</th>
                  <th className="py-2">+2 mo</th>
                  <th className="py-2">+3 mo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-50">
                {history.map((h) => (
                  <tr key={h.asOfMonth}>
                    <td className="py-2.5 text-navy">{monthLabel(h.asOfMonth)}</td>
                    {(h.forecasts || []).slice(0, 3).map((f, i) => (
                      <td key={i} className="py-2.5 tabular-nums text-navy-500">
                        {formatPct(f.yoy, false)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
