import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { TrendingUp, TrendingDown, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import Button from './Button.jsx';

const STORAGE_KEY = 'gcig_dismissed_session_';

export default function VoteNotification() {
  const [session, setSession] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .get('/votes/pending')
      .then(({ data }) => {
        if (cancelled || !data) return;
        // Check if user already dismissed this specific session.
        if (localStorage.getItem(STORAGE_KEY + data.id)) return;
        setSession(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    if (session) localStorage.setItem(STORAGE_KEY + session.id, '1');
    setSession(null);
  }

  if (!session) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-navy/70 p-4">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="bg-gradient-to-r from-emerald-500 to-emerald-700 p-6 text-white">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider opacity-90">
                Vote Now
              </div>
              <div className="mt-2 flex items-center gap-3">
                {session.kind === 'sell' ? (
                  <TrendingDown className="h-8 w-8" />
                ) : (
                  <TrendingUp className="h-8 w-8" />
                )}
                <div>
                  <div className="text-3xl font-bold">{session.ticker}</div>
                  {session.title && (
                    <div className="text-sm opacity-90">{session.title}</div>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={dismiss}
              className="rounded-lg p-1 text-white/80 hover:bg-white/20 hover:text-white"
              aria-label="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6">
          <p className="text-sm text-navy">
            A new {session.kind === 'sell' ? 'sell' : 'voting'} session on{' '}
            <strong>{session.ticker}</strong> was started by{' '}
            <strong>{session.creator?.name}</strong>.{' '}
            {session.kind === 'sell'
              ? 'Cast your Sell or Hold rating before the deadline.'
              : 'Cast your Buy, Hold, or Sell vote before the deadline.'}
          </p>
          <div className="mt-3 text-xs text-navy-400">
            Closes {formatDistanceToNow(new Date(session.deadline), { addSuffix: true })}
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={dismiss}>
              Dismiss
            </Button>
            <Button
              onClick={() => {
                dismiss();
                navigate('/votes');
              }}
            >
              Cast My Vote
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
