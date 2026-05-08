'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { X, Plus, UserMinus, Search, Users } from 'lucide-react';
import { AIBadge } from './ai-badge';
import { CreateDmModal } from './create-dm-modal';

type Member = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  kind?: 'human' | 'agent' | 'system';
  status_emoji?: string | null;
  status_text?: string | null;
};

type Props = {
  spaceId: string;
  spaceName: string;
  spaceType?: string;
  onClose: () => void;
};

function avatarColor(name: string) {
  const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function renderPickerRow(
  member: Member,
  isAgent: boolean,
  onAdd: (id: string) => void,
) {
  const color = avatarColor(member.name || '');
  return (
    <button
      key={member.id}
      onClick={() => onAdd(member.id)}
      className="flex items-center gap-3 w-full px-2 py-2 rounded-md transition-colors"
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {member.avatar_url ? (
        <img src={member.avatar_url} className="w-7 h-7 rounded-full" alt={member.name} />
      ) : (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0"
          style={{ background: color }}
        >
          {member.name?.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <p className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>
            {member.name}
          </p>
          {isAgent && <AIBadge />}
        </div>
        <p className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
          {member.email}
        </p>
      </div>
      <Plus size={14} style={{ color: 'var(--accent)' }} />
    </button>
  );
}

export function SpaceMembersPanel({ spaceId, spaceName, spaceType, onClose }: Props) {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState('');
  const [showAddSection, setShowAddSection] = useState(false);
  const [showNewGroupDm, setShowNewGroupDm] = useState(false);
  const [loading, setLoading] = useState(true);

  const isDmLike = spaceType === 'dm' || spaceType === 'group_dm';

  useEffect(() => {
    async function load() {
      const [membersRes, allRes] = await Promise.all([
        api.get(`/api/spaces/${spaceId}/members`),
        api.get('/api/members'),
      ]);
      if (membersRes.ok) setMembers(await membersRes.json());
      if (allRes.ok) setAllMembers(await allRes.json());
      setLoading(false);
    }
    load();
  }, [spaceId]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const nonMembers = allMembers.filter(m => !members.some(mem => mem.id === m.id));
  const filtered = nonMembers.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.email.toLowerCase().includes(search.toLowerCase())
  );
  const filteredHumans = filtered.filter(m => m.kind !== 'agent' && m.kind !== 'system');
  const filteredAgents = filtered.filter(m => m.kind === 'agent' || m.kind === 'system');

  const addMember = async (userId: string) => {
    const res = await api.post(`/api/spaces/${spaceId}/members`, { user_id: userId });
    if (res.ok) {
      const added = allMembers.find(m => m.id === userId);
      if (added) setMembers(prev => [...prev, added]);
    }
  };

  const removeMember = async (userId: string) => {
    const res = await api.delete(`/api/spaces/${spaceId}/members/${userId}`);
    if (res.ok) {
      setMembers(prev => prev.filter(m => m.id !== userId));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[420px] max-h-[90vh] rounded-xl flex flex-col overflow-hidden"
        style={{
          background: 'var(--card-bg, #ffffff)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div>
            <h3
              className="text-[15px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
            >
              Members
            </h3>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--muted)' }}>
              #{spaceName} &middot; {members.length} {members.length === 1 ? 'member' : 'members'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md"
            style={{ color: 'var(--muted)' }}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex gap-1.5">
                <div className="skeleton w-1.5 h-1.5 rounded-full" />
                <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.2s' }} />
                <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.4s' }} />
              </div>
            </div>
          ) : (
            <>
              {/* Member list */}
              <div className="px-2 py-2">
                {members.map((member) => {
                  const color = avatarColor(member.name || '');
                  const isCurrentUser = member.id === user?.id;
                  return (
                    <div
                      key={member.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg"
                      style={{ color: 'var(--foreground)' }}
                    >
                      {member.avatar_url ? (
                        <img src={member.avatar_url} className="w-8 h-8 rounded-full" alt={member.name} />
                      ) : (
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium text-white flex-shrink-0"
                          style={{ background: color }}
                        >
                          {member.name?.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[13px] font-medium truncate" style={{ fontFamily: 'var(--font-body)' }}>
                            {member.name}{isCurrentUser ? ' (you)' : ''}
                          </p>
                          {(member.kind === 'agent' || member.kind === 'system') && <AIBadge />}
                        </div>
                        <p className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
                          {member.status_emoji ? `${member.status_emoji} ${member.status_text || ''}` : member.email}
                        </p>
                      </div>
                      {!isCurrentUser && (
                        <button
                          onClick={() => removeMember(member.id)}
                          className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ color: 'var(--muted)' }}
                          title="Remove member"
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
                            (e.currentTarget as HTMLElement).style.opacity = '1';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.background = 'transparent';
                            (e.currentTarget as HTMLElement).style.opacity = '0';
                          }}
                        >
                          <UserMinus size={14} strokeWidth={1.5} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add member section — DMs spawn a fresh group DM (Slack semantics);
                  channels mutate in place. */}
              <div className="px-3 pb-3">
                {isDmLike ? (
                  <button
                    onClick={() => setShowNewGroupDm(true)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                    style={{ color: 'var(--accent)' }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                    title="Adding people to a DM creates a new group conversation. The original stays as-is."
                  >
                    <Users size={14} strokeWidth={2} />
                    Start a new group DM with these people
                  </button>
                ) : !showAddSection ? (
                  <button
                    onClick={() => setShowAddSection(true)}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                    style={{ color: 'var(--accent)' }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                  >
                    <Plus size={14} strokeWidth={2} />
                    Add members
                  </button>
                ) : (
                  <div
                    className="rounded-lg p-3"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Search size={14} style={{ color: 'var(--muted)' }} />
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name or email..."
                        className="flex-1 text-[13px] bg-transparent outline-none"
                        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                        autoFocus
                      />
                    </div>
                    <div className="max-h-[180px] overflow-y-auto">
                      {filtered.length === 0 ? (
                        <p className="text-[12px] py-2 text-center" style={{ color: 'var(--muted)' }}>
                          {nonMembers.length === 0 ? 'All org members are in this space' : 'No matches found'}
                        </p>
                      ) : (
                        <>
                          {filteredHumans.length > 0 && (
                            <div className="mb-2">
                              <div
                                className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-2"
                                style={{ color: 'var(--muted)' }}
                              >
                                People
                              </div>
                              {filteredHumans.map((m) => renderPickerRow(m, false, addMember))}
                            </div>
                          )}
                          {filteredAgents.length > 0 && (
                            <div>
                              <div
                                className="text-[10px] font-semibold uppercase tracking-wider mb-1 px-2"
                                style={{ color: 'var(--muted)' }}
                              >
                                Agents
                              </div>
                              {filteredAgents.map((m) => renderPickerRow(m, true, addMember))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {showNewGroupDm && (
        <CreateDmModal
          onClose={() => setShowNewGroupDm(false)}
          initialSelected={members
            .filter((m) => m.id !== user?.id)
            .map((m) => ({
              id: m.id,
              name: m.name,
              avatar: m.avatar_url,
              kind: m.kind,
            }))}
        />
      )}
    </div>
  );
}
