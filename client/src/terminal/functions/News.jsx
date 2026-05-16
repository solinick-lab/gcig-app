import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';

// CN — company news. Reuses /api/holdings/news/:ticker.
// Auto-polls every 60s for fresh headlines. New stories flash amber briefly.

const POLL_INTERVAL_MS = 60_000;

export default function News({ ticker }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [newIds, setNewIds] = useState(new Set());
  const prevUrlsRef = useRef(new Set());

  // Fetch news (initial + poll)
  const fetchNews = (isInitial) => {
    if (!ticker) return;
    if (isInitial) {
      setLoading(true);
      setErr(null);
      setItems([]);
      setBrief('');
      prevUrlsRef.current = new Set();
    }
    api
      .get(`/holdings/news/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        const list = Array.isArray(data)
          ? data
          : data?.articles || data?.items || [];
        const sliced = list.slice(0, 20);

        // Detect new headlines on poll refreshes
        if (!isInitial && prevUrlsRef.current.size > 0) {
          const fresh = new Set();
          for (const it of sliced) {
            const key = it.url || it.link || it.title;
            if (!prevUrlsRef.current.has(key)) fresh.add(key);
          }
          if (fresh.size > 0) {
            setNewIds(fresh);
            setTimeout(() => setNewIds(new Set()), 4000);
          }
        }

        prevUrlsRef.current = new Set(sliced.map((it) => it.url || it.link || it.title));
        setItems(sliced);
        setLastRefresh(new Date());
      })
      .catch((e) => {
        if (isInitial) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (isInitial) setLoading(false);
      });
  };

  // Initial fetch on ticker change
  useEffect(() => {
    fetchNews(true);
  }, [ticker]);

  // Auto-poll every 60s
  useEffect(() => {
    if (!ticker) return;
    const id = setInterval(() => fetchNews(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ticker]);

  // Header clock ticks every second so the panel reads as live rather
  // than frozen at the last 60s poll.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // AI brief on new data
  useEffect(() => {
    if (!items.length || !ticker) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = [...items]
      .sort((a, b) => tsOf(b) - tsOf(a))
      .slice(0, 8)
      .map((it, i) => `${i + 1}. ${formatTime(it.publishedAt || it.providerPublishTime || it.time)} — ${it.title || ''}`)
      .join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'CN', context })
      .then(({ data }) => {
        if (!cancelled) setBrief(data.brief || '');
      })
      .catch(() => {
        if (!cancelled) setBrief('');
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [items, ticker]);

  if (!ticker) {
    return <div className="term-panel"><div className="term-loading">Enter a ticker to load news.</div></div>;
  }
  if (loading) return <div className="term-panel"><div className="term-loading">Loading news…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;

  // Provider feeds aren't reliably time-ordered. Sort newest-first so
  // the list is a single timeline.
  const ordered = [...items].sort((a, b) => tsOf(b) - tsOf(a));

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Company News</span>
        <span className="term-live-badge">● LIVE</span>
        {lastRefresh && (
          <span className="term-refresh-ts">
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
          </span>
        )}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div>
        {ordered.length === 0 ? (
          <div className="term-loading">No recent stories.</div>
        ) : (
          ordered.map((it, i) => {
            const href = it.url || it.link;
            const key = href || it.title || i;
            const isNew = newIds.has(it.url || it.link || it.title);
            return (
              <div className={`term-news-row${isNew ? ' term-news-flash' : ''}`} key={key}>
                <span className="time">
                  {formatTime(it.publishedAt || it.providerPublishTime || it.time)}
                </span>
                <span className="title">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">{it.title}</a>
                  ) : (
                    it.title
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Comparable epoch ms for sorting, mirroring formatTime's parsing
// (providerPublishTime is seconds since epoch). Undated stories sink.
function tsOf(it) {
  const ts = it?.publishedAt ?? it?.providerPublishTime ?? it?.time;
  if (ts == null) return -Infinity;
  const d =
    typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  const t = d.getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

function formatTime(ts) {
  if (!ts) return '—';
  let d;
  if (typeof ts === 'number') {
    d = new Date(ts < 1e12 ? ts * 1000 : ts);
  } else {
    d = new Date(ts);
  }
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
