import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Plus, Search, ExternalLink, Trash2 } from 'lucide-react';
import api from '../api/client.js';
import { safeHref } from '../api/safeUrl.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import FileUploader from '../components/FileUploader.jsx';
import FileSummary from '../components/FileSummary.jsx';
import { isManagedFile, downloadFile } from '../api/fileHelpers.js';

const REPORT_ROLES = ['President', 'CIO', 'SeniorPortfolioManager', 'PortfolioManager'];

function emptyForm() {
  return { title: '', author: '', ticker: '', date: '', description: '', fileUrl: '' };
}

export default function Reports({ embedded = false } = {}) {
  const { user } = useAuth();
  const canEdit = REPORT_ROLES.includes(user?.role);

  const [reports, setReports] = useState([]);
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const { data } = await api.get('/reports');
    setReports(data);
  }
  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.author.toLowerCase().includes(q) ||
        (r.ticker || '').toLowerCase().includes(q)
    );
  }, [reports, query]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/reports', {
        title: form.title,
        author: form.author,
        ticker: form.ticker || null,
        date: new Date(form.date).toISOString(),
        description: form.description || null,
        fileUrl: form.fileUrl,
      });
      setModalOpen(false);
      setForm(emptyForm());
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save report');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this report?')) return;
    await api.delete(`/reports/${id}`);
    load();
  }

  return (
    <>
      {!embedded && (
        <PageHeader
          kicker="Archive"
          title="Research Reports"
          subtitle="Library of member-authored research."
          actions={
            canEdit && (
              <Button onClick={() => setModalOpen(true)} variant="gold">
                <Plus className="h-4 w-4" />
                Add Report
              </Button>
            )
          }
        />
      )}

      <Card>
        {embedded && canEdit && (
          <div className="mb-4 flex justify-end">
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Add Report
            </Button>
          </div>
        )}
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-navy-100 px-3 py-2">
          <Search className="h-4 w-4 text-navy-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, ticker, or author…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-navy-400">No reports yet.</div>
        ) : (
          <ul className="divide-y divide-navy-50">
            {filtered.map((r) => (
              <li key={r.id} className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-navy">{r.title}</h3>
                      {r.ticker && (
                        <span className="rounded-full bg-gold-100 px-2 py-0.5 text-xs font-bold text-gold-700">
                          {r.ticker}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-sm text-navy-400">
                      By {r.author} • {format(new Date(r.date), 'MMM d, yyyy')}
                    </div>
                    {r.description && (
                      <p className="mt-2 text-sm text-navy">{r.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isManagedFile(r.fileUrl) ? (
                      <button
                        type="button"
                        onClick={() =>
                          downloadFile(r.fileUrl, `${r.title}.pdf`).catch(() => {})
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-2 text-xs font-semibold text-navy hover:bg-navy-50"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Download
                      </button>
                    ) : (
                      <a
                        href={safeHref(r.fileUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-2 text-xs font-semibold text-navy hover:bg-navy-50"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open
                      </a>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => handleDelete(r.id)}
                        className="rounded-lg p-2 text-red-600 hover:bg-red-50"
                        aria-label="Delete report"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                {isManagedFile(r.fileUrl) && (
                  <div className="mt-3">
                    <FileSummary fileRef={r.fileUrl} filename={r.title} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Report">
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} required />
          <Field label="Author" value={form.author} onChange={(v) => setForm({ ...form, author: v })} required />
          <Field label="Ticker (optional)" value={form.ticker} onChange={(v) => setForm({ ...form, ticker: v.toUpperCase() })} />
          <Field label="Date" type="date" value={form.date} onChange={(v) => setForm({ ...form, date: v })} required />
          <div>
            <label className="block text-sm font-medium text-navy">Description</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <FileUploader
            label="Report file"
            required
            value={form.fileUrl}
            onChange={(fileUrl) => setForm({ ...form, fileUrl })}
            hint="PDF / DOCX uploaded here, or paste a Google Docs link. Uploaded files are private to members."
          />
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save Report'}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function Field({ label, value, onChange, type = 'text', required }) {
  return (
    <div>
      <label className="block text-sm font-medium text-navy">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
      />
    </div>
  );
}
