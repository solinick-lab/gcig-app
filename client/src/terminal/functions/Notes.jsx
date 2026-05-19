import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';

// NOTE — a private, per-member research note on the focused ticker,
// persisted to the member's profile (one note per user per ticker).
// The personal counterpart to the club-wide HoldingThesis: a place to
// jot a thesis, open questions, or a reminder while doing diligence,
// durable across logout/reload and visible only to its owner.
//
// Unlike the read-only data panels (EARN/CON/FIL), this one writes.
// Saving is explicit — an editor never silently round-trips keystrokes
// — so the contract is: load on mount/ticker-change, edit freely, then
// Save (PUT) or Clear (empties + saves → the server deletes the row).
// A failed save keeps the user's text on screen and shows the error;
// it does NOT wipe the textarea. No live polling — a note only changes
// when its owner changes it.

const MAX_BODY = 10_000;

const fmtSavedAt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
};

export default function Notes({ ticker }) {
  // The persisted text (last known server state) vs. the working copy
  // in the textarea. "Unsaved changes" is simply the two diverging.
  const [savedBody, setSavedBody] = useState('');
  const [draft, setDraft] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [authErr, setAuthErr] = useState(false);

  // Save lifecycle: idle | saving | saved | error. `saveErr` carries
  // the surfacing message; the textarea is never cleared on error.
  const [saveState, setSaveState] = useState('idle');
  const [saveErr, setSaveErr] = useState(null);

  // Guards a late save response from a previous ticker landing on the
  // new ticker's editor (same hazard the fetch cancelled-guard covers).
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    setAuthErr(false);
    setSaveState('idle');
    setSaveErr(null);
    setSavedBody('');
    setDraft('');
    setUpdatedAt(null);
    api
      .get(`/notes/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        if (cancelled) return;
        const body = typeof data?.body === 'string' ? data.body : '';
        setSavedBody(body);
        setDraft(body);
        setUpdatedAt(data?.updatedAt || null);
      })
      .catch((e) => {
        if (cancelled) return;
        // Terminal users are authed, but degrade honestly if the
        // session lapsed mid-session rather than showing a raw error.
        if (e.response?.status === 401) {
          setAuthErr(true);
        } else {
          setLoadErr(e.response?.data?.error || e.message || 'Failed to load');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  const dirty = draft !== savedBody;

  // Save the current draft. An empty/whitespace draft is a deliberate
  // "clear" — the server deletes the row and we settle on the empty
  // state. On any failure we keep `draft` exactly as the user left it
  // and surface the error; savedBody is untouched so it still reads as
  // unsaved and the Save button stays live for a retry.
  function persist(nextDraft) {
    if (!ticker) return;
    const seq = ++reqSeq.current;
    setSaveState('saving');
    setSaveErr(null);
    api
      .put(`/notes/${encodeURIComponent(ticker)}`, { body: nextDraft })
      .then(({ data }) => {
        if (seq !== reqSeq.current) return; // superseded by a newer save
        const body = typeof data?.body === 'string' ? data.body : '';
        setSavedBody(body);
        setDraft(body);
        setUpdatedAt(data?.updatedAt || null);
        setSaveState('saved');
      })
      .catch((e) => {
        if (seq !== reqSeq.current) return;
        if (e.response?.status === 401) {
          setAuthErr(true);
          setSaveState('idle');
          return;
        }
        // Keep the user's text. Only the status flips to error.
        setSaveErr(e.response?.data?.error || e.message || 'Could not save');
        setSaveState('error');
      });
  }

  const onSave = () => persist(draft);
  const onClear = () => {
    // Empty the editor and persist the emptiness — the server turns an
    // empty body into a delete, so the note is genuinely gone, durably.
    setDraft('');
    persist('');
  };

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">
          Enter a ticker to open your research notes.
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">
          Loading your notes for {ticker.toUpperCase()}…
        </div>
      </div>
    );
  }
  if (authErr) {
    return (
      <div className="term-panel">
        <div className="term-error">Sign in to keep notes.</div>
      </div>
    );
  }
  if (loadErr) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {loadErr}</div>
      </div>
    );
  }

  const saving = saveState === 'saving';
  const status = saving
    ? 'Saving…'
    : saveState === 'error'
    ? saveErr || 'Could not save'
    : dirty
    ? 'Unsaved changes'
    : savedBody
    ? `Saved ✓${updatedAt ? ` · ${fmtSavedAt(updatedAt)}` : ''}`
    : 'No note yet — start typing.';
  const statusColor =
    saveState === 'error'
      ? 'var(--term-negative)'
      : dirty && !saving
      ? 'var(--term-amber, var(--term-white))'
      : 'var(--term-fg-muted)';

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Notes</span>
      </div>

      <textarea
        value={draft}
        maxLength={MAX_BODY}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          // Leaving the saved/error state the moment the user types
          // again — the status should track the live edit, not stick.
          if (saveState === 'saved' || saveState === 'error') {
            setSaveState('idle');
            setSaveErr(null);
          }
        }}
        placeholder={`Your private research notes for ${ticker.toUpperCase()} — thesis, open questions, reminders. Saved to your profile.`}
        rows={16}
        style={{
          width: '100%',
          resize: 'vertical',
          minHeight: 220,
          background: 'var(--term-bg, #000)',
          color: 'var(--term-white)',
          border: '1px solid var(--term-border)',
          padding: '10px 12px',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: 1.5,
          outline: 'none',
        }}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
          className="term-btn"
          style={{
            background: 'transparent',
            color:
              saving || !dirty
                ? 'var(--term-fg-muted)'
                : 'var(--term-white)',
            border: '1px solid var(--term-border)',
            padding: '5px 14px',
            fontFamily: 'inherit',
            fontSize: 12,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            cursor: saving || !dirty ? 'default' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={saving || (!draft && !savedBody)}
          className="term-btn"
          style={{
            background: 'transparent',
            color:
              saving || (!draft && !savedBody)
                ? 'var(--term-fg-muted)'
                : 'var(--term-fg-dim)',
            border: '1px solid var(--term-border)',
            padding: '5px 14px',
            fontFamily: 'inherit',
            fontSize: 12,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            cursor:
              saving || (!draft && !savedBody) ? 'default' : 'pointer',
          }}
        >
          Clear
        </button>

        <span style={{ color: statusColor, fontSize: 12 }}>{status}</span>

        <span
          style={{
            marginLeft: 'auto',
            color: 'var(--term-fg-muted)',
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {draft.length.toLocaleString()} / {MAX_BODY.toLocaleString()}
        </span>
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Private to you and saved to your profile — not shared with the
        club. One note per ticker; Clear removes it.
      </div>
    </div>
  );
}
