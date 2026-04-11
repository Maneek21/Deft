'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { X, Search } from 'lucide-react';
import { useChatContext } from '@/lib/chat-context';
import { useAuth } from '@/lib/auth-context';

type Member = {
  id: string;
  name: string;
  avatar: string | null;
};

type Props = {
  onClose: () => void;
};

function avatarColor(name: string) {
  const colors = ['#7C6B4F', '#5B7A6B', '#6B5D7A', '#7A5B5B', '#5B6B7A', '#7A6B5B'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function CreateDmModal({ onClose }: Props) {
  const { user } = useAuth();
  const { refreshSpaces, setActiveSpaceId } = useChatContext();
  const [members, setMembers] = useState<Member[]>([]);
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
          // Filter out the current user
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

  const filtered = members.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleSelect = async (member: Member) => {
    setSubmitting(true);
    setError(null);

    try {
      const res = await api.post('/api/spaces', {
        type: 'dm',
        user_ids: [member.id],
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

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={onClose}
    >
      <div
        className="w-[calc(100vw-2rem)] max-w-[400px] max-h-[90vh] overflow-y-auto rounded-2xl"
        style={{
          background: 'var(--card-bg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between"
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

        {/* Search */}
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
            }}
          >
            <Search size={14} strokeWidth={1.5} style={{ color: 'var(--muted)' }} />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people..."
              className="flex-1 text-[13px] bg-transparent outline-none"
              style={{
                color: 'var(--foreground)',
                fontFamily: 'var(--font-body)',
              }}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2">
            <p className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>
          </div>
        )}

        {/* Members list */}
        <div className="max-h-[320px] overflow-y-auto">
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
            filtered.map((member) => (
              <button
                key={member.id}
                onClick={() => handleSelect(member)}
                disabled={submitting}
                className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors"
                style={{ opacity: submitting ? 0.5 : 1 }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--hover-tint)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'transparent';
                }}
              >
                {member.avatar ? (
                  <img src={member.avatar} className="w-8 h-8 rounded-full" alt={member.name} />
                ) : (
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-medium text-white"
                    style={{ background: avatarColor(member.name) }}
                  >
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <span
                  className="text-[13px] font-medium"
                  style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                >
                  {member.name}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
