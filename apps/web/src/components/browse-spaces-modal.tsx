'use client';

import { useEffect, useRef, useState } from 'react';
import { Hash, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useChatContext } from '@/lib/chat-context';
import { browsePublicSpacesPath, joinPublicSpacePath, type BrowsableSpace } from '@/lib/public-spaces';
import { AppDialog } from './overlay-primitives';

type Props = {
  onClose: () => void;
  onOpenSpace: (id: string) => void;
};

export function BrowseSpacesModal({ onClose, onOpenSpace }: Props) {
  const [query, setQuery] = useState('');
  const [spaces, setSpaces] = useState<BrowsableSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const { refreshSpaces } = useChatContext();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get(browsePublicSpacesPath(query));
        const body = res.ok ? await res.json() : null;
        if (!active) return;
        setError(body ? null : 'Could not load spaces.');
        setSpaces(body?.spaces ?? []);
      } catch {
        if (active) setError('Could not load spaces.');
      } finally {
        if (active) setLoading(false);
      }
    }, 200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);

  const open = (id: string) => {
    onOpenSpace(id);
    onClose();
  };

  const join = async (space: BrowsableSpace) => {
    setJoiningId(space.id);
    setError(null);
    try {
      const res = await api.post(joinPublicSpacePath(space.id));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (mountedRef.current) setError(data.error || 'Could not join this space.');
        return;
      }
      refreshSpaces();
      // A dismissed dialog does not navigate later.
      if (mountedRef.current) open(space.id);
    } catch {
      if (mountedRef.current) setError('Could not join this space. Check your connection and try again.');
    } finally {
      if (mountedRef.current) setJoiningId(null);
    }
  };

  return (
    <AppDialog
      onClose={onClose}
      title="Browse spaces"
      description="Public spaces in this workspace. Join one to read and post."
      width={480}
      initialFocusRef={searchRef}
      headerActions={(
        <button type="button" onClick={onClose} className="p-1 rounded-md" style={{ color: 'var(--muted)' }} aria-label="Close">
          <X size={16} strokeWidth={1.5} />
        </button>
      )}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}
      >
        <Search size={14} strokeWidth={1.5} style={{ color: 'var(--muted)' }} />
        <input
          ref={searchRef}
          type="text"
          value={query}
          maxLength={100}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search public spaces"
          aria-label="Search public spaces"
          className="flex-1 bg-transparent text-[13px] outline-none"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
        />
      </div>
      {error && <p role="alert" className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
      <div className="mt-2">
        {loading && spaces.length === 0 ? (
          <p className="py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : spaces.length === 0 ? (
          <p className="py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
            {query.trim() ? 'No public spaces match your search.' : 'No public spaces yet.'}
          </p>
        ) : (
          spaces.map((space) => (
            <div key={space.id} className="flex items-center gap-3 py-2.5">
              <Hash size={14} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--muted)' }} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{space.name}</p>
                <p className="text-[12px] truncate" style={{ color: 'var(--muted)' }}>
                  {space.member_count} {space.member_count === 1 ? 'member' : 'members'}
                  {space.topic || space.description ? ` · ${space.topic || space.description}` : ''}
                </p>
              </div>
              {space.is_member ? (
                <button
                  type="button"
                  onClick={() => open(space.id)}
                  aria-label={`Open ${space.name}`}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium"
                  style={{ background: 'var(--surface)', color: 'var(--foreground-secondary)' }}
                >
                  Open
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => join(space)}
                  disabled={joiningId !== null}
                  aria-label={`Join ${space.name}`}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                >
                  {joiningId === space.id ? 'Joining...' : 'Join'}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </AppDialog>
  );
}
