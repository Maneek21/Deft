'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api, isSameWebSession } from '@/lib/api';
import { matchingMentionGroups, type MentionGroup, type MentionSelection } from '@/lib/mention-suggestions';
import { AtSign, Users } from 'lucide-react';
import { PersonAvatar } from './person-avatar';

type Member = {
  id: string;
  name: string;
  avatar_url: string | null;
  kind?: 'human' | 'agent' | 'system';
};

type ApiMember = Omit<Member, 'avatar_url'> & { avatar_url?: string | null; avatar?: string | null };

type Props = {
  query: string;
  onSelect: (selection: MentionSelection) => void;
  onClose: () => void;
};

function normalizeMembers(list: ApiMember[]): Member[] {
  return list.map((member) => ({
    id: member.id,
    name: member.name,
    avatar_url: member.avatar_url ?? member.avatar ?? null,
    kind: member.kind,
  }));
}

export function MentionAutocomplete({ query, onSelect, onClose }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<MentionGroup[]>([]);
  const sessionRef = useRef(api.getAccessToken());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const session = api.getAccessToken();
    sessionRef.current = session;
    const current = () => active && isSameWebSession(session, api.getAccessToken());
    async function load() {
      try {
        const res = await api.get('/api/members');
        if (res.ok) {
          const data = await res.json();
          const list: ApiMember[] = data.members || data || [];
          const normalized = normalizeMembers(list);
          if (current()) setMembers(normalized);
        }
      } catch {
        // ignore
      }
    }
    async function loadGroups() {
      try {
        const res = await api.get('/api/groups');
        if (res.ok) {
          const data = await res.json();
          if (current()) setGroups(Array.isArray(data) ? data : []);
        }
      } catch {
        // Member selection remains available when group discovery fails.
      }
    }
    void load();
    void loadGroups();
    return () => { active = false; };
  }, []);

  const lowerQuery = query.toLowerCase();
  const filtered = members.filter((m) =>
    m.name.toLowerCase().includes(lowerQuery)
  );

  // Partition by kind: humans first, agents second (incl. Defty + BYOA), special last.
  const humans = filtered.filter((m) => m.kind !== 'agent');
  const agents = filtered.filter((m) => m.kind === 'agent');
  const matchingGroups = matchingMentionGroups(groups, query);

  const specialOptions = [
    { id: 'here', name: 'here' },
    { id: 'all', name: 'all' },
  ].filter((o) => o.name.includes(lowerQuery));

  const allOptions: MentionSelection[] = [
    ...[...humans, ...agents].map((member) => ({ type: 'person' as const, id: member.id, name: member.name })),
    ...matchingGroups.map((group) => ({ ...group, type: 'group' as const })),
    ...specialOptions.map((option) => ({ ...option, type: 'person' as const })),
  ];
  const select = useCallback((selection: MentionSelection) => {
    if (isSameWebSession(sessionRef.current, api.getAccessToken())) onSelect(selection);
    else onClose();
  }, [onSelect, onClose]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(0, Math.min(prev + 1, allOptions.length - 1)));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (allOptions[selectedIndex]) {
          select(allOptions[selectedIndex]);
        }
      }
    },
    [allOptions, selectedIndex, select, onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (allOptions.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-1 left-0 w-[260px] max-h-[240px] overflow-y-auto rounded-xl py-1 z-30"
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {humans.map((member, i) => (
        <button
          key={member.id}
          onClick={() => select({ type: 'person', id: member.id, name: member.name })}
          className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
          style={{
            background: selectedIndex === i ? 'var(--hover-tint)' : 'transparent',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-body)',
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <PersonAvatar name={member.name} avatarUrl={member.avatar_url} kind={member.kind} size={24} fontSize={10} />
          <span>{member.name}</span>
        </button>
      ))}
      {agents.length > 0 && humans.length > 0 && (
        <div className="mx-3 my-1 h-px" style={{ background: 'var(--border)' }} />
      )}
      {agents.map((agent, i) => {
        const idx = humans.length + i;
        return (
          <button
            key={agent.id}
            onClick={() => select({ type: 'person', id: agent.id, name: agent.name })}
            className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
            style={{
              background: selectedIndex === idx ? 'var(--hover-tint)' : 'transparent',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-body)',
            }}
            onMouseEnter={() => setSelectedIndex(idx)}
          >
            <PersonAvatar name={agent.name} avatarUrl={agent.avatar_url} kind={agent.kind} size={24} fontSize={10} />
            <span>{agent.name}</span>
            <span
              className="text-[11px] ml-auto px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}
            >
              AI
            </span>
          </button>
        );
      })}
      {matchingGroups.map((group, i) => {
        const idx = humans.length + agents.length + i;
        return (
          <button key={`group:${group.id}`} onClick={() => select({ ...group, type: 'group' })}
            className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
            style={{ background: selectedIndex === idx ? 'var(--hover-tint)' : 'transparent', color: 'var(--foreground)' }}
            onMouseEnter={() => setSelectedIndex(idx)}>
            <Users size={18} />
            <span><span className="block">@{group.handle}</span><span className="text-[11px]" style={{ color: 'var(--muted)' }}>{group.name}</span></span>
            <span className="text-[11px] ml-auto" style={{ color: 'var(--muted)' }}>{group.member_count ?? 0} members</span>
          </button>
        );
      })}
      {specialOptions.length > 0 && (humans.length > 0 || agents.length > 0 || matchingGroups.length > 0) && (
        <div className="mx-3 my-1 h-px" style={{ background: 'var(--border)' }} />
      )}
      {specialOptions.map((opt, i) => {
        const idx = humans.length + agents.length + matchingGroups.length + i;
        return (
          <button
            key={opt.id}
            onClick={() => select({ type: 'person', id: opt.id, name: opt.name })}
            className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
            style={{
              background: selectedIndex === idx ? 'var(--hover-tint)' : 'transparent',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-body)',
            }}
            onMouseEnter={() => setSelectedIndex(idx)}
          >
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center"
              style={{ background: 'var(--surface)', color: 'var(--muted)' }}
            >
              {opt.id === 'here' ? (
                <AtSign size={12} strokeWidth={1.5} />
              ) : (
                <Users size={12} strokeWidth={1.5} />
              )}
            </div>
            <span>@{opt.name}</span>
            <span className="text-[11px] ml-auto" style={{ color: 'var(--muted)' }}>
              {opt.id === 'here' ? 'Notify online' : 'Notify everyone'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
