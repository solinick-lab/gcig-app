import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import { Plus } from 'lucide-react';
import api from '../api/client.js';
import {
  utcIsoToEtInputValue,
  etInputValueToUtcIso,
} from '../utils/etDateTime.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import MemberPicker from '../components/MemberPicker.jsx';
import FilePreviewModal from '../components/FilePreviewModal.jsx';
import { openOrPreview } from '../api/fileHelpers.js';

const PITCH_ROLES = ['President', 'CIO', 'SeniorPortfolioManager', 'PortfolioManager'];
const CROSS_POD_ROLES = new Set(['President', 'CIO', 'SeniorPortfolioManager']);

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

function emptyForm() {
  return {
    id: null,
    pitcherName: '',
    ticker: '',
    date: '',
    location: '',
    slideshowUrl: '',
    presenterIds: [],
    industryId: '',
  };
}

export default function Pitches() {
  const [pitches, setPitches] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const { user } = useAuth();
  const canEdit = PITCH_ROLES.includes(user?.role);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [users, setUsers] = useState([]);
  const [industries, setIndustries] = useState([]);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);

  async function load() {
    const { data } = await api.get('/pitches');
    setPitches(data);
  }

  async function loadUsers() {
    const { data } = await api.get('/users');
    setUsers(data);
  }

  async function loadIndustries() {
    const { data } = await api.get('/industries');
    setIndustries(data);
  }

  useEffect(() => {
    load();
    loadIndustries();
    if (canEdit) loadUsers();
  }, [canEdit]);

  const events = pitches.map((p) => {
    const presenterText =
      p.presenters && p.presenters.length > 0
        ? p.presenters.map((pp) => pp.name.split(' ')[0]).join(', ')
        : p.industry
        ? `${p.industry.name} pod`
        : p.pitcherName || 'TBD';
    return {
      id: p.id,
      title: `${p.ticker} — ${presenterText}`,
      start: new Date(p.date),
      end: new Date(new Date(p.date).getTime() + 60 * 60 * 1000),
      resource: p,
    };
  });

  function openCreate() {
    setForm(emptyForm());
    setModalOpen(true);
  }

  function openEdit(pitch) {
    setForm({
      id: pitch.id,
      pitcherName: pitch.pitcherName || '',
      ticker: pitch.ticker,
      date: utcIsoToEtInputValue(pitch.date),
      location: pitch.location || '',
      slideshowUrl: pitch.slideshowUrl || '',
      presenterIds: (pitch.presenters || []).map((p) => p.id),
      industryId: pitch.industry?.id ? String(pitch.industry.id) : '',
    });
    setModalOpen(true);
    setSelected(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // Derive pitcherName from selected presenters, falling back to industry
      // pod label, then explicit text.
      const presenterNames = users
        .filter((u) => form.presenterIds.includes(u.id))
        .map((u) => u.name);
      const industry = industries.find(
        (i) => String(i.id) === String(form.industryId)
      );
      const pitcherName =
        form.pitcherName?.trim() ||
        presenterNames.join(', ') ||
        (industry ? `${industry.name} pod` : '') ||
        'TBD';

      const body = {
        pitcherName,
        ticker: form.ticker,
        date: etInputValueToUtcIso(form.date),
        location: form.location || null,
        slideshowUrl: form.slideshowUrl || null,
        presenterIds: form.presenterIds,
        industryId: form.industryId ? Number(form.industryId) : null,
      };

      if (form.id) {
        await api.put(`/pitches/${form.id}`, body);
      } else {
        await api.post('/pitches', body);
      }
      setModalOpen(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Upload failed — check file size (max 25 MB) and format (.pdf, .ppt, .pptx)');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this pitch?')) return;
    await api.delete(`/pitches/${id}`);
    setSelected(null);
    load();
  }

  return (
    <>
      <PageHeader
        title="Upcoming Pitches"
        subtitle="Scheduled stock pitch presentations."
        actions={
          canEdit && (
            <Button onClick={openCreate} variant="gold">
              <Plus className="h-4 w-4" />
              Add Pitch
            </Button>
          )
        }
      />

      <Card>
        <div style={{ height: 600 }}>
          <Calendar
            localizer={localizer}
            events={events}
            startAccessor="start"
            endAccessor="end"
            onSelectEvent={(e) => setSelected(e.resource)}
          />
        </div>
      </Card>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Pitch Details"
      >
        {selected && (
          <div className="space-y-3">
            <div>
              <div className="text-xs uppercase text-navy-400">Ticker</div>
              <div className="text-xl font-bold text-navy">{selected.ticker}</div>
            </div>
            {selected.industry && (
              <div>
                <div className="text-xs uppercase text-navy-400">Industry Pod</div>
                <div className="mt-1 inline-flex items-center gap-2 rounded-full bg-gold-100 px-3 py-1 text-sm font-semibold text-gold-800">
                  {selected.industry.name}
                  {selected.industry.leader && (
                    <span className="text-xs text-gold-700">
                      · led by {selected.industry.leader.name}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs uppercase text-navy-400">Presenters</div>
              {selected.presenters && selected.presenters.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {selected.presenters.map((p) => (
                    <span
                      key={p.id}
                      className="rounded-full bg-navy-50 px-2 py-0.5 text-xs font-semibold text-navy"
                    >
                      {p.name}
                    </span>
                  ))}
                </div>
              ) : selected.industry ? (
                <div className="text-sm text-navy">
                  The full {selected.industry.name} pod is presenting.
                </div>
              ) : (
                <div className="font-semibold text-navy">{selected.pitcherName || 'TBD'}</div>
              )}
            </div>
            <div>
              <div className="text-xs uppercase text-navy-400">Date</div>
              <div className="text-navy">
                {format(new Date(selected.date), "EEEE, MMMM d, yyyy 'at' h:mm a")}
              </div>
            </div>
            {selected.location && (
              <div>
                <div className="text-xs uppercase text-navy-400">Location</div>
                <div className="text-navy">{selected.location}</div>
              </div>
            )}
            {selected.slideshowUrl && (
              <button
                type="button"
                onClick={() =>
                  openOrPreview(
                    {
                      url: selected.slideshowUrl,
                      title: `${selected.ticker || 'Pitch'} slideshow`,
                      filename: `${selected.ticker || 'pitch'}-slides.pdf`,
                    },
                    setPreview
                  )
                }
                className="inline-block text-sm font-semibold text-gold-700 underline"
              >
                View slideshow →
              </button>
            )}
            {canEdit && (
              <div className="flex gap-2 pt-3 border-t border-navy-50">
                <Button variant="outline" onClick={() => openEdit(selected)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => handleDelete(selected.id)}>
                  Delete
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? 'Edit Pitch' : 'Add Pitch'}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-navy">
              Industry (pod pitching)
            </label>
            <select
              value={form.industryId}
              onChange={(e) => setForm({ ...form, industryId: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            >
              <option value="">(no industry — individual pitch)</option>
              {industries
                .filter(
                  (i) =>
                    // Presidents, CIOs, SPMs see every industry. Everyone else
                    // (PMs) only sees industries they lead.
                    CROSS_POD_ROLES.has(user?.role) || i.leader?.id === user?.id
                )
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.leader ? ` — led by ${i.leader.name}` : ''}
                  </option>
                ))}
            </select>
            <p className="mt-1 text-xs text-navy-400">
              {CROSS_POD_ROLES.has(user?.role)
                ? 'Everyone in the selected pod gets an email and in-app popup.'
                : 'You can only schedule pitches for industries you lead.'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-navy">
              Specific Presenters (optional — overrides "whole pod")
            </label>
            <div className="mt-1">
              <MemberPicker
                users={users}
                value={form.presenterIds}
                onChange={(ids) => setForm({ ...form, presenterIds: ids })}
              />
            </div>
            <p className="mt-1 text-xs text-navy-400">
              Leave blank if the full industry pod is presenting.
            </p>
          </div>

          <Field
            label="Additional names (optional — for guest pitchers)"
            value={form.pitcherName}
            onChange={(v) => setForm({ ...form, pitcherName: v })}
          />
          <Field
            label="Ticker"
            value={form.ticker}
            onChange={(v) => setForm({ ...form, ticker: v.toUpperCase() })}
            required
          />
          <Field
            label="Date & Time"
            type="datetime-local"
            value={form.date}
            onChange={(v) => setForm({ ...form, date: v })}
            required
          />
          <Field
            label="Location"
            value={form.location}
            onChange={(v) => setForm({ ...form, location: v })}
          />
          <div>
            <label className="block text-sm font-medium text-navy">Slideshow Link (Google Slides, etc.)</label>
            <input
              type="url"
              value={form.slideshowUrl}
              onChange={(e) => setForm({ ...form, slideshowUrl: e.target.value })}
              placeholder="https://docs.google.com/presentation/d/..."
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
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
              {submitting ? 'Uploading…' : 'Save'}
            </Button>
          </div>
        </form>
      </Modal>
      {preview && (
        <FilePreviewModal
          url={preview.url}
          title={preview.title}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
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
