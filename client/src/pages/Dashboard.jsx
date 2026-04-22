import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  CalendarDays,
  CalendarRange,
  FileText,
  BookOpen,
  Sparkles,
  ArrowUpRight,
  TrendingUp,
  TrendingDown,
  Building2,
} from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

// ---------------------------------------------------------------------------
// Editorial-style Dashboard. Pulls from three existing endpoints:
//   /dashboard         next pitch, upcoming events (+ pitches), activity, DIR
//   /holdings/quotes   live AUM, cash, holdings list → used for movers
//   /holdings/history  sparkline + WoW / MoM / YTD deltas
// All requests are cheap (server-cached). If any one fails the rest still
// renders; the affected section simply hides.
// ---------------------------------------------------------------------------

const ACTIVITY_ICONS = {
  pitch: CalendarDays,
  event: CalendarRange,
  report: BookOpen,
};

// Starting capital + cash infusions the club has added. Mirrors Portfolio.jsx.
const INITIAL_CAPITAL = 100_000;
const CASH_FLOWS = [
  { date: new Date('2026-01-29T12:00:00Z'), amount: 25_000 },
];
const TOTAL_INVESTED =
  INITIAL_CAPITAL + CASH_FLOWS.reduce((s, cf) => s + cf.amount, 0);

function fmtMoney(n, opts = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

function fmtPct(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [quotes, setQuotes] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    api.get('/dashboard').then((r) => setDashboard(r.data)).catch(() => setDashboard({}));
    api.get('/holdings/quotes').then((r) => setQuotes(r.data)).catch(() => setQuotes(null));
    api.get('/holdings/history').then((r) => setHistory(r.data || [])).catch(() => setHistory([]));
  }, []);

  const firstName = user?.name?.split(' ')[0] || '';

  // History in JS dates, equity = total - cash so the sparkline tracks
  // actual market movement, not capital infusions.
  const normalizedHistory = useMemo(
    () =>
      (history || []).map((s) => ({
        date: new Date(s.date),
        value: Number(s.totalValue || 0),
        cash: Number(s.cashValue || 0),
      })),
    [history]
  );

  return (
    <div className="space-y-6 md:space-y-8">
      <Masthead firstName={firstName} user={user} />

      <PortfolioHero
        totals={quotes?.totals}
        holdings={quotes?.holdings}
        history={normalizedHistory}
      />

      {dashboard?.dayInReview && (
        <DayInReview
          text={dashboard.dayInReview}
          generatedAt={dashboard.dayInReviewAt}
        />
      )}

      <SpotlightRow
        nextPitch={dashboard?.nextPitch}
        holdingsCount={quotes?.holdings?.length ?? dashboard?.holdingsCount}
        upcomingCount={dashboard?.upcomingEvents?.length ?? 0}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
        <OnTheCalendar events={dashboard?.upcomingEvents || []} />
        <LatelyFeed activity={dashboard?.activity || []} />
      </div>
    </div>
  );
}

// ─── Masthead ───────────────────────────────────────────────────────────

function Masthead({ firstName, user }) {
  const today = new Date();
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-navy-100 pb-4 md:pb-6">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
          {format(today, 'EEEE · MMMM d, yyyy')}
        </div>
        <h1 className="mt-2 font-serif text-3xl font-semibold leading-tight text-navy md:text-5xl">
          Welcome back, <span className="italic">{firstName || 'friend'}</span>.
        </h1>
      </div>
      <div className="flex items-center gap-3">
        <RoleBadge role={user?.role} className="text-[11px]" />
      </div>
    </div>
  );
}

// ─── Portfolio hero ─────────────────────────────────────────────────────

function PortfolioHero({ totals, holdings, history }) {
  const totalValue = totals?.totalValue;
  const cashValue = totals?.cashValue;
  const nonCashHoldings = (holdings || []).filter((h) => !h.isCash);

  // Return metrics. Lifetime goes against total invested capital (100k start
  // + infusions). Daily / weekly / YTD use history snapshots.
  const lifetimeDelta =
    totalValue != null ? totalValue - TOTAL_INVESTED : null;
  const lifetimePct =
    lifetimeDelta != null && TOTAL_INVESTED > 0
      ? (lifetimeDelta / TOTAL_INVESTED) * 100
      : null;

  const { weekPct, ytdPct } = useMemo(() => {
    if (!history || history.length < 2 || totalValue == null)
      return { weekPct: null, ytdPct: null };
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const findOnOrBefore = (target) =>
      [...history].reverse().find((h) => h.date <= target) || history[0];
    // Subtract capital infusions that landed inside the window — they
    // aren't market returns. Matches the logic in Portfolio.jsx.
    const pct = (from, fromDate) => {
      if (!from || from.value <= 0) return null;
      const cfInWindow = CASH_FLOWS.filter(
        (cf) => cf.date > fromDate && cf.date <= now
      ).reduce((s, cf) => s + cf.amount, 0);
      const adjustedDelta = totalValue - cfInWindow - from.value;
      return (adjustedDelta / from.value) * 100;
    };
    return {
      weekPct: pct(findOnOrBefore(weekAgo), weekAgo),
      ytdPct: pct(findOnOrBefore(yearStart), yearStart),
    };
  }, [history, totalValue]);

  const cashPct = totalValue > 0 ? (cashValue / totalValue) * 100 : null;

  const sparkData = useMemo(() => {
    // Last 90 days of history for the little curve. Lightweight.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return (history || [])
      .filter((h) => h.date >= cutoff)
      .map((h) => ({ ts: h.date.getTime(), value: h.value }));
  }, [history]);

  if (totalValue == null) {
    return (
      <div className="rounded-2xl border border-navy-100 bg-white p-6 shadow-card">
        <div className="text-sm text-navy-400">Loading portfolio…</div>
      </div>
    );
  }

  const isUp = (weekPct ?? 0) >= 0;

  return (
    <Link
      to="/portfolio"
      className="group block overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy-700 to-navy-800 text-white shadow-xl transition hover:shadow-2xl"
    >
      {/* Decorative gold grid in the background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #C9A84C 1px, transparent 1px), linear-gradient(to bottom, #C9A84C 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative grid gap-6 p-6 md:grid-cols-[1.2fr_1fr] md:gap-10 md:p-8">
        {/* Left — headline number + deltas */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold">
            <Sparkles className="h-3 w-3" />
            Fund value
          </div>
          <div className="mt-3 font-serif text-4xl font-semibold leading-none tabular-nums md:text-6xl">
            {fmtMoney(totalValue)}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                isUp
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-red-500/20 text-red-300'
              }`}
            >
              {isUp ? (
                <TrendingUp className="h-3.5 w-3.5" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5" />
              )}
              {fmtPct(weekPct)} WoW
            </span>
            {ytdPct != null && (
              <span className="text-xs text-navy-100">
                {fmtPct(ytdPct)} YTD
              </span>
            )}
            {lifetimePct != null && (
              <span className="text-xs text-navy-100">
                · {fmtPct(lifetimePct)} since inception
              </span>
            )}
          </div>

          <div className="mt-6 flex gap-6 border-t border-white/10 pt-4 text-sm">
            <MiniStat
              label="Cash"
              value={
                cashPct != null
                  ? `${cashPct.toFixed(0)}%`
                  : '—'
              }
            />
            <MiniStat label="Positions" value={nonCashHoldings.length} />
            <MiniStat label="Invested" value={fmtMoney(TOTAL_INVESTED)} />
          </div>
        </div>

        {/* Right — sparkline + movers */}
        <div className="flex flex-col gap-4">
          {sparkData.length > 1 && (
            <div className="h-20 -mx-1">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={sparkData}
                  margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
                >
                  <defs>
                    <linearGradient id="sparkGold" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#C9A84C" stopOpacity={0.55} />
                      <stop offset="100%" stopColor="#C9A84C" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="ts" hide />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid #C9A84C',
                      background: 'rgba(27,42,74,0.92)',
                      color: 'white',
                      fontSize: 11,
                    }}
                    labelFormatter={(ts) => format(new Date(ts), 'MMM d')}
                    formatter={(v) => [fmtMoney(v, { cents: true }), 'Value']}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#C9A84C"
                    strokeWidth={2}
                    fill="url(#sparkGold)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
          <MoversRail holdings={nonCashHoldings} />
        </div>

        {/* Link affordance */}
        <div className="absolute right-4 top-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-gold opacity-0 transition group-hover:opacity-100">
          Open portfolio →
        </div>
      </div>
    </Link>
  );
}

function MiniStat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gold">
        {label}
      </div>
      <div className="mt-1 font-serif text-xl font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}

function MoversRail({ holdings }) {
  // Top gainer + top loser — two little inline cards inside the hero.
  if (!holdings || holdings.length === 0) return null;
  const sorted = [...holdings]
    .filter((h) => Number.isFinite(h.percentReturn))
    .sort((a, b) => b.percentReturn - a.percentReturn);
  if (sorted.length === 0) return null;
  const gainer = sorted[0];
  const loser = sorted[sorted.length - 1];
  const showBoth = gainer !== loser && loser.percentReturn < 0;

  return (
    <div className="grid grid-cols-2 gap-2">
      <Mover holding={gainer} />
      {showBoth ? <Mover holding={loser} /> : <Mover holding={sorted[1] || gainer} />}
    </div>
  );
}

function Mover({ holding }) {
  if (!holding) return null;
  const up = (holding.percentReturn ?? 0) >= 0;
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold text-gold">{holding.ticker}</span>
        <span
          className={`text-xs font-bold tabular-nums ${
            up ? 'text-emerald-300' : 'text-red-300'
          }`}
        >
          {fmtPct(holding.percentReturn, 1)}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-navy-200">
        {holding.sector || holding.name}
      </div>
    </div>
  );
}

// ─── Day in Review ──────────────────────────────────────────────────────

function DayInReview({ text, generatedAt }) {
  // Stamp the card with an ET-formatted "as of" line so the user can see
  // exactly which market close the paragraph reflects.
  let stamp = null;
  if (generatedAt) {
    try {
      const d = new Date(generatedAt);
      const dateStr = d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      });
      const timeStr = d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York',
      });
      stamp = `As of ${timeStr} ET · ${dateStr}`;
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="rounded-2xl border border-gold-200 bg-[#FFFDF5] p-5 shadow-card md:p-7">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
        <span className="h-px w-6 bg-gold" />
        The Day in Review
      </div>
      <p className="mt-4 font-serif text-lg leading-relaxed text-navy md:text-xl">
        {text}
      </p>
      {stamp && (
        <div className="mt-4 border-t border-gold-200/60 pt-3 text-[11px] uppercase tracking-[0.18em] text-navy-400">
          {stamp}
        </div>
      )}
    </div>
  );
}

// ─── Spotlight row (three compact editorial cards) ──────────────────────

function SpotlightRow({ nextPitch, holdingsCount, upcomingCount }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <SpotlightCard
        to="/calendar"
        label="Next Pitch"
        icon={CalendarDays}
        primary={nextPitch ? nextPitch.ticker : 'None scheduled'}
        secondary={
          nextPitch
            ? `${nextPitch.pitcherName} · ${format(new Date(nextPitch.date), 'EEE, MMM d')}`
            : 'Check the calendar for upcoming sessions'
        }
      />
      <SpotlightCard
        to="/portfolio"
        label="Active Holdings"
        icon={Building2}
        primary={holdingsCount ?? '—'}
        secondary="Positions in the book"
        primaryBig
      />
      <SpotlightCard
        to="/calendar"
        label="Upcoming"
        icon={CalendarRange}
        primary={upcomingCount}
        secondary="Events + pitches in the next 30 days"
        primaryBig
      />
    </div>
  );
}

function SpotlightCard({ to, label, icon: Icon, primary, secondary, primaryBig }) {
  return (
    <Link
      to={to}
      className="group relative block overflow-hidden rounded-xl border border-navy-100 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-gold hover:shadow-md"
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700">
        <span className="h-px w-4 bg-gold" />
        {label}
      </div>
      <div
        className={`mt-3 font-serif font-semibold text-navy ${
          primaryBig ? 'text-5xl tabular-nums' : 'text-2xl'
        }`}
      >
        {primary}
      </div>
      <div className="mt-2 text-xs text-navy-400">{secondary}</div>
      <Icon
        aria-hidden
        className="pointer-events-none absolute -bottom-3 -right-3 h-20 w-20 text-gold/10 transition group-hover:text-gold/20"
      />
      <ArrowUpRight className="absolute right-4 top-4 h-4 w-4 text-navy-100 transition group-hover:text-gold" />
    </Link>
  );
}

// ─── On the Calendar ────────────────────────────────────────────────────

function OnTheCalendar({ events }) {
  return (
    <section className="rounded-2xl border border-navy-100 bg-white p-5 shadow-card md:p-6">
      <SectionHeading title="On the Calendar" href="/calendar" />
      {events.length === 0 ? (
        <div className="py-6 text-sm text-navy-400">
          Nothing scheduled in the next 30 days.
        </div>
      ) : (
        <ul className="divide-y divide-navy-50">
          {events.map((e) => {
            const isPitch = e.kind === 'pitch';
            return (
              <li key={e.id} className="py-3 first:pt-0 last:pb-0">
                <Link
                  to="/calendar"
                  className="flex items-start gap-4 rounded-md -mx-2 px-2 py-1 transition hover:bg-navy-50/60"
                >
                  <DateTile date={new Date(e.date)} accent={isPitch} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isPitch && (
                        <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-gold-800">
                          Pitch
                        </span>
                      )}
                      <span className="truncate font-serif text-base font-semibold text-navy">
                        {e.title}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-navy-400">
                      {format(new Date(e.date), 'EEEE, h:mm a')}
                      {e.location ? ` · ${e.location}` : ''}
                    </div>
                  </div>
                  <ArrowUpRight className="mt-2 h-3.5 w-3.5 shrink-0 text-navy-200" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DateTile({ date, accent }) {
  return (
    <div
      className={`flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg ${
        accent ? 'bg-gold text-navy' : 'bg-navy text-gold'
      }`}
    >
      <span className="text-[9px] font-bold uppercase tracking-[0.15em] opacity-80">
        {format(date, 'MMM')}
      </span>
      <span className="font-serif text-lg font-semibold leading-none">
        {format(date, 'd')}
      </span>
    </div>
  );
}

// ─── Lately (activity feed) ─────────────────────────────────────────────

function LatelyFeed({ activity }) {
  return (
    <section className="rounded-2xl border border-navy-100 bg-white p-5 shadow-card md:p-6">
      <SectionHeading title="Lately in the Fund" />
      {activity.length === 0 ? (
        <div className="py-6 text-sm text-navy-400">No recent activity yet.</div>
      ) : (
        <ul className="space-y-3">
          {activity.map((a, i) => {
            const Icon = ACTIVITY_ICONS[a.type] || FileText;
            const to = a.type === 'report' ? '/library' : '/calendar';
            return (
              <li key={i}>
                <Link
                  to={to}
                  className="flex items-start gap-3 rounded-md -mx-2 px-2 py-1 transition hover:bg-navy-50/60"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gold-200 bg-gold-100/40 text-gold-700">
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-navy">{a.label}</div>
                    <div className="text-[11px] text-navy-400">
                      {formatDistanceToNow(new Date(a.at), { addSuffix: true })}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── Reusable section heading (small caps w/ gold hairline) ─────────────

function SectionHeading({ title, href }) {
  return (
    <div className="mb-4 flex items-end justify-between border-b border-navy-50 pb-2">
      <div className="flex items-center gap-2">
        <span className="h-px w-6 bg-gold" />
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.25em] text-navy">
          {title}
        </h2>
      </div>
      {href && (
        <Link
          to={href}
          className="text-[10px] font-semibold uppercase tracking-[0.2em] text-gold-700 hover:text-navy"
        >
          View all →
        </Link>
      )}
    </div>
  );
}
