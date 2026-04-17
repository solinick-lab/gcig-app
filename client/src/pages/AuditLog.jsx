import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';

const ACTION_COLOR = {
  'login.success': 'bg-emerald-50 text-emerald-800',
  'login.failed': 'bg-red-50 text-red-800',
  'user.deleted': 'bg-red-50 text-red-800',
  'user.password_reset_by_admin': 'bg-gold-100 text-gold-800',
  'password_reset.requested': 'bg-gold-100 text-gold-800',
  'password_reset.completed': 'bg-emerald-50 text-emerald-800',
  'session.logout_everywhere': 'bg-gold-100 text-gold-800',
};

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/audit').then(({ data }) => {
      setLogs(data);
      setLoading(false);
    });
  }, []);

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="Security-relevant actions across the app. President only."
      />
      <Card>
        {loading ? (
          <div className="py-8 text-center text-navy-400">Loading…</div>
        ) : logs.length === 0 ? (
          <div className="py-8 text-center text-navy-400">No events yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Who</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Details</th>
                  <th className="py-2 pr-4">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-50">
                {logs.map((l) => {
                  const color = ACTION_COLOR[l.action] || 'bg-navy-50 text-navy';
                  let metaPreview = '';
                  if (l.metadata) {
                    try {
                      const parsed = JSON.parse(l.metadata);
                      metaPreview = Object.entries(parsed)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ');
                    } catch {
                      metaPreview = l.metadata;
                    }
                  }
                  return (
                    <tr key={l.id}>
                      <td className="py-2 pr-4 whitespace-nowrap text-xs text-navy-400">
                        {format(new Date(l.createdAt), 'MMM d, h:mm:ss a')}
                      </td>
                      <td className="py-2 pr-4 text-sm text-navy">
                        {l.userName || '—'}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${color}`}
                        >
                          {l.action}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-xs text-navy-400">
                        {l.resource}
                        {l.resourceId ? ` #${l.resourceId}` : ''}
                      </td>
                      <td className="py-2 pr-4 text-xs text-navy">{metaPreview}</td>
                      <td className="py-2 pr-4 text-xs text-navy-400 font-mono">
                        {l.ip || ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
