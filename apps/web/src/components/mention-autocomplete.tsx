'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { AtSign, Users, Bot } from 'lucide-react';

type Member = {
  id: string;
  name: string;
  avatar: string | null;
};

type Props = {
  query: string;
  onSelect: (user: { id: string; name: string }) => void;
  onClose: () => void;
};

let cachedMembers: Member[] | null = null;

export function MentionAutocomplete({ query, onSelect, onClose }: Props) {
  const [members, setMembers] = useState<Member[]>(cachedMembers || []);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cachedMembers) return;
    async function load() {
      try {
        const res = await api.get('/api/members');
        if (res.ok) {
          const data = await res.json();
          const list = data.members || data || [];
          cachedMembers = list;
          setMembers(list);
        }
      } catch {
        // ignore
      }
    }
    load();
  }, []);

  const lowerQuery = query.toLowerCase();
  const filtered = members.filter((m) =>
    m.name.toLowerCase().includes(lowerQuery)
  );

  // Deft agent entry — always shown when query matches
  const agentOption = { id: 'agent', name: 'Deft' };
  const agentMatches = agentOption.name.toLowerCase().includes(lowerQuery) ||
    'agent'.includes(lowerQuery) || 'deft'.includes(lowerQuery);
  const agentOptions = agentMatches ? [agentOption] : [];

  const specialOptions = [
    { id: 'here', name: 'here' },
    { id: 'all', name: 'all' },
  ].filter((o) => o.name.includes(lowerQuery));

  const allOptions = [...filtered, ...agentOptions, ...specialOptions];

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
        setSelectedIndex((prev) => Math.min(prev + 1, allOptions.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (allOptions[selectedIndex]) {
          onSelect({ id: allOptions[selectedIndex].id, name: allOptions[selectedIndex].name });
        }
      }
    },
    [allOptions, selectedIndex, onSelect, onClose]
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

  function avatarColor(name: string) {
    const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

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
      {filtered.map((member, i) => (
        <button
          key={member.id}
          onClick={() => onSelect({ id: member.id, name: member.name })}
          className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[13px]"
          style={{
            background: selectedIndex === i ? 'var(--hover-tint)' : 'transparent',
            color: 'var(--foreground)',
            fontFamily: 'var(--font-body)',
          }}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          {member.avatar ? (
            <img src={member.avatar} className="w-6 h-6 rounded-full" alt={member.name} />
          ) : (
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
              style={{ background: avatarColor(member.name) }}
            >
              {member.name.charAt(0).toUpperCase()}
            </div>
          )}
          <span>{member.name}</span>
        </button>
      ))}
      {agentOptions.length > 0 && filtered.length > 0 && (
        <div className="mx-3 my-1 h-px" style={{ background: 'var(--border)' }} />
      )}
      {agentOptions.map((opt, i) => {
        const idx = filtered.length + i;
        return (
          <button
            key={opt.id}
            onClick={() => onSelect({ id: opt.id, name: opt.name })}
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
              style={{ background: '#6366f1', color: '#fff' }}
            >
              <Bot size={13} strokeWidth={1.5} />
            </div>
            <span>@{opt.name}</span>
            <span className="text-[11px] ml-auto px-1.5 py-0.5 rounded-full" style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              AI
            </span>
          </button>
        );
      })}
      {specialOptions.length > 0 && (filtered.length > 0 || agentOptions.length > 0) && (
        <div className="mx-3 my-1 h-px" style={{ background: 'var(--border)' }} />
      )}
      {specialOptions.map((opt, i) => {
        const idx = filtered.length + agentOptions.length + i;
        return (
          <button
            key={opt.id}
            onClick={() => onSelect({ id: opt.id, name: opt.name })}
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
