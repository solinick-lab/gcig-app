import { useEffect, useMemo, useState } from 'react';
import { Calendar as BigCalendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import { Plus, Presentation, CalendarDays, Send, Utensils, Handshake } from 'lucide-react';
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
import EventAttendance from '../components/EventAttendance.jsx';
import AdminOnly from '../components/AdminOnly.jsx';
import FileUploader from '../components/FileUploader.jsx';
import FileSummary from '../components/FileSummary.jsx';
import FilePreviewModal from '../components/FilePreviewModal.jsx';
import RequestPitchModal from '../components/RequestPitchModal.jsx';
import { formatStartTime, ROOM_LABELS } from '../lib/lunchSlots.js';
import { isManagedFile, openOrPreview } from '../api/fileHelpers.js';

const PITCH_ROLES = ['President', 'CIO', 'SeniorPortfolioManager', 'PortfolioManager'];
const CROSS_POD_ROLES = new Set(['President', 'CIO', 'SeniorPortfolioManager']);
const EXECUTIVE_ROLES = new Set(['President', 'CIO']);

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

function emptyPitchForm() {
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
function emptyEventForm() {
  return {
    id: null,
    title: '',
    date: '',
    location: '',
    description: '',
    audience: 'all',
    slideshowUrl: '',
  };
}

export default function Calendar() {
  const { user } = useAuth();
  const canEditPitches = PITCH_ROLES.includes(user?.role);
  const canEditEvents = EXECUTIVE_ROLES.has(user?.role);

  // ── Data ──
  const [pitches, setPitches] = useState([]);
  const [events, setEvents] = useState([]);
  const [users, setUsers] = useState([]);
  const [industries, setIndustries] = useState([]);

  // ── UI state ──
  const [selectedType, setSelectedType] = useState(null); // 'pitch' | 'event' | null
  const [selected, setSelected] = useState(null);

  const [pitchModalOpen, setPitchModalOpen] = useState(false);
  const [pitchForm, setPitchForm] = useState(emptyPitchForm());
  const [pitchSubmitting, setPitchSubmitting] = useState(false);
  const [pitchError, setPitchError] = useState('');

  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [eventForm, setEventForm] = useState(emptyEventForm());

  const [requestPitchOpen, setRequestPitchOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [leaderLunch, setLeaderLunch] = useState([]);
  // Approved pitch meetings the current user is a party to. Fetched
  // separately from /pitches because they live in PitchRequest, not
  // Pitch — and they're scoped server-side so unrelated members
  // can't see meetings they aren't in.
  const [pitchMeetings, setPitchMeetings] = useState([]);

  async function loadLeaderLunch() {
    try {
      const { data } = await api.get('/users/lunch/leaders');
      setLeaderLunch(data);
    } catch {
      setLeaderLunch([]);
    }
  }
  async function loadPitchMeetings() {
    try {
      const { data } = await api.get('/pitch-requests/calendar');
      setPitchMeetings(data);
    } catch {
      setPitchMeetings([]);
    }
  }

  async function loadPitches() {
    const { data } = await api.get('/pitches');
    setPitches(data);
  }
  async function loadEvents() {
    const { data } = await api.get('/events');
    setEvents(data);
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
    loadPitches();
    loadEvents();
    loadIndustries();
    loadLeaderLunch();
    loadPitchMeetings();
    if (canEditPitches) loadUsers();
  }, [canEditPitches]);

  // ── Merge both sources into calendar events ──
  const calendarEvents = useMemo(() => {
    const pitchEvents = pitches.map((p) => {
      const presenterText =
        p.presenters && p.presenters.length > 0
          ? p.presenters.map((pp) => pp.name.split(' ')[0]).join(', ')
          : p.industry
          ? `${p.industry.name} pod`
          : p.pitcherName || 'TBD';
      return {
        id: `pitch-${p.id}`,
        title: `📊 ${p.ticker} — ${presenterText}`,
        start: new Date(p.date),
        end: new Date(new Date(p.date).getTime() + 60 * 60 * 1000),
        resource: { type: 'pitch', data: p },
      };
    });
    const evtEvents = events.map((e) => {
      const start = new Date(e.date);
      const durationMs = (e.durationMinutes ?? 60) * 60 * 1000;
      return {
        id: `event-${e.id}`,
        title: e.title,
        start,
        end: new Date(start.getTime() + durationMs),
        resource: { type: 'event', data: e, audience: e.audience || 'all' },
      };
    });
    // Approved pitch meetings — anchor each event at the proposed
    // start time within the proposed date and give it a 30 min slot.
    const meetingEvents = pitchMeetings
      .filter((m) => m.proposedDate && m.proposedStartTime)
      .map((m) => {
        const day = new Date(m.proposedDate);
        const [hh, mm] = m.proposedStartTime.split(':').map(Number);
        // UTC accessors keep "the day the user picked" stable — the
        // proposedDate is stored as UTC midnight, so reading via local
        // accessors flips to the previous day in ET. Combine the
        // calendar day with the school-local lunch hour for display.
        const start = new Date(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          hh,
          mm,
          0,
          0
        );
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        const requesterFirst =
          (m.requester?.name || '').split(' ')[0] || 'Member';
        return {
          id: `pitch-meeting-${m.id}`,
          title: `🤝 ${m.ticker} — ${requesterFirst} w/ President`,
          start,
          end,
          resource: { type: 'pitchRequest', data: m },
        };
      });
    return [...pitchEvents, ...evtEvents, ...meetingEvents];
  }, [pitches, events, pitchMeetings]);

  // ── Styling: pitches = gold, events = navy, pitch-meetings = emerald ──
  function eventPropGetter(calEvent) {
    const t = calEvent.resource?.type;
    if (t === 'pitch') {
      return {
        style: {
          backgroundColor: '#C9A84C',
          color: '#1B2A4A',
          borderRadius: 4,
          border: 'none',
          fontWeight: 600,
        },
      };
    }
    if (t === 'pitchRequest') {
      return {
        style: {
          backgroundColor: '#059669', // emerald-600
          color: 'white',
          borderRadius: 4,
          border: 'none',
          fontWeight: 600,
        },
      };
    }
    return {
      style: {
        backgroundColor: '#1B2A4A',
        color: 'white',
        borderRadius: 4,
        border: 'none',
      },
    };
  }

  function handleSelectEvent(calEvent) {
    setSelectedType(calEvent.resource.type);
    setSelected(calEvent.resource.data);
  }

  // ── Pitch modal handlers ──
  function openPitchCreate() {
    setPitchForm(emptyPitchForm());
    setPitchError('');
    setPitchModalOpen(true);
  }
  function openPitchEdit(p) {
    setPitchForm({
      id: p.id,
      pitcherName: p.pitcherName || '',
      ticker: p.ticker,
      date: utcIsoToEtInputValue(p.date),
      location: p.location || '',
      slideshowUrl: p.slideshowUrl || '',
      presenterIds: (p.presenters || []).map((pp) => pp.id),
      industryId: p.industry?.id ? String(p.industry.id) : '',
    });
    setPitchError('');
    setPitchModalOpen(true);
    setSelected(null);
    setSelectedType(null);
  }
  async function handlePitchSubmit(e) {
    e.preventDefault();
    setPitchError('');
    setPitchSubmitting(true);
    try {
      const presenterNames = users
        .filter((u) => pitchForm.presenterIds.includes(u.id))
        .map((u) => u.name);
      const industry = industries.find(
        (i) => String(i.id) === String(pitchForm.industryId)
      );
      const pitcherName =
        pitchForm.pitcherName?.trim() ||
        presenterNames.join(', ') ||
        (industry ? `${industry.name} pod` : '') ||
        'TBD';
      const body = {
        pitcherName,
        ticker: pitchForm.ticker,
        date: etInputValueToUtcIso(pitchForm.date),
        location: pitchForm.location || null,
        slideshowUrl: pitchForm.slideshowUrl || null,
        presenterIds: pitchForm.presenterIds,
        industryId: pitchForm.industryId ? Number(pitchForm.industryId) : null,
      };
      if (pitchForm.id) {
        await api.put(`/pitches/${pitchForm.id}`, body);
      } else {
        await api.post('/pitches', body);
      }
      setPitchModalOpen(false);
      loadPitches();
    } catch (err) {
      setPitchError(err.response?.data?.error || 'Failed to save pitch');
    } finally {
      setPitchSubmitting(false);
    }
  }
  async function handlePitchDelete(id) {
    if (!confirm('Delete this pitch?')) return;
    await api.delete(`/pitches/${id}`);
    setSelected(null);
    setSelectedType(null);
    loadPitches();
  }

  // ── Event modal handlers ──
  function openEventCreate() {
    setEventForm(emptyEventForm());
    setEventModalOpen(true);
  }
  function openEventEdit(ev) {
    setEventForm({
      id: ev.id,
      title: ev.title,
      date: utcIsoToEtInputValue(ev.date),
      location: ev.location || '',
      description: ev.description || '',
      audience: ev.audience || 'all',
      slideshowUrl: ev.slideshowUrl || '',
      recurring: !!ev.recurring,
    });
    setEventModalOpen(true);
    setSelected(null);
    setSelectedType(null);
  }
  async function handleEventSubmit(e) {
    e.preventDefault();
    const body = {
      slideshowUrl: eventForm.slideshowUrl || null,
    };
    // Recurring events: schedule fields are managed in code, only the
    // slideshow attachment is editable. Skip the rest of the body so the
    // server doesn't reject the update.
    if (!eventForm.recurring) {
      body.title = eventForm.title;
      body.date = etInputValueToUtcIso(eventForm.date);
      body.location = eventForm.location || null;
      body.description = eventForm.description || null;
      body.audience = eventForm.audience || 'all';
    }
    if (eventForm.id) {
      await api.put(`/events/${eventForm.id}`, body);
    } else {
      await api.post('/events', body);
    }
    setEventModalOpen(false);
    loadEvents();
  }
  async function handleEventDelete(id) {
    if (!confirm('Delete this event?')) return;
    await api.delete(`/events/${id}`);
    setSelected(null);
    setSelectedType(null);
    loadEvents();
  }

  return (
    <>
      <PageHeader
        kicker="Schedule"
        title="Calendar"
        subtitle="Pitches and club events on one view."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setRequestPitchOpen(true)}
              variant="outline"
            >
              <Send className="h-4 w-4" />
              Request a Pitch
            </Button>
            {canEditPitches && (
              <Button onClick={openPitchCreate} variant="gold">
                <Plus className="h-4 w-4" />
                Add Pitch
              </Button>
            )}
            {canEditEvents && (
              <Button onClick={openEventCreate}>
                <Plus className="h-4 w-4" />
                Add Event
              </Button>
            )}
          </div>
        }
      />

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-navy-400">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-gold" />
            <Presentation className="h-3 w-3" />
            Pitch
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-navy" />
            <CalendarDays className="h-3 w-3" />
            Event
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-emerald-600" />
            <Handshake className="h-3 w-3" />
            Pitch meeting
          </span>
        </div>
        {/* Mobile: agenda list. Desktop: full BigCalendar grid. */}
        <div className="md:hidden">
          <MobileAgenda events={calendarEvents} onSelect={handleSelectEvent} />
        </div>
        <div className="hidden md:block" style={{ height: 600 }}>
          <BigCalendar
            localizer={localizer}
            events={calendarEvents}
            startAccessor="start"
            endAccessor="end"
            eventPropGetter={eventPropGetter}
            onSelectEvent={handleSelectEvent}
            popup
          />
        </div>
      </Card>

      <div className="mt-4">
        <PitchRequestCard
          leaders={leaderLunch}
          onRequestClick={() => setRequestPitchOpen(true)}
        />
      </div>

      <RequestPitchModal
        open={requestPitchOpen}
        onClose={() => setRequestPitchOpen(false)}
        onSubmitted={() => {
          loadLeaderLunch();
          loadPitchMeetings();
        }}
      />

      {/* ── Pitch meeting detail modal ── */}
      <Modal
        open={selectedType === 'pitchRequest' && !!selected}
        onClose={() => {
          setSelected(null);
          setSelectedType(null);
        }}
        title="Pitch Meeting"
        size="md"
      >
        {selectedType === 'pitchRequest' && selected && (
          <div className="space-y-4">
            <div>
              <div className="text-xs uppercase text-navy-400">Ticker</div>
              <div className="text-xl font-bold text-navy">
                {selected.ticker}
                {selected.companyName && (
                  <span className="ml-2 text-sm font-normal text-navy-400">
                    {selected.companyName}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs uppercase text-navy-400">When</div>
                <div className="text-navy">
                  {format(new Date(selected.proposedDate), 'EEE, MMM d')}
                </div>
                <div className="text-sm text-navy">
                  {formatStartTime(selected.proposedStartTime)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-navy-400">Where</div>
                <div className="text-navy">
                  {ROOM_LABELS[selected.room] || selected.room || '—'}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-navy-50 pt-3">
              <div>
                <div className="text-xs uppercase text-navy-400">Requester</div>
                <div className="text-sm text-navy">
                  {selected.requester?.name || '—'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-navy-400">President</div>
                <div className="text-sm text-navy">
                  {selected.president?.name || '—'}
                </div>
              </div>
              {selected.pm && (
                <div className="col-span-2">
                  <div className="text-xs uppercase text-navy-400">Sector PM</div>
                  <div className="text-sm text-navy">
                    {selected.pm.name}
                    {selected.industry?.name ? ` · ${selected.industry.name}` : ''}
                  </div>
                </div>
              )}
            </div>
            {selected.thesis && (
              <div className="border-t border-navy-50 pt-3">
                <div className="text-xs uppercase text-navy-400">Thesis</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-navy">
                  {selected.thesis}
                </p>
              </div>
            )}
            {selected.deckRef && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() =>
                    openOrPreview(
                      {
                        url: selected.deckRef,
                        title: `${selected.ticker} pitch deck`,
                        filename: `${selected.ticker}-deck.pdf`,
                      },
                      setPreview
                    )
                  }
                  className="text-sm font-semibold text-gold-700 underline"
                >
                  View deck →
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── Pitch detail modal ── */}
      <Modal
        open={selectedType === 'pitch' && !!selected}
        onClose={() => {
          setSelected(null);
          setSelectedType(null);
        }}
        title="Pitch Details"
        size="lg"
      >
        {selectedType === 'pitch' && selected && (
          <div className="space-y-4">
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
            {isManagedFile(selected.slideshowUrl) && (
              <div className="mt-2">
                <FileSummary
                  fileRef={selected.slideshowUrl}
                  filename={`${selected.ticker} slideshow`}
                />
              </div>
            )}
            {canEditPitches && (
              <div className="flex gap-2 pt-3 border-t border-navy-50">
                <Button variant="outline" onClick={() => openPitchEdit(selected)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => handlePitchDelete(selected.id)}>
                  Delete
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ── Event detail modal (with attendance) ── */}
      <Modal
        open={selectedType === 'event' && !!selected}
        onClose={() => {
          setSelected(null);
          setSelectedType(null);
        }}
        title="Event Details"
        size="lg"
      >
        {selectedType === 'event' && selected && (
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
            {selected.slideshowUrl && (
              <button
                type="button"
                onClick={() =>
                  openOrPreview(
                    {
                      url: selected.slideshowUrl,
                      title: `${selected.title} slideshow`,
                      filename: `${selected.title || 'event'}-slides.pdf`,
                    },
                    setPreview
                  )
                }
                className="inline-block text-sm font-semibold text-gold-700 underline"
              >
                View slideshow →
              </button>
            )}
            {selected.recurring && (
              <div className="rounded-lg bg-gold-100 px-3 py-2 text-xs font-semibold text-gold-700">
                Recurring weekly event — schedule managed in code (slideshow can still be attached)
              </div>
            )}
            <AdminOnly>
              <div className="border-t border-navy-50 pt-4">
                <EventAttendance eventId={selected.id} />
              </div>
              {canEditEvents && (
                <div className="flex gap-2 pt-3 border-t border-navy-50">
                  <Button variant="outline" onClick={() => openEventEdit(selected)}>
                    Edit
                  </Button>
                  {!selected.recurring && (
                    <Button
                      variant="danger"
                      onClick={() => handleEventDelete(selected.id)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </AdminOnly>
          </div>
        )}
      </Modal>

      {/* ── Pitch create/edit modal ── */}
      <Modal
        open={pitchModalOpen}
        onClose={() => setPitchModalOpen(false)}
        title={pitchForm.id ? 'Edit Pitch' : 'Add Pitch'}
      >
        <form onSubmit={handlePitchSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-navy">
              Industry (pod pitching)
            </label>
            <select
              value={pitchForm.industryId}
              onChange={(e) => setPitchForm({ ...pitchForm, industryId: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            >
              <option value="">(no industry — individual pitch)</option>
              {industries
                .filter(
                  (i) =>
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
                value={pitchForm.presenterIds}
                onChange={(ids) => setPitchForm({ ...pitchForm, presenterIds: ids })}
              />
            </div>
            <p className="mt-1 text-xs text-navy-400">
              Leave blank if the full industry pod is presenting.
            </p>
          </div>
          <Field
            label="Additional names (optional — for guest pitchers)"
            value={pitchForm.pitcherName}
            onChange={(v) => setPitchForm({ ...pitchForm, pitcherName: v })}
          />
          <Field
            label="Ticker"
            value={pitchForm.ticker}
            onChange={(v) => setPitchForm({ ...pitchForm, ticker: v.toUpperCase() })}
            required
          />
          <Field
            label="Date & Time"
            type="datetime-local"
            value={pitchForm.date}
            onChange={(v) => setPitchForm({ ...pitchForm, date: v })}
            required
          />
          <Field
            label="Location"
            value={pitchForm.location}
            onChange={(v) => setPitchForm({ ...pitchForm, location: v })}
          />
          <FileUploader
            label="Slideshow"
            value={pitchForm.slideshowUrl}
            onChange={(slideshowUrl) =>
              setPitchForm({ ...pitchForm, slideshowUrl })
            }
            hint="Upload a PPTX / PDF, or paste a Google Slides link. Optional."
          />
          {pitchError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {pitchError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setPitchModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pitchSubmitting}>
              {pitchSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Event create/edit modal ── */}
      <Modal
        open={eventModalOpen}
        onClose={() => setEventModalOpen(false)}
        title={eventForm.id ? 'Edit Event' : 'Add Event'}
      >
        <form onSubmit={handleEventSubmit} className="space-y-3">
          {eventForm.recurring && (
            <div className="rounded-lg border border-gold-200 bg-gold-100/40 px-3 py-2 text-xs text-navy">
              <span className="font-semibold">Recurring meeting.</span> Title,
              date, location, and audience are managed in code — only the
              slideshow attachment is editable here.
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-navy">Title</label>
            <input
              required={!eventForm.recurring}
              disabled={eventForm.recurring}
              value={eventForm.title}
              onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:bg-navy-50 disabled:text-navy-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Date & Time</label>
            <input
              type="datetime-local"
              required={!eventForm.recurring}
              disabled={eventForm.recurring}
              value={eventForm.date}
              onChange={(e) => setEventForm({ ...eventForm, date: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:bg-navy-50 disabled:text-navy-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Location</label>
            <input
              disabled={eventForm.recurring}
              value={eventForm.location}
              onChange={(e) => setEventForm({ ...eventForm, location: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:bg-navy-50 disabled:text-navy-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Description</label>
            <textarea
              rows={3}
              disabled={eventForm.recurring}
              value={eventForm.description}
              onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:bg-navy-50 disabled:text-navy-400"
            />
          </div>
          {!eventForm.recurring && (
            <div>
              <label className="flex items-start gap-2 text-sm text-navy">
                <input
                  type="checkbox"
                  checked={eventForm.audience === 'advisory'}
                  onChange={(e) =>
                    setEventForm({
                      ...eventForm,
                      audience: e.target.checked ? 'advisory' : 'all',
                    })
                  }
                  className="mt-1 h-4 w-4 rounded border-navy-100 text-gold focus:ring-gold"
                />
                <span>
                  <span className="font-medium">Advisory Board event</span>
                  <span className="mt-0.5 block text-xs text-navy-400">
                    When checked, only Advisory Board members and Faculty
                    Advisors appear in the attendance sheet for this event.
                  </span>
                </span>
              </label>
            </div>
          )}
          <FileUploader
            label="Slideshow"
            value={eventForm.slideshowUrl}
            onChange={(slideshowUrl) =>
              setEventForm({ ...eventForm, slideshowUrl })
            }
            hint="Upload a PPTX / PDF, or paste a Google Slides link. Optional."
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEventModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
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

// Mobile fallback for the calendar grid. Shows a scrollable agenda of the
// next 30 days of events + pitches (plus the most recent past events so
// history is still reachable). Pitches are tinted gold, events navy — same
// palette as the desktop grid.
function MobileAgenda({ events, onSelect }) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const pastLimit = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const visible = events
    .filter((e) => e.start >= pastLimit && e.start <= horizon)
    .sort((a, b) => a.start - b.start);

  if (visible.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-navy-400">
        Nothing on the calendar in the next 30 days.
      </div>
    );
  }

  // Group by date (YYYY-MM-DD).
  const groups = new Map();
  for (const e of visible) {
    const key = format(e.start, 'yyyy-MM-dd');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([dayKey, dayEvents]) => {
        const day = new Date(dayKey);
        const isToday = format(now, 'yyyy-MM-dd') === dayKey;
        return (
          <div key={dayKey}>
            <div className="mb-2 flex items-baseline gap-2 border-b border-navy-50 pb-1">
              <div className={`text-sm font-bold ${isToday ? 'text-gold-700' : 'text-navy'}`}>
                {format(day, 'EEE, MMM d')}
              </div>
              {isToday && (
                <span className="rounded-full bg-gold px-2 py-0.5 text-[10px] font-bold uppercase text-navy">
                  Today
                </span>
              )}
            </div>
            <div className="space-y-2">
              {dayEvents.map((e) => {
                const t = e.resource?.type;
                const tone =
                  t === 'pitch'
                    ? 'border-gold-300 bg-gold-100/40 hover:bg-gold-100/70'
                    : t === 'pitchRequest'
                    ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100'
                    : 'border-navy-100 bg-white hover:bg-navy-50';
                const subline =
                  t === 'pitchRequest'
                    ? e.resource.data.room
                      ? // Use the imported helper at module top via closure
                        // — small enough that we don't import again here.
                        e.resource.data.room.replace(/_/g, ' ')
                      : null
                    : e.resource?.data?.location;
                return (
                  <button
                    key={e.id}
                    onClick={() => onSelect(e)}
                    className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition ${tone}`}
                  >
                    <div className="w-14 shrink-0 text-xs text-navy-400 tabular-nums">
                      {format(e.start, 'h:mm a')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-navy">
                        {e.title}
                      </div>
                      {subline && (
                        <div className="truncate text-[11px] text-navy-400">
                          {subline}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Editorial card for the "Request a Pitch with the President" feature.
// Renders directly under the calendar so members can see lunch availability
// across the President + every PM at a glance before opening the modal.
const LUNCH_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const LUNCH_DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };
function lunchCellLabel(v) {
  if (v === 'Both') return 'Either';
  if (v === 'First') return '1st';
  if (v === 'Second') return '2nd';
  return '—';
}
function lunchCellClass(v) {
  if (v === 'Both') return 'bg-gold-100 text-gold-800';
  if (v === 'First' || v === 'Second') return 'bg-navy-50 text-navy';
  return 'bg-white text-navy-300';
}

function PitchRequestCard({ leaders, onRequestClick }) {
  // Pitch meetings happen with the President(s), so this card only lists
  // them — PMs aren't part of the meeting cadence shown here. They're
  // still cc'd downstream via the request form's industry picker.
  const presidents = leaders.filter((l) => l.role === 'President');
  const hasAnySchedule = presidents.some(
    (l) => l.lunchSchedule && Object.values(l.lunchSchedule).some(Boolean)
  );
  return (
    <Card
      kicker="Members"
      title="Request a Pitch with the President"
      action={
        <Button onClick={onRequestClick} variant="gold">
          <Send className="h-4 w-4" />
          New request
        </Button>
      }
    >
      <p className="mb-4 text-sm text-navy-600">
        Any member can request a pitch meeting with the President. Pick a sector
        below — the PM responsible for that sector will be cc'd. Your request
        won't be submitted until you attach a slide deck.
      </p>
      <div className="rounded-lg border border-navy-100 bg-navy-50/40 p-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-700">
          <Utensils className="h-3.5 w-3.5" />
          Lunch availability
        </div>
        {!hasAnySchedule ? (
          <p className="text-xs text-navy-400">
            Lunch availability hasn't been entered yet. Members can set theirs
            from the Profile page.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-xs">
              <thead>
                <tr className="text-navy-400">
                  <th className="py-1 pr-2 font-medium">Member</th>
                  {LUNCH_DAYS.map((d) => (
                    <th key={d} className="px-2 py-1 text-center font-medium">
                      {LUNCH_DAY_LABELS[d]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {presidents.map((l) => (
                  <tr key={l.id} className="border-t border-navy-50">
                    <td className="py-1.5 pr-2">
                      <div className="font-semibold text-navy">{l.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-navy-400">
                        President
                      </div>
                    </td>
                    {LUNCH_DAYS.map((d) => {
                      const v = l.lunchSchedule?.[d] || null;
                      return (
                        <td key={d} className="px-1 py-1.5 text-center">
                          <span
                            className={`inline-block rounded-md px-2 py-0.5 text-[10px] font-semibold ${lunchCellClass(
                              v
                            )}`}
                          >
                            {lunchCellLabel(v)}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
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
