import { useState, useRef } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/Button.jsx';

const ALLOWED_DOMAIN = '@gcschool.org';

export default function Login() {
  const { user, login, signup, verify, resendCode } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'verify'
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const codeRefs = useRef([]);

  if (user) return <Navigate to="/" replace />;

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await signup(name, email, password);
      setPendingEmail(result.email);
      setMode('verify');
      setMessage(`Verification code sent to ${result.email}`);
      setCode(['', '', '', '', '', '']);
    } catch (err) {
      setError(err.response?.data?.error || 'Signup failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    setSubmitting(true);
    const codeStr = code.join('');
    if (codeStr.length !== 6) {
      setError('Enter all 6 digits');
      setSubmitting(false);
      return;
    }
    try {
      await verify(pendingEmail, codeStr);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setError('');
    setMessage('');
    try {
      await resendCode(pendingEmail);
      setMessage('New code sent — check your inbox');
      setCode(['', '', '', '', '', '']);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resend');
    }
  }

  function handleCodeChange(index, value) {
    if (value.length > 1) value = value.slice(-1);
    if (value && !/^\d$/.test(value)) return;
    const next = [...code];
    next[index] = value;
    setCode(next);
    // Auto-advance to next input
    if (value && index < 5) {
      codeRefs.current[index + 1]?.focus();
    }
  }

  function handleCodeKeyDown(index, e) {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      codeRefs.current[index - 1]?.focus();
    }
  }

  function handleCodePaste(e) {
    const pasted = e.clipboardData.getData('text').trim().slice(0, 6);
    if (/^\d{1,6}$/.test(pasted)) {
      const next = [...code];
      for (let i = 0; i < 6; i++) next[i] = pasted[i] || '';
      setCode(next);
      const focusIdx = Math.min(pasted.length, 5);
      codeRefs.current[focusIdx]?.focus();
      e.preventDefault();
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-navy via-navy-700 to-navy-800 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
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
          <p className="mt-4 text-xs uppercase tracking-[0.2em] text-gold font-semibold">
            Investment Group
          </p>
        </div>

        <div className="rounded-xl bg-white p-8 shadow-xl">
          {mode === 'verify' ? (
            <>
              <h2 className="text-lg font-semibold text-navy">Verify your email</h2>
              <p className="mt-1 text-sm text-navy-400">
                Enter the 6-digit code we sent to <strong>{pendingEmail}</strong>
              </p>

              <form onSubmit={handleVerify} className="mt-6 space-y-4">
                <div
                  className="flex justify-center gap-2"
                  onPaste={handleCodePaste}
                >
                  {code.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => (codeRefs.current[i] = el)}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleCodeChange(i, e.target.value)}
                      onKeyDown={(e) => handleCodeKeyDown(i, e)}
                      className="h-14 w-12 rounded-lg border-2 border-navy-100 text-center text-2xl font-bold text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                    />
                  ))}
                </div>

                {message && (
                  <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    {message}
                  </div>
                )}
                {error && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Verifying…' : 'Verify & Create Account'}
                </Button>

                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={handleResend}
                    className="font-semibold text-gold-700 underline"
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signup');
                      setError('');
                      setMessage('');
                    }}
                    className="font-semibold text-navy-400 underline"
                  >
                    Start over
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
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

              <form
                onSubmit={mode === 'login' ? handleLogin : handleSignup}
                className="mt-6 space-y-4"
              >
                {mode === 'signup' && (
                  <div>
                    <label className="block text-sm font-medium text-navy">
                      Full Name
                    </label>
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
                      : 'Sending code…'
                    : mode === 'login'
                    ? 'Sign in'
                    : 'Send verification code'}
                </Button>
              </form>
            </>
          )}
        </div>

        {mode === 'signup' && (
          <p className="mt-4 text-center text-xs text-navy-100">
            We'll send a 6-digit code to verify your email before creating your account.
            New members join as Junior Analyst.
          </p>
        )}
      </div>
    </div>
  );
}
