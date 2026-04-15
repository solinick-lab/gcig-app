import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/Button.jsx';

const ALLOWED_DOMAIN = '@gcschool.org';

export default function Login() {
  const { user, login, signup } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await signup(name, email, password);
      }
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || `${mode === 'login' ? 'Login' : 'Signup'} failed`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-navy via-navy-700 to-navy-800 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-gold text-navy">
            <TrendingUp className="h-8 w-8" />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-white">GCIG</h1>
          <p className="mt-1 text-xs uppercase tracking-wider text-gold">
            Grace Church Investment Group
          </p>
        </div>

        <div className="rounded-xl bg-white p-8 shadow-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-navy">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </h2>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setError('');
              }}
              className="text-xs font-semibold text-gold-700 underline"
            >
              {mode === 'login' ? 'Need an account?' : 'Have an account? Sign in'}
            </button>
          </div>

          <p className="mt-1 text-sm text-navy-400">
            {mode === 'login'
              ? 'Club members can sign in below.'
              : `Self-signup is restricted to ${ALLOWED_DOMAIN} email addresses.`}
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="block text-sm font-medium text-navy">Full Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-navy">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder={mode === 'signup' ? `you${ALLOWED_DOMAIN}` : ''}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-navy">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'signup' ? 8 : undefined}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
              {mode === 'signup' && (
                <p className="mt-1 text-xs text-navy-400">Minimum 8 characters.</p>
              )}
            </div>
            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting
                ? mode === 'login'
                  ? 'Signing in…'
                  : 'Creating account…'
                : mode === 'login'
                ? 'Sign in'
                : 'Create account'}
            </Button>
          </form>
        </div>

        {mode === 'signup' && (
          <p className="mt-4 text-center text-xs text-navy-100">
            New members join as Junior Analyst — the President can promote your role after signup.
          </p>
        )}
      </div>
    </div>
  );
}
