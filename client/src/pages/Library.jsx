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
        kicker="Research Archive"
        title="Library"
        subtitle="Searchable reference content — pitch slideshows and research reports."
      />
      <div className="mb-6 flex gap-6 border-b border-navy-100">
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
