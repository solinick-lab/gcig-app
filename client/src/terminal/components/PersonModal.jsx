import { useEffect, useRef } from 'react';

// A person's profile/bio over the MGMT panel. Directors carry a bio
// straight from the DEF 14A; exec bios arrive lazily from the 10-K so
// the parent owns the fetch and hands us { person, bio, loading } —
// this component never touches the network and never invents prose.
//
// Rendered in place (not a portal) on purpose: the terminal theme is
// scoped to the [data-theme="terminal"] subtree, so the inline
// var(--term-*) reads below only resolve while we stay inside it.

const dash = (v) => (v == null || v === '' ? '—' : v);

// Split a bio into display paragraphs. SEC prose comes through as
// either real newlines or run-together sentences glued by the
// double-space the parser leaves between source blocks; treat both
// as breaks and drop empties so a stray gap can't render a blank
// paragraph.
function toParagraphs(text) {
  return String(text)
    .split(/\n+|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Selector for the elements Tab should cycle through inside the
// dialog. Deliberately narrow — the modal only ever holds the close
// button and (scrollable) text, so this is mostly future-proofing
// the trap against richer content later.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export default function PersonModal({ person, bio, loading, onClose }) {
  const dialogRef = useRef(null);
  const closeBtnRef = useRef(null);
  // The element focus should snap back to on close — captured once,
  // before we steal focus into the dialog, so dismissing returns the
  // user to the exact row button they opened this from.
  const restoreRef = useRef(null);

  // Esc closes; Tab is trapped within the dialog. Bound to the
  // document so a keystroke still lands while focus sits on the
  // scrollable body (which isn't itself a focus target).
  useEffect(() => {
    if (!person) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const nodes = Array.from(root.querySelectorAll(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement
      );
      if (nodes.length === 0) {
        // Nothing tabbable but the dialog itself — keep focus pinned
        // there rather than letting it escape to the page behind.
        e.preventDefault();
        root.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      // Wrap at both ends, and also reel focus back in if it somehow
      // sits outside the dialog (e.g. browser chrome round-trip).
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [person, onClose]);

  // Move focus in on open, restore it on close/unmount. Storing the
  // previously-focused node in a ref (not state) keeps this a pure
  // side effect with no re-render, and the cleanup runs on both the
  // person→null transition and a hard unmount.
  useEffect(() => {
    if (!person) return undefined;
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Focus the close control rather than the dialog shell so the
    // first Tab/Enter does something useful and screen readers
    // announce an actionable element straight away.
    closeBtnRef.current?.focus();
    return () => {
      const el = restoreRef.current;
      // Only restore if that element is still in the document and
      // focusable — a ticker switch can unmount the row underneath us.
      if (el && document.contains(el)) el.focus();
    };
  }, [person]);

  // Conditional mount lives last so the hooks above always run in the
  // same order; the parent may also just not render us at all.
  if (!person) return null;

  const titleId = 'person-modal-title';

  // Compact fact line, same grammar as the Leadership/Comp tabs:
  // title · age · since · total · pay mix, each part omitted when
  // absent so a director (no comp) doesn't show a row of dashes.
  const facts = [];
  if (person.title) facts.push(dash(person.title));
  if (person.age != null && person.age !== '') facts.push(`age ${person.age}`);
  if (person.since != null && person.since !== '')
    facts.push(`since ${person.since}`);
  if (person.total != null && person.total !== '')
    facts.push(`total $${Number(person.total).toLocaleString()}`);
  const mix = [
    person.salaryPct == null ? null : `${person.salaryPct}% salary`,
    person.stockPct == null ? null : `${person.stockPct}% stock`,
    person.optionPct == null ? null : `${person.optionPct}% options`,
    person.otherPct == null ? null : `${person.otherPct}% other`,
  ].filter(Boolean);

  const hasBio = typeof bio === 'string' && bio.trim().length > 0;

  return (
    <div
      onMouseDown={(e) => {
        // Backdrop dismiss. Fires only when the press both starts and
        // is reported on the backdrop itself, so a text drag that
        // begins inside the dialog can't close it on release.
        if (e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: 'var(--term-bg-panel)',
          border: '1px solid var(--term-border-focused)',
          width: 'min(560px, 100%)',
          maxHeight: 'min(80vh, 640px)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 0 0 100vmax rgba(0, 0, 0, 0.4)',
        }}
      >
        <div
          className="term-panel-header"
          style={{
            padding: '10px 14px',
            margin: 0,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              id={titleId}
              className="sym"
              style={{ fontSize: 15, fontWeight: 700 }}
            >
              {person.name}
            </div>
            {facts.length > 0 && (
              <div
                style={{
                  color: 'var(--term-fg-dim)',
                  fontSize: 11,
                  marginTop: 3,
                }}
              >
                {facts.join(' · ')}
              </div>
            )}
            {mix.length > 0 && (
              <div
                style={{
                  color: 'var(--term-fg-muted)',
                  fontSize: 11,
                  marginTop: 2,
                }}
              >
                {mix.join(' · ')}
              </div>
            )}
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={() => onClose?.()}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: '1px solid var(--term-border)',
              color: 'var(--term-fg-dim)',
              font: 'inherit',
              fontSize: 14,
              lineHeight: 1,
              padding: '3px 9px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            padding: '12px 14px',
            overflowY: 'auto',
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--term-white)',
          }}
        >
          {loading ? (
            <div className="term-loading">Loading bio…</div>
          ) : hasBio ? (
            toParagraphs(bio).map((p, i) => (
              <p
                key={i}
                style={{ margin: i === 0 ? '0 0 8px' : '8px 0' }}
              >
                {p}
              </p>
            ))
          ) : (
            // No fabrication: say plainly that the filing carried no
            // bio. The fact line above still gives the reader the
            // structured comp/tenure we do have.
            <div style={{ color: 'var(--term-fg-dim)', fontStyle: 'italic' }}>
              No bio disclosed in this company&apos;s SEC filing.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
