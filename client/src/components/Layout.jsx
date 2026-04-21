import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import MobileTabBar from './MobileTabBar.jsx';
import VoteNotification from './VoteNotification.jsx';
import PitchNotification from './PitchNotification.jsx';

export default function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-full bg-[#F7F8FB]">
      <VoteNotification />
      <PitchNotification />

      {/* Desktop sidebar — hidden below md */}
      <div className="hidden md:block shrink-0">
        <Sidebar />
      </div>

      {/* Mobile "More" drawer — overflow nav from the tab bar */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-navy/60 md:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            className="absolute inset-y-0 left-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <main className="relative flex-1 overflow-y-auto">
        {/* Site-wide gold grid — the same pattern used on hero cards, but
            at very low opacity so it sits behind content on every page. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #1B2A4A 1px, transparent 1px), linear-gradient(to bottom, #1B2A4A 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />

        {/* Extra bottom padding on mobile so the tab bar doesn't cover the
            last row of content. Desktop gets the normal py-8. */}
        <div className="relative mx-auto max-w-7xl px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-8 md:pt-8 md:pb-8">
          <Outlet />
        </div>
      </main>

      <MobileTabBar onOpenMore={() => setDrawerOpen(true)} />
    </div>
  );
}
