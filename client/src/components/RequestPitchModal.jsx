import { useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import Modal from './Modal.jsx';
import Button from './Button.jsx';
import FileUploader from './FileUploader.jsx';
import { Send } from 'lucide-react';
import {
  weekdayKeyFor,
  generateLunchSlots,
  formatStartTime,
  ROOM_VALUES,
  ROOM_LABELS,
} from '../lib/lunchSlots.js';

const LUNCH_OPTIONS = [
  { value: '', label: 'No preference' },
  { value: 'First', label: 'First lunch' },
  { value: 'Second', label: 'Second lunch' },
  { value: 'Both', label: 'Either lunch' },
];

function lunchLabel(v) {
  if (v === 'Both') return 'Either';
  if (v === 'First') return '1st';
  if (v === 'Second') return '2nd';
  return '—';
}

export default function RequestPitchModal({ open, onClose, onSubmitted }) {
  const [industries, setIndustries] = useState([]);
  const [leaders, setLeaders] = useState([]);
  const [form, setForm] = useState({
    ticker: '',
    companyName: '',
    industryId: '',
    proposedDate: '',
    proposedLunch: '',
    proposedStartTime: '',
    room: '',
    thesis: '',
    notes: '',
    deckRef: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      api.get('/industries').then((r) => r.data).catch(() => []),
      api.get('/users/lunch/leaders').then((r) => r.data).catch(() => []),
    ]).then(([inds, lead]) => {
      if (cancelled) return;
      setIndustries(inds);
      setLeaders(lead);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset on close so reopening starts fresh.
  useEffect(() => {
    if (!open) {
      setForm({
        ticker: '',
        companyName: '',
        industryId: '',
        proposedDate: '',
        proposedLunch: '',
        thesis: '',
        notes: '',
        deckRef: '',
      });
      setError('');
    }
  }, [open]);

  // The club can have multiple co-Presidents — list every one so the
  // requester can see who's actually free, not just the first one
  // alphabetically.
  const presidents = useMemo(
    () => leaders.filter((l) => l.role === 'President'),
    [leaders]
  );
  const pmForIndustry = useMemo(() => {
    if (!form.industryId) return null;
    const ind = industries.find(
      (i) => String(i.id) === String(form.industryId)
    );
    if (!ind?.leader) return null;
    return leaders.find((l) => l.id === ind.leader.id) || ind.leader;
  }, [form.industryId, industries, leaders]);

  const dayKey = weekdayKeyFor(form.proposedDate);
  // Per-President lunch on the chosen day. Used both for the "Who's free"
  // list and the mismatch heads-up below.
  const presidentDayLunches = useMemo(
    () =>
      presidents.map((p) => ({
        id: p.id,
        name: p.name,
        lunch: dayKey && p.lunchSchedule ? p.lunchSchedule[dayKey] : null,
      })),
    [presidents, dayKey]
  );
  const pmDayLunch =
    dayKey && pmForIndustry?.lunchSchedule
      ? pmForIndustry.lunchSchedule[dayKey]
      : null;

  // Available start-time slots for the chosen (weekday, lunch period).
  // When the user picks "Both" / no preference, the helper returns the
  // union of First + Second slots so they can still commit to a
  // concrete time. Empty array when no date is set yet.
  const availableSlots = useMemo(
    () => generateLunchSlots(dayKey, form.proposedLunch),
    [dayKey, form.proposedLunch]
  );

  // If the user re-pickes the date or lunch period in a way that
  // invalidates their previously-chosen start time, clear it so they
  // can't accidentally submit a stale time.
  useEffect(() => {
    if (
      form.proposedStartTime &&
      !availableSlots.includes(form.proposedStartTime)
    ) {
      setForm((prev) => ({ ...prev, proposedStartTime: '' }));
    }
  }, [availableSlots, form.proposedStartTime]);

  // Highlight a lunch mismatch — when the requester picked First but the
  // President only has Second free, etc. Surfaces the conflict before
  // submission rather than after the email has gone out.
  const mismatchWarning = useMemo(() => {
    if (!form.proposedLunch || !dayKey) return null;
    function clashes(scheduleVal) {
      if (!scheduleVal) return null; // unknown — don't warn
      if (scheduleVal === 'Both') return false;
      if (form.proposedLunch === 'Both') return false;
      return scheduleVal !== form.proposedLunch;
    }
    // Multiple co-Presidents: only flag when every President with a
    // known schedule clashes. If at least one is free (or hasn't entered
    // their schedule yet) we stay silent — the meeting can still happen.
    const knownPresClashes = presidentDayLunches
      .map((p) => clashes(p.lunch))
      .filter((v) => v !== null);
    const allPresClash =
      knownPresClashes.length > 0 && knownPresClashes.every((v) => v === true);
    const pmClash = clashes(pmDayLunch);
    const warnings = [];
    if (allPresClash) {
      warnings.push(
        `No President has ${lunchLabel(form.proposedLunch)} lunch free that day`
      );
    }
    if (pmClash && pmForIndustry)
      warnings.push(`${pmForIndustry.name} has ${lunchLabel(pmDayLunch)} lunch that day`);
    return warnings.length ? warnings.join('. ') + '.' : null;
  }, [form.proposedLunch, dayKey, presidentDayLunches, pmDayLunch, pmForIndustry]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!form.deckRef) {
      setError('Please attach a slide deck before submitting.');
      return;
    }
    if (!form.ticker.trim()) {
      setError('Ticker is required.');
      return;
    }
    if (!form.proposedDate) {
      setError('Pick a meeting date.');
      return;
    }
    if (!form.proposedStartTime) {
      setError('Pick a start time.');
      return;
    }
    if (!form.room) {
      setError('Pick a room.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/pitch-requests', {
        ticker: form.ticker.trim().toUpperCase(),
        companyName: form.companyName.trim() || null,
        thesis: form.thesis.trim() || null,
        industryId: form.industryId ? Number(form.industryId) : null,
        proposedDate: form.proposedDate
          ? new Date(form.proposedDate).toISOString()
          : null,
        proposedLunch: form.proposedLunch || null,
        proposedStartTime: form.proposedStartTime,
        room: form.room,
        notes: form.notes.trim() || null,
        deckRef: form.deckRef,
      });
      onSubmitted?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Request a Pitch with the President"
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-lg border border-gold-300 bg-gold-100/40 px-4 py-3 text-xs text-navy">
          The President receives an in-app notification + email. Your sector PM
          is also emailed for awareness — only the President's decision blocks
          the meeting.
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Ticker"
            required
            value={form.ticker}
            onChange={(v) => setForm({ ...form, ticker: v.toUpperCase() })}
            placeholder="AAPL"
          />
          <Field
            label="Company name (optional)"
            value={form.companyName}
            onChange={(v) => setForm({ ...form, companyName: v })}
            placeholder="Apple Inc."
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-navy">
            Sector / Industry
          </label>
          <select
            value={form.industryId}
            onChange={(e) => setForm({ ...form, industryId: e.target.value })}
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          >
            <option value="">Select a sector…</option>
            {industries.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.leader ? ` — PM: ${i.leader.name}` : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-navy-400">
            Picks which Portfolio Manager gets cc'd on the request.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Proposed date"
            type="date"
            value={form.proposedDate}
            onChange={(v) => setForm({ ...form, proposedDate: v })}
          />
          <div>
            <label className="block text-sm font-medium text-navy">
              Lunch period
            </label>
            <select
              value={form.proposedLunch}
              onChange={(e) =>
                setForm({ ...form, proposedLunch: e.target.value })
              }
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            >
              {LUNCH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-navy">
              Start time
              <span className="ml-0.5 text-red-600">*</span>
            </label>
            <select
              value={form.proposedStartTime}
              onChange={(e) =>
                setForm({ ...form, proposedStartTime: e.target.value })
              }
              disabled={availableSlots.length === 0}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:bg-navy-50 disabled:text-navy-400"
            >
              <option value="">
                {availableSlots.length === 0
                  ? 'Pick a date first…'
                  : 'Select a start time…'}
              </option>
              {availableSlots.map((s) => (
                <option key={s} value={s}>
                  {formatStartTime(s)}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-navy-400">
              Slots end 45 min into the lunch block — anything later doesn't
              leave room to actually meet.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">
              Room
              <span className="ml-0.5 text-red-600">*</span>
            </label>
            <select
              value={form.room}
              onChange={(e) => setForm({ ...form, room: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            >
              <option value="">Select a room…</option>
              {ROOM_VALUES.map((r) => (
                <option key={r} value={r}>
                  {ROOM_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {(presidents.length > 0 || pmForIndustry) && dayKey && (
          <div className="rounded-lg border border-navy-100 bg-navy-50/50 px-3 py-2 text-xs text-navy">
            <div className="font-semibold text-navy">
              Who's free that day:
            </div>
            <ul className="mt-1 space-y-0.5">
              {presidentDayLunches.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">{p.name}</span> (President)
                  : {p.lunch ? `${lunchLabel(p.lunch)} lunch` : 'no schedule entered'}
                </li>
              ))}
              {pmForIndustry && (
                <li>
                  <span className="font-medium">{pmForIndustry.name}</span> (PM)
                  : {pmDayLunch ? `${lunchLabel(pmDayLunch)} lunch` : 'no schedule entered'}
                </li>
              )}
            </ul>
            {mismatchWarning && (
              <div className="mt-2 text-xs font-semibold text-red-700">
                Heads up: {mismatchWarning}
              </div>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-navy">
            Investment thesis (short)
          </label>
          <textarea
            rows={3}
            value={form.thesis}
            onChange={(e) => setForm({ ...form, thesis: e.target.value })}
            placeholder="Why is this a buy?"
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-navy">
            Notes for the President (optional)
          </label>
          <textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
          />
        </div>

        <FileUploader
          label="Slide deck"
          required
          value={form.deckRef}
          onChange={(deckRef) => setForm({ ...form, deckRef })}
          hint="Upload a PDF / PPTX, or paste a Google Drive / Slides link. Required."
        />

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-navy-50 pt-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="gold"
            disabled={
              submitting ||
              !form.deckRef ||
              !form.ticker.trim() ||
              !form.proposedDate ||
              !form.proposedStartTime ||
              !form.room
            }
          >
            <Send className="h-4 w-4" />
            {submitting ? 'Sending…' : 'Submit request'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, value, onChange, type = 'text', required, placeholder }) {
  return (
    <div>
      <label className="block text-sm font-medium text-navy">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
      />
    </div>
  );
}
