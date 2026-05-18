import usePriceFlash from '../hooks/usePriceFlash.js';

// The cell-content wrapper that puts the tick flash on screen. It is
// deliberately the thinnest possible thing: an inline <span> around
// whatever already-formatted price node the panel hands it, plus a
// transient tick-up/tick-down class while the value is flashing.
//
// Why a component and not a bare hook call at the panel: Movers, Peers
// and WEI render their price rows in a .map(), and a hook cannot be
// called inside that loop. Rendering one <FlashPrice> per row moves
// the hook into a component that mounts once per row instead — and
// since the rows are keyed by ticker, each instance stays bound to its
// ticker across refreshes and reorders, so its previous-value tracking
// is correctly per-ticker without any parent-side bookkeeping.
//
// Contract: `value` is the live numeric to watch (the same effective
// last/level the cell is showing); `children` is the panel's own
// formatted node, rendered verbatim so every panel keeps its own
// fmt(); `className` carries the cell's existing classes. The span is
// inline and adds nothing but the flash class, so text, alignment and
// the number itself are untouched — purely a decorative background
// pulse around the same content. In the table panels this span lives
// *inside* the existing <td>, so column widths and cell classes are
// undisturbed; in WEI it is the grid cell itself and carries the
// cell's `num` class directly, exactly as the plain <span> did before.
export default function FlashPrice({ value, children, className = '' }) {
  const dir = usePriceFlash(value);
  const flashClass = dir === 'up' ? 'tick-up' : dir === 'down' ? 'tick-down' : '';
  const cls = `${className} ${flashClass}`.trim();
  return <span className={cls || undefined}>{children}</span>;
}
