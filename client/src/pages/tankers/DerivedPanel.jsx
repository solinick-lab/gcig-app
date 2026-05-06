import DerivedCard from './DerivedCard';

function fmt(n, digits = 1) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
}

export default function DerivedPanel({ derived }) {
  if (!derived) return null;

  const t = derived.hormuzThroughputMbbl || {};
  const fh = derived.flowHealth || {};
  const cp = derived.chokepointPressure || {};
  const sarStrait = derived.sarStraitVessels || {};
  const sarIran = derived.sarIranActivity || {};

  // We deliberately don't render iranExportShare / opecCoordinationZ
  // here. Both depend on per-country terminal_departures counts for
  // Saudi/Iran/Kuwait/Iraq/Qatar — none of which AISStream's
  // terrestrial-only feed actually sees. Their values would read as
  // silently-broken zeros. The backend still computes them so they're
  // ready to surface the day we add a satellite AIS provider.

  function relTime(iso) {
    if (!iso) return null;
    const hrs = (Date.now() - new Date(iso).getTime()) / 3600000;
    if (hrs < 1) return `${Math.round(hrs * 60)} min ago`;
    if (hrs < 48) return `${Math.round(hrs)} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {/* Throughput */}
      <DerivedCard
        title="Hormuz Throughput"
        valueText={t.value === null || t.value === undefined ? '—' : `${fmt(t.value, 2)} Mbbl/d`}
        subtle={`${t.tanker_count || 0} laden tankers today · baseline ~${fmt(t.baseline_mbbl, 0)} Mbbl/d`}
        footnote="Estimated barrels of crude leaving the Gulf today"
        status={
          t.value === null || t.value === undefined || t.tanker_count === 0
            ? 'warming_up'
            : (t.value >= 15 ? 'ok' : t.value >= 8 ? 'below_normal' : 'stalled')
        }
      />

      {/* Flow Health */}
      <DerivedCard
        title="Flow Health"
        valueText={fh.value === null || fh.value === undefined ? '—' : `${fh.value} / 100`}
        subtle={
          fh.value === null
            ? 'Need 7+ days of history'
            : `Today ${fmt(fh.today, 0)} crossings · 30d median ${fmt(fh.median_30d, 0)}`
        }
        footnote="Are tankers actually moving through the strait"
        status={fh.status || 'warming_up'}
      />

      {/* Chokepoint Pressure */}
      <DerivedCard
        title="Chokepoint Pressure"
        valueText={
          cp.value === null || cp.value === undefined
            ? (cp.anchored_at_strait ? `${cp.anchored_at_strait} idle` : '—')
            : `${fmt(cp.value, 2)}×`
        }
        subtle={
          cp.value === null
            ? `${cp.anchored_at_strait || 0} anchored, no outbound today`
            : `${cp.anchored_at_strait} anchored vs ${cp.outbound_today} crossings`
        }
        footnote="Idle tankers near Hormuz divided by today's transits"
        status={cp.status || 'warming_up'}
      />

      {/* SAR Strait Vessels */}
      <DerivedCard
        title="SAR · Strait Vessels"
        valueText={sarStrait.value === null || sarStrait.value === undefined ? '—' : `${sarStrait.value}`}
        subtle={
          sarStrait.asOf
            ? `${sarStrait.all_count || 0} total radar returns · last pass ${relTime(sarStrait.asOf)}`
            : 'No SAR scene processed yet'
        }
        footnote="Tanker-class hulls in the Hormuz chokepoint at the latest Sentinel-1 pass"
        status={sarStrait.status === 'no_detections' ? 'warming_up' : (sarStrait.status || 'warming_up')}
      />

      {/* SAR Iran Activity */}
      <DerivedCard
        title="SAR · Iran Side"
        valueText={sarIran.value === null || sarIran.value === undefined ? '—' : `${sarIran.value}`}
        subtle={
          sarIran.asOf
            ? `${sarIran.all_count || 0} total radar returns · last pass ${relTime(sarIran.asOf)}`
            : 'No SAR scene processed yet'
        }
        footnote="Tanker-class hulls along Iran's south coast — the AIS-blind zone"
        status={sarIran.status === 'no_detections' ? 'warming_up' : (sarIran.status || 'warming_up')}
      />
    </div>
  );
}
