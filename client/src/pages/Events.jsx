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
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import AdminOnly from '../components/AdminOnly.jsx';
import EventAttendance from '../components/EventAttendance.jsx';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

function emptyForm() {
  return { id: null, title: '', date: '', location: '', description: '' };
}

export default function Events() {
  const [events, setEvents] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [selected, setSelected] = useState(null);

  async function load() {
    const { data } = await api.get('/events');
    setEvents(data);
  }
  useEffect(() => {
    load();
  }, []);

  const calendarEvents = events.map((e) => {
    const start = new Date(e.date);
    const durationMs = (e.durationMinutes ?? 60) * 60 * 1000;
    return {
      id: e.id,
      title: e.title,
      start,
      end: new Date(start.getTime() + durationMs),
      resource: e,
    };
  });

  function openCreate() {
    setForm(emptyForm());
    setModalOpen(true);
  }
  function openEdit(ev) {
    setForm({
      id: ev.id,
      title: ev.title,
      date: utcIsoToEtInputValue(ev.date),
      location: ev.location || '',
      description: ev.description || '',
    });
    setModalOpen(true);
    setSelected(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const body = {
      title: form.title,
      date: etInputValueToUtcIso(form.date),
      location: form.location || null,
      description: form.description || null,
    };
    if (form.id) {
      await api.put(`/events/${form.id}`, body);
    } else {
      await api.post('/events', body);
    }
    setModalOpen(false);
    load();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this event?')) return;
    await api.delete(`/events/${id}`);
    setSelected(null);
    load();
  }

  return (
    <>
      <PageHeader
        title="Events"
        subtitle="Speaker series, field trips, and other club events."
        actions={
          <AdminOnly>
            <Button onClick={openCreate} variant="gold">
              <Plus className="h-4 w-4" />
              Add Event
            </Button>
          </AdminOnly>
        }
      />

      <Card>
        <div style={{ height: 600 }}>
          <Calendar
            localizer={localizer}
            events={calendarEvents}
            startAccessor="start"
            endAccessor="end"
            onSelectEvent={(e) => setSelected(e.resource)}
          />
        </div>
      </Card>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Event Details"
        size="lg"
      >
        {selected && (
          <div className="space-y-4">
            <div className="text-xl font-bold text-navy">{selected.title}</div>
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
            {selected.description && (
              <div>
                <div className="text-xs uppercase text-navy-400">Description</div>
                <div className="whitespace-pre-wrap text-navy">{selected.description}</div>
              </div>
            )}

            {selected.recurring && (
              <div className="rounded-lg bg-gold-100 px-3 py-2 text-xs font-semibold text-gold-700">
                Recurring weekly event — managed in code
              </div>
            )}

            <AdminOnly>
              <div className="border-t border-navy-50 pt-4">
                <EventAttendance eventId={selected.id} />
              </div>
              {!selected.recurring && (
                <div className="flex gap-2 pt-3 border-t border-navy-50">
                  <Button variant="outline" onClick={() => openEdit(selected)}>
                    Edit
                  </Button>
                  <Button variant="danger" onClick={() => handleDelete(selected.id)}>
                    Delete
                  </Button>
                </div>
              )}
            </AdminOnly>
          </div>
        )}
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? 'Edit Event' : 'Add Event'}
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-navy">Title</label>
            <input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Date & Time</label>
            <input
              type="datetime-local"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Location</label>
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Description</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
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
