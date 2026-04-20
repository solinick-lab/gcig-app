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
  const text = !data?.configured
    ? 'Not configured'
    : data.ok
    ? `Up · ${data.latencyMs} ms`
    : `Down — ${data.error || 'no response'}`;
  return (
    <div className="flex items-center justify-between rounded-lg border border-navy-100 bg-white px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-semibold text-navy">{label}</span>
        {data?.model && (
          <span className="text-[10px] text-navy-400">{data.model}</span>
        )}
      </div>
      <span className={data?.ok ? 'text-navy' : 'text-navy-400'}>{text}</span>
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
  // Audit Log is only visible to the super admin (app owner). Other Presidents
  // see only the Members tab — no tab strip rendered if there's nothing to switch to.
  const tabs = [
    { id: 'members', label: 'Members' },
    ...(isSuperAdmin ? [{ id: 'audit', label: 'Audit Log' }] : []),
  ];
  const [tab, setTab] = useState('members');

  return (
    <>
      <PageHeader
        title="Admin"
        subtitle="Manage members and review security events."
      />
      <div className="mb-4">
        <LlmStatusCard />
      </div>
      <div className="mb-4 flex gap-1 border-b border-navy-100">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-semibold transition ${
              tab === t.id
                ? 'border-b-2 border-gold text-navy'
                : 'text-navy-400 hover:text-navy'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'audit' && isSuperAdmin ? <AuditLog embedded /> : <Members embedded />}
    </>
  );
}
