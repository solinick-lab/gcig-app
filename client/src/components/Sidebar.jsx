import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarDays,
  LineChart,
  BookOpen,
  ClipboardCheck,
  UserCircle,
  LogOut,
  Vote,
  Building2,
  ShieldAlert,
  MessageSquare,
  Trophy,
  Megaphone,
  Bot,
  Send,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import RoleBadge from './RoleBadge.jsx';
import api from '../api/client.js';

// Grouped sidebar nav. Sections with a header collapse the crowd of items
// into 4 scannable clusters instead of a flat list of 12.
const NAV_SECTIONS = [
  {
    items: [{ to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    header: 'Day to day',
    items: [
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/pitch-requests', label: 'Pitch Requests', icon: Send, badgeKey: 'pitchRequests' },
      { to: '/chat', label: 'Chat', icon: MessageSquare },
      { to: '/broadcast', label: 'Broadcast', icon: Megaphone, executiveOnly: true },
      { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, hideForAdvisory: true },
    ],
  },
  {
    header: 'Investing',
    items: [
      { to: '/portfolio', label: 'Portfolio', icon: LineChart },
      { to: '/outcomes', label: 'Coverage Outcomes', icon: Trophy },
      { to: '/votes', label: 'Voting', icon: Vote },
      { to: '/industries', label: 'Industries', icon: Building2 },
    ],
  },
  {
    items: [{ to: '/library', label: 'Library', icon: BookOpen }],
  },
  {
    items: [
      { to: '/admin', label: 'Admin', icon: ShieldAlert, executiveOnly: true },
      { to: '/ai-chat', label: 'AI Assistant', icon: Bot },
    ],
  },
  {
    items: [{ to: '/profile', label: 'Profile', icon: UserCircle }],
  },
];

export default function Sidebar({ onNavigate }) {
  const { user, logout, isAdmin, isExecutive, isAdvisory, isSuperAdmin } = useAuth();
  const [badges, setBadges] = useState({ pitchRequests: 0 });

  // Poll the pending-pitch-requests count so the sidebar chip stays fresh.
  // 60s cadence is plenty for an inbox-style notification — anything more
  // aggressive just spams the API for nothing.
  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const { data } = await api.get('/pitch-requests/pending-count');
        if (cancelled) return;
        setBadges({ pitchRequests: (data.count || 0) + (data.mineUnseen || 0) });
      } catch {
        /* ignore — badge defaults to 0 */
      }
    }
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <aside className="flex h-full w-64 flex-col bg-navy text-white">
      <div className="flex flex-col items-center gap-3 px-5 py-6 border-b border-navy-500/50">
        <div className="rounded-lg bg-white px-3 py-2">
          <img
            src="/grace-logo.png"
            alt="Grace Church School"
            className="h-10 w-auto"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        </div>
        <div className="text-center leading-tight">
          <div className="font-serif text-lg font-semibold text-white">
            The Griffin Fund
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-gold font-semibold">
            Grace Church School
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section, sectionIdx) => {
          const visible = section.items.filter(
            (i) =>
              (!i.adminOnly || isAdmin) &&
              (!i.executiveOnly || isExecutive) &&
              (!i.superAdminOnly || isSuperAdmin) &&
              (!i.hideForAdvisory || !isAdvisory)
          );
          if (visible.length === 0) return null;
          return (
            <div key={sectionIdx} className={sectionIdx === 0 ? 'mb-2' : 'mt-5 mb-2'}>
              {section.header && (
                <div className="mb-2 flex items-center gap-2 px-3 text-[9px] font-semibold uppercase tracking-[0.25em] text-gold/70">
                  <span className="h-px w-3 bg-gold/50" />
                  {section.header}
                </div>
              )}
              <div className="space-y-0.5">
                {visible.map((item) => {
                  const Icon = item.icon;
                  const badge = item.badgeKey ? badges[item.badgeKey] : 0;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                          isActive
                            ? 'bg-gold text-navy'
                            : 'text-navy-100 hover:bg-navy-500 hover:text-white'
                        }`
                      }
                    >
                      <Icon className="h-4 w-4" />
                      <span className="flex-1">{item.label}</span>
                      {badge > 0 && (
                        <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-gold px-1.5 text-[10px] font-bold text-navy">
                          {badge}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-navy-500/50 p-4">
        <div className="mb-3">
          <div className="text-[9px] font-semibold uppercase tracking-[0.25em] text-gold/70">
            Signed in
          </div>
          <div className="mt-1 font-serif text-base font-semibold text-white truncate">
            {user?.name}
          </div>
          <div className="mt-1">
            <RoleBadge role={user?.role} />
          </div>
        </div>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-lg border border-navy-400/40 px-3 py-2 text-sm font-medium text-navy-100 transition hover:border-gold hover:bg-gold hover:text-navy"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
