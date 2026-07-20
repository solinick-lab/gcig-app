import { Link } from 'react-router-dom';
import { Terminal as TerminalIcon, ArrowUpRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

// Persistent Terminal launcher. Pinned to the top of the main scroll area
// on every page (sticky), so the fund's research desk is one glance and one
// click away no matter where a member is or how far they've scrolled — it
// used to be a single nav row buried in the sidebar. Gated to the same
// roles the /terminal route allows (execs + advisory board); everyone else
// gets nothing and the strip collapses. The terminal page itself renders
// outside this Layout, so the launcher never stacks on top of the terminal.
export default function TerminalLauncher() {
  const { isExecutive, isAdvisory } = useAuth();
  if (!isExecutive && !isAdvisory) return null;

  return (
    <div className="sticky top-0 z-30 bg-[#F7F8FB]/90 px-4 pt-3 backdrop-blur md:px-8">
      <div className="mx-auto max-w-7xl">
        <Link
          to="/terminal"
          className="group relative flex items-center gap-3 overflow-hidden rounded-xl border border-gold/30 bg-navy-800 px-4 py-2.5 shadow-md transition hover:border-gold hover:shadow-lg"
        >
          {/* Faint scanlines — a nod to the CRT terminal aesthetic. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.06]"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, #C9A84C 0, #C9A84C 1px, transparent 1px, transparent 3px)',
            }}
          />
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gold/40 bg-navy text-gold">
            <TerminalIcon className="h-5 w-5" />
          </div>
          <div className="relative min-w-0 flex-1">
            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-gold">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Griffin Terminal
            </div>
            <div className="truncate text-xs text-navy-100">
              Research desk — quotes, filings, news &amp; the whole book
            </div>
          </div>
          <span className="relative inline-flex shrink-0 items-center gap-1 rounded-lg border border-gold/40 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-gold transition group-hover:bg-gold group-hover:text-navy">
            Launch <ArrowUpRight className="h-3.5 w-3.5" />
          </span>
        </Link>
      </div>
    </div>
  );
}
