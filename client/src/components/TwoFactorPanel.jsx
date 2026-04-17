import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, Smartphone, Mail } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';

export default function TwoFactorPanel() {
  const [status, setStatus] = useState(null);
  const [stage, setStage] = useState('idle'); // idle | choose | totp-setup | email-setup | disable
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadStatus() {
    const { data } = await api.get('/auth/me');
    setStatus(data);
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function startTotp() {
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/setup');
      setSetup(data);
      setStage('totp-setup');
    } catch (err) {
      setError(err.response?.data?.error || 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  async function startEmail() {
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/setup-email');
      setSetup({ email: data.email });
      setStage('email-setup');
    } catch (err) {
      setError(err.response?.data?.error || 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  async function confirmTotp(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/2fa/verify-setup', { code });
      setMessage('Two-factor authentication is on.');
      setStage('idle');
      setSetup(null);
      setCode('');
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function confirmEmail(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/2fa/verify-setup-email', { code });
      setMessage('Email 2FA is on.');
      setStage('idle');
      setSetup(null);
      setCode('');
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function resendEmailSetup() {
    setError('');
    setMessage('');
    try {
      await api.post('/2fa/resend-setup-email');
      setMessage('New code sent.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resend');
    }
  }

  async function requestDisableCode() {
    setError('');
    setMessage('');
    try {
      await api.post('/2fa/send-disable-code');
      setMessage('Code sent — check your inbox.');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send code');
    }
  }

  async function submitDisable(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/disable', { password, code });
      if (data.token) localStorage.setItem('gcig_token', data.token);
      setMessage('Two-factor authentication is off.');
      setStage('idle');
      setPassword('');
      setCode('');
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.error || 'Disable failed');
    } finally {
      setLoading(false);
    }
  }

  if (!status) return <div className="text-navy-400">Loading…</div>;

  if (stage === 'idle') {
    return (
      <div>
        <div className="flex items-start gap-3">
          {status.twoFactorEnabled ? (
            <ShieldCheck className="h-8 w-8 shrink-0 text-emerald-600" />
          ) : (
            <ShieldOff className="h-8 w-8 shrink-0 text-navy-400" />
          )}
          <div className="flex-1">
            <div className="font-semibold text-navy">
              {status.twoFactorEnabled
                ? 'Two-factor authentication is ON'
                : 'Two-factor authentication is OFF'}
            </div>
            <p className="mt-1 text-sm text-navy-400">
              {status.twoFactorEnabled
                ? "You'll need a code every time you sign in. If you lose access, ask the President to reset it."
                : 'Add a second factor so a stolen password alone cannot sign in.'}
            </p>
          </div>
        </div>

        {message && (
          <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {message}
          </div>
        )}

        <div className="mt-4">
          {status.twoFactorEnabled ? (
            <Button variant="danger" onClick={() => setStage('disable')}>
              Disable 2FA
            </Button>
          ) : (
            <Button onClick={() => setStage('choose')}>Enable 2FA</Button>
          )}
        </div>
        {error && (
          <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  if (stage === 'choose') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-navy">Pick a method:</p>
        <button
          type="button"
          onClick={startTotp}
          disabled={loading}
          className="flex w-full items-start gap-3 rounded-lg border border-navy-100 p-4 text-left hover:border-gold hover:bg-gold-100/30 transition"
        >
          <Smartphone className="h-6 w-6 shrink-0 text-navy" />
          <div>
            <div className="font-semibold text-navy">Authenticator app (Recommended)</div>
            <div className="mt-1 text-xs text-navy-400">
              Google Authenticator, Authy, 1Password. Works offline, hardest to phish.
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={startEmail}
          disabled={loading}
          className="flex w-full items-start gap-3 rounded-lg border border-navy-100 p-4 text-left hover:border-gold hover:bg-gold-100/30 transition"
        >
          <Mail className="h-6 w-6 shrink-0 text-navy" />
          <div>
            <div className="font-semibold text-navy">Email code</div>
            <div className="mt-1 text-xs text-navy-400">
              We email you an 8-character code every sign-in. Simpler but weaker — anyone in your inbox can sign in as you.
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setStage('idle')}
          className="text-xs font-semibold text-navy-400 underline"
        >
          Cancel
        </button>
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
      </div>
    );
  }

  if (stage === 'totp-setup' && setup) {
    return (
      <div className="space-y-5">
        <div>
          <div className="text-sm font-semibold text-navy">1. Scan this QR code</div>
          <p className="mt-1 text-xs text-navy-400">
            In Google Authenticator, Authy, 1Password, or any TOTP app.
          </p>
          <img
            src={setup.qrCodeDataUrl}
            alt="2FA QR code"
            className="mt-3 h-48 w-48 rounded-lg border border-navy-100 bg-white"
          />
          <details className="mt-2 text-xs text-navy-400">
            <summary className="cursor-pointer">Can't scan? Enter manually</summary>
            <div className="mt-2 rounded-lg bg-navy-50 p-2 font-mono text-navy break-all">
              {setup.secret}
            </div>
          </details>
        </div>

        <form onSubmit={confirmTotp} className="space-y-3 border-t border-navy-100 pt-4">
          <div className="text-sm font-semibold text-navy">
            2. Enter the 6-digit code from your app
          </div>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456"
            className="w-full rounded-lg border border-navy-100 px-3 py-2 text-center text-xl font-bold tracking-widest text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStage('idle')}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !code}>
              {loading ? 'Verifying…' : 'Enable 2FA'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (stage === 'email-setup' && setup) {
    return (
      <div className="space-y-4">
        <div>
          <div className="text-sm font-semibold text-navy">Check your email</div>
          <p className="mt-1 text-sm text-navy-400">
            We sent an 8-character code to <strong>{setup.email}</strong>. Enter it below.
          </p>
        </div>
        <form onSubmit={confirmEmail} className="space-y-3">
          <input
            type="text"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD-EFGH"
            className="w-full rounded-lg border border-navy-100 px-3 py-3 text-center text-xl font-bold tracking-[0.3em] font-mono text-navy focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          {message && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {message}
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStage('idle')}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !code}>
              {loading ? 'Verifying…' : 'Enable email 2FA'}
            </Button>
          </div>
          <div className="text-center">
            <button
              type="button"
              onClick={resendEmailSetup}
              className="text-xs font-semibold text-gold-700 underline"
            >
              Resend code
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (stage === 'disable') {
    const isEmail = status.twoFactorEnabled && status.twoFactorMethod === 'email';
    return (
      <form onSubmit={submitDisable} className="space-y-3">
        <p className="text-sm text-navy">
          Disabling 2FA makes your account less secure. Confirm with your password
          {isEmail ? ' and an emailed code' : ' and a current code from your authenticator app'}.
        </p>
        <div>
          <label className="block text-sm font-medium text-navy">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-navy">
            {isEmail ? 'Email code' : 'Authenticator code'}
          </label>
          <input
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={isEmail ? 'ABCD-EFGH' : '123 456'}
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
          {isEmail && (
            <button
              type="button"
              onClick={requestDisableCode}
              className="mt-1 text-xs font-semibold text-gold-700 underline"
            >
              Send me a code
            </button>
          )}
        </div>
        {message && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setStage('idle');
              setError('');
              setMessage('');
              setPassword('');
              setCode('');
            }}
          >
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={loading}>
            {loading ? 'Disabling…' : 'Disable 2FA'}
          </Button>
        </div>
      </form>
    );
  }

  return null;
}
