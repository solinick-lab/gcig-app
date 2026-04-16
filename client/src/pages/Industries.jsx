import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Crown, X } from 'lucide-react';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Button from '../components/Button.jsx';
import Modal from '../components/Modal.jsx';
import RoleBadge from '../components/RoleBadge.jsx';

const LEADER_ROLES = new Set(['President', 'CIO', 'SeniorPortfolioManager', 'PortfolioManager']);

export default function Industries() {
  const { isAdmin } = useAuth();
  const [industries, setIndustries] = useState([]);
  const [users, setUsers] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newLeaderId, setNewLeaderId] = useState('');
  const [memberModal, setMemberModal] = useState(null); // industry or null
  const [addUserId, setAddUserId] = useState('');

  async function load() {
    const [i, u] = await Promise.all([api.get('/industries'), api.get('/users')]);
    setIndustries(i.data);
    setUsers(u.data);
  }

  useEffect(() => {
    load();
  }, []);

  const leaderCandidates = useMemo(
    () => users.filter((u) => LEADER_ROLES.has(u.role)),
    [users]
  );

  async function handleCreate(e) {
    e.preventDefault();
    await api.post('/industries', {
      name: newName,
      leaderId: newLeaderId || null,
    });
    setNewName('');
    setNewLeaderId('');
    setCreateOpen(false);
    load();
  }

  async function handleDelete(id) {
    if (!confirm('Delete this industry? Members will be unassigned.')) return;
    await api.delete(`/industries/${id}`);
    load();
  }

  async function handleSetLeader(industryId, leaderId) {
    await api.put(`/industries/${industryId}`, { leaderId: leaderId || null });
    load();
  }

  async function handleAddMember(industryId, userId) {
    if (!userId) return;
    await api.post(`/industries/${industryId}/members`, { userId: Number(userId) });
    setAddUserId('');
    load();
    // Reopen detail with fresh data
    const fresh = await api.get('/industries');
    const refreshed = fresh.data.find((i) => i.id === industryId);
    setMemberModal(refreshed || null);
  }

  async function handleRemoveMember(industryId, userId) {
    await api.delete(`/industries/${industryId}/members/${userId}`);
    load();
    const fresh = await api.get('/industries');
    const refreshed = fresh.data.find((i) => i.id === industryId);
    setMemberModal(refreshed || null);
  }

  return (
    <>
      <PageHeader
        title="Industries"
        subtitle="Coverage groups led by a Portfolio Manager, with members underneath."
        actions={
          isAdmin && (
            <Button onClick={() => setCreateOpen(true)} variant="gold">
              <Plus className="h-4 w-4" />
              New Industry
            </Button>
          )
        }
      />

      {industries.length === 0 ? (
        <Card>
          <div className="py-12 text-center text-navy-400">
            No industries yet.{' '}
            {isAdmin && 'Click "New Industry" to create the first one.'}
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {industries.map((ind) => (
            <Card key={ind.id}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-navy">{ind.name}</h3>
                  <div className="mt-1 flex items-center gap-2 text-xs text-navy-400">
                    <Crown className="h-3.5 w-3.5 text-gold" />
                    {ind.leader ? (
                      <>
                        <span className="font-semibold text-navy">{ind.leader.name}</span>
                        <RoleBadge role={ind.leader.role} />
                      </>
                    ) : (
                      <span>No leader assigned</span>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <button
                    onClick={() => handleDelete(ind.id)}
                    className="rounded-lg p-2 text-red-600 hover:bg-red-50"
                    aria-label="Delete industry"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>

              {isAdmin && (
                <div className="mt-3">
                  <label className="block text-xs text-navy-400">Leader</label>
                  <select
                    value={ind.leader?.id || ''}
                    onChange={(e) => handleSetLeader(ind.id, e.target.value)}
                    className="mt-1 w-full rounded-md border border-navy-100 px-2 py-1 text-sm"
                  >
                    <option value="">(none)</option>
                    {leaderCandidates.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="mt-4">
                <div className="text-xs font-semibold uppercase text-navy-400">
                  Members ({ind.members.length})
                </div>
                {ind.members.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {ind.members.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-navy">{m.name}</span>
                        <RoleBadge role={m.role} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-2 text-sm text-navy-400">No members yet.</div>
                )}
              </div>

              {isAdmin && (
                <Button
                  variant="outline"
                  onClick={() => setMemberModal(ind)}
                  className="mt-4 w-full"
                >
                  Manage Members
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New Industry">
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-navy">Name</label>
            <input
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Technology, Healthcare, Energy…"
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">Leader (Portfolio Manager or above)</label>
            <select
              value={newLeaderId}
              onChange={(e) => setNewLeaderId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm"
            >
              <option value="">(optional)</option>
              {leaderCandidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Create</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={!!memberModal}
        onClose={() => setMemberModal(null)}
        title={memberModal ? `Members of ${memberModal.name}` : ''}
      >
        {memberModal && (
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-navy">Add Member</label>
              <div className="mt-1 flex gap-2">
                <select
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  className="flex-1 rounded-lg border border-navy-100 px-3 py-2 text-sm"
                >
                  <option value="">Select a member…</option>
                  {users
                    .filter((u) => !memberModal.members.some((m) => m.id === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
                <Button
                  onClick={() => handleAddMember(memberModal.id, addUserId)}
                  disabled={!addUserId}
                >
                  Add
                </Button>
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold uppercase text-navy-400">
                Current Members
              </div>
              {memberModal.members.length === 0 ? (
                <div className="mt-2 text-sm text-navy-400">No members yet.</div>
              ) : (
                <ul className="mt-2 space-y-2">
                  {memberModal.members.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-navy-100 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-navy">{m.name}</span>
                        <RoleBadge role={m.role} />
                      </div>
                      <button
                        onClick={() => handleRemoveMember(memberModal.id, m.id)}
                        className="rounded p-1 text-red-600 hover:bg-red-50"
                        aria-label="Remove"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
