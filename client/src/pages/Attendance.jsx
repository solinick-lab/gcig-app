import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Download } from 'lucide-react';
import api, { API_BASE } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

const STATUSES = ['Present', 'Absent', 'Excused'];
const STATUS_COLORS = {
  Present: 'bg-emerald-100 text-emerald-800',
  Absent: 'bg-red-100 text-red-800',
  Excused: 'bg-gold-100 text-gold-800',
};

export default function Attendance() {
  const { isAdmin } = useAuth();
  return isAdmin ? <AdminAttendance /> : <MineAttendance />;
}

function MineAttendance() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/attendance/mine').then((r) => setData(r.data));
  }, []);

  if (!data) return <div>Loading…</div>;

  return (
    <>
      <PageHeader
        title="My Attendance"
        subtitle="Your attendance record across all club meetings and events."
      />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <div className="text-xs uppercase text-navy-400">Attendance Rate</div>
          <div className="mt-2 text-3xl font-bold text-navy">{data.percentage}%</div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-navy-400">Total Meetings</div>
          <div className="mt-2 text-3xl font-bold text-navy">{data.total}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-navy-400">Present</div>
          <div className="mt-2 text-3xl font-bold text-emerald-600">{data.present}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase text-navy-400">Excused</div>
          <div className="mt-2 text-3xl font-bold text-gold-700">{data.excused}</div>
        </Card>
      </div>

      <div className="mt-6">
        <Card title="History">
          {data.records.length === 0 ? (
            <div className="py-8 text-center text-navy-400">No attendance records yet.</div>
          ) : (
            <ul className="divide-y divide-navy-50">
              {data.records.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="font-semibold text-navy">{r.event.title}</div>
                    <div className="text-xs text-navy-400">
                      {format(new Date(r.event.date), 'MMM d, yyyy')}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ${STATUS_COLORS[r.status]}`}
                  >
                    {r.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function AdminAttendance() {
  const [data, setData] = useState({ users: [], events: [], records: [] });
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/attendance');
    setData(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const recordMap = useMemo(() => {
    const m = new Map();
    for (const r of data.records) m.set(`${r.userId}:${r.eventId}`, r.status);
    return m;
  }, [data.records]);

  async function setStatus(userId, eventId, status) {
    // Optimistic
    const key = `${userId}:${eventId}`;
    const prev = recordMap.get(key);
    recordMap.set(key, status);
    setData({ ...data });
    try {
      await api.post('/attendance', { userId, eventId, status });
      load();
    } catch {
      if (prev) recordMap.set(key, prev);
      else recordMap.delete(key);
      setData({ ...data });
    }
  }

  async function downloadCsv() {
    const token = localStorage.getItem('gcig_token');
    const res = await fetch(`${API_BASE}/attendance/export.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gcig-attendance.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Mark attendance for each member at every event."
        actions={
          <Button onClick={downloadCsv} variant="gold">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      <Card>
        {loading ? (
          <div className="py-8 text-center text-navy-400">Loading…</div>
        ) : data.events.length === 0 ? (
          <div className="py-8 text-center text-navy-400">
            No events yet — create events first to start tracking attendance.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                  <th className="sticky left-0 z-10 bg-white py-2 pr-4">Member</th>
                  {data.events.map((e) => (
                    <th key={e.id} className="py-2 px-2 text-center">
                      <div className="font-semibold text-navy normal-case">{e.title}</div>
                      <div className="text-[10px] text-navy-400">
                        {format(new Date(e.date), 'MMM d')}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-50">
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td className="sticky left-0 z-10 bg-white py-3 pr-4">
                      <div className="font-semibold text-navy">{u.name}</div>
                      <div className="mt-1">
                        <RoleBadge role={u.role} />
                      </div>
                    </td>
                    {data.events.map((e) => {
                      const status = recordMap.get(`${u.id}:${e.id}`) || '';
                      return (
                        <td key={e.id} className="py-3 px-2 text-center">
                          <select
                            value={status}
                            onChange={(ev) => setStatus(u.id, e.id, ev.target.value)}
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
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
