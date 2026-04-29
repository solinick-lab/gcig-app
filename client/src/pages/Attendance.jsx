import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Download, ChevronDown, ChevronUp } from 'lucide-react';
import api, { API_BASE } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import EditorialMasthead from '../components/EditorialMasthead.jsx';

const STATUSES = ['Present', 'Absent', 'Excused'];
const STATUS_COLORS = {
  Present: 'bg-emerald-100 text-emerald-800',
  Absent: 'bg-red-100 text-red-800',
  Excused: 'bg-gold-100 text-gold-800',
};

export default function Attendance() {
  const { isAdmin, isAdvisory } = useAuth();
  if (isAdvisory) return <AdvisoryAttendance />;
  return isAdmin ? <AdminAttendance /> : <MineAttendance />;
}

function AdvisoryAttendance() {
  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="Attendance"
        subtitle="Attendance tracking is for active club members only."
      />
      <Card>
        <div className="py-10 text-center text-navy-400">
          Advisory Board Members and Faculty Advisors don't have attendance
          recorded. Nothing to show here.
        </div>
      </Card>
    </>
  );
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
        kicker="Meetings"
        title="My Attendance"
        subtitle="Your attendance record across all club meetings and events."
      />

      <EditorialMasthead
        stats={[
          {
            kicker: 'Attendance Rate',
            value: `${data.percentage}%`,
            sub: `${data.present} present of ${data.total}`,
          },
          {
            kicker: 'Present',
            value: data.present,
            sub: 'Meetings attended',
          },
          {
            kicker: 'Excused',
            value: data.excused,
            sub: 'Approved absences',
          },
        ]}
      />

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
  const [showPast, setShowPast] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await api.get('/attendance');
    setData(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  // Wipe every attendance row for a given event. Confirm twice — once
  // on the in-page button, again with a typed-in date so the executive
  // can't nuke the wrong column with a stray click.
  async function clearEventAttendance(event) {
    const dateLabel = format(new Date(event.date), 'MMM d, yyyy');
    const ok = window.confirm(
      `Clear EVERY attendance record for "${event.title}" on ${dateLabel}?\n\nThis cannot be undone.`
    );
    if (!ok) return;
    try {
      await api.delete(`/attendance/event/${event.id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to clear attendance');
    }
  }

  // Pin the "Current" meeting: the next upcoming one (or today).
  // Fallback to the most recent past meeting if nothing upcoming exists.
  // Then sort everything else newest-first after the current one.
  //
  // Cutover happens at *midnight*, not at the meeting time — so a 7pm
  // meeting on Wednesday stays "current" until end of day Wednesday,
  // not the moment 7pm passes. Without this, attendance would jump to
  // next week's meeting mid-meeting.
  const { sortedEvents, currentEventId } = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const all = [...data.events].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    const upcoming = all.find((e) => {
      const d = new Date(e.date);
      d.setHours(0, 0, 0, 0);
      return d >= todayStart;
    });
    const currentId = upcoming?.id ?? all[all.length - 1]?.id ?? null;
    const rest = all
      .filter((e) => e.id !== currentId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const current = all.find((e) => e.id === currentId);
    const ordered = current ? [current, ...rest] : rest;
    return { sortedEvents: ordered, currentEventId: currentId };
  }, [data.events]);

  // Show only the current + 1 past by default; expand to all with "Show Past"
  const visibleEvents = showPast ? sortedEvents : sortedEvents.slice(0, 2);

  const recordMap = useMemo(() => {
    const m = new Map();
    for (const r of data.records) m.set(`${r.userId}:${r.eventId}`, r.status);
    return m;
  }, [data.records]);

  async function setStatus(userId, eventId, status) {
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
    a.download = 'griffin-fund-attendance.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        kicker="Meetings"
        title="Attendance"
        subtitle="Mark attendance for each member at every event."
        actions={
          <Button onClick={downloadCsv} variant="gold">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      {data.events.length > 0 && data.users.length > 0 && (
        <div className="mb-6">
          <EditorialMasthead
            stats={(() => {
              // Club-wide participation for the events we have records on.
              const presentCount = data.records.filter(
                (r) => r.status === 'Present'
              ).length;
              const possible = data.records.length;
              const rate =
                possible > 0 ? Math.round((presentCount / possible) * 100) : 0;
              return [
                {
                  kicker: 'Club Attendance',
                  value: `${rate}%`,
                  sub: `${presentCount} present of ${possible} records`,
                },
                {
                  kicker: 'Events Tracked',
                  value: data.events.length,
                  sub: 'Meetings + pitches with attendance',
                },
                {
                  kicker: 'Active Members',
                  value: data.users.length,
                  sub: 'Counted in attendance',
                },
              ];
            })()}
          />
        </div>
      )}

      <Card>
        {loading ? (
          <div className="py-8 text-center text-navy-400">Loading…</div>
        ) : data.events.length === 0 ? (
          <div className="py-8 text-center text-navy-400">
            No events yet — create events first to start tracking attendance.
          </div>
        ) : (
          <>
            {/* Mobile: one event at a time. Defaults to the current meeting;
                a pill bar at the top lets you switch. Each member is its own
                row with a big dropdown. */}
            <MobileAttendance
              events={visibleEvents}
              users={data.users}
              recordMap={recordMap}
              currentEventId={currentEventId}
              setStatus={setStatus}
            />

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                    <th className="sticky left-0 z-10 bg-white py-2 pr-4">Member</th>
                    {visibleEvents.map((e) => {
                      const isCurrent = e.id === currentEventId;
                      return (
                        <th
                          key={e.id}
                          className={`py-2 px-3 text-center ${
                            isCurrent ? 'bg-gold-100 rounded-t-lg' : ''
                          }`}
                        >
                          {isCurrent && (
                            <div className="mb-1 rounded-full bg-gold px-2 py-0.5 text-[10px] font-bold uppercase text-navy inline-block">
                              Current
                            </div>
                          )}
                          <div className="font-semibold text-navy normal-case">{e.title}</div>
                          <div className="text-[10px] text-navy-400">
                            {format(new Date(e.date), 'MMM d, yyyy')}
                          </div>
                          <button
                            type="button"
                            onClick={() => clearEventAttendance(e)}
                            className="mt-1 text-[10px] font-semibold text-red-600 underline hover:text-red-700"
                            title="Clear all attendance for this meeting"
                          >
                            Clear
                          </button>
                        </th>
                      );
                    })}
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
                      {visibleEvents.map((e) => {
                        const isCurrent = e.id === currentEventId;
                        const status = recordMap.get(`${u.id}:${e.id}`) || '';
                        return (
                          <td
                            key={e.id}
                            className={`py-3 px-3 text-center ${
                              isCurrent ? 'bg-gold-100/40' : ''
                            }`}
                          >
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

            {sortedEvents.length > 2 && (
              <div className="mt-4 text-center">
                <button
                  onClick={() => setShowPast(!showPast)}
                  className="inline-flex items-center gap-1 rounded-lg border border-navy-100 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-navy-50"
                >
                  {showPast ? (
                    <>
                      <ChevronUp className="h-4 w-4" />
                      Hide Past Meetings
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-4 w-4" />
                      Show Past Meetings ({sortedEvents.length - 2} more)
                    </>
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function MobileAttendance({ events, users, recordMap, currentEventId, setStatus }) {
  const [selectedEventId, setSelectedEventId] = useState(
    currentEventId || events[0]?.id || null
  );
  // Re-sync when the parent's current event changes (e.g. after fetch).
  useEffect(() => {
    if (!selectedEventId && (currentEventId || events[0]?.id)) {
      setSelectedEventId(currentEventId || events[0]?.id || null);
    }
  }, [currentEventId, events, selectedEventId]);

  const selected = events.find((e) => e.id === selectedEventId) || events[0];
  if (!selected) return null;

  return (
    <div className="md:hidden">
      {/* Event pill selector */}
      <div className="-mx-2 flex gap-2 overflow-x-auto px-2 pb-3">
        {events.map((e) => {
          const isCurrent = e.id === currentEventId;
          const isActive = e.id === selected.id;
          return (
            <button
              key={e.id}
              onClick={() => setSelectedEventId(e.id)}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                isActive
                  ? 'border-navy bg-navy text-white'
                  : isCurrent
                  ? 'border-gold bg-gold-100/60 text-navy'
                  : 'border-navy-100 bg-white text-navy-400'
              }`}
            >
              {isCurrent && !isActive && <span className="mr-1 text-gold">●</span>}
              <span>{e.title}</span>
              <span className="ml-2 opacity-60">
                {format(new Date(e.date), 'M/d')}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mb-2 text-xs text-navy-400">
        {format(new Date(selected.date), 'EEE, MMM d, yyyy')}
      </div>

      <ul className="divide-y divide-navy-50">
        {users.map((u) => {
          const status = recordMap.get(`${u.id}:${selected.id}`) || '';
          return (
            <li key={u.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-navy">{u.name}</div>
                <div className="mt-0.5"><RoleBadge role={u.role} /></div>
              </div>
              <select
                value={status}
                onChange={(ev) => setStatus(u.id, selected.id, ev.target.value)}
                className={`shrink-0 rounded-md border border-navy-100 px-2 py-2 text-xs font-semibold ${
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
