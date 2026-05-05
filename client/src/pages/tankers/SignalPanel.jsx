import SignalCard from './SignalCard';

// Trimmed to signals that are actually reliable on AISStream's
// terrestrial-only coverage. UAE/Oman/Hormuz are well-covered; Saudi,
// Iran, Kuwait, Iraq, Qatar terminals don't feed public terrestrial
// AIS so their per-country counts read as silently-broken zeros. Keep
// UAE departures because Fujairah and Jebel Dhanna are visible.
const ORDER = [
  'hormuz_outbound_laden_count',
  'hormuz_inbound_ballast_count',
  'anchored_tanker_count',
  'gulf_laden_ballast_ratio',
  'hormuz_outbound_dwt_proxy',
  'gulf_total_dwt_proxy',
  'terminal_departures_uae',
];

export default function SignalPanel({ signals }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {ORDER.map((name) => {
        const entry = (signals || {})[name] || {};
        return (
          <SignalCard
            key={name}
            name={name}
            value={entry.value}
            asOf={entry.asOf}
          />
        );
      })}
    </div>
  );
}
