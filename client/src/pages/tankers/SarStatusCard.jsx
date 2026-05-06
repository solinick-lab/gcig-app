import { Satellite } from 'lucide-react';

// Status banner above the map describing the Sentinel-1 SAR
// detection layer. Pulls from the snapshot's sarDetections array
// — those red dots on the map come from radar imagery our own
// pipeline pulls from the Copernicus Data Space, processes via
// median+MAD threshold + connected-component clustering, and
// geocodes through the GRD annotation GCPs. Honest framing: 5-day
// satellite revisit, lots of false positives without land masking,
// real data nonetheless.

export default function SarStatusCard({ sarDetections }) {
  const list = sarDetections || [];
  if (list.length === 0) {
    return (
      <div className="rounded-lg border border-navy/10 bg-navy/[0.02] p-3 text-xs text-navy/70">
        <div className="flex items-start gap-2">
          <Satellite size={14} className="mt-0.5 shrink-0 text-navy/50" />
          <div>
            <span className="font-medium text-navy">Satellite SAR detections (idle)</span>{' '}
            — no Sentinel-1 detections in the database yet. Run{' '}
            <code>sea_tracker sar-detect-one &lt;scene-id&gt;</code> on the collector box
            to populate, or schedule the daily <code>sar-detect</code> task.
          </div>
        </div>
      </div>
    );
  }
  const tankers = list.filter((d) => d.likelyTanker).length;
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900">
      <div className="flex items-start gap-2">
        <Satellite size={14} className="mt-0.5 shrink-0" />
        <div>
          <span className="font-medium">Satellite SAR detections</span> — red dots on the
          map are <span className="font-semibold">{list.length}</span> hulls picked up by
          Sentinel-1 radar imagery in the last 14 days
          {tankers > 0 && <> (<span className="font-semibold">{tankers}</span> tanker-class)</>}.
          Covers waters AIS can't reach (Iran, Saudi, Kuwait, Iraq) but lags real-time
          by 5 days and includes some land/oil-rig false positives until we add a coastline mask.
        </div>
      </div>
    </div>
  );
}
