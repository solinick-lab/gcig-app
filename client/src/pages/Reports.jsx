import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Plus, Search, Download, Trash2 } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import AdminOnly from '../components/AdminOnly.jsx';

function emptyForm() {
  return { title: '', author: '', ticker: '', date: '', description: '', file: null };
}

export default function Reports() {
  const [reports, setReports] = useState([]);
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());

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
    const fd = new FormData();
    fd.append('title', form.title);
    fd.append('author', form.author);
    if (form.ticker) fd.append('ticker', form.ticker);
    fd.append('date', new Date(form.date).toISOString());
    if (form.description) fd.append('description', form.description);
    fd.append('file', form.file);
    await api.post('/reports', fd);
    setModalOpen(false);
    setForm(emptyForm());
    load();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this report?')) return;
    await api.delete(`/reports/${id}`);
    load();
  }

  return (
    <>
      <PageHeader
        title="Research Reports"
        subtitle="Library of member-authored research."
        actions={
          <AdminOnly>
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Upload Report
            </Button>
          </AdminOnly>
        }
      />

      <Card>
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
              <li key={r.id} className="flex items-start justify-between gap-4 py-4">
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
                  <a
                    href={r.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-2 text-xs font-semibold text-navy hover:bg-navy-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    View
                  </a>
                  <AdminOnly>
                    <button
                      onClick={() => handleDelete(r.id)}
                      className="rounded-lg p-2 text-red-600 hover:bg-red-50"
                      aria-label="Delete report"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </AdminOnly>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Upload Report">
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
          <div>
            <label className="block text-sm font-medium text-navy">PDF File</label>
            <input
              type="file"
              accept=".pdf"
              required
              onChange={(e) => setForm({ ...form, file: e.target.files[0] })}
              className="mt-1 w-full text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Upload</Button>
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
