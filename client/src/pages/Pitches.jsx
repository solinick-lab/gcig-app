import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import { Plus } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import AdminOnly from '../components/AdminOnly.jsx';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

function emptyForm() {
  return {
    id: null,
    pitcherName: '',
    ticker: '',
    date: '',
    location: '',
    slideshow: null,
  };
}

export default function Pitches() {
  const [pitches, setPitches] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [selected, setSelected] = useState(null);

  async function load() {
    const { data } = await api.get('/pitches');
    setPitches(data);
  }

  useEffect(() => {
    load();
  }, []);

  const events = pitches.map((p) => ({
    id: p.id,
    title: `${p.ticker} — ${p.pitcherName}`,
    start: new Date(p.date),
    end: new Date(new Date(p.date).getTime() + 60 * 60 * 1000),
    resource: p,
  }));

  function openCreate() {
    setForm(emptyForm());
    setModalOpen(true);
  }

  function openEdit(pitch) {
    setForm({
      id: pitch.id,
      pitcherName: pitch.pitcherName,
      ticker: pitch.ticker,
      date: new Date(pitch.date).toISOString().slice(0, 16),
      location: pitch.location || '',
      slideshow: null,
    });
    setModalOpen(true);
    setSelected(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const fd = new FormData();
    fd.append('pitcherName', form.pitcherName);
    fd.append('ticker', form.ticker);
    fd.append('date', new Date(form.date).toISOString());
    if (form.location) fd.append('location', form.location);
    if (form.slideshow) fd.append('slideshow', form.slideshow);

    if (form.id) {
      await api.put(`/pitches/${form.id}`, fd);
    } else {
      await api.post('/pitches', fd);
    }
    setModalOpen(false);
    load();
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
          <AdminOnly>
            <Button onClick={openCreate} variant="gold">
              <Plus className="h-4 w-4" />
              Add Pitch
            </Button>
          </AdminOnly>
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
            <div>
              <div className="text-xs uppercase text-navy-400">Pitcher</div>
              <div className="font-semibold text-navy">{selected.pitcherName}</div>
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
              <a
                href={selected.slideshowUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-sm font-semibold text-gold-700 underline"
              >
                View slideshow →
              </a>
            )}
            <AdminOnly>
              <div className="flex gap-2 pt-3 border-t border-navy-50">
                <Button variant="outline" onClick={() => openEdit(selected)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => handleDelete(selected.id)}>
                  Delete
                </Button>
              </div>
            </AdminOnly>
          </div>
        )}
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? 'Edit Pitch' : 'Add Pitch'}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field
            label="Pitcher Name"
            value={form.pitcherName}
            onChange={(v) => setForm({ ...form, pitcherName: v })}
            required
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
            <label className="block text-sm font-medium text-navy">Slideshow (PDF/PPTX)</label>
            <input
              type="file"
              accept=".pdf,.ppt,.pptx"
              onChange={(e) => setForm({ ...form, slideshow: e.target.files[0] })}
              className="mt-1 w-full text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
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
