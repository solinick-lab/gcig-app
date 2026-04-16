import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { CalendarDays, LineChart, CalendarRange, FileText, BookOpen } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

const ACTIVITY_ICONS = {
  pitch: CalendarDays,
  event: CalendarRange,
  report: BookOpen,
};

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/dashboard').then((r) => setData(r.data)).catch(() => setData({}));
  }, []);

  return (
    <>
      <PageHeader
        title={`Welcome, ${user?.name?.split(' ')[0] || ''}`}
        subtitle="Here's what's happening at the Investment Group today."
        actions={<RoleBadge role={user?.role} className="text-sm" />}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-navy-400">Next Pitch</div>
              <div className="mt-2 text-lg font-bold text-navy">
                {data?.nextPitch
                  ? `${data.nextPitch.pitcherName} — ${data.nextPitch.ticker}`
                  : 'No upcoming pitches'}
              </div>
              {data?.nextPitch && (
                <div className="mt-1 text-sm text-navy-400">
                  {format(new Date(data.nextPitch.date), 'EEE, MMM d • h:mm a')}
                </div>
              )}
            </div>
            <CalendarDays className="h-8 w-8 text-gold" />
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-navy-400">Active Holdings</div>
              <div className="mt-2 text-3xl font-bold text-navy">
                {data?.holdingsCount ?? '—'}
              </div>
              <div className="mt-1 text-sm text-navy-400">positions in portfolio</div>
            </div>
            <LineChart className="h-8 w-8 text-gold" />
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs uppercase tracking-wider text-navy-400">Upcoming Events</div>
              <div className="mt-2 text-3xl font-bold text-navy">
                {data?.upcomingEvents?.length ?? 0}
              </div>
              <div className="mt-1 text-sm text-navy-400">next 30 days</div>
            </div>
            <CalendarRange className="h-8 w-8 text-gold" />
          </div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Upcoming Events">
          {data?.upcomingEvents?.length ? (
            <ul className="divide-y divide-navy-50">
              {data.upcomingEvents.map((e) => (
                <li key={e.id} className="py-3">
                  <div className="font-semibold text-navy">{e.title}</div>
                  <div className="text-sm text-navy-400">
                    {format(new Date(e.date), 'EEE, MMM d • h:mm a')}
                    {e.location ? ` • ${e.location}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-navy-400">No upcoming events scheduled.</div>
          )}
        </Card>

        <Card title="Recent Activity">
          {data?.activity?.length ? (
            <ul className="space-y-3">
              {data.activity.map((a, i) => {
                const Icon = ACTIVITY_ICONS[a.type] || FileText;
                return (
                  <li key={i} className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-lg bg-gold-100 p-1.5 text-gold-700">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm text-navy">{a.label}</div>
                      <div className="text-xs text-navy-400">
                        {format(new Date(a.at), 'MMM d, yyyy')}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-sm text-navy-400">No recent activity.</div>
          )}
        </Card>
      </div>
    </>
  );
}
