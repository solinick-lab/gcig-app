import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  CalendarDays,
  CalendarRange,
  FileText,
  LineChart,
  BookOpen,
  ClipboardCheck,
  Users,
  UserCircle,
  LogOut,
  Vote,
  Building2,
  ShieldAlert,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import RoleBadge from './RoleBadge.jsx';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/pitches', label: 'Pitches Calendar', icon: CalendarDays },
  { to: '/events', label: 'Events Calendar', icon: CalendarRange },
  { to: '/archive', label: 'Pitch Archive', icon: FileText },
  { to: '/portfolio', label: 'Portfolio', icon: LineChart },
  { to: '/votes', label: 'Voting', icon: Vote },
  { to: '/industries', label: 'Industries', icon: Building2 },
  { to: '/reports', label: 'Research Reports', icon: BookOpen },
  { to: '/attendance', label: 'Attendance', icon: ClipboardCheck },
  { to: '/members', label: 'Members', icon: Users, executiveOnly: true },
  { to: '/audit', label: 'Audit Log', icon: ShieldAlert, adminOnly: true },
  { to: '/profile', label: 'Profile', icon: UserCircle },
];

export default function Sidebar({ onNavigate }) {
  const { user, logout, isAdmin, isExecutive } = useAuth();

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
        <div className="text-center text-[11px] uppercase tracking-[0.15em] text-gold font-semibold">
          Investment Group
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {NAV_ITEMS.filter(
          (i) =>
            (!i.adminOnly || isAdmin) &&
            (!i.executiveOnly || isExecutive)
        ).map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
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
