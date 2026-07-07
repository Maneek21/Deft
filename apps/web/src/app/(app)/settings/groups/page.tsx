'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AtSign, Check, MessageSquare, Plus, Trash2, Users, X } from 'lucide-react';
import { api } from '@/lib/api';

type GroupMember = {
  user_id: string;
  name: string;
  email?: string | null;
  avatar_url?: string | null;
};

type Group = {
  id: string;
  name: string;
  handle: string;
  description: string | null;
  member_count?: number;
  members?: GroupMember[];
};

type Member = {
  id: string;
  user_id?: string;
  name: string;
  email: string;
  avatar_url?: string | null;
};

function normalizeMembers(value: any): Member[] {
  const rows = Array.isArray(value) ? value : value?.members ?? value?.data ?? [];
  return rows
    .map((row: any) => ({
      id: row.user_id ?? row.id,
      user_id: row.user_id ?? row.id,
      name: row.name ?? row.user_name ?? row.email ?? 'Unknown',
      email: row.email ?? '',
      avatar_url: row.avatar_url ?? null,
    }))
    .filter((row: Member) => !!row.id);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [creating, setCreating] = useState(false);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [memberPicker, setMemberPicker] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadGroups() {
    const res = await api.get('/api/groups');
    if (!res.ok) return;
    const body = await res.json();
    setGroups(Array.isArray(body) ? body : body.groups ?? body.data ?? []);
  }

  async function loadGroupDetails(groupId: string) {
    const res = await api.get(`/api/groups/${groupId}`);
    if (!res.ok) return;
    const body = await res.json();
    setGroups((prev) => prev.map((group) => group.id === groupId ? body : group));
  }

  useEffect(() => {
    Promise.all([
      api.get('/api/groups').then(async (r) => r.ok ? r.json() : []),
      api.get('/api/members').then(async (r) => r.ok ? r.json() : []),
    ]).then(([groupRows, memberRows]) => {
      setGroups(Array.isArray(groupRows) ? groupRows : groupRows.groups ?? groupRows.data ?? []);
      setMembers(normalizeMembers(memberRows));
      setLoading(false);
    });
  }, []);

  const expandedGroup = useMemo(
    () => groups.find((group) => group.id === expandedGroupId) ?? null,
    [expandedGroupId, groups],
  );

  const addableMembers = useMemo(() => {
    if (!expandedGroup) return [];
    const existing = new Set((expandedGroup.members ?? []).map((member) => member.user_id));
    return members.filter((member) => !existing.has(member.id));
  }, [expandedGroup, members]);

  const totalMemberships = groups.reduce((sum, group) => sum + (group.member_count ?? group.members?.length ?? 0), 0);

  const handleCreate = async () => {
    if (!name.trim() || !handle.trim()) return;
    setSaving(true);
    try {
      const res = await api.post('/api/groups', {
        name,
        handle: handle.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        description: description.trim() || null,
      });
      if (res.ok) {
        const group = await res.json();
        setGroups((prev) => [...prev, { ...group, member_count: 0, members: [] }]);
        setName('');
        setHandle('');
        setDescription('');
        setCreating(false);
        setExpandedGroupId(group.id);
        await loadGroupDetails(group.id);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this group?')) return;
    const res = await api.delete(`/api/groups/${id}`);
    if (res.ok) {
      setGroups((prev) => prev.filter((group) => group.id !== id));
      if (expandedGroupId === id) setExpandedGroupId(null);
    }
  };

  const handleExpand = async (groupId: string) => {
    const next = expandedGroupId === groupId ? null : groupId;
    setExpandedGroupId(next);
    if (next) await loadGroupDetails(next);
  };

  const handleAddMember = async (groupId: string) => {
    const userId = memberPicker[groupId];
    if (!userId) return;
    const res = await api.post(`/api/groups/${groupId}/members`, { user_ids: [userId] });
    if (res.ok) {
      setMemberPicker((prev) => ({ ...prev, [groupId]: '' }));
      await loadGroupDetails(groupId);
      await loadGroups();
    }
  };

  const handleRemoveMember = async (groupId: string, userId: string) => {
    const res = await api.delete(`/api/groups/${groupId}/members/${userId}`);
    if (res.ok) {
      await loadGroupDetails(groupId);
      await loadGroups();
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] p-4 sm:p-6">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[1.125rem] font-semibold" style={{ color: 'var(--on-surface)' }}>Groups</h2>
            <p className="mt-0.5 text-[0.8125rem]" style={{ color: 'var(--outline)' }}>
              Lightweight mention lists for chat. Use teams when you need ownership, leads, resources, and operating context.
            </p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-[0.75rem] font-medium text-white"
            style={{ background: 'var(--primary-container)' }}
          >
            <Plus size={14} strokeWidth={2} /> Create
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3 mb-5">
          <GroupNote icon={AtSign} title="Mention lists" body="Groups exist so people can notify a set of coworkers with one handle." />
          <GroupNote icon={MessageSquare} title="Chat-first" body="Use @handle in chat; it does not grant private space access by itself." />
          <Link
            href="/settings/teams"
            className="rounded-xl p-4"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
          >
            <Users size={16} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
            <p className="text-[13px] font-semibold mt-3" style={{ color: 'var(--on-surface)' }}>Need structure?</p>
            <p className="text-[12px] leading-relaxed mt-1" style={{ color: 'var(--outline)' }}>Use Teams for leads, membership, linked work, and team dashboards.</p>
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-5">
          <GroupStat label="Groups" value={groups.length} />
          <GroupStat label="Memberships" value={totalMemberships} />
        </div>

        {creating && (
          <div className="mb-4 rounded-lg border p-4" style={{ background: 'var(--surface-container)', borderColor: 'var(--outline-variant)' }}>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
                }}
                placeholder="Group name"
                className="h-10 rounded-md px-3 text-[0.8125rem] outline-none"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
              />
              <input
                value={handle}
                onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="handle"
                className="h-10 rounded-md px-3 text-[0.8125rem] outline-none"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)', fontFamily: 'var(--font-mono)' }}
              />
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this group is for"
                className="h-10 rounded-md px-3 text-[0.8125rem] outline-none sm:col-span-2"
                style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-[0.75rem] font-medium text-white disabled:opacity-60"
                style={{ background: 'var(--primary-container)' }}
              >
                <Check size={13} strokeWidth={2} /> Create group
              </button>
              <button
                onClick={() => setCreating(false)}
                className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-[0.75rem]"
                style={{ color: 'var(--outline)' }}
              >
                <X size={13} strokeWidth={2} /> Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {groups.map((group) => {
            const expanded = expandedGroupId === group.id;
            return (
              <div key={group.id} className="rounded-lg border" style={{ background: 'var(--surface-container)', borderColor: 'var(--outline-variant)' }}>
                <div className="flex items-center gap-3 p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md" style={{ background: 'var(--surface-container-high)', color: 'var(--outline)' }}>
                    <Users size={16} strokeWidth={1.5} />
                  </div>
                  <button onClick={() => handleExpand(group.id)} className="min-w-0 flex-1 text-left">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[0.8125rem] font-medium" style={{ color: 'var(--on-surface)' }}>{group.name}</span>
                      <span className="text-[0.6875rem]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>@{group.handle}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[0.6875rem]" style={{ color: 'var(--outline)' }}>
                      {group.member_count ?? group.members?.length ?? 0} members{group.description ? ` - ${group.description}` : ''}
                    </div>
                  </button>
                  <button onClick={() => handleDelete(group.id)} className="rounded-md p-2" style={{ color: 'var(--outline)' }} aria-label={`Delete ${group.name}`}>
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                </div>

                {expanded && (
                  <div className="border-t p-3" style={{ borderColor: 'var(--outline-variant)' }}>
                    <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                      <select
                        value={memberPicker[group.id] ?? ''}
                        onChange={(event) => setMemberPicker((prev) => ({ ...prev, [group.id]: event.target.value }))}
                        className="h-9 min-w-0 flex-1 rounded-md px-3 text-[0.75rem] outline-none"
                        style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
                      >
                        <option value="">Add a member</option>
                        {addableMembers.map((member) => (
                          <option key={member.id} value={member.id}>{member.name} - {member.email}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleAddMember(group.id)}
                        disabled={!memberPicker[group.id]}
                        className="inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-[0.75rem] font-medium disabled:opacity-50"
                        style={{ background: 'var(--surface-container-high)', color: 'var(--on-surface)' }}
                      >
                        <Plus size={13} strokeWidth={2} /> Add
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {(group.members ?? []).map((member) => (
                        <div key={member.user_id} className="inline-flex max-w-full items-center gap-2 rounded-full border px-2 py-1" style={{ borderColor: 'var(--outline-variant)', color: 'var(--on-surface)' }}>
                          {member.avatar_url ? (
                            <img src={member.avatar_url} alt="" className="h-6 w-6 rounded-full object-cover" />
                          ) : (
                            <span className="flex h-6 w-6 items-center justify-center rounded-full text-[0.625rem] font-semibold" style={{ background: 'var(--primary-container)', color: 'white' }}>
                              {initials(member.name)}
                            </span>
                          )}
                          <span className="max-w-[180px] truncate text-[0.75rem]">{member.name}</span>
                          <button onClick={() => handleRemoveMember(group.id, member.user_id)} className="rounded-full p-1" style={{ color: 'var(--outline)' }} aria-label={`Remove ${member.name}`}>
                            <X size={12} strokeWidth={2} />
                          </button>
                        </div>
                      ))}
                      {(group.members ?? []).length === 0 && (
                        <span className="text-[0.75rem]" style={{ color: 'var(--outline)' }}>No members yet.</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {!loading && groups.length === 0 && !creating && (
            <div
              className="py-12 px-6 text-center rounded-xl"
              style={{ background: 'var(--surface-container-low)', border: '1px dashed var(--outline-variant)' }}
            >
              <AtSign size={28} className="mx-auto mb-3" style={{ color: 'var(--outline)' }} />
              <p className="text-[13px] font-medium" style={{ color: 'var(--on-surface)' }}>No mention groups yet.</p>
              <p className="text-[12px] mt-1" style={{ color: 'var(--outline)' }}>Create a group when the same people are repeatedly mentioned together.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupNote({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof AtSign;
  title: string;
  body: string;
}) {
  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
    >
      <Icon size={16} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
      <p className="text-[13px] font-semibold mt-3" style={{ color: 'var(--on-surface)' }}>{title}</p>
      <p className="text-[12px] leading-relaxed mt-1" style={{ color: 'var(--outline)' }}>{body}</p>
    </div>
  );
}

function GroupStat({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="rounded-xl px-3 py-3"
      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--outline-variant)' }}
    >
      <p className="text-[20px] font-semibold tabular-nums" style={{ color: 'var(--on-surface)', fontFamily: 'var(--font-heading)' }}>{value}</p>
      <p className="text-[11px] mt-0.5" style={{ color: 'var(--outline)' }}>{label}</p>
    </div>
  );
}
