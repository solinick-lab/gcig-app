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
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import RoleBadge from './RoleBadge.jsx';

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
    ],
  },
  {
    items: [{ to: '/profile', label: 'Profile', icon: UserCircle }],
  },
];

export default function Sidebar({ onNavigate }) {
  const { user, logout, isAdmin, isExecutive, isAdvisory } = useAuth();

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

      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV_SECTIONS.map((section, sectionIdx) => {
          const visible = section.items.filter(
            (i) =>
              (!i.adminOnly || isAdmin) &&
              (!i.executiveOnly || isExecutive) &&
              (!i.hideForAdvisory || !isAdvisory)
          );
          if (visible.length === 0) return null;
          return (
            <div key={sectionIdx} className={sectionIdx === 0 ? 'mb-1' : 'mt-4 mb-1'}>
              {section.header && (
                <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-navy-200/60">
                  {section.header}
                </div>
              )}
              <div className="space-y-0.5">
                {visible.map((item) => {
                  const Icon = item.icon;
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
                      {item.label}
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
          <div className="text-sm font-semibold truncate">{user?.name}</div>
          <div className="mt-1">
            <RoleBadge role={user?.role} />
          </div>
        </div>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-lg bg-navy-500 px-3 py-2 text-sm font-medium text-white hover:bg-navy-400"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
