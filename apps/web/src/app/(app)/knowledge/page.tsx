'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/time';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

const KnowledgeGraph = lazy(() => import('./graph'));
import {
  Loader2, BookOpen, ArrowLeft, Link2, ArrowUpRight,
  Brain, Users, Scale, LinkIcon, Cog, Heart, Lightbulb,
  Plus, Pencil, Trash2, X, Check, History, GitBranch,
  Activity, Download, BarChart3, AlertTriangle, RotateCcw, RefreshCw,
  Sparkles,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { OverflowMenu } from '@/components/overflow-menu';

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
  metadata?: Record<string, unknown> | null;
  confidence: number;
  tags?: string[] | null;
  version: number;
  space_id: string | null;
  origin_space_id?: string | null;
  origin_message_id?: string | null;
  origin_user_id?: string | null;
  created_via?: string | null;
  created_at: string;
  updated_at: string;
  link_count: number;
};

type SpaceOption = {
  id: string;
  name: string;
  type: string;
};

/** Returns true if a decision wiki page has been reversed. */
function isDecisionReversed(entry: Pick<WikiPage, 'confidence' | 'tags'>): boolean {
  return entry.confidence < 0.5 || (entry.tags ?? []).includes('reversed');
}

function getMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

type MemoryRoutablePage = Pick<WikiPage, 'scope' | 'space_id' | 'origin_space_id' | 'origin_message_id' | 'created_via'>;

function getMemoryRoute(page: MemoryRoutablePage): { label: string; color: string } {
  if (page.scope === 'user') {
    return { label: 'Personal memory', color: '#EC4899' };
  }
  if (page.scope === 'space' || page.space_id) {
    return { label: 'Channel memory', color: '#7C9885' };
  }
  if (page.origin_space_id) {
    return { label: 'Company memory from channel', color: '#D4A853' };
  }
  if (page.origin_message_id) {
    return { label: 'Company memory from chat', color: '#D4A853' };
  }
  return { label: 'Company memory', color: '#5B8FA8' };
}

function getCreatedViaLabel(createdVia: string | null | undefined): string | null {
  switch (createdVia) {
    case 'memory_extract':
      return 'Captured from chat';
    case 'wiki_create':
      return 'Saved by agent';
    case 'space_knowledge_panel':
      return 'Saved from channel notes';
    case 'human_mcp':
      return 'Saved through MCP';
    case 'manual':
      return 'Saved manually';
    default:
      return null;
  }
}

function getMemoryProvenanceLabels(page: MemoryRoutablePage): string[] {
  return [
    getCreatedViaLabel(page.created_via),
    page.origin_message_id ? 'source message linked' : null,
    page.origin_space_id && page.scope !== 'space' ? 'channel-originated' : null,
  ].filter((label): label is string => Boolean(label));
}

function getGraphScopeHint(mode: 'org' | 'space', includeOrg: boolean): string {
  if (mode === 'org') return 'Company memory graph';
  return includeOrg ? 'Channel context with company memory' : 'Channel-only context graph';
}

function MemoryRouteBadge({ page }: { page: MemoryRoutablePage }) {
  const route = getMemoryRoute(page);
  return (
    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
      style={{ background: `${route.color}18`, color: route.color, border: `1px solid ${route.color}35` }}>
      {route.label}
    </span>
  );
}

type WikiPageDetail = WikiPage & {
  content: string;
  linked_pages: { slug: string; title: string; type: string; summary: string | null; confidence?: number; context?: string }[];
  backlinks: { slug: string; title: string; type: string; summary?: string | null; context?: string }[];
  citations: { id: string; source_type: string; source_id: string; excerpt: string | null; created_at: string; source_space_id?: string | null }[];
};

type AskKnowledgeSource = {
  index: number;
  source_type: string;
  source_id: string;
  title: string;
  excerpt: string;
  score: number;
  scope: string | null;
  confidence: number | null;
  slug: string | null;
  type: string;
  summary: string | null;
  space_id: string | null;
  origin_space_id: string | null;
  origin_message_id: string | null;
  created_via: string | null;
};

type AskKnowledgeResponse = {
  answer: string;
  mode: 'answered' | 'retrieval_only';
  model: string | null;
  sources: AskKnowledgeSource[];
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
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    const parsedTags = tags.split(',').map(t => t.trim()).filter(Boolean).filter((t, i, arr) => arr.indexOf(t) === i);
    try {
      const res = await api.post('/api/wiki', {
        title: title.trim(),
        content: content.trim(),
        type,
        scope,
        summary: summary.trim() || null,
        confidence,
        tags: parsedTags,
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

        {/* Tags */}
        <div>
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>Tags (optional, comma-separated)</label>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="e.g. security, workflow, audit"
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
  const searchParams = useSearchParams();
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>(() => {
    // Support ?type=decision (or any valid type) deep-link
    const typeParam = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('type')
      : null;
    const validTypes = ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'];
    return typeParam && validTypes.includes(typeParam) ? typeParam : 'all';
  });
  const [scopeFilter, setScopeFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<WikiPageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<{ title: string; content: string; summary: string; type: string; confidence: number; tags: string }>({
    title: '', content: '', summary: '', type: 'concept', confidence: 1.0, tags: '',
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<any>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [graphData, setGraphData] = useState<{ nodes: any[]; edges: any[]; mode?: string; scope_label?: string; space_id?: string | null } | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphMode, setGraphMode] = useState<'org' | 'space'>('org');
  const [graphSpaceId, setGraphSpaceId] = useState<string>('');
  const [graphIncludeOrg, setGraphIncludeOrg] = useState(true);
  const [spaces, setSpaces] = useState<SpaceOption[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'pages' | 'activity' | 'stats' | 'doctor'>('pages');
  const [activityLog, setActivityLog] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [doctor, setDoctor] = useState<any>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [askQuery, setAskQuery] = useState('');
  const [askScope, setAskScope] = useState<'company' | 'channel'>('company');
  const [askLoading, setAskLoading] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<AskKnowledgeResponse | null>(null);
  const pagesAbortRef = useRef<AbortController | null>(null);
  const pagesRequestIdRef = useRef(0);
  const limit = 50;
  const isSearchSettling = searchQuery.trim() !== debouncedSearchQuery;

  const fetchPages = useCallback(async () => {
    const requestId = pagesRequestIdRef.current + 1;
    pagesRequestIdRef.current = requestId;
    pagesAbortRef.current?.abort();
    const controller = new AbortController();
    pagesAbortRef.current = controller;

    setLoading(true);
    setPagesError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filter !== 'all') params.set('type', filter);
    if (scopeFilter !== 'all') params.set('scope', scopeFilter);
    if (debouncedSearchQuery) params.set('q', debouncedSearchQuery);

    try {
      const res = await api.fetch(`/api/wiki?${params.toString()}`, { signal: controller.signal });
      if (requestId !== pagesRequestIdRef.current) return;

      if (!res.ok) {
        let message = 'Could not load wiki pages.';
        try {
          const data = await res.json();
          message = data.error || message;
        } catch {
          // Keep the generic message.
        }
        if (res.status === 429) {
          message = 'Knowledge search is being rate limited. Pause briefly and try again.';
        }
        setPagesError(message);
        return;
      }

      const data = await res.json();
      if (requestId !== pagesRequestIdRef.current) return;
      setPages(data.pages || []);
      setTotal(data.total || 0);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (requestId === pagesRequestIdRef.current) {
        setPagesError(err instanceof Error ? err.message : 'Could not load wiki pages.');
      }
    } finally {
      if (requestId === pagesRequestIdRef.current) {
        setLoading(false);
        if (pagesAbortRef.current === controller) {
          pagesAbortRef.current = null;
        }
      }
    }
  }, [page, filter, scopeFilter, debouncedSearchQuery]);

  // Sync filter from URL ?type= param, open detail from ?slug= param
  useEffect(() => {
    const typeParam = searchParams.get('type');
    const validTypes = ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'];
    if (typeParam && validTypes.includes(typeParam)) {
      setFilter(typeParam);
    }
    const slugParam = searchParams.get('slug');
    if (slugParam) {
      setSelectedSlug(slugParam);
    }
  }, [searchParams]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  // Fetch wiki pages list
  useEffect(() => {
    fetchPages();
    return () => {
      pagesAbortRef.current?.abort();
    };
  }, [fetchPages]);

  useEffect(() => {
    let cancelled = false;
    setSpacesLoading(true);
    api.get('/api/spaces').then(async res => {
      if (!res.ok) return;
      const data = await res.json();
      if (cancelled) return;
      const nextSpaces = (Array.isArray(data) ? data : [])
        .filter((s: any) => s && s.type !== 'dm' && s.type !== 'group_dm')
        .map((s: any) => ({ id: s.id, name: s.name, type: s.type }));
      setSpaces(nextSpaces);
      setGraphSpaceId(prev => prev || nextSpaces[0]?.id || '');
    }).catch(() => {
      if (!cancelled) setSpaces([]);
    }).finally(() => {
      if (!cancelled) setSpacesLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

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
      tags: (detail.tags ?? []).join(', '),
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const parsedTags = editForm.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .filter((t, i, arr) => arr.indexOf(t) === i);
      const res = await api.patch(`/api/wiki/${detail.slug}`, {
        title: editForm.title.trim(),
        content: editForm.content.trim(),
        summary: editForm.summary.trim() || null,
        type: editForm.type,
        confidence: editForm.confidence,
        tags: parsedTags,
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

  const fetchGraph = useCallback(async (
    mode: 'org' | 'space' = graphMode,
    spaceId: string = graphSpaceId,
    includeOrg: boolean = graphIncludeOrg,
  ) => {
    if (mode === 'space' && !spaceId) {
      setGraphData({ nodes: [], edges: [], mode, scope_label: 'Channel', space_id: null });
      return;
    }
    setGraphLoading(true);
    try {
      const params = new URLSearchParams({ mode });
      if (mode === 'space') {
        params.set('space_id', spaceId);
        params.set('include_org', String(includeOrg));
      }
      const res = await api.get(`/api/wiki/graph?${params.toString()}`);
      if (res.ok) {
        setGraphData(await res.json());
      }
    } catch {
    } finally {
      setGraphLoading(false);
    }
  }, [graphIncludeOrg, graphMode, graphSpaceId]);

  useEffect(() => {
    if (!showGraph) return;
    fetchGraph(graphMode, graphSpaceId, graphIncludeOrg);
  }, [fetchGraph, showGraph, graphMode, graphSpaceId, graphIncludeOrg]);

  const reverseDecision = async (entry: WikiPage, targetReversed: boolean) => {
    const confirmMsg = targetReversed
      ? 'Mark this decision as reversed? This will lower its confidence and tag it as reversed.'
      : 'Re-activate this decision? This will restore its confidence and remove the reversed tag.';
    if (!window.confirm(confirmMsg)) return;

    setReversingId(entry.id);
    setReverseError(null);
    try {
      const res = await api.patch(`/api/decisions/${entry.id}`, { is_reversed: targetReversed });
      if (res.ok) {
        // Update the page in local state so badge refreshes immediately (no full refetch needed)
        const data = await res.json();
        setPages(prev => prev.map(p => {
          if (p.id !== entry.id) return p;
          return {
            ...p,
            confidence: data.confidence ?? p.confidence,
            tags: data.tags ?? p.tags,
          };
        }));
      } else {
        const errData = await res.json().catch(() => ({}));
        setReverseError(errData.error || 'Failed to update decision. Please try again.');
      }
    } catch {
      setReverseError('Failed to update decision. Please try again.');
    } finally {
      setReversingId(null);
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

  const fetchDoctor = async () => {
    setDoctorLoading(true);
    try {
      const res = await api.get('/api/wiki/doctor');
      if (res.ok) {
        setDoctor(await res.json());
      }
    } catch {
    } finally {
      setDoctorLoading(false);
    }
  };

  const askKnowledge = async () => {
    const query = askQuery.trim();
    if (!query) return;
    setAskLoading(true);
    setAskError(null);
    try {
      const body: Record<string, unknown> = {
        query,
        limit: 6,
        include_org: askScope === 'channel' ? graphIncludeOrg : true,
      };
      if (askScope === 'channel' && graphSpaceId) {
        body.space_id = graphSpaceId;
      }
      const res = await api.post('/api/wiki/ask', body);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setAskError(data?.error || 'Could not ask knowledge.');
        return;
      }
      setAskResult(data);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'Could not ask knowledge.');
    } finally {
      setAskLoading(false);
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

  const openKnowledgeView = (next: 'pages' | 'activity' | 'stats' | 'doctor' | 'graph') => {
    if (next === 'graph') {
      setShowGraph(true);
      setViewMode('pages');
      return;
    }
    setShowGraph(false);
    setViewMode(next);
    if (next === 'activity' && activityLog.length === 0) fetchActivity();
    if (next === 'stats' && !stats) fetchStats();
    if (next === 'doctor' && !doctor) fetchDoctor();
  };

  const detailResourceUrl = getMetadataString(detail?.metadata, 'url');

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
                  {/* Edit: tags */}
                  <div className="mt-2">
                    <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-tertiary)' }}>
                      Tags (comma-separated)
                    </label>
                    <input value={editForm.tags} onChange={e => setEditForm(f => ({ ...f, tags: e.target.value }))}
                      placeholder="e.g. security, workflow, audit"
                      className="w-full px-2 py-1 rounded-lg text-[12px] outline-none"
                      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                      style={{ background: `${(TYPE_CONFIG[detail.type] || TYPE_CONFIG.fact!).color}20`, color: (TYPE_CONFIG[detail.type] || TYPE_CONFIG.fact!).color }}>
                      {WIKI_TYPE_LABELS[detail.type]?.singular ?? (TYPE_CONFIG[detail.type] || TYPE_CONFIG.fact!).label.replace(/s$/, '')}
                    </span>
                    <MemoryRouteBadge page={detail} />
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
                  {detailResourceUrl && (
                    <a href={detailResourceUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mt-2 text-[12px] hover:underline"
                      style={{ color: 'var(--accent)' }}>
                      <LinkIcon size={12} />
                      {detailResourceUrl.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80)}
                      <ArrowUpRight size={11} />
                    </a>
                  )}
                  {detail.tags && detail.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {detail.tags.map(tag => (
                        <span key={tag} className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
                          style={{ background: 'var(--surface-container)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)' }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px] mt-2" style={{ color: 'var(--text-tertiary)' }}>
                    Updated {formatRelative(detail.updated_at)}
                  </p>
                  {getMemoryProvenanceLabels(detail).length > 0 && (
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {getMemoryProvenanceLabels(detail).join(' / ')}
                    </p>
                  )}
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
                <div className="text-[13px] leading-relaxed prose prose-sm max-w-none" style={{ color: 'var(--text-primary)' }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[[rehypeSanitize, defaultSchema]]}
                  >
                    {detail.content}
                  </ReactMarkdown>
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
                      {cit.source_type === 'message' && cit.source_space_id ? (
                        <a href={`/chat?space=${cit.source_space_id}&message=${cit.source_id}`}
                          className="inline-flex items-center gap-1 font-medium hover:underline"
                          style={{ color: 'var(--accent)' }}>
                          Chat message <ArrowUpRight size={10} />
                        </a>
                      ) : (
                        <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>
                          {cit.source_type === 'message' ? 'Chat message' : cit.source_type}
                        </span>
                      )}
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header — mobile-trimmed */}
      <PageHeader
        title="Knowledge Wiki"
        compact
        primary={
          <>
            {/* + New */}
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <Plus size={12} /> New
            </button>
            {/* Pages (primary view toggle — always visible) */}
            <button
              onClick={() => { setViewMode('pages'); setShowGraph(false); }}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
              style={{
                background: viewMode === 'pages' && !showGraph ? 'var(--surface-container-high)' : 'transparent',
                color: viewMode === 'pages' && !showGraph ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              <BookOpen size={12} /> Pages
            </button>
            {/* Graph toggle */}
            <button
              onClick={() => { setShowGraph(prev => !prev); setViewMode('pages'); }}
              className="hidden md:flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
              style={{
                background: showGraph ? 'var(--surface-container-high)' : 'transparent',
                color: showGraph ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              <GitBranch size={12} /> Graph
            </button>
            {/* Search */}
            <input
              value={searchQuery}
              onChange={e => {
                const val = e.target.value;
                // Auto-clear type filter when starting a search so results span all types
                if (val && !searchQuery) setFilter('all');
                setSearchQuery(val);
                setPage(1);
              }}
              placeholder="Search wiki..."
              title="Search returns results across all types — clear the search to refine by type."
              className="w-28 md:w-36 px-3 py-1.5 rounded-lg text-[12px] outline-none"
              style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
            {/* Overflow menu — Activity, Stats, Graph (mobile), Export */}
            <OverflowMenu
              items={[
                {
                  label: 'Activity',
                  onClick: () => {
                    setViewMode('activity');
                    setShowGraph(false);
                    if (activityLog.length === 0) fetchActivity();
                  },
                },
                {
                  label: 'Stats',
                  onClick: () => {
                    setViewMode('stats');
                    setShowGraph(false);
                    if (!stats) fetchStats();
                  },
                },
                {
                  label: 'Doctor',
                  onClick: () => {
                    setViewMode('doctor');
                    setShowGraph(false);
                    if (!doctor) fetchDoctor();
                  },
                },
                {
                  label: 'Graph',
                  onClick: () => { setShowGraph(true); setViewMode('pages'); },
                },
                {
                  label: 'Export',
                  onClick: () => {
                    window.open(
                      `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/wiki/export?format=md`,
                      '_blank',
                    );
                  },
                },
              ]}
            />
          </>
        }
        secondary={
          <div className="flex flex-col gap-1 px-1">
            <div className="md:hidden flex gap-2">
              <select
                value={showGraph ? 'graph' : viewMode}
                onChange={e => openKnowledgeView(e.target.value as 'pages' | 'activity' | 'stats' | 'doctor' | 'graph')}
                className="flex-1 text-[0.8125rem] rounded-md px-2 py-1 outline-none"
                style={{
                  background: 'var(--surface-container-low)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="pages">Pages</option>
                <option value="activity">Activity</option>
                <option value="stats">Stats</option>
                <option value="doctor">Doctor</option>
                <option value="graph">Graph</option>
              </select>
              <button
                onClick={() => setShowCreate(true)}
                className="px-3 py-1 rounded-md text-[0.8125rem] font-medium"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                New
              </button>
            </div>
            {/* Scope axis: <select> on mobile, inline tab strip on md+ */}
            <div className="flex gap-1">
              {/* Mobile: select */}
              <select
                value={scopeFilter}
                onChange={e => { setScopeFilter(e.target.value); setPage(1); }}
                className="md:hidden text-[0.8125rem] rounded-md px-2 py-1 outline-none"
                style={{
                  background: 'var(--surface-container-low)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              >
                {scopeFilters.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              {/* Desktop: inline pill buttons */}
              <div className="hidden md:flex gap-1">
                {scopeFilters.map(f => (
                  <button
                    key={f.value}
                    onClick={() => { setScopeFilter(f.value); setPage(1); }}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                    style={{
                      background: scopeFilter === f.value ? 'var(--surface-container-high)' : 'transparent',
                      color: scopeFilter === f.value ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Type axis: scrollable tab strip on both mobile + desktop */}
            <div className="flex flex-nowrap gap-1 overflow-x-auto">
              {typeFilters.map(f => (
                <button
                  key={f.value}
                  onClick={() => { setFilter(f.value); setPage(1); }}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors flex-shrink-0"
                  style={{
                    background: filter === f.value ? 'var(--accent)' : 'var(--surface-container-low)',
                    color: filter === f.value ? 'white' : 'var(--text-secondary)',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {/* Entries */}
      <div className="flex flex-col flex-1 overflow-hidden px-4 md:px-6 pb-4 md:pb-6">
      {viewMode === 'pages' && !showGraph && (
        <div className="mb-3 rounded-lg p-3 flex-shrink-0"
          style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex flex-col md:flex-row md:items-center gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--accent-muted, rgba(91, 143, 168, 0.16))', color: 'var(--accent)' }}>
                <Sparkles size={15} />
              </span>
              <input
                value={askQuery}
                onChange={e => setAskQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void askKnowledge();
                  }
                }}
                placeholder="Ask what the workspace knows..."
                className="flex-1 min-w-0 px-3 py-2 rounded-lg text-[13px] outline-none"
                style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={askScope}
                onChange={e => setAskScope(e.target.value as 'company' | 'channel')}
                className="px-2 py-2 rounded-lg text-[12px] outline-none"
                style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              >
                <option value="company">Company memory</option>
                <option value="channel">Channel context</option>
              </select>
              {askScope === 'channel' && (
                <>
                  <select
                    value={graphSpaceId}
                    onChange={e => setGraphSpaceId(e.target.value)}
                    disabled={spacesLoading || spaces.length === 0}
                    className="px-2 py-2 rounded-lg text-[12px] outline-none max-w-[180px]"
                    style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  >
                    {spaces.length === 0 ? (
                      <option value="">{spacesLoading ? 'Loading channels...' : 'No channels'}</option>
                    ) : spaces.map(space => (
                      <option key={space.id} value={space.id}>{space.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setGraphIncludeOrg(v => !v)}
                    className="px-2 py-2 rounded-lg text-[11px] font-medium"
                    style={{
                      background: graphIncludeOrg ? 'var(--surface-container-high)' : 'transparent',
                      border: '1px solid var(--border-default)',
                      color: graphIncludeOrg ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    Include company
                  </button>
                </>
              )}
              <button
                onClick={() => void askKnowledge()}
                disabled={askLoading || !askQuery.trim() || (askScope === 'channel' && !graphSpaceId)}
                className="px-3 py-2 rounded-lg text-[12px] font-medium disabled:opacity-40 flex items-center gap-1.5"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {askLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                Ask
              </button>
            </div>
          </div>
          {askError && (
            <p className="mt-2 text-[12px]" style={{ color: '#EF4444' }}>{askError}</p>
          )}
          {askResult && (
            <div className="mt-3 rounded-lg p-3"
              style={{ background: 'var(--surface-container)', border: '1px solid var(--border-default)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                  style={{ background: askResult.mode === 'answered' ? '#22C55E20' : '#EAB30820', color: askResult.mode === 'answered' ? '#22C55E' : '#A16207' }}>
                  {askResult.mode === 'answered' ? 'Answered from sources' : 'Sources only'}
                </span>
                {askResult.model && (
                  <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{askResult.model}</span>
                )}
              </div>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                {askResult.answer}
              </p>
              {askResult.sources.length > 0 && (
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {askResult.sources.map(source => (
                    <div key={`${source.source_type}:${source.source_id}`} className="p-2 rounded-lg"
                      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] font-semibold w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                          style={{ background: 'var(--surface-container)', color: 'var(--text-secondary)' }}>
                          {source.index}
                        </span>
                        <div className="min-w-0 flex-1">
                          {source.slug ? (
                            <button onClick={() => setSelectedSlug(source.slug)}
                              className="text-left text-[12px] font-medium hover:underline"
                              style={{ color: 'var(--accent)' }}>
                              {source.title}
                            </button>
                          ) : (
                            <p className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{source.title}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-1 mt-1">
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                              style={{ background: 'var(--surface-container)', color: 'var(--text-tertiary)' }}>
                              {source.type}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                              style={{ background: 'var(--surface-container)', color: 'var(--text-tertiary)' }}>
                              {source.scope || 'workspace'}
                            </span>
                            <span className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
                              {Math.round(source.score * 100)}% match
                            </span>
                          </div>
                          {source.excerpt && (
                            <p className="mt-1 text-[11px] line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>
                              {source.excerpt}
                            </p>
                          )}
                          {source.origin_message_id && (source.space_id || source.origin_space_id) && (
                            <a href={`/chat?space=${source.space_id || source.origin_space_id}&message=${source.origin_message_id}`}
                              className="inline-flex items-center gap-1 mt-1 text-[10px] hover:underline"
                              style={{ color: 'var(--accent)' }}>
                              Open source message <ArrowUpRight size={10} />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Graph View — interactive force-directed graph */}
      {showGraph && (
        <div className="flex-1 rounded-lg overflow-hidden flex flex-col"
          style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 flex-shrink-0"
            style={{ background: 'var(--surface-container)', borderBottom: '1px solid var(--border-default)' }}>
            <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
              <button
                onClick={() => setGraphMode('org')}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                style={{
                  background: graphMode === 'org' ? 'var(--accent)' : 'transparent',
                  color: graphMode === 'org' ? 'white' : 'var(--text-secondary)',
                }}
              >
                Company
              </button>
              <button
                onClick={() => setGraphMode('space')}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                style={{
                  background: graphMode === 'space' ? 'var(--accent)' : 'transparent',
                  color: graphMode === 'space' ? 'white' : 'var(--text-secondary)',
                }}
              >
                Channel
              </button>
            </div>
            {graphMode === 'space' && (
              <>
                <select
                  value={graphSpaceId}
                  onChange={e => setGraphSpaceId(e.target.value)}
                  disabled={spacesLoading || spaces.length === 0}
                  className="px-2 py-1 rounded-lg text-[11px] outline-none"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  {spaces.length === 0 ? (
                    <option value="">{spacesLoading ? 'Loading channels...' : 'No channels'}</option>
                  ) : spaces.map(space => (
                    <option key={space.id} value={space.id}>{space.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => setGraphIncludeOrg(v => !v)}
                  className="px-2 py-1 rounded-lg text-[11px] font-medium transition-colors"
                  style={{
                    background: graphIncludeOrg ? 'var(--surface-container-high)' : 'transparent',
                    border: '1px solid var(--border-default)',
                    color: graphIncludeOrg ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  }}
                >
                  Include company memory
                </button>
              </>
            )}
            <span className="text-[11px] px-2 py-1 rounded-lg"
              style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-tertiary)' }}>
              {getGraphScopeHint(graphMode, graphIncludeOrg)}
            </span>
            <button
              onClick={() => fetchGraph(graphMode, graphSpaceId, graphIncludeOrg)}
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors"
              style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              <RefreshCw size={11} /> Refresh
            </button>
          </div>
          {graphLoading ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          ) : !graphData || graphData.nodes.length === 0 ? (
            <p className="flex-1 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
              {graphMode === 'space' ? 'No channel graph data yet' : 'No graph data'}
            </p>
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
                {graphData.scope_label || (graphMode === 'space' ? 'Channel' : 'Company')} &middot; {graphData.nodes.length} pages &middot; {graphData.edges.length} connections
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

      {/* Doctor View */}
      {viewMode === 'doctor' && !showGraph && (
        <div className="flex-1 overflow-y-auto space-y-4">
          {doctorLoading || !doctor ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { key: 'low_confidence', label: 'Low confidence', color: '#EF4444' },
                  { key: 'stale', label: 'Stale', color: '#EAB308' },
                  { key: 'orphaned', label: 'Orphaned', color: '#5B8FA8' },
                  { key: 'contradictions', label: 'Contradictions', color: '#C97B6B' },
                ].map(item => (
                  <div key={item.key} className="p-3 rounded-lg"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                    <div className="text-[18px] font-bold" style={{ color: item.color }}>{doctor.summary?.[item.key] ?? 0}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{item.label}</div>
                  </div>
                ))}
              </div>

              {[
                { key: 'low_confidence', label: 'Low confidence pages', hint: 'Review source evidence or confidence before agents rely on these.' },
                { key: 'stale', label: 'Stale pages', hint: 'These have not changed in 90+ days; confirm they still match reality.' },
                { key: 'orphaned', label: 'Orphaned pages', hint: 'These have no links or citations, so they are harder for people to trust.' },
              ].map(section => {
                const rows = doctor.issues?.[section.key] ?? [];
                return (
                  <div key={section.key} className="p-3 rounded-lg"
                    style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <h3 className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{section.label}</h3>
                      <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{rows.length}</span>
                    </div>
                    <p className="text-[11px] mb-2" style={{ color: 'var(--text-tertiary)' }}>{section.hint}</p>
                    {rows.length === 0 ? (
                      <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No issues found.</p>
                    ) : (
                      <div className="space-y-1">
                        {rows.map((row: any) => (
                          <button key={row.id} onClick={() => { setViewMode('pages'); setSelectedSlug(row.slug); }}
                            className="w-full text-left p-2 rounded-md"
                            style={{ background: 'var(--surface-container)', color: 'var(--text-primary)' }}>
                            <span className="text-[12px] font-medium">{row.title}</span>
                            <span className="text-[10px] ml-2" style={{ color: 'var(--text-tertiary)' }}>
                              {row.type} / {row.scope} / {Math.round((row.confidence ?? 0) * 100)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="p-3 rounded-lg"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}>
                <h3 className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Contradictions</h3>
                <p className="text-[11px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                  These are lint findings only. Deft shows them for review; it does not rewrite memory automatically.
                </p>
                {(doctor.issues?.contradictions ?? []).length === 0 ? (
                  <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No visible contradictions found.</p>
                ) : (
                  <div className="space-y-1">
                    {doctor.issues.contradictions.map((row: any) => (
                      <button key={row.id} onClick={() => { if (row.page_slug) { setViewMode('pages'); setSelectedSlug(row.page_slug); } }}
                        className="w-full text-left p-2 rounded-md"
                        style={{ background: 'var(--surface-container)', color: 'var(--text-primary)' }}>
                        <span className="text-[12px] font-medium">{row.page_title || 'Knowledge contradiction'}</span>
                        <span className="text-[10px] ml-2" style={{ color: 'var(--text-tertiary)' }}>
                          {formatRelative(row.created_at)}
                        </span>
                        {row.details?.description && (
                          <p className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>{row.details.description}</p>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* List View */}
      <div className="flex-1 overflow-y-auto space-y-2" style={{ display: (showGraph || viewMode !== 'pages') ? 'none' : undefined }}>
        {/* Reverse action error banner */}
        {reverseError && (
          <div className="flex items-center justify-between p-2.5 rounded-lg mb-1"
            style={{ background: '#EF444415', border: '1px solid #EF444440' }}>
            <span className="text-[12px]" style={{ color: '#EF4444' }}>{reverseError}</span>
            <button onClick={() => setReverseError(null)} className="ml-2 p-0.5 rounded hover:opacity-70">
              <X size={13} style={{ color: '#EF4444' }} />
            </button>
          </div>
        )}
        {pagesError && (
          <div className="flex items-center justify-between gap-3 p-2.5 rounded-lg mb-1"
            style={{ background: '#EF444415', border: '1px solid #EF444440' }}>
            <span className="text-[12px]" style={{ color: '#EF4444' }}>{pagesError}</span>
            <button onClick={fetchPages} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium hover:opacity-80"
              style={{ background: '#EF444420', color: '#EF4444' }}>
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        )}
        {(loading || isSearchSettling) && pages.length > 0 && (
          <div className="flex items-center gap-2 px-2 py-1 mb-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            <Loader2 size={12} className="animate-spin" />
            Searching knowledge...
          </div>
        )}
        {loading && pages.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
          </div>
        ) : pages.length === 0 && !pagesError ? (
          <div className="text-center py-12">
            <BookOpen size={24} style={{ color: 'var(--text-tertiary)', margin: '0 auto 8px' }} />
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
              {debouncedSearchQuery ? `No wiki pages match "${debouncedSearchQuery}"` : 'No wiki pages yet'}
            </p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {debouncedSearchQuery
                ? 'Try a broader term or clear the search.'
                : 'Knowledge is automatically captured from conversations and agent interactions'}
            </p>
            {!debouncedSearchQuery && (
              <button onClick={() => setShowCreate(true)}
                className="mt-3 px-4 py-2 rounded-lg text-[12px] font-medium"
                style={{ background: 'var(--accent)', color: 'white' }}>
                Create First Page
              </button>
            )}
          </div>
        ) : (
          pages.map((entry) => {
            const config = TYPE_CONFIG[entry.type] || TYPE_CONFIG.fact!;
            const Icon = config.icon;
            const isDecision = entry.type === 'decision';
            const reversed = isDecision && isDecisionReversed(entry);
            const isBeingReversed = reversingId === entry.id;
            return (
              <div key={entry.id} className="w-full rounded-lg transition-colors"
                style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border-default)' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}>
                <button className="w-full text-left p-3" onClick={() => setSelectedSlug(entry.slug)}>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ background: `${config.color}20` }}>
                      <Icon size={14} style={{ color: config.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[13px] font-medium" style={{ color: reversed ? 'var(--text-tertiary)' : 'var(--text-primary)', textDecoration: reversed ? 'line-through' : 'none' }}>
                          {entry.title}
                        </span>
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                          style={{ background: `${config.color}20`, color: config.color }}>
                          {WIKI_TYPE_LABELS[entry.type]?.singular ?? config.label.replace(/s$/, '')}
                        </span>
                        <MemoryRouteBadge page={entry} />
                        {isDecision && (
                          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{
                              background: reversed ? '#EF444420' : '#22C55E20',
                              color: reversed ? '#EF4444' : '#22C55E',
                              border: `1px solid ${reversed ? '#EF444440' : '#22C55E40'}`,
                            }}>
                            {reversed ? 'Reversed' : 'Active'}
                          </span>
                        )}
                      </div>
                      {entry.summary && (
                        <p className="text-[12px] line-clamp-2 mb-1" style={{ color: 'var(--text-secondary)' }}>
                          {entry.summary}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        <ConfidenceBar value={entry.confidence} />
                        {entry.link_count > 0 && (
                          <span className="text-[11px] flex items-center gap-0.5" style={{ color: 'var(--text-tertiary)' }}>
                            <Link2 size={10} /> {entry.link_count} links
                          </span>
                        )}
                        {getMemoryProvenanceLabels(entry).length > 0 && (
                          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {getMemoryProvenanceLabels(entry).join(' / ')}
                          </span>
                        )}
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {formatRelative(entry.updated_at)}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
                {/* Decision reverse / re-activate actions */}
                {isDecision && (
                  <div className="px-3 pb-2.5 flex items-center gap-2">
                    {!reversed ? (
                      <button
                        onClick={() => reverseDecision(entry, true)}
                        disabled={isBeingReversed}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-40"
                        style={{ background: '#EF444415', color: '#EF4444', border: '1px solid #EF444430' }}>
                        {isBeingReversed ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                        Reverse
                      </button>
                    ) : (
                      <button
                        onClick={() => reverseDecision(entry, false)}
                        disabled={isBeingReversed}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-40"
                        style={{ background: '#22C55E15', color: '#22C55E', border: '1px solid #22C55E30' }}>
                        {isBeingReversed ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                        Re-activate
                      </button>
                    )}
                  </div>
                )}
              </div>
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

      </div>{/* /entries wrapper */}

      {/* Create Modal */}
      {showCreate && (
        <CreatePageModal onClose={() => setShowCreate(false)} onCreated={fetchPages} />
      )}
    </div>
  );
}
