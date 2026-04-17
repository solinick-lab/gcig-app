import { useState } from 'react';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Members from './Members.jsx';
import AuditLog from './AuditLog.jsx';

export default function Admin() {
  const { isAdmin } = useAuth();
  const tabs = [
    { id: 'members', label: 'Members' },
    ...(isAdmin ? [{ id: 'audit', label: 'Audit Log' }] : []),
  ];
  const [tab, setTab] = useState('members');

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="Manage members and review security events."
      />
      <div className="mb-4 flex gap-1 border-b border-navy-100">
        {tabs.map((t) => (
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
      {tab === 'audit' && isAdmin ? <AuditLog embedded /> : <Members embedded />}
    </>
  );
}
