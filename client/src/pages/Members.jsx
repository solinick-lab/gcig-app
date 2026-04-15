import { useEffect, useState } from 'react';
import { Plus, KeyRound, Trash2 } from 'lucide-react';
import api from '../api/client.js';
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
  'JuniorAnalyst',
];

export default function Members() {
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
    setTempPassword({ email: data.user.email, password: data.tempPassword });
    setForm({ name: '', email: '', role: 'JuniorAnalyst' });
    load();
  }

  async function handleRoleChange(id, role) {
    await api.put(`/users/${id}`, { role });
    load();
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

  return (
    <>
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

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-100 text-left text-xs uppercase text-navy-400">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-50">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-3 pr-4 font-semibold text-navy">{u.name}</td>
                  <td className="py-3 pr-4 text-navy-400">{u.email}</td>
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
                  <td className="py-3 pr-4 text-right">
                    <button
                      onClick={() => handleReset(u.id, u.email)}
                      className="mr-2 inline-flex items-center gap-1 text-xs font-semibold text-navy underline"
                    >
                      <KeyRound className="h-3 w-3" />
                      Reset
                    </button>
                    <button
                      onClick={() => handleDelete(u.id)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 underline"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
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
        title="Temporary Password"
      >
        {tempPassword && (
          <div className="space-y-3">
            <p className="text-sm text-navy">
              Share these credentials with <strong>{tempPassword.email}</strong>. This is
              the only time the password will be shown.
            </p>
            <div className="rounded-lg bg-navy-50 p-4 font-mono text-sm">
              <div>
                <span className="text-navy-400">email: </span>
                <span className="font-bold text-navy">{tempPassword.email}</span>
              </div>
              <div>
                <span className="text-navy-400">password: </span>
                <span className="font-bold text-navy">{tempPassword.password}</span>
              </div>
            </div>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(
                  `email: ${tempPassword.email}\npassword: ${tempPassword.password}`
                );
              }}
            >
              Copy to clipboard
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
