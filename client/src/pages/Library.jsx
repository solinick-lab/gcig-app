import { useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import PreviousPitches from './PreviousPitches.jsx';
import Reports from './Reports.jsx';

const TABS = [
  { id: 'pitches', label: 'Pitch Archive' },
  { id: 'reports', label: 'Research Reports' },
];

export default function Library() {
  const [tab, setTab] = useState('pitches');

  return (
    <>
      <PageHeader
        title="Library"
        subtitle="Searchable reference content — pitch slideshows and research reports."
      />
      <div className="mb-4 flex gap-1 border-b border-navy-100">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-semibold transition ${
              tab === t.id
                ? 'border-b-2 border-gold text-navy'
                : 'text-navy-400 hover:text-navy'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pitches' ? <PreviousPitches embedded /> : <Reports embedded />}
    </>
  );
}
