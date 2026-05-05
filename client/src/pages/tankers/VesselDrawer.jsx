import { X } from 'lucide-react';

const SIZE_LABELS = {
  vlcc: 'VLCC',
  suezmax: 'Suezmax',
  aframax: 'Aframax',
  small: 'Small / Other',
  unknown: '—',
};

function row(label, value) {
  return (
    <div className="flex justify-between border-b border-navy/5 py-2 text-sm">
      <span className="text-navy/60">{label}</span>
      <span className="font-medium text-navy">{value}</span>
    </div>
  );
}

export default function VesselDrawer({ vessel, onClose }) {
  if (!vessel) return null;
  const headingDeg = Number.isFinite(vessel.heading) ? `${vessel.heading}°` : '—';
  return (
    <div className="fixed right-0 top-0 z-40 h-full w-full max-w-sm overflow-y-auto border-l border-navy/10 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-navy/10 px-5 py-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-navy/50">Vessel</div>
          <div className="text-lg font-semibold text-navy">{vessel.name || `MMSI ${vessel.mmsi}`}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-navy/60 hover:bg-navy/5 hover:text-navy"
          aria-label="Close vessel detail"
        >
          <X size={18} />
        </button>
      </div>
      <div className="px-5 py-3">
        {row('MMSI', vessel.mmsi)}
        {row('Type', vessel.shipType ?? '—')}
        {row('Class', SIZE_LABELS[vessel.sizeClass || 'unknown'])}
        {row('Laden', vessel.laden === true ? 'Yes' : vessel.laden === false ? 'No' : '—')}
        {row('Speed', vessel.sog == null ? '—' : `${vessel.sog.toFixed(1)} kn`)}
        {row('Course', vessel.cog == null ? '—' : `${vessel.cog.toFixed(0)}°`)}
        {row('Heading', headingDeg)}
        {row('Last seen', vessel.lastSeen ? new Date(vessel.lastSeen).toLocaleString() : '—')}
      </div>
      <div className="px-5 py-4">
        <a
          className="inline-block rounded-lg bg-navy px-3 py-2 text-sm font-medium text-white hover:bg-navy/90"
          href={`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${vessel.mmsi}`}
          target="_blank"
          rel="noreferrer"
        >
          View on MarineTraffic
        </a>
      </div>
    </div>
  );
}
