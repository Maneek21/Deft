'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X, Search, Bot, Check } from 'lucide-react';
import { useChatContext } from '@/lib/chat-context';
import { useAuth } from '@/lib/auth-context';
import { AIBadge } from './ai-badge';

type Member = {
  id: string;
  name: string;
  avatar: string | null;
  kind?: 'human' | 'agent' | 'system';
};

type Props = {
  onClose: () => void;
  /** Pre-seed selected recipients (e.g. when starting a new group DM from an existing one). */
  initialSelected?: Member[];
};

function avatarColor(name: string) {
  const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function MemberRow({
  member,
  isAgent,
  selected,
  onToggle,
  disabled,
}: {
  member: Member;
  isAgent: boolean;
  selected: boolean;
  onToggle: (m: Member) => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={() => onToggle(member)}
      disabled={disabled}
      className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors"
      style={{ opacity: disabled ? 0.5 : 1, background: selected ? 'var(--hover-tint)' : 'transparent' }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {member.avatar ? (
        <img src={member.avatar} className="w-8 h-8 rounded-full" alt={member.name} />
      ) : isAgent ? (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background: '#6366f1', color: '#fff' }}
        >
          <Bot size={15} strokeWidth={1.5} />
        </div>
      ) : (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium text-white"
          style={{ background: avatarColor(member.name) }}
        >
          {member.name.charAt(0).toUpperCase()}
        </div>
      )}
      <span
        className="text-[13px] font-medium flex-1"
        style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
      >
        {member.name}
      </span>
      {isAgent && <AIBadge />}
      {selected && (
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center"
          style={{ background: 'var(--primary)', color: '#fff' }}
        >
          <Check size={12} strokeWidth={2.5} />
        </div>
      )}
    </button>
  );
}

export function CreateDmModal({ onClose, initialSelected = [] }: Props) {
  const { user } = useAuth();
  const { refreshSpaces, setActiveSpaceId } = useChatContext();
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Member[]>(initialSelected);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const res = await api.get('/api/members');
        if (res.ok) {
          const data = await res.json();
          const list: Member[] = data.members || data || [];
          setMembers(list.filter((m) => m.id !== user?.id));
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [user?.id]);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const isSelected = (id: string) => selected.some((s) => s.id === id);
  const toggle = (m: Member) => {
    setSelected((prev) => (prev.some((s) => s.id === m.id) ? prev.filter((s) => s.id !== m.id) : [...prev, m]));
  };

  const filtered = members.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));
  const humans = filtered.filter((m) => m.kind !== 'agent');
  const agents = filtered.filter((m) => m.kind === 'agent');

  const submit = async () => {
    if (selected.length === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      const type = selected.length === 1 ? 'dm' : 'group_dm';
      const namePart = [user?.name, ...selected.map((s) => s.name)].filter(Boolean).join(', ');
      const res = await api.post('/api/spaces', {
        type,
        name: namePart,
        user_ids: selected.map((s) => s.id),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to create DM' }));
        throw new Error(data.error || 'Failed to create DM');
      }

      const space = await res.json();
      refreshSpaces();
      setActiveSpaceId(space.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create DM');
      setSubmitting(false);
    }
  };

  const ctaLabel = selected.length === 0
    ? 'Pick someone'
    : selected.length === 1
      ? `Message ${selected[0]!.name}`
      : `Start group DM (${selected.length})`;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[440px] max-h-[90vh] overflow-hidden rounded-2xl flex flex-col"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <h2
            className="text-[15px] font-semibold"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}
          >
            New message
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md"
            style={{ color: 'var(--muted)' }}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Search + chips */}
        <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            className="flex flex-wrap items-center gap-1.5 px-3 py-2 rounded-lg"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              minHeight: 38,
            }}
          >
            <Search size={14} strokeWidth={1.5} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            {selected.map((s) => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px]"
                style={{ background: 'var(--surface-variant)', color: 'var(--foreground)' }}
              >
                {s.name}
                <button
                  onClick={() => setSelected((prev) => prev.filter((p) => p.id !== s.id))}
                  className="hover:opacity-70"
                  style={{ color: 'var(--muted)' }}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            ))}
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && search === '' && selected.length > 0) {
                  setSelected((prev) => prev.slice(0, -1));
                } else if (e.key === 'Enter' && selected.length > 0) {
                  submit();
                }
              }}
              placeholder={selected.length === 0 ? 'Search people...' : ''}
              className="flex-1 min-w-[80px] text-[13px] bg-transparent outline-none"
              style={{
                color: 'var(--foreground)',
                fontFamily: 'var(--font-body)',
              }}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 flex-shrink-0">
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>
          </div>
        )}

        {/* Members list */}
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: 320 }}>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex gap-1.5">
                <div className="skeleton w-1.5 h-1.5 rounded-full" />
                <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.2s' }} />
                <div className="skeleton w-1.5 h-1.5 rounded-full" style={{ animationDelay: '0.4s' }} />
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="flex items-center justify-center py-12 text-[13px]"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}
            >
              No members found
            </div>
          ) : (
            <>
              {agents.length > 0 && (
                <>
                  <div
                    className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide"
                    style={{ color: 'var(--muted)' }}
                  >
                    Agents
                  </div>
                  {agents.map((member) => (
                    <MemberRow
                      key={member.id}
                      member={member}
                      isAgent
                      selected={isSelected(member.id)}
                      onToggle={toggle}
                      disabled={submitting}
                    />
                  ))}
                </>
              )}
              {humans.length > 0 && (
                <>
                  <div
                    className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide"
                    style={{ color: 'var(--muted)' }}
                  >
                    People
                  </div>
                  {humans.map((member) => (
                    <MemberRow
                      key={member.id}
                      member={member}
                      isAgent={false}
                      selected={isSelected(member.id)}
                      onToggle={toggle}
                      disabled={submitting}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        {/* CTA */}
        <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={submit}
            disabled={selected.length === 0 || submitting}
            className="w-full py-2 text-[13px] font-medium rounded-lg transition-opacity"
            style={{
              background: selected.length === 0 ? 'var(--surface-variant)' : 'var(--primary)',
              color: selected.length === 0 ? 'var(--muted)' : '#fff',
              opacity: submitting ? 0.6 : 1,
              cursor: selected.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Creating...' : ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
