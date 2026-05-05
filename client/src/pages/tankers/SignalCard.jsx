import { useEffect, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { getSignalHistory } from '../../api/sea';

const LABELS = {
  hormuz_outbound_laden_count: 'Hormuz Outbound (Laden)',
  hormuz_outbound_dwt_proxy: 'Hormuz Outbound DWT Proxy',
  hormuz_inbound_ballast_count: 'Hormuz Inbound (Ballast)',
  gulf_laden_ballast_ratio: 'Gulf Laden / Ballast Ratio',
  anchored_tanker_count: 'Anchored Tankers',
  gulf_total_dwt_proxy: 'Gulf Total DWT Proxy',
  terminal_departures_saudi: 'Saudi Terminal Departures',
  terminal_departures_iran: 'Iran Terminal Departures',
  terminal_departures_kuwait: 'Kuwait Terminal Departures',
  terminal_departures_iraq: 'Iraq Terminal Departures',
  terminal_departures_uae: 'UAE Terminal Departures',
  terminal_departures_qatar: 'Qatar Terminal Departures',
};

// Format a single signal value. Ratios as %, DWT proxies in compact
// notation, everything else as integers. Keeps panel cards uniform
// without each signal needing bespoke logic.
function formatValue(name, value) {
  if (value === null || value === undefined) return '—';
  if (name === 'gulf_laden_ballast_ratio') {
    return `${(value * 100).toFixed(0)}%`;
  }
  if (name.endsWith('_dwt_proxy')) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export default function SignalCard({ name, value, asOf }) {
  const [series, setSeries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getSignalHistory(name, 90)
      .then((res) => { if (!cancelled) setSeries(res.points || []); })
      .catch(() => { if (!cancelled) setSeries([]); });
    return () => { cancelled = true; };
  }, [name]);

  return (
    <div className="rounded-2xl border border-navy/10 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-navy/60">
        {LABELS[name] || name}
      </div>
      <div className="mt-1 text-2xl font-semibold text-navy">
        {formatValue(name, value)}
      </div>
      <div className="mt-2 h-12">
        {series && series.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <YAxis hide domain={['auto', 'auto']} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#C9A84C"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full rounded bg-navy/5" />
        )}
      </div>
      <div className="mt-2 text-[10px] uppercase tracking-wider text-navy/40">
        {asOf ? `as of ${asOf}` : '—'}
      </div>
    </div>
  );
}
