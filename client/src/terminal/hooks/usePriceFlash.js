import { useEffect, useRef, useState } from 'react';

// The tick flash: hand this the live numeric a cell is rendering and it
// tells you, for this render only, whether the value just ticked 'up',
// 'down', or didn't move ('null'). The caller maps that onto a CSS
// class so the cell background pulses and fades — the classic Bloomberg
// cue that a price is live, not a stale snapshot.
//
// One instance per cell is the whole design. Movers/Peers/WEI render
// their rows in a .map(), so the hook can't be called in the loop body
// (Rules of Hooks). Instead a tiny per-row cell component calls this
// once; because the rows are keyed by ticker, React keeps each cell
// instance bound to its ticker across re-renders and reorders, so the
// prevRef below is always *that ticker's* previous price. No parent-
// held ticker→prev map, no positional compare.
//
// Decorative and defensive: a flash must never throw or gate the
// render. The value still shows even if every guard here trips.
export default function usePriceFlash(value) {
  // The last finite value we actually compared against. Deliberately a
  // ref, not state: updating it must not itself trigger a render, and
  // it has to survive the poll-driven re-renders that arrive every
  // ~20s. `undefined` means "nothing seen yet" — the first observed
  // value records into here and explicitly does not flash (no prior to
  // compare, per the locked no-spurious-flashes rule).
  const prevRef = useRef(undefined);

  // The transient direction. Set on a real change, cleared by a timer
  // ~900ms later so the class falls off and the cell is free to flash
  // again on the next tick. Null the rest of the time.
  const [dir, setDir] = useState(null);

  // Held so we can cancel a still-pending clear on unmount, and so a
  // change that lands while a previous flash is mid-fade restarts the
  // animation cleanly rather than leaking a stale timeout.
  const timerRef = useRef(null);

  // Derive whether *this* render represents a tick, and against what.
  // Done in render (not an effect) so the direction is available on the
  // same paint as the new number — the flash and the value change land
  // together, not a frame apart. We only ever touch React state from
  // inside the effect below; this block just reads/decides.
  const num = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const prev = prevRef.current;

  // A genuine tick: we have a finite new value, we had a finite prior
  // to compare it to, and they actually differ. Equal values are not a
  // tick (no flash on an unchanged refresh). A null/NaN/undefined new
  // value is not a tick and, crucially, does NOT overwrite prev — a
  // momentary gap between ticks must not make the next real value look
  // like "first observed" and either suppress a true flash or, worse,
  // flash spuriously when the same number returns. We hold the last
  // good prev through the gap.
  const changed =
    num !== null && prev !== undefined && prev !== null && num !== prev;
  const nextDir = changed ? (num > prev ? 'up' : 'down') : null;

  // Advance prev only when we have a finite value to advance it to.
  // This covers both the genuine-tick case and the first-observed case
  // (prev was undefined → record it, nextDir is null → no flash). A
  // non-finite value leaves prev untouched on purpose (see above).
  if (num !== null) {
    prevRef.current = num;
  }

  useEffect(() => {
    if (!nextDir) return;
    // Restart cleanly if a prior flash is still fading: drop its timer,
    // re-assert the direction (a no-op if unchanged, but it makes an
    // up→down flip take effect immediately), and arm a fresh clear.
    if (timerRef.current) clearTimeout(timerRef.current);
    setDir(nextDir);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setDir(null);
    }, 900);
    // nextDir is the only thing that should re-arm this. value/num are
    // intentionally out: an unchanged refresh recomputes nextDir=null
    // and must not disturb a flash already in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextDir]);

  // Clear any pending timer if the cell unmounts mid-fade (pane close,
  // ticker dropped from the set) so we don't setState on an unmounted
  // instance.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return dir;
}
