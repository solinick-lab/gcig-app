import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import RoleBadge from '../components/RoleBadge.jsx';
import Button from '../components/Button.jsx';

export default function Profile() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/attendance/mine').then((r) => setStats(r.data));
  }, []);

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
    </>
  );
}
