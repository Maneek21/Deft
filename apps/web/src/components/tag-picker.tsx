'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { Hash, Plus, X, Check } from 'lucide-react';

type Tag = {
  id: string;
  name: string;
  color: string | null;
};

type Props = {
  entityType: 'message' | 'task' | 'clip' | 'daily_note';
  entityId: string;
  appliedTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
  compact?: boolean;
};

export function TagPicker({ entityType, entityId, appliedTags, onTagsChange, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load all tags when picker opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get('/api/tags').then(async res => {
      if (res.ok) {
        const data = await res.json();
        setAllTags(data.map((t: any) => ({ id: t.id, name: t.name, color: t.color })));
      }
      setLoading(false);
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const appliedIds = new Set(appliedTags.map(t => t.id));
  const filtered = allTags.filter(t =>
    t.name.toLowerCase().includes(query.toLowerCase()) && !appliedIds.has(t.id)
  );
  const canCreate = query.trim().length > 0 && !allTags.some(t => t.name === query.trim().toLowerCase().replace(/\s+/g, '-'));

  const applyTag = async (tag: Tag) => {
    await api.post(`/api/tags/${tag.id}/apply`, { entity_type: entityType, entity_id: entityId });
    onTagsChange([...appliedTags, tag]);
  };

  const removeTag = async (tag: Tag) => {
    // DELETE with body — need to use fetch directly since api.delete doesn't send body
    await api.fetch(`/api/tags/${tag.id}/apply`, {
      method: 'DELETE',
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
    });
    onTagsChange(appliedTags.filter(t => t.id !== tag.id));
  };

  const createAndApply = async () => {
    const name = query.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    const res = await api.post('/api/tags', { name });
    if (res.ok) {
      const tag = await res.json();
      await api.post(`/api/tags/${tag.id}/apply`, { entity_type: entityType, entity_id: entityId });
      onTagsChange([...appliedTags, { id: tag.id, name: tag.name, color: tag.color }]);
      setAllTags(prev => [...prev, { id: tag.id, name: tag.name, color: tag.color }]);
      setQuery('');
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      {/* Applied tags + add button */}
      <div className="flex flex-wrap gap-1 items-center">
        {appliedTags.map(tag => (
          <span key={tag.id}
            className="text-[11px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
            style={{ background: `${tag.color || '#6b7280'}20`, color: tag.color || '#6b7280' }}>
            #{tag.name}
            <button onClick={() => removeTag(tag)} className="hover:opacity-70">
              <X size={10} />
            </button>
          </span>
        ))}
        <button onClick={() => setOpen(!open)}
          className={`inline-flex items-center gap-1 rounded-full transition-colors ${compact ? 'p-1' : 'px-2 py-0.5 text-[11px]'}`}
          style={{ color: 'var(--muted)', border: open ? '1px solid var(--accent)' : '1px dashed var(--border)' }}>
          <Plus size={compact ? 12 : 10} />
          {!compact && 'Tag'}
        </button>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 rounded-lg py-1 z-50"
          style={{ background: 'var(--surface-container-highest)', boxShadow: 'var(--glass-shadow)' }}>
          <div className="px-2 py-1">
            <input ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && canCreate) createAndApply();
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="Search or create tag..."
              className="w-full h-7 px-2 text-[12px] rounded outline-none"
              style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }}
            />
          </div>

          <div className="max-h-40 overflow-y-auto">
            {filtered.map(tag => (
              <button key={tag.id} onClick={() => { applyTag(tag); setQuery(''); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--foreground-secondary)' }}>
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ background: tag.color || '#6b7280' }} />
                #{tag.name}
              </button>
            ))}

            {canCreate && (
              <button onClick={createAndApply}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--accent)' }}>
                <Plus size={12} />
                Create "#{query.trim().toLowerCase().replace(/\s+/g, '-')}"
              </button>
            )}

            {filtered.length === 0 && !canCreate && (
              <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                {loading ? 'Loading...' : 'No tags found'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
