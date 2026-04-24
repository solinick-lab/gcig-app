import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft,
  Building2,
  CalendarCheck,
  Presentation,
  Vote as VoteIcon,
  UserRound,
} from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import EditorialMasthead from '../components/EditorialMasthead.jsx';

// Per-member profile. Any authed user can view any member's record —
// the data exposed here is the same tier already on the Members page,
// just organized per-person. Surfaces pitch history, attendance rate,
// voting record, and industry assignments so the club has a shared
// view of what each member has actually done.

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'MMM d, yyyy');
  } catch {
    return iso;
  }
}

function formatRelative(iso) {
  if (!iso) return '';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

// Compact 2-letter monogram fallback when there's no photo (there
// isn't today; we hook in a photo layer once the User model carries one).
function initialsOf(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export default function MemberProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/users/${encodeURIComponent(id)}/profile`)
      .then((r) => {
        if (!cancelled) setProfile(r.data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.response?.data?.error || 'Could not load profile');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Stats shown in the masthead strip. Attendance is suppressed for
  // exempt roles (advisory / chief of comms) so the tile doesn't
  // misleadingly show 0%.
  const stats = useMemo(() => {
    if (!profile) return [];
    const out = [
      {
        kicker: 'Pitches',
        value: profile.pitches?.length ?? 0,
        sub: profile.pitches?.length === 1 ? 'presentation on record' : 'presentations on record',
      },
      {
        kicker: 'Votes Cast',
        value: profile.votes?.total ?? 0,
        sub: 'ballots in voting sessions',
      },
    ];
    if (profile.attendanceExempt) {
      out.splice(1, 0, {
        kicker: 'Attendance',
        value: '—',
        sub: 'Exempt role (advisory / comms)',
      });
    } else if (profile.attendance) {
      out.splice(1, 0, {
        kicker: 'Attendance',
        value: profile.attendance.rate != null ? `${profile.attendance.rate}%` : '—',
        sub:
          profile.attendance.total > 0
            ? `${profile.attendance.present + profile.attendance.excused} of ${profile.attendance.total} eligible`
            : 'No records yet',
      });
    }
    return out;
  }, [profile]);

  if (loading) {
    return (
      <div className="py-12 text-center text-navy-400">Loading profile…</div>
    );
  }

  if (error || !profile) {
    return (
      <>
        <BackLink onClick={() => navigate(-1)} />
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error || 'Member not found.'}
        </div>
      </>
    );
  }

  const monogram = initialsOf(profile.name);

  return (
    <>
      <BackLink onClick={() => navigate(-1)} />

      <PageHeader
        kicker="Member"
        title={profile.honorificName || profile.name}
        subtitle={profile.firstName ? `Also known as ${profile.firstName}.` : null}
        actions={<RoleBadge role={profile.role} />}
      />

      {/* Avatar + identity strip above the stat grid. Photo slot left
          for a future upload — for now we draw a gold-on-navy
          monogram so the page still has a human face. */}
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-navy font-serif text-xl font-semibold text-gold">
          {monogram}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-navy">{profile.name}</div>
          <div className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-navy-400">
            Joined {formatDate(profile.createdAt)}
            {profile.createdAt && (
              <span className="ml-1 text-navy-300">
                · {formatRelative(profile.createdAt)}
              </span>
            )}
          </div>
          {profile.industries && profile.industries.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {profile.industries.map((i) => (
                <Link
                  key={i.id}
                  to="/industries"
                  className="inline-flex items-center gap-1 rounded-full border border-navy-100 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-navy hover:border-gold"
                >
                  <Building2 className="h-3 w-3 text-navy-400" />
                  {i.name}
                </Link>
              ))}
            </div>
          )}
          {profile.extraRoles && profile.extraRoles.length > 0 && (
            <div className="mt-2 text-[11px] text-navy-400">
              Also carries:{' '}
              {profile.extraRoles
                .map((r) => r.replace(/([A-Z])/g, ' $1').trim())
                .join(' · ')}
            </div>
          )}
        </div>
      </div>

      {stats.length > 0 && (
        <div className="mb-6">
          <EditorialMasthead stats={stats} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.15fr_1fr]">
        <PitchesCard pitches={profile.pitches} />
        <VotesCard votes={profile.votes} />
      </div>
    </>
  );
}

function BackLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 inline-flex items-center gap-1.5 text-xs font-semibold text-navy-400 hover:text-navy"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back
    </button>
  );
}

// ─── Pitches card ─────────────────────────────────────────────────────
// Empty-state is important here: the user who triggered this feature
// pointed out that the AI was fabricating pitches when the Pitch table
// was empty. An honest "no pitches yet" reads far better than a fake
// list. Same philosophy here on the profile page.

function PitchesCard({ pitches }) {
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Presentation className="h-4 w-4 text-gold" />
        <div className="text-sm font-semibold text-navy">Pitches</div>
        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-navy-400">
          {pitches.length} on record
        </span>
      </div>
      {pitches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-navy-100 bg-navy-50/40 px-4 py-6 text-center text-xs text-navy-400">
          No pitches on record yet.
        </div>
      ) : (
        <ul className="divide-y divide-navy-50">
          {pitches.map((p) => {
            const tone =
              p.votedOutcome === 'Buy'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : p.votedOutcome === 'NoBuy'
                  ? 'bg-red-50 text-red-800 border-red-200'
                  : 'bg-navy-50 text-navy-500 border-navy-100';
            return (
              <li key={p.id} className="flex items-start gap-3 py-2.5">
                <div className="flex-shrink-0">
                  <div className="font-serif text-lg font-semibold text-navy">
                    {p.ticker}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-navy">
                    {formatDate(p.date)}
                  </div>
                  {p.industry?.name && (
                    <div className="mt-0.5 text-[11px] text-navy-400">
                      {p.industry.name}
                    </div>
                  )}
                </div>
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}
                >
                  {p.votedOutcome || 'Pending'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ─── Votes card ───────────────────────────────────────────────────────

function VotesCard({ votes }) {
  const recent = votes?.recent || [];
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <VoteIcon className="h-4 w-4 text-gold" />
        <div className="text-sm font-semibold text-navy">Recent votes</div>
        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-navy-400">
          {votes?.total ?? 0} total
        </span>
      </div>
      {recent.length === 0 ? (
        <div className="rounded-lg border border-dashed border-navy-100 bg-navy-50/40 px-4 py-6 text-center text-xs text-navy-400">
          No ballots cast yet.
        </div>
      ) : (
        <ul className="divide-y divide-navy-50">
          {recent.map((v) => {
            const tone =
              v.action === 'Buy'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : v.action === 'Sell'
                  ? 'bg-red-50 text-red-800 border-red-200'
                  : 'bg-gold-100/40 text-navy border-gold-200';
            return (
              <li
                key={v.sessionId + ':' + v.castAt}
                className="flex items-center gap-3 py-2.5"
              >
                <div className="font-serif text-base font-semibold text-navy">
                  {v.ticker || '—'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-navy-400">
                    {formatRelative(v.castAt)}
                  </div>
                  {v.action === 'Buy' && v.investmentAmount != null && (
                    <div className="text-[11px] font-semibold text-navy-500">
                      ${Number(v.investmentAmount).toLocaleString()} proposed
                    </div>
                  )}
                </div>
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}
                >
                  {v.action}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
