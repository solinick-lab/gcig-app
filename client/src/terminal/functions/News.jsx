import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// CN — company news. Reuses /api/holdings/news/:ticker.
export default function News({ ticker }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setItems([]);
    setBrief('');
    api
      .get(`/holdings/news/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        if (cancelled) return;
        const list = Array.isArray(data)
          ? data
          : data?.articles || data?.items || [];
        setItems(list.slice(0, 20));
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!items.length || !ticker) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = items
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

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Company News</span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div>
        {items.length === 0 ? (
          <div className="term-loading">No recent stories.</div>
        ) : (
          items.map((it, i) => {
            const href = it.url || it.link;
            return (
              <div className="term-news-row" key={it.uuid || it.id || href || i}>
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

function formatTime(ts) {
  if (!ts) return '—';
  let d;
  if (typeof ts === 'number') {
    // Yahoo's providerPublishTime is seconds since epoch.
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
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
