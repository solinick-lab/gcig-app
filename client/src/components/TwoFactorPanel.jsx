import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, Copy, Check } from 'lucide-react';
import api from '../api/client.js';
import Button from './Button.jsx';

export default function TwoFactorPanel() {
  const [status, setStatus] = useState(null); // { enabled }
  const [stage, setStage] = useState('idle'); // idle | setup | verify | disable
  const [setup, setSetup] = useState(null); // { secret, qrCodeDataUrl, backupCodes }
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function loadStatus() {
    const { data } = await api.get('/auth/me');
    setStatus(data);
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function startSetup() {
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/setup');
      setSetup(data);
      setStage('setup');
    } catch (err) {
      setError(err.response?.data?.error || 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  async function confirmSetup(e) {
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

  async function submitDisable(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/2fa/disable', { password, code });
      if (data.token) {
        // Server re-issued our session; keep us logged in.
        localStorage.setItem('gcig_token', data.token);
      }
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

  function copyBackup() {
    if (!setup?.backupCodes) return;
    navigator.clipboard.writeText(setup.backupCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!status) return <div className="text-navy-400">Loading…</div>;

  // After verify-setup completes, we land back on idle with message shown.
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
                ? "You'll need a code from your authenticator app every time you sign in."
                : 'Add a second factor (authenticator app) so a stolen password alone cannot sign in to your account.'}
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
            <Button onClick={startSetup} disabled={loading}>
              {loading ? 'Preparing…' : 'Enable 2FA'}
            </Button>
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

  if (stage === 'setup' && setup) {
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

        <div>
          <div className="text-sm font-semibold text-navy">2. Save your backup codes</div>
          <p className="mt-1 text-xs text-navy-400">
            You can use these codes if you lose access to your authenticator. Each code works once.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-navy-50 p-3 font-mono text-sm text-navy">
            {setup.backupCodes.map((c) => (
              <div key={c}>{c}</div>
            ))}
          </div>
          <Button variant="outline" onClick={copyBackup} className="mt-2">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy all codes'}
          </Button>
        </div>

        <form onSubmit={confirmSetup} className="space-y-3 border-t border-navy-100 pt-4">
          <div className="text-sm font-semibold text-navy">
            3. Enter the 6-digit code from your app to confirm
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
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
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

  if (stage === 'disable') {
    return (
      <form onSubmit={submitDisable} className="space-y-3">
        <p className="text-sm text-navy">
          Disabling 2FA makes your account less secure. Enter your password and a
          current code (or backup code) to confirm.
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
            Authenticator code or backup code
          </label>
          <input
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456  or  ABCD-EFGH"
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setStage('idle');
              setError('');
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
