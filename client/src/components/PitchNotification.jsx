import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Presentation, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import Button from './Button.jsx';

export default function PitchNotification() {
  const [assignment, setAssignment] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .get('/pitches/mine/upcoming')
      .then(({ data }) => {
        if (cancelled) return;
        // Grab the most recent unseen assignment.
        if (data && data.length > 0) setAssignment(data[0]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function dismiss() {
    if (!assignment) return;
    try {
      await api.post(`/pitches/mine/seen/${assignment.pitchId}`);
    } catch {
      /* non-fatal */
    }
    setAssignment(null);
  }

  if (!assignment) return null;
  const pitch = assignment.pitch;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-navy/70 p-4">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="bg-gradient-to-r from-gold-500 to-gold-700 p-6 text-navy">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider opacity-80">
                New Pitch Assignment
              </div>
              <div className="mt-2 flex items-center gap-3">
                <Presentation className="h-8 w-8" />
                <div>
                  <div className="text-3xl font-bold">{pitch.ticker}</div>
                  <div className="text-sm opacity-90">
                    {format(new Date(pitch.date), "EEE, MMM d 'at' h:mm a")}
                  </div>
                </div>
              </div>
            </div>
            <button
              onClick={dismiss}
              className="rounded-lg p-1 text-navy/70 hover:bg-navy/10 hover:text-navy"
              aria-label="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6">
          <p className="text-sm text-navy">
            You've been added as a presenter on the <strong>{pitch.ticker}</strong> pitch.
          </p>
          {pitch.presenters && pitch.presenters.length > 0 && (
            <div className="mt-3 text-xs text-navy-400">
              Presenters:{' '}
              <span className="text-navy">
                {pitch.presenters.map((p) => p.name).join(', ')}
              </span>
            </div>
          )}
          {pitch.location && (
            <div className="mt-1 text-xs text-navy-400">
              Location: <span className="text-navy">{pitch.location}</span>
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={dismiss}>
              Got it
            </Button>
            <Button
              onClick={async () => {
                await dismiss();
                navigate('/pitches');
              }}
            >
              View Pitch
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
