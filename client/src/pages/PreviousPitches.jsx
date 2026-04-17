import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Search, FileText, ExternalLink } from 'lucide-react';
import api from '../api/client.js';
import { safeHref } from '../api/safeUrl.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';

export default function PreviousPitches() {
  const [pitches, setPitches] = useState([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.get('/pitches').then((r) => setPitches(r.data));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = pitches.filter((p) => p.slideshowUrl);
    if (!q) return list;
    return list.filter(
      (p) =>
        p.ticker.toLowerCase().includes(q) ||
        p.pitcherName.toLowerCase().includes(q)
    );
  }, [pitches, query]);

  return (
    <>
      <PageHeader
        title="Pitch Archive"
        subtitle="Previously delivered stock pitches and their slideshows."
      />

      <Card>
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-navy-100 px-3 py-2">
          <Search className="h-4 w-4 text-navy-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ticker or pitcher name…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-navy-400">
            {pitches.some((p) => p.slideshowUrl)
              ? 'No pitches match your search.'
              : 'No pitch slideshows linked yet.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <a
                key={p.id}
                href={safeHref(p.slideshowUrl)}
                target="_blank"
                rel="noreferrer"
                className="group flex flex-col overflow-hidden rounded-lg border border-navy-100 bg-white text-left transition hover:border-gold hover:shadow-card"
              >
                <div className="flex h-36 items-center justify-center bg-navy">
                  <FileText className="h-12 w-12 text-gold" />
                </div>
                <div className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold text-navy">{p.ticker}</div>
                    <ExternalLink className="h-4 w-4 text-navy-400 group-hover:text-gold" />
                  </div>
                  {p.industry && (
                    <div className="mt-1 inline-block rounded-full bg-gold-100 px-2 py-0.5 text-[10px] font-bold text-gold-800">
                      {p.industry.name}
                    </div>
                  )}
                  <div className="mt-1 text-sm text-navy-400">
                    {p.presenters && p.presenters.length > 0
                      ? p.presenters.map((pp) => pp.name).join(', ')
                      : p.industry
                      ? `${p.industry.name} pod`
                      : p.pitcherName}
                  </div>
                  <div className="mt-2 text-xs text-navy-400">
                    {format(new Date(p.date), 'MMM d, yyyy')}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
