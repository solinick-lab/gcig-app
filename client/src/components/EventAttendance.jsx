import { useEffect, useState } from 'react';
import api from '../api/client.js';
import RoleBadge from './RoleBadge.jsx';

const STATUSES = ['Present', 'Absent', 'Excused'];
const STATUS_COLORS = {
  Present: 'bg-emerald-100 text-emerald-800',
  Absent: 'bg-red-100 text-red-800',
  Excused: 'bg-gold-100 text-gold-800',
};

export default function EventAttendance({ eventId }) {
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    if (!eventId) return;
    setData(null);
    api.get(`/attendance/event/${eventId}`).then((r) => setData(r.data));
  }, [eventId]);

  async function setStatus(userId, status) {
    setSaving(userId);
    const prev = data.records[userId];
    setData({ ...data, records: { ...data.records, [userId]: status } });
    try {
      await api.post('/attendance', { userId, eventId, status });
    } catch {
      // revert on failure
      setData({ ...data, records: { ...data.records, [userId]: prev } });
    } finally {
      setSaving(null);
    }
  }

  function markAll(status) {
    data.users.forEach((u) => setStatus(u.id, status));
  }

  if (!data) return <div className="text-sm text-navy-400">Loading members…</div>;

  const marked = Object.keys(data.records).length;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-navy-400">
          Attendance ({marked} / {data.users.length} marked)
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => markAll('Present')}
            className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            All Present
          </button>
          <button
            type="button"
            onClick={() => markAll('Absent')}
            className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-800 hover:bg-red-100"
          >
            All Absent
          </button>
        </div>
      </div>

      <ul className="divide-y divide-navy-50 rounded-lg border border-navy-100">
        {data.users.map((u) => {
          const status = data.records[u.id] || '';
          return (
            <li
              key={u.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-navy">{u.name}</div>
                <div className="mt-0.5">
                  <RoleBadge role={u.role} />
                </div>
              </div>
              <select
                value={status}
                disabled={saving === u.id}
                onChange={(e) => setStatus(u.id, e.target.value)}
                className={`rounded-md border border-navy-100 px-2 py-1 text-xs font-semibold ${
                  status ? STATUS_COLORS[status] : ''
                }`}
              >
                <option value="">—</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
