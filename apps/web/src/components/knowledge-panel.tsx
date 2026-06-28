'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { getSocket } from '@/lib/socket';
import {
  X, Plus, BookOpen, Scale, Link2, CheckSquare, StickyNote,
  Pencil, Trash2, ExternalLink, ChevronDown, Lightbulb, User, Heart,
} from 'lucide-react';

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);
  return isMobile;
}

// Wiki's 7 canonical types
type KnowledgeType = 'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact';

type KnowledgeEntry = {
  id: string;
  type: KnowledgeType;
  title: string;
  content: string | null;
  metadata: any;
  source_message_id: string | null;
  source_space_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  author_name: string | null;
  author_avatar: string | null;
  slug?: string;
  scope?: string;
  space_id?: string | null;
};

const TYPE_CONFIG: Record<KnowledgeType, { icon: typeof Scale; label: string; color: string }> = {
  decision: { icon: Scale, label: 'Decision', color: 'var(--status-purple, #a78bfa)' },
  resource: { icon: Link2, label: 'Resource', color: 'var(--status-blue, #60a5fa)' },
  procedure: { icon: CheckSquare, label: 'Procedure', color: 'var(--status-orange, #fb923c)' },
  fact: { icon: StickyNote, label: 'Fact', color: 'var(--status-green, #4ade80)' },
  concept: { icon: Lightbulb, label: 'Concept', color: 'var(--status-yellow, #facc15)' },
  entity: { icon: User, label: 'Entity', color: 'var(--status-teal, #2dd4bf)' },
  preference: { icon: Heart, label: 'Preference', color: 'var(--status-pink, #f472b6)' },
};

const FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'decision', label: 'Decisions' },
  { value: 'resource', label: 'Resources' },
  { value: 'procedure', label: 'Procedures' },
  { value: 'fact', label: 'Facts' },
  { value: 'concept', label: 'Concepts' },
  { value: 'entity', label: 'Entities' },
  { value: 'preference', label: 'Preferences' },
];

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type Props = { spaceId: string; onClose: () => void };

export function KnowledgePanel({ spaceId, onClose }: Props) {
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadEntries = useCallback(async () => {
    const url = filter === 'all'
      ? `/api/spaces/${spaceId}/knowledge`
      : `/api/spaces/${spaceId}/knowledge?type=${filter}`;
    const res = await api.get(url);
    if (res.ok) {
      const data = await res.json();
      setEntries(data.entries || []);
    }
    setLoading(false);
  }, [spaceId, filter]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // Real-time updates
  useEffect(() => {
    const token = localStorage.getItem('deft-access-token');
    if (!token) return;
    const socket = getSocket(token);
    if (!socket) return;

    const onCreated = (entry: KnowledgeEntry) => {
      setEntries(prev => [entry, ...prev]);
    };
    const onUpdated = (entry: KnowledgeEntry) => {
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, ...entry } : e));
    };
    const onDeleted = ({ id }: { id: string }) => {
      setEntries(prev => prev.filter(e => e.id !== id));
    };

    socket.on('knowledge:created', onCreated);
    socket.on('knowledge:updated', onUpdated);
    socket.on('knowledge:deleted', onDeleted);
    return () => {
      socket.off('knowledge:created', onCreated);
      socket.off('knowledge:updated', onUpdated);
      socket.off('knowledge:deleted', onDeleted);
    };
  }, []);

  const handleDelete = async (id: string) => {
    await api.delete(`/api/spaces/${spaceId}/knowledge/${id}`);
    setEntries(prev => prev.filter(e => e.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  return (
    <div
      className={isMobile ? 'fixed inset-0 z-50 flex flex-col' : 'w-[400px] h-full flex flex-col flex-shrink-0'}
      style={{ background: 'var(--surface-container-low)', borderLeft: isMobile ? 'none' : '1px solid var(--border)' }}
    >
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <BookOpen size={14} strokeWidth={1.5} style={{ color: 'var(--muted)' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>Knowledge</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ color: 'var(--muted)', background: 'var(--surface-container)' }}>
            {entries.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => { setIsAdding(true); setEditingId(null); }}
            className="p-1.5 rounded-md" style={{ color: 'var(--muted)' }} title="Add entry">
            <Plus size={14} strokeWidth={1.5} />
          </button>
          <button onClick={onClose}
            className="p-1.5 rounded-md" style={{ color: 'var(--muted)' }} title="Close">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-3 py-2 overflow-x-auto flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}>
        {FILTERS.map(f => (
          <button key={f.value} onClick={() => setFilter(f.value)}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors"
            style={{
              color: filter === f.value ? 'var(--accent)' : 'var(--muted)',
              background: filter === f.value ? 'var(--accent-subtle)' : 'transparent',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Add form */}
      {isAdding && (
        <AddForm spaceId={spaceId} onDone={() => { setIsAdding(false); loadEntries(); }} onCancel={() => setIsAdding(false)} />
      )}

      {/* Entries list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--muted)', borderTopColor: 'transparent' }} />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12 px-4">
            <BookOpen size={28} className="mx-auto mb-3" style={{ color: 'var(--muted)', opacity: 0.4 }} />
            <p className="text-[13px] font-medium" style={{ color: 'var(--muted)' }}>No entries yet</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--muted)', opacity: 0.7 }}>
              Capture decisions, resources, and notes for this space
            </p>
          </div>
        ) : (
          <div className="py-1">
            {entries.map(entry => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isExpanded={expandedId === entry.id}
                isEditing={editingId === entry.id}
                onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                onEdit={() => { setEditingId(entry.id); setExpandedId(entry.id); }}
                onCancelEdit={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); loadEntries(); }}
                onDelete={() => handleDelete(entry.id)}
                spaceId={spaceId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add Form ────────────────────────────────────────────────
// Types shown in the create form (most commonly used)
const CREATE_TYPES: KnowledgeType[] = ['decision', 'resource', 'procedure', 'fact', 'concept', 'entity', 'preference'];

function AddForm({ spaceId, onDone, onCancel }: { spaceId: string; onDone: () => void; onCancel: () => void }) {
  const [type, setType] = useState<KnowledgeType>('fact');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const metadata: any = {};
    if (type === 'resource' && url) metadata.url = url;
    if (type === 'decision') metadata.status = 'accepted';
    if (type === 'procedure') metadata.status = 'open';

    await api.post(`/api/spaces/${spaceId}/knowledge`, {
      type, title: title.trim(), content: content.trim() || null, metadata,
    });
    setSaving(false);
    onDone();
  };

  const contentPlaceholder = type === 'decision' ? 'Context and reasoning...'
    : type === 'resource' ? 'Description...'
    : type === 'procedure' ? 'Steps or details...'
    : 'Details...';

  return (
    <div className="px-3 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-container)' }}>
      {/* Type selector — scrollable row */}
      <div className="flex items-center gap-1 mb-2 overflow-x-auto">
        {CREATE_TYPES.map(t => {
          const cfg = TYPE_CONFIG[t];
          const Icon = cfg.icon;
          return (
            <button key={t} onClick={() => setType(t)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap"
              style={{
                color: type === t ? cfg.color : 'var(--muted)',
                background: type === t ? 'var(--surface-container-highest)' : 'transparent',
              }}>
              <Icon size={11} /> {cfg.label}
            </button>
          );
        })}
      </div>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title"
        className="w-full text-[13px] font-medium bg-transparent outline-none mb-2 px-1"
        style={{ color: 'var(--foreground)' }}
        autoFocus
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave(); } }}
      />
      {type === 'resource' && (
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="URL"
          className="w-full text-[12px] bg-transparent outline-none mb-2 px-1"
          style={{ color: 'var(--muted)' }}
        />
      )}
      <textarea value={content} onChange={e => setContent(e.target.value)}
        placeholder={contentPlaceholder}
        rows={2}
        className="w-full text-[12px] bg-transparent outline-none resize-none mb-2 px-1"
        style={{ color: 'var(--foreground)', lineHeight: '1.5' }}
      />
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="text-[11px] px-2 py-1 rounded-md" style={{ color: 'var(--muted)' }}>Cancel</button>
        <button onClick={handleSave} disabled={!title.trim() || saving}
          className="text-[11px] px-3 py-1 rounded-md font-medium"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)', opacity: !title.trim() || saving ? 0.5 : 1 }}>
          {saving ? 'Saving...' : 'Add'}
        </button>
      </div>
    </div>
  );
}

// ── Entry Card ──────────────────────────────────────────────
function EntryCard({
  entry, isExpanded, isEditing, onToggle, onEdit, onCancelEdit, onSaved, onDelete, spaceId,
}: {
  entry: KnowledgeEntry;
  isExpanded: boolean;
  isEditing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onDelete: () => void;
  spaceId: string;
}) {
  const cfg = TYPE_CONFIG[entry.type];
  const Icon = cfg.icon;
  const sourceHref = entry.source_message_id
    ? `/chat?space=${entry.source_space_id || entry.space_id || spaceId}&message=${entry.source_message_id}`
    : null;

  return (
    <div className="px-3 py-2 transition-colors hover:bg-[var(--surface-container)]"
      style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Summary row */}
      <div className="flex items-start gap-2 cursor-pointer" onClick={onToggle}>
        <div className="flex-shrink-0 mt-0.5 p-1 rounded" style={{ color: cfg.color }}>
          <Icon size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium truncate min-w-0" style={{ color: 'var(--foreground)' }}>
              {entry.title}
            </span>
            {entry.type === 'procedure' && entry.metadata?.status === 'done' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ background: 'var(--status-green)', color: '#000', opacity: 0.8 }}>Done</span>
            )}
            {entry.type === 'decision' && entry.metadata?.status === 'revisited' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ background: 'var(--status-orange)', color: '#000', opacity: 0.8 }}>Revisited</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px]" style={{ color: cfg.color }}>{cfg.label}</span>
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{timeAgo(entry.created_at)}</span>
            {entry.author_name && (
              <span className="text-[10px]" style={{ color: 'var(--muted)' }}>· {entry.author_name}</span>
            )}
          </div>
        </div>
        <ChevronDown size={12} className="flex-shrink-0 mt-1 transition-transform"
          style={{ color: 'var(--muted)', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
      </div>

      {/* Expanded content */}
      {isExpanded && !isEditing && (
        <div className="mt-2 ml-7">
          {entry.content && (
            <p className="text-[12px] mb-2" style={{ color: 'var(--foreground)', lineHeight: '1.6', opacity: 0.85 }}>
              {entry.content}
            </p>
          )}
          {entry.type === 'resource' && entry.metadata?.url && (
            <a href={entry.metadata.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] mb-2 hover:underline"
              style={{ color: 'var(--accent)' }}>
              <ExternalLink size={10} /> {entry.metadata.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}
            </a>
          )}
          {sourceHref && (
            <a href={sourceHref}
              className="inline-flex max-w-full items-center gap-1 text-[10px] mb-2 rounded px-1.5 py-0.5 hover:underline"
              style={{ color: 'var(--primary)', background: 'var(--bg-active)' }}>
              <ExternalLink size={9} className="flex-shrink-0" />
              <span className="truncate">Source message</span>
            </a>
          )}
          <div className="flex items-center gap-2 mt-1">
            <button onClick={onEdit} className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1"
              style={{ color: 'var(--muted)' }}>
              <Pencil size={9} /> Edit
            </button>
            <button onClick={onDelete} className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1"
              style={{ color: 'var(--status-red, #f87171)' }}>
              <Trash2 size={9} /> Delete
            </button>
            <a href={`/knowledge?slug=${entry.slug}`} className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1"
              style={{ color: 'var(--accent)' }}>
              <ExternalLink size={9} /> View in Wiki
            </a>
          </div>
        </div>
      )}

      {/* Inline edit form */}
      {isExpanded && isEditing && (
        <EditForm entry={entry} spaceId={spaceId} onDone={onSaved} onCancel={onCancelEdit} />
      )}
    </div>
  );
}

// ── Edit Form ───────────────────────────────────────────────
function EditForm({ entry, spaceId, onDone, onCancel }: { entry: KnowledgeEntry; spaceId: string; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content || '');
  const [url, setUrl] = useState(entry.metadata?.url || '');
  const [status, setStatus] = useState(entry.metadata?.status || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const metadata = { ...entry.metadata };
    if (entry.type === 'resource') metadata.url = url;
    if (status) metadata.status = status;

    await api.patch(`/api/spaces/${spaceId}/knowledge/${entry.id}`, {
      title: title.trim(), content: content.trim() || null, metadata,
    });
    setSaving(false);
    onDone();
  };

  return (
    <div className="mt-2 ml-7">
      <input value={title} onChange={e => setTitle(e.target.value)}
        className="w-full text-[13px] font-medium bg-transparent outline-none mb-1.5"
        style={{ color: 'var(--foreground)' }} autoFocus />
      {entry.type === 'resource' && (
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="URL"
          className="w-full text-[11px] bg-transparent outline-none mb-1.5"
          style={{ color: 'var(--muted)' }} />
      )}
      <textarea value={content} onChange={e => setContent(e.target.value)}
        rows={3} className="w-full text-[12px] bg-transparent outline-none resize-none mb-1.5"
        style={{ color: 'var(--foreground)', lineHeight: '1.5' }} />
      {(entry.type === 'decision' || entry.type === 'procedure') && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>Status:</span>
          {entry.type === 'decision' ? (
            ['proposed', 'accepted', 'revisited'].map(s => (
              <button key={s} onClick={() => setStatus(s)}
                className="text-[10px] px-1.5 py-0.5 rounded capitalize"
                style={{ color: status === s ? 'var(--accent)' : 'var(--muted)', background: status === s ? 'var(--accent-subtle)' : 'transparent' }}>
                {s}
              </button>
            ))
          ) : (
            ['open', 'done'].map(s => (
              <button key={s} onClick={() => setStatus(s)}
                className="text-[10px] px-1.5 py-0.5 rounded capitalize"
                style={{ color: status === s ? 'var(--accent)' : 'var(--muted)', background: status === s ? 'var(--accent-subtle)' : 'transparent' }}>
                {s}
              </button>
            ))
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="text-[11px] px-2 py-1 rounded-md" style={{ color: 'var(--muted)' }}>Cancel</button>
        <button onClick={handleSave} disabled={!title.trim() || saving}
          className="text-[11px] px-3 py-1 rounded-md font-medium"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)', opacity: !title.trim() || saving ? 0.5 : 1 }}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
