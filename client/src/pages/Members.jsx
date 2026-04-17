import { useEffect, useState } from 'react';
import { Plus, KeyRound, Trash2, ShieldCheck, ShieldOff } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import RoleBadge, { ROLE_LABELS } from '../components/RoleBadge.jsx';

const ROLES = [
  'President',
  'CIO',
  'SeniorPortfolioManager',
  'PortfolioManager',
  'SeniorAnalyst',
  'Analyst',
  'JuniorAnalyst',
  'AdvisoryBoardMember',
  'FacultyAdvisory',
];

export default function Members({ embedded = false } = {}) {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'JuniorAnalyst' });
  const [tempPassword, setTempPassword] = useState(null);

  async function load() {
    const { data } = await api.get('/users');
    setUsers(data);
  }
  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    const { data } = await api.post('/users', form);
    setTempPassword({
      email: data.email,
      inviteUrl: data.inviteUrl,
      emailSent: data.emailSent,
    });
    setForm({ name: '', email: '', role: 'JuniorAnalyst' });
    load();
  }

  async function handleRoleChange(id, role) {
    try {
      await api.put(`/users/${id}/role`, { role });
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to change role');
      load();
    }
  }

  async function handleReset(id, email) {
    const { data } = await api.post(`/users/${id}/reset-password`);
    setTempPassword({ email, password: data.tempPassword });
  }

  async function handleDelete(id) {
    if (!confirm('Delete this member? Their attendance records will also be removed.')) return;
    await api.delete(`/users/${id}`);
    load();
  }

  async function handleReset2FA(id, name) {
    if (
      !confirm(
        `Reset 2FA for ${name}? They'll be able to sign in with just their password and can re-enroll afterwards.`
      )
    )
      return;
    await api.post(`/2fa/admin-reset/${id}`);
    load();
  }

  return (
    <>
      {!embedded && (
        <PageHeader
          title="Members"
          subtitle="Manage club member accounts and roles."
          actions={
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Invite Member
            </Button>
          }
        />
      )}

      <Card>
        {embedded && (
          <div className="mb-4 flex justify-end">
            <Button onClick={() => setModalOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              Invite Member
            </Button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Extra Roles</th>
                <th className="py-2 pr-4">Industries</th>
                <th className="py-2 pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-50">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-3 pr-4">
                    <div className="font-semibold text-navy">{u.name}</div>
                    <div className="text-xs text-navy-400">{u.email}</div>
                  </td>
                  <td className="py-3 pr-4">
                    <select
                      value={u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      className="rounded-md border border-navy-100 px-2 py-1 text-xs"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 pr-4">
                    <ExtraRoleEditor user={u} onChange={load} />
                  </td>
                  <td className="py-3 pr-4">
                    {u.industries && u.industries.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {u.industries.map((ind) => (
                          <span
                            key={ind.id}
                            className="rounded-full bg-navy-50 px-2 py-0.5 text-[10px] font-semibold text-navy"
                          >
                            {ind.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-navy-400">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right">
                    {isAdmin ? (
                      <>
                        {u.twoFactorEnabled && (
                          <span
                            title="2FA enabled"
                            className="mr-2 inline-flex items-center text-emerald-600"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                          </span>
                        )}
                        <button
                          onClick={() => handleReset(u.id, u.email)}
                          className="mr-2 inline-flex items-center gap-1 text-xs font-semibold text-navy underline"
                        >
                          <KeyRound className="h-3 w-3" />
                          Reset
                        </button>
                        {u.twoFactorEnabled && (
                          <button
                            onClick={() => handleReset2FA(u.id, u.name)}
                            className="mr-2 inline-flex items-center gap-1 text-xs font-semibold text-gold-700 underline"
                          >
                            <ShieldOff className="h-3 w-3" />
                            Reset 2FA
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(u.id)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 underline"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-navy-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Invite Member">
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-navy">Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Email</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Role</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Create Account</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!tempPassword}
        onClose={() => {
          setTempPassword(null);
          setModalOpen(false);
        }}
        title="Invite Sent"
      >
        {tempPassword && (
          <div className="space-y-3">
            {tempPassword.emailSent ? (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
                <div className="text-sm font-semibold text-emerald-800">
                  Invite email sent to {tempPassword.email}
                </div>
                <div className="mt-1 text-xs text-emerald-700">
                  They'll receive a link to set their password and sign in. Link expires in 7 days.
                </div>
              </div>
            ) : (
              <div className="rounded-lg bg-gold-100 border border-gold-300 px-4 py-3">
                <div className="text-sm font-semibold text-gold-800">
                  Email could not be sent — share the invite link manually
                </div>
              </div>
            )}
            <p className="text-xs text-navy-400">
              Invite link (valid 7 days):
            </p>
            <div className="rounded-lg bg-navy-50 p-3 font-mono text-xs break-all text-navy">
              {tempPassword.inviteUrl}
            </div>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(tempPassword.inviteUrl);
              }}
            >
              Copy invite link
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}

function ExtraRoleEditor({ user, onChange }) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(user.extraRoles || []);

  async function save() {
    await api.put(`/users/${user.id}/extra-roles`, { extraRoles: selected });
    setEditing(false);
    onChange();
  }

  function toggle(role) {
    setSelected((s) => (s.includes(role) ? s.filter((x) => x !== role) : [...s, role]));
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {(user.extraRoles || []).map((r) => (
          <span
            key={r}
            className="rounded-full border border-navy-100 bg-white px-2 py-0.5 text-[10px] font-semibold text-navy"
          >
            {ROLE_LABELS[r] || r}
          </span>
        ))}
        <button
          onClick={() => {
            setSelected(user.extraRoles || []);
            setEditing(true);
          }}
          className="text-[10px] font-semibold text-gold-700 underline"
        >
          {user.extraRoles && user.extraRoles.length > 0 ? 'Edit' : '+ Add'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {ROLES.filter((r) => r !== user.role).map((r) => (
          <label
            key={r}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold cursor-pointer ${
              selected.includes(r)
                ? 'bg-navy text-white border-navy'
                : 'bg-white text-navy border-navy-100'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.includes(r)}
              onChange={() => toggle(r)}
              className="sr-only"
            />
            {ROLE_LABELS[r] || r}
          </label>
        ))}
      </div>
      <div className="flex gap-1">
        <button
          onClick={save}
          className="rounded bg-navy px-2 py-1 text-[10px] font-semibold text-white"
        >
          Save
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded border border-navy-100 px-2 py-1 text-[10px] font-semibold text-navy"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
