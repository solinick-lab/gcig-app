import { useEffect, useRef, useState } from 'react';
import api from '../../api/client.js';

// TOP — market-wide top headlines. Auto-polls every 60s.
// Uses the terminal/top-news endpoint (Finnhub general feed, 10-min server cache).

const POLL_INTERVAL_MS = 60_000;

export default function TopNews() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [newIds, setNewIds] = useState(new Set());
  const prevUrlsRef = useRef(new Set());

  const fetchTop = (isInitial) => {
    if (isInitial) {
      setLoading(true);
      setErr(null);
      setItems([]);
      setBrief('');
      prevUrlsRef.current = new Set();
    }
    api
      .get('/terminal/top-news')
      .then(({ data }) => {
        const list = data?.articles || [];

        if (!isInitial && prevUrlsRef.current.size > 0) {
          const fresh = new Set();
          for (const it of list) {
            if (!prevUrlsRef.current.has(it.url)) fresh.add(it.url);
          }
          if (fresh.size > 0) {
            setNewIds(fresh);
            setTimeout(() => setNewIds(new Set()), 4000);
          }
        }

        prevUrlsRef.current = new Set(list.map((it) => it.url));
        setItems(list);
        setLastRefresh(new Date());
      })
      .catch((e) => {
        if (isInitial) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (isInitial) setLoading(false);
      });
  };

  useEffect(() => {
    fetchTop(true);
  }, []);

  useEffect(() => {
    const id = setInterval(() => fetchTop(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // AI brief
  useEffect(() => {
    if (!items.length) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = items
      .slice(0, 10)
      .map((it, i) => `${i + 1}. ${formatTime(it.publishedAt)} — ${it.title || ''} (${it.source || ''})`)
      .join('\n');
    api
      .post('/terminal/annotate', { ticker: '', function: 'TOP', context })
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
  }, [items]);

  if (loading) return <div className="term-panel"><div className="term-loading">Loading top news…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">TOP</span>
        <span className="name">Market Headlines</span>
        <span className="term-live-badge">● LIVE</span>
        {lastRefresh && (
          <span className="term-refresh-ts">
            {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          </span>
        )}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div>
        {items.length === 0 ? (
          <div className="term-loading">No headlines available.</div>
        ) : (
          items.map((it, i) => {
            const isNew = newIds.has(it.url);
            return (
              <div className={`term-news-row${isNew ? ' term-news-flash' : ''}`} key={it.url || i}>
                <span className="time">{formatTime(it.publishedAt)}</span>
                <span className="source">{it.source || ''}</span>
                <span className="title">
                  {it.url ? (
                    <a href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a>
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

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
