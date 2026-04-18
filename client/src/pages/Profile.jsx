import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  TrendingUp,
  TrendingDown,
  Target,
  Trophy,
  FileText,
  BookOpen,
} from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import Button from '../components/Button.jsx';
import TwoFactorPanel from '../components/TwoFactorPanel.jsx';

export default function Profile() {
  const { user, logoutEverywhere, isAdvisory } = useAuth();
  const [stats, setStats] = useState(null);
  const [mine, setMine] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/attendance/mine').then((r) => setStats(r.data));
    api
      .get('/pitches/outcomes/mine')
      .then((r) => setMine(r.data))
      .catch(() => setMine({ rows: [], totalPitches: 0, totalReports: 0 }));
  }, []);

  const hasCoverageData =
    mine && ((mine.totalPitches ?? 0) > 0 || (mine.totalReports ?? 0) > 0);

  async function handleChangePassword(e) {
    e.preventDefault();
    setMessage('');
    setError('');
    try {
      await api.post('/auth/change-password', form);
      setMessage('Password updated.');
      setForm({ currentPassword: '', newPassword: '' });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to change password');
    }
  }

  return (
    <>
      <PageHeader title="Profile" subtitle="Your account details." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Account">
          <dl className="space-y-3">
            <div>
              <dt className="text-xs uppercase text-navy-400">Name</dt>
              <dd className="text-lg font-semibold text-navy">{user?.name}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-navy-400">Email</dt>
              <dd className="text-navy">{user?.email}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-navy-400">Role</dt>
              <dd className="mt-1">
                <RoleBadge role={user?.role} className="text-sm" />
              </dd>
            </div>
            {user?.createdAt && (
              <div>
                <dt className="text-xs uppercase text-navy-400">Member Since</dt>
                <dd className="text-navy">
                  {format(new Date(user.createdAt), 'MMMM d, yyyy')}
                </dd>
              </div>
            )}
          </dl>
        </Card>

        <Card title="Attendance Summary">
          {stats ? (
            <div>
              <div className="text-xs uppercase text-navy-400">Attendance Rate</div>
              <div className="mt-2 text-5xl font-bold text-navy">
                {stats.percentage}%
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-emerald-50 p-3">
                  <div className="text-xs uppercase text-emerald-800">Present</div>
                  <div className="text-xl font-bold text-emerald-700">{stats.present}</div>
                </div>
                <div className="rounded-lg bg-gold-100 p-3">
                  <div className="text-xs uppercase text-gold-700">Excused</div>
                  <div className="text-xl font-bold text-gold-700">{stats.excused}</div>
                </div>
                <div className="rounded-lg bg-navy-50 p-3">
                  <div className="text-xs uppercase text-navy-400">Total</div>
                  <div className="text-xl font-bold text-navy">{stats.total}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-navy-400">Loading…</div>
          )}
        </Card>
      </div>

      {hasCoverageData && (
        <div className="mt-6">
          <Card title="My Results">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-navy-100 p-4">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-gold" />
                  <div className="text-xs uppercase text-navy-400">Pitches Given</div>
                </div>
                <div className="mt-2 text-3xl font-bold text-navy">
                  {mine.totalPitches}
                </div>
                {mine.pitchesVotedNo > 0 && (
                  <div className="mt-0.5 text-[11px] text-navy-400">
                    {mine.pitchesVotedNo} voted no
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-navy-100 p-4">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-gold" />
                  <div className="text-xs uppercase text-navy-400">Reports Written</div>
                </div>
                <div className="mt-2 text-3xl font-bold text-navy">
                  {mine.totalReports || 0}
                </div>
              </div>
              <div className="rounded-lg border border-navy-100 p-4">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-gold" />
                  <div className="text-xs uppercase text-navy-400">Avg Return</div>
                </div>
                <div
                  className={`mt-2 flex items-center gap-1 text-3xl font-bold ${
                    (mine.avgReturn ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {(mine.avgReturn ?? 0) >= 0 ? (
                    <TrendingUp className="h-6 w-6" />
                  ) : (
                    <TrendingDown className="h-6 w-6" />
                  )}
                  {(mine.avgReturn ?? 0) >= 0 ? '+' : ''}
                  {(mine.avgReturn ?? 0).toFixed(2)}%
                </div>
                <div className="mt-0.5 text-[11px] text-navy-400">
                  Across {mine.positionsCount || 0} held positions
                </div>
              </div>
              <div className="rounded-lg border border-navy-100 p-4">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-gold" />
                  <div className="text-xs uppercase text-navy-400">Hit Rate</div>
                </div>
                <div className="mt-2 text-3xl font-bold text-navy">
                  {((mine.hitRate ?? 0) * 100).toFixed(0)}%
                </div>
                <div className="mt-0.5 text-[11px] text-navy-400">
                  {mine.pitchesVotedBuy ?? 0} voted yes ·{' '}
                  {mine.pitchesVotedNo ?? 0} voted no
                </div>
              </div>
            </div>

            {mine.rows && mine.rows.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                      <th className="py-2 pr-4">Type</th>
                      <th className="py-2 pr-4">Ticker</th>
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4 text-right">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy-50">
                    {mine.rows.map((r) => {
                      const isNoBuy = r.votedOutcome === 'NoBuy';
                      const up = (r.percent ?? 0) >= 0;
                      return (
                        <tr key={r.id}>
                          <td className="py-3 pr-4">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                                r.type === 'report'
                                  ? 'bg-navy-50 text-navy'
                                  : 'bg-gold-100 text-gold-800'
                              }`}
                            >
                              {r.type === 'report' ? (
                                <BookOpen className="h-3 w-3" />
                              ) : (
                                <FileText className="h-3 w-3" />
                              )}
                              {r.type}
                            </span>
                          </td>
                          <td className="py-3 pr-4 font-bold text-navy">
                            {r.ticker}
                            {r.title && (
                              <div className="truncate max-w-[220px] text-xs font-normal text-navy-400">
                                {r.title}
                              </div>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-xs text-navy-400">
                            {format(new Date(r.date), 'MMM d, yyyy')}
                          </td>
                          <td className="py-3 pr-4 text-right">
                            {isNoBuy ? (
                              <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                                Voted No
                              </span>
                            ) : r.percent != null ? (
                              <span
                                className={`font-bold tabular-nums ${
                                  up ? 'text-emerald-600' : 'text-red-600'
                                }`}
                              >
                                {up ? '+' : ''}
                                {r.percent.toFixed(2)}%
                              </span>
                            ) : r.isPosition ? (
                              <span className="text-xs text-navy-400">Held</span>
                            ) : (
                              <span className="text-xs text-navy-400">Pending</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="mt-6">
        <Card title="Change Password">
          <form onSubmit={handleChangePassword} className="max-w-md space-y-3">
            <div>
              <label className="block text-sm font-medium text-navy">Current Password</label>
              <input
                type="password"
                required
                value={form.currentPassword}
                onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-navy">New Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={form.newPassword}
                onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
              <p className="mt-1 text-xs text-navy-400">Minimum 8 characters.</p>
            </div>
            {message && (
              <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {message}
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
            <Button type="submit">Update Password</Button>
          </form>
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Two-Factor Authentication">
          <TwoFactorPanel />
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Session Security">
          <p className="text-sm text-navy-400">
            If you suspect your account has been accessed from another device,
            sign out of all sessions immediately. You'll need to sign in again
            on every device.
          </p>
          <Button
            variant="danger"
            className="mt-4"
            onClick={async () => {
              if (!confirm('Sign out of every device you are logged in on?')) return;
              await logoutEverywhere();
              window.location.href = '/login';
            }}
          >
            Sign out everywhere
          </Button>
        </Card>
      </div>
    </>
  );
}
