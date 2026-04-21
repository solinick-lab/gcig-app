import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Button from '../components/Button.jsx';

export default function ForgotPassword() {
  const { forgotPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await forgotPassword(email);
      setSent(true);
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
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
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
          <h2 className="text-lg font-semibold text-navy">Reset your password</h2>
          {sent ? (
            <>
              <p className="mt-2 text-sm text-navy-400">
                If an account exists for that email, we've sent a reset link. Check
                your inbox (and spam folder). The link expires in 30 minutes.
              </p>
              <Link
                to="/login"
                className="mt-6 inline-block text-sm font-semibold text-gold-700 underline"
              >
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-navy-400">
                Enter your email and we'll send you a reset link.
              </p>
              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-navy">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
                  />
                </div>
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Sending…' : 'Send reset link'}
                </Button>
                <div className="text-center">
                  <Link to="/login" className="text-xs font-semibold text-navy-400 underline">
                    Back to sign in
                  </Link>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
