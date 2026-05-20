import { useEffect, useRef } from 'react';
import { isManagedFile, downloadFile } from '../api/fileHelpers.js';

// Lean in-app PDF previewer. The body is a single <iframe> pointed at a
// viewer-friendly URL so the browser's native PDF reader handles the
// render — no PDF.js, no extra client dep. The discipline below mirrors
// PersonModal 1:1 (role=dialog, aria-modal, focus on open + restore on
// close, focus trap, Esc + backdrop dismiss, click-inside no-close,
// prefers-reduced-motion, conditional mount last so hooks run in stable
// order). The two intentional differences from PersonModal:
//
//   1. position: fixed; inset: 0. PersonModal is scoped to one terminal
//      panel (the parent sets position:relative so the backdrop only
//      paints that pane — leaves the terminal var(--term-*) scope
//      intact). PDFModal opens from the main app Layout — no scoped
//      theme to stay inside, the backdrop should cover the viewport.
//   2. The body iframe is the only "tabbable" element besides the
//      header buttons, so the focus trap also wraps the iframe handle.
//
// Auth wrinkle for our OneDrive-served PDFs: `<iframe src=…>` is a
// top-level GET that cannot carry our Authorization: Bearer header. The
// existing /api/files/:itemId route is Bearer-only (verifyJwt, no query
// /cookie auth path), so embedding it would 401. v1 ships with the
// honest fallback for onedrive: refs — the preview panel says "can't
// preview inline yet" and the new-tab button triggers the existing
// authenticated download (downloadFile fetches with the Bearer header,
// streams to a blob, and the browser saves it). Drive/Slides/plain-PDF
// URLs still embed cleanly, which is the real v1 win. A small signed-
// URL endpoint (≤30 min follow-up) lifts that gap when we get to it.

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, iframe, [tabindex]:not([tabindex="-1"])';

// Rewrite well-known share URLs to their iframe-friendly cousins. Google
// Drive's /view route serves the gated UI which sets X-Frame-Options;
// /preview allows framing. Same idea for Slides /edit → /preview. Other
// http(s) URLs pass through and we trust the iframe attempt — if the
// remote sets framing headers the browser will just show a blank pane,
// the new-tab button is always reachable as the escape hatch.
export function embedUrl(url, mime) {
  if (!url) return null;
  // Our OneDrive-served files would 401 in an iframe (Bearer-only
  // route, no top-level navigation auth). Return null so the modal
  // shows the honest fallback instead of a broken viewer.
  if (isManagedFile(url)) return null;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('drive.google.com')) {
      u.pathname = u.pathname.replace(/\/view\b.*/, '/preview');
      return u.toString();
    }
    if (u.hostname.endsWith('docs.google.com')) {
      // Presentations: /edit → /preview. Same transform also covers
      // /view (Slides uses both forms in the wild).
      u.pathname = u.pathname.replace(/\/(edit|view)\b.*/, '/preview');
      return u.toString();
    }
    // SEC.gov refuses third-party framing with X-Frame-Options plus a
    // CSP frame-ancestors directive, so the direct URL paints blank
    // in our iframe. Route SEC documents through our own origin via
    // the public sec-doc-proxy: server-side it fetches the page with
    // the keyless SEC_UA we already use elsewhere, strips the
    // framing-refusal headers, and injects <base href> so SEC's
    // relative asset paths still resolve back to sec.gov. The
    // fallback "Open in new tab" link still goes to the original SEC
    // URL for the rare case the proxy can't render perfectly.
    if (u.hostname === 'www.sec.gov' || u.hostname === 'data.sec.gov') {
      // The iframe `src` is a top-level GET — not an axios call — so
      // we need the absolute API origin here. A relative `/api/...`
      // would resolve against the client origin (no /api on the
      // static site → 404 → blank pane). Same `VITE_API_BASE_URL`
      // the shared `api` axios client reads at build time.
      const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
      return `${apiBase}/api/terminal/sec-doc-proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
  } catch {
    // Non-URL strings (or odd custom schemes) — let the iframe try; if
    // it fails the new-tab button still reaches the original href via
    // window.open below.
    return url;
  }
}

// v1.1 widens the embed attempt to any http(s) document — PDFs and
// HTML alike — because the FIL terminal opens SEC EDGAR pages, which
// are plain HTML, not PDF. The iframe is best-effort: if the source
// sends X-Frame-Options / Content-Security-Policy: frame-ancestors
// that bar us, the pane just paints blank and the header's
// always-visible "Open in new tab" link is the user's escape (the
// honest-no-silent-break posture v1 already committed to). Known
// non-embeddable downloads (PPTX, DOCX, archives) still return false
// up front so we show the explicit fallback message instead of a
// useless blank iframe, and managed onedrive: refs stay false for the
// Bearer-header gap noted up top.
const NON_EMBEDDABLE_EXTS = /\.(pptx?|docx?|xlsx?|zip|rar|7z|tar|gz)(?:[?#].*)?$/i;

export function embeddable(url, mime) {
  if (!url) return false;
  if (isManagedFile(url)) return false; // see auth note above
  if (mime === 'application/pdf') return true;
  try {
    const u = new URL(url);
    if (/\.pdf(?:[?#].*)?$/i.test(u.pathname)) return true;
    if (
      (u.hostname.endsWith('drive.google.com') ||
        u.hostname.endsWith('docs.google.com')) &&
      u.pathname.includes('/preview')
    ) {
      return true;
    }
    // Widened path: any http(s) document the browser can navigate to
    // is worth attempting in an iframe (covers SEC EDGAR HTML docs,
    // arbitrary news/research pages). Skip known binary downloads
    // where an iframe attempt has no chance of rendering.
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        !NON_EMBEDDABLE_EXTS.test(u.pathname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export default function PDFModal({ url, title, mime, onClose }) {
  const dialogRef = useRef(null);
  const closeBtnRef = useRef(null);
  // Snapshot the previously-focused element BEFORE we steal focus into
  // the dialog so dismissing returns the user to whatever button opened
  // this. A ref (not state) keeps the effect pure with no re-render.
  const restoreRef = useRef(null);

  // Esc closes; Tab is trapped within the dialog. Bound to the document
  // so a keystroke still lands while focus sits on the scrollable body
  // or the iframe itself (which steals focus once the PDF viewer mounts).
  useEffect(() => {
    if (!url) return;
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
        e.preventDefault();
        root.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
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
  }, [url, onClose]);

  // Move focus in on open, restore it on close/unmount. The cleanup
  // runs on both the url→null transition and a hard unmount.
  useEffect(() => {
    if (!url) return undefined;
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeBtnRef.current?.focus();
    return () => {
      const el = restoreRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [url]);

  // Conditional mount lives last so the hooks above always run in the
  // same order. Parent may also just not render us at all.
  if (!url) return null;

  const titleId = 'pdf-modal-title';
  const src = embedUrl(url, mime);
  const canEmbed = embeddable(url, mime);
  const managed = isManagedFile(url);

  // The "Open in new tab" affordance has two routes. For external URLs
  // we just window.open them. For managed onedrive: refs the URL is a
  // pseudo-scheme — there's no public href to open — so we trigger the
  // existing authenticated download (Bearer header on a fetch, blob URL,
  // programmatic click). That's the honest v1 fallback the spec calls
  // out: members reach the file, just not inline.
  async function handleOpenExternal() {
    if (!managed) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      // Strip a trailing space-padded extension to derive a download
      // name; falls back to the title or a sensible default. The actual
      // filename the API returns wins anyway via Content-Disposition.
      const filename = (title && /\S/.test(title) ? title : 'document') + '.pdf';
      await downloadFile(url, filename);
    } catch {
      // Swallow — the fallback panel below still surfaces the message,
      // and a failed download is no worse than the old new-tab behavior
      // on a flaky network.
    }
  }

  return (
    <div
      onMouseDown={(e) => {
        // Backdrop dismiss only when the press both starts and is
        // reported on the backdrop itself — a text-select drag that
        // begins inside the dialog can't close it on release.
        if (e.target === e.currentTarget) onClose?.();
      }}
      // position:fixed (vs. PersonModal's absolute) because we're an
      // app-level overlay — no scoped theme to stay inside, the
      // backdrop should cover the entire viewport regardless of where
      // we mount in the tree. z-index 60 matches FilePreviewModal so
      // we sit above sidebar/header chrome.
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.72)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: 0,
        zIndex: 60,
      }}
      // Respect prefers-reduced-motion. We have no transitions to
      // suppress today, but the attribute is here so any future
      // flourish (fade-in, scale) can branch on it without touching
      // the dialog structure.
      data-prefers-reduced-motion={
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'reduce'
          : 'no-preference'
      }
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col bg-white shadow-xl md:h-[90vh] md:max-h-[90vh] md:max-w-5xl md:overflow-hidden md:rounded-xl md:my-auto"
        style={{ alignSelf: 'center' }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-navy-50 px-4 py-3 md:px-5 md:py-4">
          <h2
            id={titleId}
            className="truncate text-base font-semibold text-navy md:text-lg"
          >
            {title || 'Document'}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpenExternal}
              className="rounded-lg border border-navy-100 px-2.5 py-1 text-xs font-semibold text-navy hover:bg-navy-50"
              title={managed ? 'Download a copy' : 'Open in a new tab'}
            >
              {managed ? 'Download' : 'Open in new tab'}
            </button>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={() => onClose?.()}
              aria-label="Close"
              className="rounded-lg border border-navy-100 px-3 py-1 text-sm font-semibold text-navy-400 hover:bg-navy-50 hover:text-navy"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-navy-50">
          {canEmbed && src ? (
            <iframe
              src={src}
              title={title || 'Document'}
              className="h-full w-full"
              // Drive/Slides preview pages render full-screen controls;
              // anything more permissive is unnecessary for a PDF.
              allow="fullscreen"
            />
          ) : (
            <FallbackPanel
              managed={managed}
              onOpenExternal={handleOpenExternal}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Honest fallback when we can't render inline — never a fake viewer,
// never a silent failure. The copy is plain English: tell the reader
// why and give them the one action that does work.
function FallbackPanel({ managed, onOpenExternal }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm text-navy">
        {managed
          ? "This file can't preview inline yet — download it to view."
          : "This file can't preview inline — open it in a new tab to view."}
      </p>
      <button
        type="button"
        onClick={onOpenExternal}
        className="inline-flex items-center gap-1 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:bg-navy-50"
      >
        {managed ? 'Download' : 'Open in new tab'}
      </button>
    </div>
  );
}
