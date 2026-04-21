import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Navigate } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/Button.jsx';

const ROLE_LABELS = {
  President: 'President',
  CIO: 'CIO',
  SeniorPortfolioManager: 'Senior Portfolio Manager',
  PortfolioManager: 'Portfolio Manager',
  SeniorAnalyst: 'Senior Analyst',
  JuniorAnalyst: 'Junior Analyst',
};

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const { user } = useAuth();

  const [invite, setInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError('No invite token in URL');
      setLoading(false);
      return;
    }
    api
      .get(`/auth/invite/${token}`)
      .then(({ data }) => setInvite(data))
      .catch((err) => setLoadError(err.response?.data?.error || 'Invalid invite link'))
      .finally(() => setLoading(false));
  }, [token]);

  if (user) return <Navigate to="/dashboard" replace />;

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
      const { data } = await api.post('/auth/accept-invite', { token, password });
      localStorage.setItem('gcig_token', data.token);
      localStorage.setItem('gcig_user', JSON.stringify(data.user));
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to set up account');
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
          <div className="rounded-xl bg-white px-6 py-4">
            <img
              src="/grace-logo.png"
              alt="Grace Church School"
              className="h-14 w-auto"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </div>
          <div className="mt-4 font-serif text-2xl font-semibold text-white">
            The Griffin Fund
          </div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-gold">
            Grace Church School
          </div>
        </div>

        <div className="rounded-xl bg-white p-8 shadow-xl">
          {loading ? (
            <div className="text-center text-navy-400">Checking your invite…</div>
          ) : loadError ? (
            <>
              <h2 className="text-lg font-semibold text-red-700">Invite not valid</h2>
              <p className="mt-2 text-sm text-navy-400">{loadError}</p>
              <Button
                variant="outline"
                onClick={() => navigate('/login')}
                className="mt-6 w-full"
              >
                Go to sign in
              </Button>
            </>
          ) : invite ? (
            <>
              <h2 className="text-lg font-semibold text-navy">Set up your account</h2>
              <p className="mt-1 text-sm text-navy-400">
                You've been invited as <strong>{ROLE_LABELS[invite.role] || invite.role}</strong>.
              </p>

              <div className="mt-4 rounded-lg bg-navy-50 px-3 py-2">
                <div className="text-xs text-navy-400">Name</div>
                <div className="font-semibold text-navy">{invite.name}</div>
                <div className="mt-2 text-xs text-navy-400">Email</div>
                <div className="text-navy">{invite.email}</div>
              </div>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-navy">Choose a password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                  />
                  <p className="mt-1 text-xs text-navy-400">Minimum 8 characters.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-navy">Confirm password</label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    minLength={8}
                    className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                  />
                </div>
                {error && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                )}
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Creating account…' : 'Create account'}
                </Button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
