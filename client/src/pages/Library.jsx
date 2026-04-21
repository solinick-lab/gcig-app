import { useEffect, useState } from 'react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import EditorialMasthead from '../components/EditorialMasthead.jsx';
import PreviousPitches from './PreviousPitches.jsx';
import Reports from './Reports.jsx';

const TABS = [
  { id: 'pitches', label: 'Pitch Archive' },
  { id: 'reports', label: 'Research Reports' },
];

export default function Library() {
  const [tab, setTab] = useState('pitches');
  const [stats, setStats] = useState({ pitches: null, reports: null });

  // Small parallel fetch so the masthead can show real archive counts.
  // Errors fall through silently — the masthead just hides.
  useEffect(() => {
    Promise.all([
      api.get('/pitches').then((r) => r.data).catch(() => []),
      api.get('/reports').then((r) => r.data).catch(() => []),
    ]).then(([pitches, reports]) =>
      setStats({ pitches: pitches.length, reports: reports.length })
    );
  }, []);

  return (
    <>
      <PageHeader
        kicker="Research Archive"
        title="Library"
        subtitle="Searchable reference content — pitch slideshows and research reports."
      />

      {stats.pitches != null && (
        <EditorialMasthead
          stats={[
            {
              kicker: 'Pitches Archived',
              value: stats.pitches,
              sub: 'Slide decks catalogued',
            },
            {
              kicker: 'Research Reports',
              value: stats.reports,
              sub: 'Member-authored write-ups',
            },
            {
              kicker: 'Total Records',
              value: stats.pitches + stats.reports,
              sub: 'Across pitches + reports',
            },
          ]}
        />
      )}

      <div className="mb-6 mt-6 flex gap-6 border-b border-navy-100">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative pb-3 font-serif text-lg font-semibold transition ${
              tab === t.id
                ? 'text-navy'
                : 'text-navy-400 hover:text-navy'
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute -bottom-px left-0 h-[2px] w-full bg-gold" />
            )}
          </button>
        ))}
      </div>
      {tab === 'pitches' ? <PreviousPitches embedded /> : <Reports embedded />}
    </>
  );
}
