'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus, X, Loader2, Tag as TagIcon, MessageSquare, CheckSquare, Mic,
  FileText, Circle, CheckCircle2, ArrowRight,
} from 'lucide-react';

type Tag = {
  id: string;
  name: string;
  color: string | null;
  count: number;
  created_at: string;
};

type ResolvedEntity = {
  id: string;
  entity_type: 'message' | 'task' | 'clip' | 'daily_note' | 'note';
  entity_id: string;
  title: string;
  status?: string;
  author?: string;
  task_ref?: string;
  space_id?: string;
  created_at: string;
};

const TAG_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6b7280',
];

const ENTITY_ICONS: Record<string, typeof MessageSquare> = {
  message: MessageSquare,
  task: CheckSquare,
  clip: Mic,
  daily_note: FileText,
};

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--muted)',
  todo: 'var(--foreground-secondary)',
  in_progress: 'var(--accent)',
  in_review: '#8B5CF6',
  done: 'var(--status-green)',
  cancelled: 'var(--status-red)',
};

export default function TagsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(searchParams.get('new') === '1');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0]);
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);
  const [entities, setEntities] = useState<ResolvedEntity[]>([]);
  const [loadingEntities, setLoadingEntities] = useState(false);

  const loadTags = useCallback(async () => {
    const res = await api.get('/api/tags');
    if (res.ok) setTags(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { loadTags(); }, [loadTags]);

  // Auto-select tag from URL
  useEffect(() => {
    const tagId = searchParams.get('tag');
    if (tagId && tags.length > 0 && !selectedTag) {
      const found = tags.find(t => t.id === tagId);
      if (found) handleSelectTag(found);
    }
  }, [tags, searchParams]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await api.post('/api/tags', { name: newName.trim(), color: newColor });
    if (res.ok) {
      await loadTags();
      setNewName('');
      setCreating(false);
    }
  };

  const handleDelete = async (tagId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.delete(`/api/tags/${tagId}`);
    setTags(prev => prev.filter(t => t.id !== tagId));
    if (selectedTag?.id === tagId) { setSelectedTag(null); setEntities([]); }
  };

  const handleSelectTag = async (tag: Tag) => {
    if (selectedTag?.id === tag.id) { setSelectedTag(null); setEntities([]); return; }
    setSelectedTag(tag);
    setLoadingEntities(true);
    const res = await api.get(`/api/tags/${tag.id}/entities`);
    if (res.ok) setEntities(await res.json());
    setLoadingEntities(false);
  };

  const navigateToEntity = (entity: ResolvedEntity) => {
    if (entity.entity_type === 'task' && entity.task_ref) {
      router.push(`/tasks?task=${entity.task_ref}`);
    } else if (entity.entity_type === 'task') {
      router.push('/tasks');
    } else if (entity.entity_type === 'message' && entity.space_id) {
      router.push(`/chat?space=${entity.space_id}&message=${entity.entity_id}`);
    } else if (entity.entity_type === 'message') {
      router.push('/chat');
    } else if (entity.entity_type === 'note' || entity.entity_type === 'daily_note') {
      router.push(`/notes?id=${entity.entity_id}`);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold"
              style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)', letterSpacing: '-0.02em' }}>
              Tags
            </h1>
            <p className="text-[13px] mt-0.5" style={{ color: 'var(--muted)' }}>
              {tags.length} tag{tags.length !== 1 ? 's' : ''} across your workspace
            </p>
          </div>
          {!creating && (
            <button onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white"
              style={{ background: 'var(--accent)' }}>
              <Plus size={14} /> New Tag
            </button>
          )}
        </div>

        {/* Create tag */}
        {creating && (
          <div className="mb-6 p-4 rounded-xl" style={{ background: 'var(--surface-container)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-5 h-5 rounded-full flex-shrink-0" style={{ background: newColor }} />
              <input autoFocus value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
                placeholder="Tag name (e.g. launch, q3-planning)"
                className="flex-1 h-9 px-3 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--input-bg)', color: 'var(--foreground)', border: '1px solid var(--input-border)' }} />
              <button onClick={handleCreate} className="px-4 h-9 rounded-lg text-[13px] font-medium text-white"
                style={{ background: 'var(--accent)' }}>Create</button>
              <button onClick={() => setCreating(false)} className="p-2 rounded-lg" style={{ color: 'var(--muted)' }}>
                <X size={16} /></button>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {TAG_COLORS.map(c => (
                <button key={c} onClick={() => setNewColor(c)}
                  className="w-6 h-6 rounded-full transition-all"
                  style={{ background: c, boxShadow: newColor === c ? `0 0 0 2px var(--background), 0 0 0 4px ${c}` : 'none' }} />
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
          </div>
        ) : tags.length === 0 ? (
          <div className="text-center py-20">
            <TagIcon size={36} style={{ color: 'var(--muted)', opacity: 0.3 }} className="mx-auto mb-3" />
            <p className="text-[14px] mb-1" style={{ color: 'var(--muted)' }}>No tags yet</p>
            <p className="text-[12px]" style={{ color: 'var(--muted)', opacity: 0.7 }}>
              Create tags to organize tasks, messages, and notes across your workspace.
            </p>
          </div>
        ) : (
          <>
            {/* Tag grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-6">
              {tags.map(tag => {
                const active = selectedTag?.id === tag.id;
                return (
                  <div key={tag.id} onClick={() => handleSelectTag(tag)}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl transition-all group cursor-pointer"
                    style={{
                      background: active ? 'var(--bg-active)' : 'var(--surface-container)',
                      border: `1.5px solid ${active ? (tag.color || 'var(--accent)') : 'transparent'}`,
                    }}>
                    <div className="w-3.5 h-3.5 rounded-full flex-shrink-0"
                      style={{ background: tag.color || 'var(--muted)' }} />
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] font-medium block truncate"
                        style={{ color: 'var(--foreground)' }}>#{tag.name}</span>
                    </div>
                    <span className="text-[11px] tabular-nums flex-shrink-0 group-hover:hidden"
                      style={{ color: 'var(--muted)' }}>{tag.count}</span>
                    <button onClick={(e) => handleDelete(tag.id, e)}
                      className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      style={{ color: 'var(--muted)' }}>
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Entities panel */}
            {selectedTag && (
              <div className="rounded-xl overflow-hidden"
                style={{ border: '1px solid var(--border)' }}>
                <div className="px-4 py-3 flex items-center gap-2"
                  style={{ background: 'var(--surface-container)', borderBottom: '1px solid var(--border)' }}>
                  <div className="w-3 h-3 rounded-full" style={{ background: selectedTag.color || 'var(--muted)' }} />
                  <h3 className="text-[14px] font-semibold"
                    style={{ color: 'var(--foreground)', fontFamily: 'var(--font-heading)' }}>
                    #{selectedTag.name}
                  </h3>
                  <span className="text-[11px] ml-1" style={{ color: 'var(--muted)' }}>
                    {selectedTag.count} item{selectedTag.count !== 1 ? 's' : ''}
                  </span>
                </div>

                {loadingEntities ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 size={20} className="animate-spin" style={{ color: 'var(--muted)' }} />
                  </div>
                ) : entities.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
                      No items tagged with #{selectedTag.name} yet.
                    </p>
                    <p className="text-[12px] mt-1" style={{ color: 'var(--muted)', opacity: 0.6 }}>
                      Open a task and use the tag picker to apply this tag.
                    </p>
                  </div>
                ) : (
                  <div>
                    {entities.map(entity => {
                      const Icon = ENTITY_ICONS[entity.entity_type] || TagIcon;
                      const statusColor = entity.status ? STATUS_COLORS[entity.status] : undefined;
                      return (
                        <div key={entity.id}
                          onClick={() => navigateToEntity(entity)}
                          className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-white/[0.03] transition-colors"
                          style={{ borderBottom: '1px solid var(--border)' }}>
                          {entity.entity_type === 'task' && entity.status ? (
                            entity.status === 'done' ? (
                              <CheckCircle2 size={15} style={{ color: 'var(--status-green)' }} />
                            ) : (
                              <Circle size={15} style={{ color: statusColor || 'var(--muted)' }} />
                            )
                          ) : (
                            <Icon size={15} style={{ color: 'var(--muted)' }} />
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="text-[13px] block truncate" style={{
                              color: 'var(--foreground)',
                              textDecoration: entity.status === 'done' ? 'line-through' : 'none',
                              opacity: entity.status === 'done' ? 0.6 : 1,
                            }}>{entity.title}</span>
                            {entity.author && (
                              <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{entity.author}</span>
                            )}
                          </div>
                          <span className="text-[10px] uppercase tracking-wider flex-shrink-0 px-1.5 py-0.5 rounded"
                            style={{ color: 'var(--muted)', background: 'var(--surface-container)' }}>
                            {entity.entity_type.replace('_', ' ')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
