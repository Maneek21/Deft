'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Plus, Trash2, Users } from 'lucide-react';

type Group = { id: string; name: string; handle: string; description: string | null; member_count?: number };
type Member = { id: string; name: string; email: string };

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/api/groups').then(async r => r.ok ? r.json() : []),
      api.get('/api/members').then(async r => r.ok ? r.json() : []),
    ]).then(([g, m]) => { setGroups(g); setMembers(m); setLoading(false); });
  }, []);

  const handleCreate = async () => {
    if (!name.trim() || !handle.trim()) return;
    const res = await api.post('/api/groups', { name, handle: handle.toLowerCase().replace(/[^a-z0-9-]/g, '') });
    if (res.ok) {
      const group = await res.json();
      setGroups(prev => [...prev, group]);
      setName(''); setHandle(''); setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this group?')) return;
    await api.delete(`/api/groups/${id}`);
    setGroups(prev => prev.filter(g => g.id !== id));
  };

  return (
    <div className="p-6 max-w-[640px]">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-[1.125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>User Groups</h2>
          <p className="text-[0.8125rem] mt-0.5" style={{ color: 'var(--outline)' }}>
            Create groups to mention multiple people at once with @handle
          </p>
        </div>
        <button onClick={() => setCreating(true)}
          className="px-3 py-1.5 text-[0.75rem] font-medium text-white rounded-md"
          style={{ background: 'var(--primary-container)' }}>
          <Plus size={12} strokeWidth={2} className="inline mr-1" /> Create Group
        </button>
      </div>

      {creating && (
        <div className="p-4 rounded-lg mb-4" style={{ background: 'var(--surface-container)' }}>
          <div className="flex gap-2 mb-3">
            <input value={name} onChange={e => { setName(e.target.value); setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')); }}
              placeholder="Group name" className="flex-1 h-9 px-3 text-[0.8125rem] rounded-md outline-none"
              style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }} />
            <input value={handle} onChange={e => setHandle(e.target.value)}
              placeholder="handle" className="w-32 h-9 px-3 text-[0.8125rem] rounded-md outline-none"
              style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)', fontFamily: 'var(--font-mono)' }} />
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 text-[0.75rem] font-medium text-white rounded-md"
              style={{ background: 'var(--primary-container)' }}>Create</button>
            <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-[0.75rem] rounded-md"
              style={{ color: 'var(--outline)' }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {groups.map(g => (
          <div key={g.id} className="flex items-center gap-3 p-3 rounded-lg"
            style={{ background: 'var(--surface-container)' }}>
            <Users size={16} strokeWidth={1.5} style={{ color: 'var(--outline)' }} />
            <div className="flex-1">
              <span className="text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>{g.name}</span>
              <span className="text-[0.6875rem] ml-2" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>@{g.handle}</span>
            </div>
            <button onClick={() => handleDelete(g.id)} className="p-1" style={{ color: 'var(--outline)' }}>
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
          </div>
        ))}
        {!loading && groups.length === 0 && !creating && (
          <p className="text-center py-8 text-[0.75rem]" style={{ color: 'var(--outline)' }}>No groups yet</p>
        )}
      </div>
    </div>
  );
}
