import { useEffect, useState } from 'react';
import { Satellite } from 'lucide-react';
import { getSarDetections } from '../../api/sea';

// Surfaces the Global Fishing Watch SAR vessel-detection feed status
// — covers waters our terrestrial AIS can't see (Iran, Saudi, Kuwait,
// Iraq) at a 5-day lag. Free non-commercial API; needs the operator
// to register and drop a token into GFW_API_TOKEN on Render.

export default function SarStatusCard() {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    getSarDetections(7)
      .then((data) => { if (alive) setState({ loading: false, data }); })
      .catch((err) => {
        if (alive) setState({ loading: false, error: err?.response?.data?.error || err.message });
      });
    return () => { alive = false; };
  }, []);

  if (state.loading) return null;

  const enabled = state.data?.enabled === true;
  const noToken = state.data?.enabled === false;

  if (noToken) {
    return (
      <div className="rounded-lg border border-navy/10 bg-navy/[0.02] p-3 text-xs text-navy/70">
        <div className="flex items-start gap-2">
          <Satellite size={14} className="mt-0.5 shrink-0 text-navy/50" />
          <div>
            <span className="font-medium text-navy">Satellite SAR detections (off)</span>{' '}
            — Global Fishing Watch publishes free Sentinel-1 ship detections that cover
            the entire Persian Gulf (including Iran, Saudi, Kuwait waters our AIS can't
            see) at a 5-day lag. To enable: register at{' '}
            <a
              href="https://globalfishingwatch.org/our-apis/tokens/request"
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
            >
              globalfishingwatch.org
            </a>{' '}
            (free, non-commercial), then set <code>GFW_API_TOKEN</code> on Render.
          </div>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
        <div className="flex items-start gap-2">
          <Satellite size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Satellite SAR detections</span> — error fetching:{' '}
            {state.error}
          </div>
        </div>
      </div>
    );
  }

  if (enabled) {
    const range = state.data.dateRange;
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
        <div className="flex items-start gap-2">
          <Satellite size={14} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Satellite SAR detections</span> — Global Fishing
            Watch data loaded for {range?.start} to {range?.end}. Map overlay landing in
            a follow-up release once the response shape is wired up.
          </div>
        </div>
      </div>
    );
  }

  return null;
}
