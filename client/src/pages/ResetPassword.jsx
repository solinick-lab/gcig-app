import { useEffect, useState } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/Button.jsx';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { resetPassword } = useAuth();

  const [email, setEmail] = useState('');
  const [validating, setValidating] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError('No reset token in URL');
      setValidating(false);
      return;
    }
    api
      .get(`/auth/reset/${token}`)
      .then(({ data }) => setEmail(data.email))
      .catch((err) => setLoadError(err.response?.data?.error || 'Invalid reset link'))
      .finally(() => setValidating(false));
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-gradient-to-br from-navy via-navy-700 to-navy-800 p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #C9A84C 1px, transparent 1px), linear-gradient(to bottom, #C9A84C 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="rounded-xl bg-white px-8 py-5">
            <img
              src="/griffin-logo.png"
              alt="The Griffin Fund — Grace Church School"
              className="h-16 w-auto"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
          <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.3em] text-gold">
            Grace Church School Investment Group
          </div>
        </div>
        <div className="rounded-xl bg-white p-8 shadow-xl">
          {validating ? (
            <div className="text-center text-navy-400">Checking your reset link…</div>
          ) : loadError ? (
            <>
              <h2 className="text-lg font-semibold text-red-700">Link not valid</h2>
              <p className="mt-2 text-sm text-navy-400">{loadError}</p>
              <Link to="/forgot-password" className="mt-6 inline-block text-sm font-semibold text-gold-700 underline">
                Request a new reset link
              </Link>
            </>
          ) : done ? (
            <div className="text-center">
              <h2 className="text-lg font-semibold text-emerald-700">Password updated</h2>
              <p className="mt-2 text-sm text-navy-400">Redirecting to sign in…</p>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-navy">Set a new password</h2>
              <p className="mt-1 text-sm text-navy-400">
                For <strong>{email}</strong>
              </p>
              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-navy">New password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                  />
                  <p className="mt-1 text-xs text-navy-400">Minimum 8 characters.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-navy">Confirm</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                  />
                </div>
                {error && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                )}
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Updating…' : 'Update password'}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
