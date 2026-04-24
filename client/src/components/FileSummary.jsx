import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import api from '../api/client.js';
import { extractItemId, isManagedFile } from '../api/fileHelpers.js';

// AI summary panel for an uploaded file. Given a fileRef that points
// at a managed OneDrive file (e.g. `onedrive:ITEM_ID`), this:
//
//   1. On mount, fetches the cached summary (if any) via GET /summary.
//   2. If none exists, shows a "Generate summary" button. Click calls
//      POST /summarize which runs the LLM (10-30s).
//   3. Once rendered, shows a discreet "Regenerate" button for fresh
//      runs after the file is replaced.
//
// Renders nothing for non-managed file refs (external Google Drive
// links, etc.) because we don't have the bytes to extract.

// Markdown renderer tuned to match the rest of the app's type palette.
const MD = {
  h2: ({ children }) => (
    <h3 className="mb-1 mt-3 font-serif text-sm font-semibold text-navy first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-1 mt-2 font-serif text-sm font-semibold text-navy first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-navy">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
};

export default function FileSummary({ fileRef, filename, compact = false }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const itemId = extractItemId(fileRef);
  const supported = isManagedFile(fileRef);

  useEffect(() => {
    if (!supported || !itemId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/files/${encodeURIComponent(itemId)}/summary`)
      .then(({ data }) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err) => {
        if (!cancelled) {
          if (err.response?.status === 404) {
            // No summary yet — normal state, not an error.
            setSummary(null);
          } else {
            setError(err.response?.data?.error || 'Could not load summary');
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, supported]);

  async function generate(force = false) {
    if (!itemId) return;
    setGenerating(true);
    setError('');
    try {
      const url = `/files/${encodeURIComponent(itemId)}/summarize${force ? '?force=1' : ''}`;
      const { data } = await api.post(url);
      setSummary(data);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          'Summary generation failed. The model may be cold or the file may be image-only.'
      );
    } finally {
      setGenerating(false);
    }
  }

  // Not a managed file → nothing we can summarize.
  if (!supported) return null;
  if (loading) {
    return compact ? null : (
      <div className="mt-2 text-xs text-navy-400">Checking for summary…</div>
    );
  }

  if (summary) {
    const updated = summary.updatedAt
      ? new Date(summary.updatedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '';
    return (
      <div className="rounded-xl border border-gold-200 bg-[#FFFDF5] px-3 py-3 md:px-4 md:py-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gold-700">
          <Sparkles className="h-3.5 w-3.5" />
          AI Summary
          {summary.truncated && (
            <span className="text-[10px] normal-case tracking-normal text-navy-400">
              · based on first portion of doc
            </span>
          )}
          <button
            type="button"
            onClick={() => generate(true)}
            disabled={generating}
            title="Regenerate from the current file"
            className="ml-auto inline-flex items-center gap-1 text-navy-400 hover:text-navy disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${generating ? 'animate-spin' : ''}`}
            />
            <span className="text-[10px] normal-case tracking-normal">
              {generating ? 'Regenerating…' : 'Regenerate'}
            </span>
          </button>
        </div>
        <div className="text-sm leading-relaxed text-navy">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
            {summary.summary}
          </ReactMarkdown>
        </div>
        <div className="mt-2 text-[10px] text-navy-400">
          {summary.model === 'local' ? 'House model' : 'OpenAI fallback'} ·{' '}
          {updated}
        </div>
        {error && (
          <div className="mt-2 text-[11px] font-semibold text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  // No summary yet — offer generation.
  return (
    <div className="rounded-xl border border-dashed border-navy-100 bg-navy-50/40 px-3 py-3 md:px-4 md:py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-navy-500">
          <Sparkles className="h-3.5 w-3.5 text-gold-700" />
          <span>
            {filename ? `No AI summary for ${filename} yet.` : 'No AI summary yet.'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => generate(false)}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy transition hover:border-gold hover:bg-gold-100/40 disabled:opacity-60"
        >
          {generating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Summarizing…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              Generate summary
            </>
          )}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-[11px] font-semibold text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
