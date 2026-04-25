import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { RefreshCw, Sparkles, Cloud, Upload, Unplug } from 'lucide-react';
import api, { API_BASE } from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Members from './Members.jsx';
import AuditLog from './AuditLog.jsx';
import Participation from './Participation.jsx';

function ProviderRow({ label, data }) {
  const dot = !data?.configured
    ? 'bg-navy-200'
    : data.ok
    ? 'bg-emerald-500'
    : 'bg-red-500';
  const fullText = !data?.configured
    ? 'Not configured'
    : data.ok
    ? `Up · ${data.latencyMs} ms`
    : `Down — ${data.error || 'no response'}`;
  // Cap display to avoid a wall of HTML when the origin returns an error page.
  const displayText =
    fullText.length > 100 ? fullText.slice(0, 100).trim() + '…' : fullText;
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3"
      title={fullText}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
        <span className="font-semibold text-navy shrink-0">{label}</span>
        {data?.model && (
          <span className="truncate text-[10px] text-navy-400">{data.model}</span>
        )}
      </div>
      <span
        className={`truncate text-left sm:text-right ${data?.ok ? 'text-navy' : 'text-navy-400'}`}
      >
        {displayText}
      </span>
    </div>
  );
}

function LlmStatusCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/system/llm-status');
      setStatus(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load LLM status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const activeLabel =
    status?.active === 'local'
      ? 'Local (Ollama)'
      : status?.active === 'openai'
      ? 'OpenAI'
      : 'None reachable';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-gold" />
          <div className="text-sm font-semibold text-navy">AI Providers</div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-xs font-semibold text-gold-700 underline disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Checking…' : 'Recheck'}
        </button>
      </div>
      {error ? (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      ) : (
        <>
          <div className="space-y-1.5">
            <ProviderRow label="Local (Ollama)" data={status?.local} />
            <ProviderRow label="OpenAI" data={status?.openai} />
          </div>
          <div className="mt-3 text-[11px] text-navy-400">
            Serving: <span className="font-semibold text-navy">{activeLabel}</span>
            {status?.active === 'openai' && status?.local?.configured && (
              <> · local is down, fallback is live</>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export default function Admin() {
  const { isAdmin, isExecutive, isSuperAdmin } = useAuth();

  // Page-level gate. Everything under /admin is for the executive tier
  // or above — if a non-executive user lands here via a direct URL,
  // bounce them to the dashboard. Server-side routes are also gated,
  // but this prevents them from seeing scaffolding (PageHeader, tab
  // strip) that would suggest the page exists.
  if (!isExecutive && !isSuperAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  // Tab visibility:
  //   Members — always shown (every executive can see the roster).
  //   Participation — President only (isAdmin).
  //   Audit Log / Name Inference — super admin only.
  const tabs = [
    { id: 'members', label: 'Members' },
    ...(isAdmin ? [{ id: 'participation', label: 'Participation' }] : []),
    ...(isSuperAdmin
      ? [
          { id: 'audit', label: 'Audit Log' },
          { id: 'inference', label: 'Name Inference' },
        ]
      : []),
  ];
  const [tab, setTab] = useState('members');

  // The status cards are sensitive (LLM provider config / OneDrive
  // tokens) so they're gated tighter than the page itself. CIOs who
  // visit /admin just see the Members tab — no infrastructure strip.
  const showStatusStrip = isAdmin || isSuperAdmin;

  return (
    <>
      <PageHeader
        kicker="Club Management"
        title="Admin"
        subtitle="Manage members and review security events."
      />
      {showStatusStrip && (
        <div className="mb-4 grid gap-4 md:grid-cols-2">
          {isAdmin && <LlmStatusCard />}
          {isSuperAdmin && <OneDriveCard />}
        </div>
      )}
      <div className="mb-6 flex gap-6 border-b border-navy-100">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative pb-3 font-serif text-lg font-semibold transition ${
              tab === t.id
                ? 'text-navy'
                : 'text-navy-400 hover:text-navy'
            }`}
          >
            {t.label}
            {tab === t.id && (
              <span className="absolute -bottom-px left-0 h-[2px] w-full bg-gold" />
            )}
          </button>
        ))}
      </div>
      {tab === 'audit' && isSuperAdmin ? (
        <AuditLog embedded />
      ) : tab === 'inference' && isSuperAdmin ? (
        <NameInferenceTable />
      ) : tab === 'participation' && isAdmin ? (
        <Participation embedded />
      ) : (
        <Members embedded />
      )}
    </>
  );
}

// ─── Name Inference (super-admin only) ─────────────────────────────────
// Readout of what the name-gender service thinks for each member:
// inferred gender, pronouns, honorific, and confidence. Useful for
// spotting wrong guesses (unisex / international / nicknames) before
// they land in a drafted AI message or a Landing page avatar tint.
function NameInferenceTable() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/users/name-inference');
      setRows(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load name inference');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        {error}
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="p-6 text-center text-sm text-navy-400">Loading…</div>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-navy">
            What the app thinks about each member's name
          </div>
          <p className="mt-1 max-w-2xl text-xs text-navy-400">
            Inferred from a US-frequency dataset, using the member's first
            name. Below 85% confidence the app falls back to they/them and
            drops the honorific — those rows show "Mx." below. This view is
            super-admin-only so wrong guesses can be caught before they
            surface in the AI Assistant or avatar tints.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:bg-navy-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-navy-100 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-navy-400">
              <th className="py-2 pr-3">Member</th>
              <th className="py-2 pr-3">First name</th>
              <th className="py-2 pr-3">Gender</th>
              <th className="py-2 pr-3">Confidence</th>
              <th className="py-2 pr-3">Honorific</th>
              <th className="py-2 pr-3">Pronouns</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const g = r.gender;
              const genderClass =
                g === 'F'
                  ? 'bg-rose-50 text-rose-800 border-rose-200'
                  : g === 'M'
                    ? 'bg-sky-50 text-sky-800 border-sky-200'
                    : 'bg-navy-50 text-navy-500 border-navy-100';
              const pronouns = r.pronouns
                ? `${r.pronouns.subject} / ${r.pronouns.object} / ${r.pronouns.possessive}`
                : '—';
              const confPct = r.confidence != null
                ? `${(r.confidence * 100).toFixed(1)}%`
                : '—';
              const lowConfidence =
                r.confidence != null && r.confidence < 0.85;
              return (
                <tr
                  key={r.id}
                  className="border-b border-navy-50 last:border-b-0"
                >
                  <td className="py-2 pr-3">
                    <div className="font-semibold text-navy">{r.name}</div>
                    <div className="text-[10px] text-navy-400">{r.role}</div>
                  </td>
                  <td className="py-2 pr-3 text-navy-500">
                    {r.firstName || '—'}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${genderClass}`}
                    >
                      {g === 'M' ? 'Male' : g === 'F' ? 'Female' : 'Unknown'}
                    </span>
                  </td>
                  <td
                    className={`py-2 pr-3 font-semibold tabular-nums ${
                      lowConfidence ? 'text-amber-700' : 'text-navy'
                    }`}
                    title={
                      lowConfidence
                        ? 'Below 85% — app uses neutral defaults'
                        : 'Confident enough to use honorific + binary pronouns'
                    }
                  >
                    {confPct}
                  </td>
                  <td className="py-2 pr-3">
                    {r.honorificName ? (
                      <span className="font-semibold text-navy">
                        {r.honorificName}
                      </span>
                    ) : (
                      <span className="text-navy-400">
                        Mx. (neutral fallback)
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-navy-500">{pronouns}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── OneDrive storage (super-admin only) ───────────────────────────────
// Status card + Connect / Disconnect / Test-upload buttons. The Connect
// button triggers a full-page navigation to /api/files/oauth/start —
// Microsoft's OAuth flow demands a real redirect, not a fetch. We pass
// the JWT via a query param for that one request because cross-origin
// redirects can't carry the Authorization header.
function OneDriveCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const fileInputRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/files/status');
      setStatus(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // If we just returned from the OAuth redirect, clear the hint
    // param and show a confirmation.
    if (searchParams.get('onedrive') === 'connected') {
      setTestMsg('Connected! Try a test upload below.');
      const next = new URLSearchParams(searchParams);
      next.delete('onedrive');
      setSearchParams(next, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleConnect() {
    // Fetch the Microsoft authorize URL (JWT carried in the header),
    // then full-page navigate so the browser follows the OAuth dance
    // and Microsoft can redirect back to our /oauth/callback.
    setError('');
    try {
      const { data } = await api.get('/files/oauth/start');
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setError('No authorize URL returned');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect OneDrive? You\'ll need to re-authorize to re-enable uploads.')) return;
    try {
      await api.post('/files/disconnect');
      setTestMsg('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Disconnect failed');
    }
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function handleTestUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setTestMsg(`Uploading ${file.name}…`);
    setError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post('/files/upload', form);
      setTestMsg(
        `Uploaded: ${data.name} (${Math.round(data.size / 1024)} KB). Item id: ${data.itemId.slice(0, 18)}…`
      );
    } catch (err) {
      setTestMsg('');
      setError(err.response?.data?.error || 'Upload failed');
    } finally {
      // Reset the input so the same file can be picked again
      e.target.value = '';
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-gold" />
          <div className="text-sm font-semibold text-navy">OneDrive</div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-xs font-semibold text-gold-700 underline disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {!status ? (
        <div className="rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs text-navy-400">
          Loading…
        </div>
      ) : !status.configured ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Server env vars not set. Add{' '}
          <code className="rounded bg-amber-100 px-1">ONEDRIVE_CLIENT_ID</code>
          ,{' '}
          <code className="rounded bg-amber-100 px-1">
            ONEDRIVE_CLIENT_SECRET
          </code>
          , and{' '}
          <code className="rounded bg-amber-100 px-1">
            ONEDRIVE_REDIRECT_URI
          </code>{' '}
          on Render, then redeploy.
        </div>
      ) : !status.connected ? (
        <div className="space-y-2">
          <div className="rounded-lg border border-navy-100 bg-navy-50/40 px-3 py-2 text-xs text-navy-500">
            Not connected. A super admin clicks <strong>Connect</strong> to
            authorize against a OneDrive account. Uploads are disabled until
            this is done.
          </div>
          <button
            type="button"
            onClick={handleConnect}
            className="inline-flex items-center gap-1.5 rounded-lg bg-navy px-3 py-2 text-xs font-semibold text-gold hover:bg-navy-700"
          >
            <Cloud className="h-3.5 w-3.5" />
            Connect OneDrive
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <div className="font-semibold">Connected</div>
            <div className="mt-0.5">
              Account: <span className="font-mono">{status.email || '—'}</span>
            </div>
            <div className="mt-0.5">
              Folder:{' '}
              <span className="font-mono">{status.folder}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-emerald-700">
              Token refreshes automatically.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleTestUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={pickFile}
              className="inline-flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-1.5 text-xs font-semibold text-navy hover:bg-navy-50"
            >
              <Upload className="h-3.5 w-3.5" />
              Test upload
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
            >
              <Unplug className="h-3.5 w-3.5" />
              Disconnect
            </button>
          </div>
          {testMsg && (
            <div className="rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs text-navy">
              {testMsg}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}
    </Card>
  );
}
