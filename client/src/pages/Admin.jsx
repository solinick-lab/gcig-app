import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import Members from './Members.jsx';
import AuditLog from './AuditLog.jsx';

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
  const { isSuperAdmin } = useAuth();
  // Audit Log + Name Inference are only visible to the super admin (app
  // owner). Other Presidents see only the Members tab — no tab strip
  // rendered if there's nothing to switch to.
  const tabs = [
    { id: 'members', label: 'Members' },
    ...(isSuperAdmin
      ? [
          { id: 'audit', label: 'Audit Log' },
          { id: 'inference', label: 'Name Inference' },
        ]
      : []),
  ];
  const [tab, setTab] = useState('members');

  return (
    <>
      <PageHeader
        kicker="Club Management"
        title="Admin"
        subtitle="Manage members and review security events."
      />
      <div className="mb-4">
        <LlmStatusCard />
      </div>
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
