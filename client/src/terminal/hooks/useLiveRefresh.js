import { useEffect, useRef, useState } from 'react';

// The terminal's shared demand-driven poller. Every quote-bearing
// panel (DES, Peers, Movers, WEI) hands this a fetch function and gets
// back a refreshing { data, loading, error, lastUpdated }. The rule
// the whole live-quotes feature rests on: a fetch only ever fires
// while the panel is mounted, the tab is visible, and the caller has
// it enabled — so the free Finnhub budget is bounded by what's
// actually on screen, never by a background loop.
//
// Scheduling mirrors the Tankers page's self-rescheduling setTimeout:
// run, then arm the next tick from inside the resolve, with an `alive`
// guard and a cleared timer on teardown. We deliberately do NOT use
// setInterval — a slow fetch must not let ticks pile up behind it, and
// a single rescheduling timeout makes the visibility pause/resume a
// matter of simply not arming the next one.
//
// `fetchFn` is intentionally NOT an effect dependency. Callers pass an
// inline async closure (a fresh identity every render); depending on
// it would tear down and rebuild the timer on every parent re-render,
// which both resets the cadence and can spin into a refetch loop. We
// keep the latest closure in a ref refreshed each render and let the
// effect depend only on [intervalMs, enabled] — the inputs that
// genuinely change the schedule. The timer reads fetchFnRef.current at
// fire time, so it always calls the newest closure without resubscribing.
export default function useLiveRefresh(
  fetchFn,
  { intervalMs = 20000, enabled = true } = {}
) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Latest fetch closure, refreshed every render so the running timer
  // calls the current one without the effect depending on its identity.
  const fetchFnRef = useRef(fetchFn);
  fetchFnRef.current = fetchFn;

  // Flipped false on teardown / pause so a fetch that resolves after
  // we've stopped caring (unmount, enabled→false, tab hidden) drops its
  // result instead of writing stale state into an unmounted or paused
  // panel. The effect re-running gives each active period a fresh true.
  const aliveRef = useRef(false);

  // True only while a first-ever fetch is in flight with nothing good
  // to show yet. Once we have data we keep rendering it across later
  // refreshes (and across a failed poll), so `loading` is the empty
  // first-paint signal, not a spinner that flickers on every tick.
  const hasDataRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    let timer = null;

    // A resolve is only allowed to touch state if this same effect run
    // is still the live one. Re-checked after the await because the tab
    // can hide, `enabled` can flip, or the panel can unmount while the
    // request is on the wire.
    async function run() {
      if (!aliveRef.current) return;
      if (!hasDataRef.current) setLoading(true);
      try {
        const result = await fetchFnRef.current();
        if (!aliveRef.current) return;
        hasDataRef.current = true;
        setData(result);
        setError(null);
        setLastUpdated(Date.now());
      } catch (e) {
        if (!aliveRef.current) return;
        // Best-effort, like the rest of the terminal: a failed poll
        // must not blank a panel that was showing good numbers. Keep
        // the last `data`, surface the error alongside it, and let the
        // next successful tick clear the error on its own.
        setError(e);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    }

    // Run now, then arm the next tick from inside the resolve so a
    // slow fetch can't let ticks stack. Re-guarded because the gating
    // conditions can change during the await.
    async function tick() {
      if (!aliveRef.current) return;
      await run();
      if (aliveRef.current) timer = setTimeout(tick, intervalMs);
    }

    // Visibility is the rate-safety net. The effect only runs the
    // poller when the tab is visible to begin with; this listener
    // handles the tab leaving and coming back without remounting the
    // panel. Going hidden drops the alive flag and clears the pending
    // timer (an in-flight fetch will see !alive on resolve and discard
    // its result); coming back, if still enabled, re-arms alive and
    // does an immediate refresh before resuming the interval.
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        if (!enabled || aliveRef.current) return;
        aliveRef.current = true;
        tick();
      } else {
        aliveRef.current = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    // Only start polling when all three gates are open. If disabled or
    // the tab is already hidden at mount, we subscribe to
    // visibilitychange and idle — `enabled` flipping true re-runs this
    // effect, and a hidden→visible transition is picked up by the
    // listener above.
    if (enabled && document.visibilityState === 'visible') {
      tick();
    } else {
      aliveRef.current = false;
    }

    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);

  return { data, loading, error, lastUpdated };
}
