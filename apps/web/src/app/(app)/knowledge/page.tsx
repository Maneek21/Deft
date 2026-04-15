'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';

const KnowledgeGraph = lazy(() => import('./graph'));
import {
  Loader2, BookOpen, ArrowLeft, Link2, ArrowUpRight,
  Brain, Users, Scale, LinkIcon, Cog, Heart, Lightbulb,
  Plus, Pencil, Trash2, X, Check, History, GitBranch,
  Activity, Download, BarChart3, AlertTriangle,
} from 'lucide-react';

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: React.ComponentType<any> }> = {
  concept: { label: 'Concepts', color: '#8B5CF6', icon: Brain },
  entity: { label: 'Entities', color: '#06B6D4', icon: Users },
  decision: { label: 'Decisions', color: '#D4A853', icon: Scale },
  resource: { label: 'Resources', color: '#5B8FA8', icon: LinkIcon },
  procedure: { label: 'Procedures', color: '#C97B6B', icon: Cog },
  preference: { label: 'Preferences', color: '#EC4899', icon: Heart },
  fact: { label: 'Facts', color: '#7C9885', icon: Lightbulb },
};

const WIKI_TYPE_LABELS: Record<string, { singular: string; plural: string }> = {
  concept: { singular: 'Concept', plural: 'Concepts' },
  entity: { singular: 'Entity', plural: 'Entities' },
  decision: { singular: 'Decision', plural: 'Decisions' },
  resource: { singular: 'Resource', plural: 'Resources' },
  procedure: { singular: 'Procedure', plural: 'Procedures' },
  preference: { singular: 'Preference', plural: 'Preferences' },
  fact: { singular: 'Fact', plural: 'Facts' },
};

const WIKI_TYPES = ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'] as const;
const WIKI_SCOPES = ['org', 'space', 'user'] as const;

function formatActivityDetails(operation: string, details: any): string {
  if (!details) return '';
  if (details.message) return details.message;
  if (details.title) return `${operation === 'create' ? 'Created' : 'Updated'} "${details.title}" (${details.type || ''})`;
  if (details.updated_fields) return `Changed: ${details.updated_fields.join(', ')}`;
  if (details.triggered_by) return `Cascade from "${details.triggered_by}"`;
  if (details.appended_text) return details.appended_text.slice(0, 100);
  return JSON.stringify(details).slice(0, 100);
}

type WikiPage = {
  id: string;
  type: string;
  scope: string;
  title: string;
  slug: string;
  summary: string | null;
  confidence: number;
  version: number;
  space_id: string | null;
  created_at: string;
  updated_at: string;
  link_count: number;
};

type WikiPageDetail = WikiPage & {
  content: string;
  linked_pages: { slug: string; title: string; type: string; summary: string | null; confidence?: number; context?: string }[];
  backlinks: { slug: string; title: string; type: string; summary?: string | null; context?: string }[];
  citations: { id: string; source_type: string; source_id: string; excerpt: string | null; created_at: string }[];
};

function ConfidenceBar({ value }: { value: number }) {
  const color = value > 0.7 ? '#22C55E' : value > 0.5 ? '#EAB308' : '#EF4444';
  return (
    <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
      <div className="h-full rounded-full transition-all" style={{ width: `${value * 100}%`, background: color }} />
    </div>
  );
}

function CreatePageModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<string>('concept');
  const [scope, setScope] = useState<string>('org');
  const [summary, setSummary] = useState('');
  const [confidence, setConfidence] = useState(1.0);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      const res = await api.post('/api/wiki', {
        title: title.trim(),
        content: content.trim(),
        type,
        scope,
        summary: summary.trim() || null,
        confidence,
      });
      if (res.ok) {
        onCreated();
        onClose();
      }
    } catch {
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-lg mx-4 rounded-xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>Create Wiki Page</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:opacity-70">
            <X size={16} style={{ color: 'var(--text-tertiary)' }} />
          </button>
        </div>

        {/* Title */}
        <div>
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>Title</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Page title..."
            className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
        </div>

        {/* Type & Scope */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>Type</label>
            <div className="flex flex-wrap gap-1">
              {WIKI_TYPES.map(t => {
                const cfg = TYPE_CONFIG[t]!;
                return (
                  <button key={t} onClick={() => setType(t)}
                    className="px-2 py-1 rounded-md text-[10px] font-medium transition-colors"
                    style={{
                      background: type === t ? `${cfg.color}30` : 'var(--surface-container-low)',
                      color: type === t ? cfg.color : 'var(--text-tertiary)',
                      border: `1px solid ${type === t ? cfg.color : 'var(--border-default)'}`,
                    }}>
                    {WIKI_TYPE_LABELS[t]?.singular ?? cfg.label.replace(/s$/, '')}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Scope */}
        <div>
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>Scope</label>
          <div className="flex gap-1">
            {WIKI_SCOPES.map(s => (
              <button key={s} onClick={() => setScope(s)}
                className="px-3 py-1 rounded-md text-[11px] font-medium capitalize transition-colors"
                style={{
                  background: scope === s ? 'var(--accent)' : 'var(--surface-container-low)',
                  color: scope === s ? 'white' : 'var(--text-tertiary)',
                  border: `1px solid ${scope === s ? 'var(--accent)' : 'var(--border-default)'}`,
                }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Summary */}
        <div>
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>Summary (optional)</label>
          <input value={summary} onChange={e => setSummary(e.target.value)} placeholder="Brief summary..."
            className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
        </div>

        {/* Content */}
        <div>
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>Content</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Write page content..."
            rows={6}
            className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-y"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
        </div>

        {/* Confidence */}
        <div>
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>
            Confidence: {Math.round(confidence * 100)}%
          </label>
          <input type="range" min="0" max="100" value={Math.round(confidence * 100)}
            onChange={e => setConfidence(parseInt(e.target.value) / 100)}
            className="w-full" />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-[12px] font-medium"
            style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving || !title.trim() || !content.trim()}
            className="px-4 py-2 rounded-lg text-[12px] font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'white' }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [scopeFilter, setScopeFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<WikiPageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<{ title: string; content: string; summary: string; type: string; confidence: number }>({
    title: '', content: '', summary: '', type: 'concept', confidence: 1.0,
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<any>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [graphData, setGraphData] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'pages' | 'activity' | 'stats'>('pages');
  const [activityLog, setActivityLog] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const limit = 50;

  const fetchPages = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filter !== 'all') params.set('type', filter);
    if (scopeFilter !== 'all') params.set('scope', scopeFilter);
    if (searchQuery.trim()) params.set('q', searchQuery.trim());

    api.get(`/api/wiki?${params.toString()}`).then(async res => {
      if (res.ok) {
        const data = await res.json();
        setPages(data.pages || []);
        setTotal(data.total || 0);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  };

  // Fetch wiki pages list
  useEffect(() => {
    fetchPages();
  }, [filter, scopeFilter, page, searchQuery]);

  // Fetch page detail when selected
  useEffect(() => {
    if (!selectedSlug) {
      setDetail(null);
      setEditing(false);
      return;
    }
    setDetailLoading(true);
    api.get(`/api/wiki/${selectedSlug}`).then(async res => {
      if (res.ok) {
        setDetail(await res.json());
      }
    }).catch(() => {}).finally(() => setDetailLoading(false));
  }, [selectedSlug]);

  const startEditing = () => {
    if (!detail) return;
    setEditForm({
      title: detail.title,
      content: detail.content,
      summary: detail.summary || '',
      type: detail.type,
      confidence: detail.confidence,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await api.patch(`/api/wiki/${detail.slug}`, {
        title: editForm.title.trim(),
        content: editForm.content.trim(),
        summary: editForm.summary.trim() || null,
        type: editForm.type,
        confidence: editForm.confidence,
      });
      if (res.ok) {
        setEditing(false);
        // Refetch detail
        const detailRes = await api.get(`/api/wiki/${detail.slug}`);
        if (detailRes.ok) setDetail(await detailRes.json());
        fetchPages();
      }
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const fetchHistory = async (slug: string) => {
    setHistoryLoading(true);
    try {
      const res = await api.get(`/api/wiki/${slug}/history`);
      if (res.ok) {
        const data = await res.json();
        setHistoryVersions(data.versions || []);
      }
    } catch {
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchActivity = async () => {
    setActivityLoading(true);
    try {
      const res = await api.get('/api/wiki/log?limit=30');
      if (res.ok) {
        const data = await res.json();
        setActivityLog(data.entries || []);
      }
    } catch {
    } finally {
      setActivityLoading(false);
    }
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const res = await api.get('/api/wiki/stats');
      if (res.ok) {
        setStats(await res.json());
      }
    } catch {
    } finally {
      setStatsLoading(false);
    }
  };

  const fetchGraph = async () => {
    setGraphLoading(true);
    try {
      const res = await api.get('/api/wiki/graph');
      if (res.ok) {
        setGraphData(await res.json());
      }
    } catch {
    } finally {
      setGraphLoading(false);
    }
  };

  const deletePage = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
      const res = await api.delete(`/api/wiki/${detail.slug}`);
      if (res.ok) {
        setSelectedSlug(null);
        setShowDeleteConfirm(false);
        fetchPages();
      }
    } catch {
    } finally {
      setDeleting(false);
    }
  };

  const typeFilters = [
    { value: 'all', label: 'All' },
    { value: 'concept', label: 'Concepts' },
    { value: 'entity', label: 'Entities' },
    { value: 'decision', label: 'Decisions' },
    { value: 'resource', label: 'Resources' },
    { value: 'procedure', label: 'Procedures' },
    { value: 'preference', label: 'Preferences' },
    { value: 'fact', label: 'Facts' },
  ];

  const scopeFilters = [
    { value: 'all', label: 'All' },
    { value: 'org', label: 'Org' },
    { value: 'space', label: 'Space' },
    { value: 'user', label: 'Personal' },
  ];

  // Detail view
  if (selectedSlug) {
    return (
      <div className="flex flex-col h-full p-4 md:p-6 overflow-hidden">
        {/* Back button + actions */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <button
            onClick={() => setSelectedSlug(null)}
            className="flex items-center gap-1.5 text-[13px] font-medium"
            style={{ color: 'var(--accent)' }}
          >
            <ArrowLeft size={14} />
            Back to Knowledge
          </button>
          {detail && !editing && (
            <div className="flex items-center gap-2">
              <button onClick={startEditing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                <Pencil size={12} /> Edit
              </button>
              <button onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{ background: 'var(--surface-container-low)', color: '#EF4444', border: '1px solid var(--border-default)' }}>
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
          {editing && (
            <div className="flex items-center gap-2">
              <button onClick={() => setEditing(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
                style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>
                <X size={12} /> Cancel
              </button>
              <button onClick={saveEdit} disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'white' }}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <><Check size={12} /> Save</>}
              </button>
            </div>
          )}
        </div>

        {/* Delete confirmation */}
        {showDeleteConfirm && (
          <div className="mb-4 p-3 rounded-lg flex items-center justify-between"
            style={{ background: '#EF444415', border: '1px solid #EF444440' }}>
            <span className="text-[12px]" style={{ color: '#EF4444' }}>
              Delete &ldquo;{detail?.title}&rdquo;? This can&apos;t be undone.
            </span>
            <div className="flex gap-2">
              <button onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1 rounded-md text-[11px] font-medium"
                style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)' }}>
                Cancel
              </button>
              <button onClick={deletePage} disabled={deleting}
                className="px-3 py-1 rounded-md text-[11px] font-medium disabled:opacity-40"
                style={{ background: '#EF4444', color: 'white' }}>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        )}

        {detailLoading || !detail ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-4">
            {/* Page header */}
            <div>
              {editing ? (
                <>
                  {/* Edit: type selector */}
                  <div className="flex flex-wrap gap-1 mb-2">
                    {WIKI_TYPES.map(t => {
                      const cfg = TYPE_CONFIG[t]!;
                      return (
                        <button key={t} onClick={() => setEditForm(f => ({ ...f, type: t }))}
                          className="px-2 py-0.5 rounded-md text-[9px] font-medium"
                          style={{
                            background: editForm.type === t ? `${cfg.color}30` : 'var(--surface-container-low)',
                            color: editForm.type === t ? cfg.color : 'var(--text-tertiary)',
                            border: `1px solid ${editForm.type === t ? cfg.color : 'var(--border-default)'}`,
                          }}>
                          {WIKI_TYPE_LABELS[t]?.singular ?? cfg.label.replace(/s$/, '')}
                        </button>
                      );
                    })}
                  </div>
                  {/* Edit: title */}
                  <input value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                    className="w-full text-[20px] font-semibold mb-1 px-2 py-1 rounded-lg outline-none"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
                  {/* Edit: summary */}
                  <input value={editForm.summary} onChange={e => setEditForm(f => ({ ...f, summary: e.target.value }))}
                    placeholder="Summary (optional)..."
                    className="w-full text-[13px] px-2 py-1 rounded-lg outline-none mt-1"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }} />
                  {/* Edit: confidence */}
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      Confidence: {Math.round(editForm.confidence * 100)}%
                    </span>
                    <input type="range" min="0" max="100" value={Math.round(editForm.confidence * 100)}
                      onChange={e => setEditForm(f => ({ ...f, confidence: parseInt(e.target.value) / 100 }))}
                      className="flex-1" />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                      style={{ background: `${(TYPE_CONFIG[detail.type] || TYPE_CONFIG.fact!).color}20`, color: (TYPE_CONFIG[detail.type] || TYPE_CONFIG.fact!).color }}>
                      {WIKI_TYPE_LABELS[detail.type]?.singular ?? (TYPE_CONFIG[detail.type] || TYPE_CONFIG.fact!).label.replace(/s$/, '')}
                    </span>
                    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full capitalize"
                      style={{ background: 'var(--surface-container-low)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' }}>
                      {detail.scope}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>v{detail.version}</span>
                    <ConfidenceBar value={detail.confidence} />
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {Math.round(detail.confidence * 100)}% confidence
                    </span>
                  </div>
                  <h1 className="text-[20px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                    {detail.title}
                  </h1>
                  {detail.summary && (
                    <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{detail.summary}</p>
                  )}
                  <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
                    Updated {formatRelative(detail.updated_at)}
                  </p>
                </>
              )}
            </div>

            {/* Content */}
            <div className="p-4 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
              {editing ? (
                <textarea value={editForm.content} onChange={e => setEditForm(f => ({ ...f, content: e.target.value }))}
                  rows={12}
                  className="w-full text-[13px] leading-relaxed outline-none resize-y bg-transparent"
                  style={{ color: 'var(--text-primary)' }} />
              ) : (
                <div className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                  {detail.content}
                </div>
              )}
            </div>

            {/* Linked Pages */}
            {!editing && detail.linked_pages.length > 0 && (
              <div>
                <h3 className="text-[12px] font-semibold mb-2 flex items-center gap-1.5"
                  style={{ color: 'var(--text-secondary)' }}>
                  <Link2 size={13} />
                  Linked Pages ({detail.linked_pages.length})
                </h3>
                <div className="space-y-1">
                  {detail.linked_pages.map(lp => {
                    const lpConfig = TYPE_CONFIG[lp.type] || TYPE_CONFIG.fact!;
                    return (
                      <button key={lp.slug} onClick={() => setSelectedSlug(lp.slug)}
                        className="w-full text-left p-2.5 rounded-lg flex items-center gap-2 transition-colors"
                        style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}>
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ background: `${lpConfig.color}20`, color: lpConfig.color }}>
                          {WIKI_TYPE_LABELS[lp.type]?.singular ?? lpConfig.label.replace(/s$/, '')}
                        </span>
                        <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{lp.title}</span>
                        {lp.summary && (
                          <span className="text-[11px] truncate flex-1" style={{ color: 'var(--text-tertiary)' }}>— {lp.summary}</span>
                        )}
                        <ArrowUpRight size={11} style={{ color: 'var(--text-tertiary)' }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Backlinks */}
            {!editing && detail.backlinks.length > 0 && (
              <div>
                <h3 className="text-[12px] font-semibold mb-2 flex items-center gap-1.5"
                  style={{ color: 'var(--text-secondary)' }}>
                  <ArrowLeft size={13} />
                  Referenced By ({detail.backlinks.length})
                </h3>
                <div className="space-y-1">
                  {detail.backlinks.map(bl => {
                    const blConfig = TYPE_CONFIG[bl.type] || TYPE_CONFIG.fact!;
                    return (
                      <button key={bl.slug} onClick={() => setSelectedSlug(bl.slug)}
                        className="w-full text-left p-2.5 rounded-lg flex items-center gap-2 transition-colors"
                        style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}>
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ background: `${blConfig.color}20`, color: blConfig.color }}>
                          {WIKI_TYPE_LABELS[bl.type]?.singular ?? blConfig.label.replace(/s$/, '')}
                        </span>
                        <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{bl.title}</span>
                        <ArrowUpRight size={11} style={{ color: 'var(--text-tertiary)' }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Citations / Sources */}
            {!editing && detail.citations.length > 0 && (
              <div>
                <h3 className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Sources ({detail.citations.length})
                </h3>
                <div className="space-y-1">
                  {detail.citations.map(cit => (
                    <div key={cit.id} className="p-2 rounded-lg text-[11px]"
                      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {cit.source_type === 'message' ? 'Chat message' : cit.source_type}
                      </span>
                      {cit.excerpt && (
                        <p className="mt-0.5 line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>
                          &ldquo;{cit.excerpt}&rdquo;
                        </p>
                      )}
                      <span style={{ color: 'var(--text-tertiary)' }}> &middot; {formatRelative(cit.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Version History */}
            {!editing && detail.version > 1 && (
              <div>
                <button
                  onClick={() => { if (!showHistory) fetchHistory(detail.slug); setShowHistory(!showHistory); }}
                  className="text-[12px] font-semibold flex items-center gap-1.5 mb-2"
                  style={{ color: 'var(--text-secondary)' }}>
                  <History size={13} />
                  Version History ({detail.version} versions)
                </button>
                {showHistory && (
                  <div className="space-y-1">
                    {historyLoading ? (
                      <Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
                    ) : historyVersions.length === 0 ? (
                      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>No previous versions</p>
                    ) : (
                      historyVersions.map(v => (
                        <button key={v.id}
                          onClick={() => setSelectedVersion(selectedVersion?.id === v.id ? null : v)}
                          className="w-full text-left p-2 rounded-lg text-[11px]"
                          style={{
                            background: selectedVersion?.id === v.id ? 'var(--accent-muted, var(--surface-container))' : 'var(--surface-container-low)',
                            border: `1px solid ${selectedVersion?.id === v.id ? 'var(--accent)' : 'var(--border-default)'}`,
                          }}>
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>v{v.version}</span>
                          <span style={{ color: 'var(--text-tertiary)' }}> &middot; {v.title} &middot; {formatRelative(v.created_at)}</span>
                        </button>
                      ))
                    )}
                    {selectedVersion && (
                      <div className="mt-2 p-3 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                        <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>
                          v{selectedVersion.version} content:
                        </div>
                        <div className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                          {selectedVersion.content}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // List view
  return (
    <div className="flex flex-col h-full p-4 md:p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen size={20} style={{ color: 'var(--accent)' }} />
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>Knowledge Wiki</h1>
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors"
            style={{ background: 'var(--accent)', color: 'white' }}>
            <Plus size={12} /> New
          </button>
        </div>
        <div className="flex flex-nowrap items-center gap-2 overflow-x-auto flex-shrink-0">
          {/* View mode toggles */}
          {([
            { key: 'pages', icon: BookOpen, label: 'Pages' },
            { key: 'activity', icon: Activity, label: 'Activity' },
            { key: 'stats', icon: BarChart3, label: 'Stats' },
          ] as const).map(v => (
            <button key={v.key} onClick={() => {
              setViewMode(v.key);
              setShowGraph(false);
              if (v.key === 'activity' && activityLog.length === 0) fetchActivity();
              if (v.key === 'stats' && !stats) fetchStats();
            }}
              className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
              style={{
                background: viewMode === v.key ? 'var(--accent)' : 'transparent',
                color: viewMode === v.key ? 'white' : 'var(--text-tertiary)',
              }}>
              <v.icon size={12} /> {v.label}
            </button>
          ))}
          <button onClick={() => { if (!showGraph) fetchGraph(); setShowGraph(!showGraph); setViewMode('pages'); }}
            className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
            style={{
              background: showGraph ? 'var(--accent)' : 'transparent',
              color: showGraph ? 'white' : 'var(--text-tertiary)',
            }}>
            <GitBranch size={12} /> Graph
          </button>
          {/* Export */}
          <a href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/wiki/export?format=md`}
            target="_blank" rel="noopener noreferrer"
            className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium"
            style={{ color: 'var(--text-tertiary)' }}>
            <Download size={12} />
          </a>
          {/* Search */}
          <input
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
            placeholder="Search wiki..."
            className="flex-shrink-0 w-36 px-3 py-1.5 rounded-lg text-[12px] outline-none"
            style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      {/* Scope filter */}
      <div className="flex gap-1 mb-2 flex-shrink-0">
        {scopeFilters.map((f) => (
          <button key={f.value} onClick={() => { setScopeFilter(f.value); setPage(1); }}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
            style={{
              background: scopeFilter === f.value ? 'var(--surface-container-high)' : 'transparent',
              color: scopeFilter === f.value ? 'var(--text-primary)' : 'var(--text-tertiary)',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Type filter tabs */}
      <div className="flex flex-nowrap gap-1 mb-4 flex-shrink-0 overflow-x-auto">
        {typeFilters.map((f) => (
          <button key={f.value} onClick={() => { setFilter(f.value); setPage(1); }}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors flex-shrink-0"
            style={{
              background: filter === f.value ? 'var(--accent)' : 'var(--surface-container-low)',
              color: filter === f.value ? 'white' : 'var(--text-secondary)',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Entries */}
      {/* Graph View — interactive force-directed graph */}
      {showGraph && (
        <div className="flex-1 rounded-lg overflow-hidden"
          style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          {graphLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          ) : !graphData || graphData.nodes.length === 0 ? (
            <p className="text-center py-8 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No graph data</p>
          ) : (
            <div className="relative w-full h-full min-h-[450px]">
              {/* Legend */}
              <div className="absolute top-3 left-3 z-10 flex flex-wrap gap-2">
                {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
                  <span key={key} className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: `${cfg.color}15`, color: cfg.color }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: cfg.color }} />
                    {WIKI_TYPE_LABELS[key]?.singular ?? cfg.label.replace(/s$/, '')}
                  </span>
                ))}
              </div>
              {/* Stats */}
              <div className="absolute top-3 right-3 z-10 text-[11px] px-2 py-1 rounded-lg"
                style={{ background: 'var(--surface-container)', color: 'var(--text-tertiary)' }}>
                {graphData.nodes.length} pages &middot; {graphData.edges.length} connections
              </div>
              <Suspense fallback={<div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} /></div>}>
                <KnowledgeGraph
                  nodes={graphData.nodes}
                  edges={graphData.edges}
                  onNodeClick={(slug) => { setShowGraph(false); setSelectedSlug(slug); }}
                />
              </Suspense>
            </div>
          )}
        </div>
      )}

      {/* Activity View */}
      {viewMode === 'activity' && !showGraph && (
        <div className="flex-1 overflow-y-auto space-y-2">
          {activityLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          ) : activityLog.length === 0 ? (
            <p className="text-center py-8 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No activity yet</p>
          ) : (
            activityLog.map(entry => (
              <div key={entry.id} className="p-3 rounded-lg"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                    style={{
                      background: entry.operation === 'create' ? '#22C55E20' : entry.operation === 'contradiction' ? '#EF444420' : 'var(--surface-container)',
                      color: entry.operation === 'create' ? '#22C55E' : entry.operation === 'contradiction' ? '#EF4444' : 'var(--text-secondary)',
                    }}>
                    {entry.operation}
                  </span>
                  {entry.page_title && (
                    <button onClick={() => { setViewMode('pages'); setSelectedSlug(entry.page_slug); }}
                      className="text-[12px] font-medium hover:underline"
                      style={{ color: 'var(--accent)' }}>
                      {entry.page_title}
                    </button>
                  )}
                  <span className="text-[11px] ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                    {formatRelative(entry.created_at)}
                  </span>
                </div>
                {entry.details && (
                  <p className="text-[11px] ml-6" style={{ color: 'var(--text-tertiary)' }}>
                    {formatActivityDetails(entry.operation, entry.details)}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Stats View */}
      {viewMode === 'stats' && !showGraph && (
        <div className="flex-1 overflow-y-auto space-y-4">
          {statsLoading || !stats ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          ) : (
            <>
              {/* Overview cards */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Total Pages', value: stats.total },
                  { label: 'Total Links', value: stats.total_links },
                  { label: 'High Confidence', value: stats.by_confidence?.high || 0 },
                ].map(card => (
                  <div key={card.label} className="p-3 rounded-lg text-center"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                    <div className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>{card.value}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{card.label}</div>
                  </div>
                ))}
              </div>

              {/* By type */}
              <div className="p-3 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                <h3 className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Pages by Type</h3>
                <div className="space-y-1">
                  {Object.entries(stats.by_type || {}).map(([type, count]) => {
                    const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.fact!;
                    return (
                      <div key={type} className="flex items-center gap-2">
                        <span className="text-[11px] w-20 capitalize" style={{ color: cfg.color }}>{type}</span>
                        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--border-default)' }}>
                          <div className="h-full rounded-full" style={{ width: `${Math.min(100, ((count as number) / Math.max(stats.total, 1)) * 100)}%`, background: cfg.color }} />
                        </div>
                        <span className="text-[11px] w-6 text-right" style={{ color: 'var(--text-tertiary)' }}>{count as number}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Confidence distribution */}
              <div className="p-3 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                <h3 className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Confidence Distribution</h3>
                <div className="flex gap-3">
                  {[
                    { band: 'high', label: 'High (80%+)', color: '#22C55E' },
                    { band: 'medium', label: 'Medium (50-80%)', color: '#EAB308' },
                    { band: 'low', label: 'Low (<50%)', color: '#EF4444' },
                  ].map(b => (
                    <div key={b.band} className="flex-1 p-2 rounded-lg text-center" style={{ background: `${b.color}10` }}>
                      <div className="text-[16px] font-bold" style={{ color: b.color }}>{stats.by_confidence?.[b.band] || 0}</div>
                      <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{b.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Needs review */}
              {stats.needs_review?.length > 0 && (
                <div className="p-3 rounded-lg" style={{ background: '#EF444410', border: '1px solid #EF444430' }}>
                  <h3 className="text-[12px] font-semibold mb-2 flex items-center gap-1.5" style={{ color: '#EF4444' }}>
                    <AlertTriangle size={13} /> Needs Review
                  </h3>
                  <div className="space-y-1">
                    {stats.needs_review.map((p: any) => (
                      <button key={p.id} onClick={() => { setViewMode('pages'); setSelectedSlug(p.slug); }}
                        className="w-full text-left p-2 rounded-md text-[12px] hover:underline"
                        style={{ color: 'var(--text-primary)' }}>
                        {p.title} — {Math.round(p.confidence * 100)}% confidence
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent operations */}
              {Object.keys(stats.recent_ops || {}).length > 0 && (
                <div className="p-3 rounded-lg" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                  <h3 className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>Last 7 Days</h3>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(stats.recent_ops).map(([op, count]) => (
                      <span key={op} className="text-[11px] px-2 py-1 rounded-full"
                        style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)' }}>
                        {op}: {count as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* List View */}
      <div className="flex-1 overflow-y-auto space-y-2" style={{ display: (showGraph || viewMode !== 'pages') ? 'none' : undefined }}>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : pages.length === 0 ? (
          <div className="text-center py-12">
            <BookOpen size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No wiki pages yet</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Knowledge is automatically captured from conversations and agent interactions
            </p>
            <button onClick={() => setShowCreate(true)}
              className="mt-3 px-4 py-2 rounded-lg text-[12px] font-medium"
              style={{ background: 'var(--accent)', color: 'white' }}>
              Create First Page
            </button>
          </div>
        ) : (
          pages.map((entry) => {
            const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.fact!;
            const Icon = config.icon;
            return (
              <button key={entry.id} onClick={() => setSelectedSlug(entry.slug)}
                className="w-full text-left p-3 rounded-lg transition-colors"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: `${config.color}20` }}>
                    <Icon size={14} style={{ color: config.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {entry.title}
                      </span>
                      <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: `${config.color}20`, color: config.color }}>
                        {WIKI_TYPE_LABELS[entry.type]?.singular ?? config.label.replace(/s$/, '')}
                      </span>
                      {entry.scope !== 'org' && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full capitalize flex-shrink-0"
                          style={{ background: 'var(--surface-container)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' }}>
                          {entry.scope}
                        </span>
                      )}
                    </div>
                    {entry.summary && (
                      <p className="text-[12px] line-clamp-2 mb-1" style={{ color: 'var(--text-secondary)' }}>
                        {entry.summary}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      <ConfidenceBar value={entry.confidence} />
                      {entry.link_count > 0 && (
                        <span className="text-[11px] flex items-center gap-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          <Link2 size={10} /> {entry.link_count} links
                        </span>
                      )}
                      <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {formatRelative(entry.updated_at)}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        )}

        {/* Pagination */}
        {total > limit && (
          <div className="flex items-center justify-center gap-3 py-4">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-30"
              style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
            >
              Previous
            </button>
            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Page {page} of {Math.ceil(total / limit)}
            </span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page >= Math.ceil(total / limit)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium disabled:opacity-30"
              style={{ background: 'var(--surface-container-low)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <CreatePageModal onClose={() => setShowCreate(false)} onCreated={fetchPages} />
      )}
    </div>
  );
}
