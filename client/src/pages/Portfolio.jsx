import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  LineChart as RLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, TrendingDown, RefreshCw, ExternalLink } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';

function fmtMoney(n) {
  if (n == null) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export default function Portfolio() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [quotes, hist] = await Promise.all([
        api.get('/holdings/quotes'),
        api.get('/holdings/history'),
      ]);
      setData(quotes.data);
      setHistory(hist.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load portfolio');
      setData({ holdings: [], totals: {} });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const totals = data?.totals || {};
  const isUp = (totals.totalGainLoss ?? 0) >= 0;
  const holdings = data?.holdings || [];

  const chartData = history.map((s) => ({
    date: format(new Date(s.date), 'MMM d'),
    value: Number(s.totalValue.toFixed(2)),
  }));

  return (
    <>
      <PageHeader
        title="Live Portfolio"
        subtitle={
          data?.fetchedAt
            ? `Live from Google Sheets • fetched ${format(new Date(data.fetchedAt), 'h:mm:ss a')}`
            : 'Live from Google Sheets'
        }
        actions={
          <div className="flex gap-2">
            <a
              href={`https://docs.google.com/spreadsheets/d/${import.meta.env.VITE_SHEET_ID || '10b43Ry4YBfY_Uk_8nIlJLjmfNgzzjAm6BjN7UewSdRQ'}/edit`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-navy-100 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open Sheet
            </a>
            <Button onClick={load} variant="gold" disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <strong>Couldn't load the sheet.</strong> {error}
          <div className="mt-2 text-xs">
            Make sure the sheet is shared as "Anyone with the link can view".
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">Total Value</div>
          <div className="mt-2 text-3xl font-bold text-navy">
            {fmtMoney(totals.totalValue)}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">Total Cost Basis</div>
          <div className="mt-2 text-3xl font-bold text-navy">
            {fmtMoney(totals.totalCost)}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-navy-400">Total Gain/Loss</div>
          <div
            className={`mt-2 flex items-center gap-2 text-3xl font-bold ${
              isUp ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {isUp ? <TrendingUp className="h-7 w-7" /> : <TrendingDown className="h-7 w-7" />}
            {fmtMoney(totals.totalGainLoss)}
          </div>
          <div
            className={`mt-1 text-sm font-semibold ${
              isUp ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {fmtPct(totals.totalGainLossPct)}
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Performance Over Time">
          {chartData.length > 1 ? (
            <div style={{ width: '100%', height: 280 }}>
              <ResponsiveContainer>
                <RLineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" />
                  <XAxis dataKey="date" stroke="#1B2A4A" fontSize={12} />
                  <YAxis
                    stroke="#1B2A4A"
                    fontSize={12}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    formatter={(v) => fmtMoney(v)}
                    contentStyle={{ borderRadius: 8, borderColor: '#C9A84C' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#1B2A4A"
                    strokeWidth={2.5}
                    dot={{ fill: '#C9A84C', r: 3 }}
                  />
                </RLineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-navy-400">
              Performance history will populate as daily snapshots accrue.
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Holdings">
          {loading && !holdings.length ? (
            <div className="py-8 text-center text-navy-400">Loading from Google Sheets…</div>
          ) : holdings.length === 0 ? (
            <div className="py-8 text-center text-navy-400">
              No positions found in the sheet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="py-2 pr-4">Ticker</th>
                    <th className="py-2 pr-4">Sector</th>
                    <th className="py-2 pr-4 text-right">Shares</th>
                    <th className="py-2 pr-4 text-right">Avg Cost</th>
                    <th className="py-2 pr-4 text-right">Price</th>
                    <th className="py-2 pr-4 text-right">Value</th>
                    <th className="py-2 pr-4 text-right">Weight</th>
                    <th className="py-2 pr-4 text-right">Return $</th>
                    <th className="py-2 pr-4 text-right">Return %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-50">
                  {holdings.map((h) => {
                    const up = (h.dollarReturn ?? 0) >= 0;
                    const marketValue =
                      h.marketValue ??
                      (h.shares != null && h.price != null ? h.shares * h.price : null);
                    return (
                      <tr key={h.ticker} className={h.isCash ? 'bg-gold-100/40' : ''}>
                        <td className="py-3 pr-4">
                          <div className="font-bold text-navy">{h.ticker}</div>
                          <div className="text-xs text-navy-400 truncate max-w-[220px]">
                            {h.name}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-xs text-navy-400">
                          {h.sector || '—'}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {h.isCash ? '—' : h.shares ?? '—'}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {h.isCash ? '—' : fmtMoney(h.costBasis)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">
                          {h.isCash ? '—' : fmtMoney(h.price)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums font-semibold">
                          {fmtMoney(marketValue)}
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums text-navy-400">
                          {h.portfolioPct != null ? `${h.portfolioPct.toFixed(2)}%` : '—'}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right tabular-nums font-semibold ${
                            h.isCash
                              ? 'text-navy-400'
                              : up
                              ? 'text-emerald-600'
                              : 'text-red-600'
                          }`}
                        >
                          {h.isCash ? '—' : fmtMoney(h.dollarReturn)}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right tabular-nums font-semibold ${
                            h.isCash
                              ? 'text-navy-400'
                              : up
                              ? 'text-emerald-600'
                              : 'text-red-600'
                          }`}
                        >
                          {h.isCash ? '—' : fmtPct(h.percentReturn)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-navy-100">
                    <td colSpan={5} className="py-3 pr-4 font-bold text-navy">
                      Total ({holdings.length} positions)
                    </td>
                    <td className="py-3 pr-4 text-right font-bold text-navy tabular-nums">
                      {fmtMoney(totals.totalValue)}
                    </td>
                    <td />
                    <td
                      className={`py-3 pr-4 text-right font-bold tabular-nums ${
                        isUp ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {fmtMoney(totals.totalGainLoss)}
                    </td>
                    <td
                      className={`py-3 pr-4 text-right font-bold tabular-nums ${
                        isUp ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {fmtPct(totals.totalGainLossPct)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="mt-4 text-xs text-navy-400">
            Positions and prices are read live from the club's Google Sheet. To
            add or remove a position, edit the sheet directly.
          </div>
        </Card>
      </div>
    </>
  );
}
