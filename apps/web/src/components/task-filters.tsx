'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { ChevronDown, X, User, AlertTriangle, Calendar, FolderOpen, Bookmark, Save, SlidersHorizontal, CircleDashed, Tag } from 'lucide-react';
import { STATUS_LABELS, statusLabel } from '@/lib/task-status-labels';
import type { PriorityVocab, ResolvedStatus, CanonicalPriority } from '@/hooks/use-project-resolved-config';
import { priorityFullLabel } from '@/hooks/use-project-resolved-config';
import { AppBottomSheet } from '@/components/overlay-primitives';

export type Filters = {
  assigneeIds: string[];
  priorities: string[];
  status: string[];
  labels: string[];
  dueDate: 'overdue' | 'today' | 'this_week' | null;
  dateFrom: string | null;
  dateTo: string | null;
  projectId: string | null;
};

type Props = {
  filters: Filters;
  onChange: (filters: Filters) => void;
  projects?: { id: string; name: string; prefix: string; color: string | null }[];
  /** Task 4.9 — resolved skill config drives status chips + priority labels. */
  statuses?: ResolvedStatus[];
  priorityVocab?: PriorityVocab;
};

type Member = { id: string; name: string; email: string; avatar_url: string | null };
type Label = { id: string; name: string; color: string };
type SavedView = { id: string; name: string; config: any };

const PRIORITY_COLORS: Record<string, string> = {
  p0: '#DC2626',
  p1: '#F59E0B',
  p2: '#3B82F6',
  p3: '#6B7280',
};

const DEFAULT_STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map(value => ({
  value: value as string,
  label: statusLabel(value),
}));

const DUE_DATE_OPTIONS = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'this_week', label: 'This week' },
];

export function TaskFilters({ filters, onChange, projects, statuses, priorityVocab }: Props) {
  const { user } = useAuth();
  const PRIORITY_OPTIONS = (['p0', 'p1', 'p2', 'p3'] as CanonicalPriority[]).map((value) => ({
    value,
    label: priorityFullLabel(value, priorityVocab),
    color: PRIORITY_COLORS[value],
  }));
  const STATUS_OPTIONS = statuses && statuses.length > 0
    ? [...statuses].sort((a, b) => a.order - b.order).map((s) => ({ value: s.id, label: s.label }))
    : DEFAULT_STATUS_OPTIONS;
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [availableLabels, setAvailableLabels] = useState<Label[]>([]);
  const [labelSearch, setLabelSearch] = useState('');
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [saveViewName, setSaveViewName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Close any open dropdown on Escape so the fixed inset-0 backdrop is removed.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && openDropdown) {
        setOpenDropdown(null);
        setMemberSearch('');
        setLabelSearch('');
        setShowSaveInput(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openDropdown]);

  useEffect(() => {
    api.get('/api/members').then(async res => {
      if (res.ok) setMembers(await res.json());
    }).catch(() => {});
    api.get('/api/tasks/labels').then(async res => {
      if (res.ok) setAvailableLabels(await res.json());
    }).catch(() => {});
    api.get('/api/tasks/saved-views').then(async res => {
      if (res.ok) setSavedViews(await res.json());
    }).catch(() => {});
  }, []);

  const handleSaveView = async () => {
    if (!saveViewName.trim()) return;
    const res = await api.post('/api/tasks/saved-views', { name: saveViewName.trim(), config: filters });
    if (res.ok) {
      const view = await res.json();
      setSavedViews(prev => [view, ...prev]);
      setSaveViewName('');
      setShowSaveInput(false);
    }
  };

  const handleLoadView = (view: SavedView) => {
    onChange(view.config as Filters);
    setOpenDropdown(null);
  };

  const handleDeleteView = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = await api.delete(`/api/tasks/saved-views/${id}`);
    if (res.ok) {
      setSavedViews(prev => prev.filter(v => v.id !== id));
    }
  };

  const hasActive =
    filters.assigneeIds.length > 0 ||
    filters.priorities.length > 0 ||
    filters.status.length > 0 ||
    filters.labels.length > 0 ||
    filters.dueDate !== null ||
    filters.dateFrom !== null ||
    filters.dateTo !== null ||
    filters.projectId !== null;

  const activeFilterCount =
    filters.assigneeIds.length +
    filters.priorities.length +
    filters.status.length +
    filters.labels.length +
    (filters.dueDate ? 1 : 0) +
    (filters.dateFrom || filters.dateTo ? 1 : 0) +
    (filters.projectId ? 1 : 0);

  const clearAll = () => {
    onChange({ assigneeIds: [], priorities: [], status: [], labels: [], dueDate: null, dateFrom: null, dateTo: null, projectId: null });
  };

  const togglePriority = (p: string) => {
    const next = filters.priorities.includes(p)
      ? filters.priorities.filter((x) => x !== p)
      : [...filters.priorities, p];
    onChange({ ...filters, priorities: next });
  };

  const toggleStatus = (s: string) => {
    const next = filters.status.includes(s)
      ? filters.status.filter((x) => x !== s)
      : [...filters.status, s];
    onChange({ ...filters, status: next });
  };

  const toggleAssignee = (id: string) => {
    const next = filters.assigneeIds.includes(id)
      ? filters.assigneeIds.filter(x => x !== id)
      : [...filters.assigneeIds, id];
    onChange({ ...filters, assigneeIds: next });
  };

  const toggleLabel = (id: string) => {
    const next = filters.labels.includes(id)
      ? filters.labels.filter(x => x !== id)
      : [...filters.labels, id];
    onChange({ ...filters, labels: next });
  };

  const filteredMembers = members.filter(m =>
    m.name.toLowerCase().includes(memberSearch.toLowerCase()) ||
    m.email.toLowerCase().includes(memberSearch.toLowerCase())
  );

  const filteredLabels = availableLabels.filter(l =>
    l.name.toLowerCase().includes(labelSearch.toLowerCase())
  );

  // Mobile: single "Filters" button with stacked dropdown
  const mobileFilterBar = (
    <>
      <div
        className="flex items-center gap-2 px-4 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'mobile-filters' ? null : 'mobile-filters')}
            className="deft-pill min-h-[38px]"
            style={{
              background: activeFilterCount > 0 ? 'var(--accent-subtle)' : 'transparent',
              color: activeFilterCount > 0 ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${activeFilterCount > 0 ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <SlidersHorizontal size={12} />
            {activeFilterCount > 0 ? `Filters (${activeFilterCount})` : 'Filters'}
            <ChevronDown size={11} />
          </button>
          <AppBottomSheet
            open={openDropdown === 'mobile-filters'}
            onClose={() => { setOpenDropdown(null); setMemberSearch(''); setLabelSearch(''); setShowSaveInput(false); }}
            title={`Task filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}`}
          >
            <div className="pb-2">
              {/* Assignee section */}
              <div className="px-3 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Assignee</p>
                <button
                  onClick={() => { if (user) toggleAssignee(user.id); }}
                  className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[12px] font-medium rounded-md"
                  style={{
                    color: user && filters.assigneeIds.includes(user.id) ? 'var(--accent)' : 'var(--foreground)',
                    fontFamily: 'var(--font-body)',
                    background: user && filters.assigneeIds.includes(user.id) ? 'var(--accent-subtle)' : 'transparent',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = user && filters.assigneeIds.includes(user.id) ? 'var(--accent-subtle)' : 'transparent')}
                >
                  <User size={12} />
                  My tasks
                </button>
                {members.map(m => (
                  <button
                    key={m.id}
                    onClick={() => toggleAssignee(m.id)}
                    className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[12px] rounded-md"
                    style={{
                      color: filters.assigneeIds.includes(m.id) ? 'var(--accent)' : 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                      background: filters.assigneeIds.includes(m.id) ? 'var(--accent-subtle)' : 'transparent',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = filters.assigneeIds.includes(m.id) ? 'var(--accent-subtle)' : 'transparent')}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                      style={{
                        borderColor: filters.assigneeIds.includes(m.id) ? 'var(--accent)' : 'var(--border)',
                        background: filters.assigneeIds.includes(m.id) ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {filters.assigneeIds.includes(m.id) && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    {m.name}
                  </button>
                ))}
              </div>

              <div style={{ borderTop: '1px solid var(--border)' }} className="my-1" />

              {/* Priority section */}
              <div className="px-3 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Priority</p>
                {PRIORITY_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => togglePriority(opt.value)}
                    className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[12px] rounded-md"
                    style={{
                      color: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                      background: filters.priorities.includes(opt.value) ? 'var(--accent-subtle)' : 'transparent',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = filters.priorities.includes(opt.value) ? 'var(--accent-subtle)' : 'transparent')}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                      style={{
                        borderColor: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'var(--border)',
                        background: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {filters.priorities.includes(opt.value) && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: opt.color }} />
                    {opt.label}
                  </button>
                ))}
              </div>

              <div style={{ borderTop: '1px solid var(--border)' }} className="my-1" />

              {/* Status section */}
              <div className="px-3 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Status</p>
                {STATUS_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => toggleStatus(opt.value)}
                    className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[12px] rounded-md"
                    style={{
                      color: filters.status.includes(opt.value) ? 'var(--accent)' : 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                      background: filters.status.includes(opt.value) ? 'var(--accent-subtle)' : 'transparent',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = filters.status.includes(opt.value) ? 'var(--accent-subtle)' : 'transparent')}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                      style={{
                        borderColor: filters.status.includes(opt.value) ? 'var(--accent)' : 'var(--border)',
                        background: filters.status.includes(opt.value) ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {filters.status.includes(opt.value) && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    {opt.label}
                  </button>
                ))}
              </div>

              <div style={{ borderTop: '1px solid var(--border)' }} className="my-1" />

              {/* Labels section */}
              {availableLabels.length > 0 && (
                <>
                  <div className="px-3 py-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Labels</p>
                    <div className="max-h-32 overflow-y-auto">
                      {availableLabels.map(l => (
                        <button
                          key={l.id}
                          onClick={() => toggleLabel(l.id)}
                          className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[12px] rounded-md"
                          style={{
                            color: filters.labels.includes(l.id) ? 'var(--accent)' : 'var(--foreground)',
                            fontFamily: 'var(--font-body)',
                            background: filters.labels.includes(l.id) ? 'var(--accent-subtle)' : 'transparent',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = filters.labels.includes(l.id) ? 'var(--accent-subtle)' : 'transparent')}
                        >
                          <div
                            className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                            style={{
                              borderColor: filters.labels.includes(l.id) ? 'var(--accent)' : 'var(--border)',
                              background: filters.labels.includes(l.id) ? 'var(--accent)' : 'transparent',
                            }}
                          >
                            {filters.labels.includes(l.id) && (
                              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </div>
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: l.color }} />
                          <span className="truncate">{l.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ borderTop: '1px solid var(--border)' }} className="my-1" />
                </>
              )}

              {/* Due date section */}
              <div className="px-3 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Due date</p>
                {DUE_DATE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      onChange({ ...filters, dueDate: filters.dueDate === opt.value ? null : opt.value as Filters['dueDate'], dateFrom: null, dateTo: null });
                    }}
                    className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[12px] rounded-md"
                    style={{
                      color: filters.dueDate === opt.value ? 'var(--accent)' : 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                      background: filters.dueDate === opt.value ? 'var(--accent-subtle)' : 'transparent',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = filters.dueDate === opt.value ? 'var(--accent-subtle)' : 'transparent')}
                  >
                    {opt.label}
                  </button>
                ))}
                {/* Custom date range (mobile) */}
                <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                  <p className="text-[10px] font-medium mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Custom range</p>
                  <div className="flex gap-1.5">
                    <input
                      type="date"
                      value={filters.dateFrom || ''}
                      onChange={e => onChange({ ...filters, dateFrom: e.target.value || null, dueDate: null })}
                      className="flex-1 px-1.5 py-1 text-[11px] rounded outline-none"
                      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                    />
                    <input
                      type="date"
                      value={filters.dateTo || ''}
                      onChange={e => onChange({ ...filters, dateTo: e.target.value || null, dueDate: null })}
                      className="flex-1 px-1.5 py-1 text-[11px] rounded outline-none"
                      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border)' }} className="my-1" />

              {/* Saved views (mobile) */}
              <div className="px-3 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Saved views</p>
                {savedViews.map(v => (
                  <div
                    key={v.id}
                    className="flex items-center px-2 py-1.5 text-[12px] rounded-md"
                    style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <button onClick={() => handleLoadView(v)} className="flex-1 text-left truncate flex items-center gap-2">
                      <Bookmark size={12} />
                      {v.name}
                    </button>
                    <button onClick={(e) => handleDeleteView(v.id, e)} className="ml-1 p-0.5" style={{ color: 'var(--muted)' }}>
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {hasActive && (
                  <div className="mt-1">
                    {showSaveInput ? (
                      <div className="flex gap-1">
                        <input
                          value={saveViewName}
                          onChange={e => setSaveViewName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveView(); }}
                          placeholder="View name..."
                          className="flex-1 px-2 py-1 text-[11px] rounded outline-none"
                          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                          autoFocus
                        />
                        <button onClick={handleSaveView} className="p-1" style={{ color: 'var(--accent)' }}>
                          <Save size={12} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setShowSaveInput(true)}
                        className="w-full text-left px-2 py-1.5 text-[11px] font-medium rounded-md"
                        style={{ color: 'var(--accent)', fontFamily: 'var(--font-heading)' }}
                      >
                        + Save current filters
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </AppBottomSheet>
        </div>

        {activeFilterCount > 0 && (
          <button
            onClick={clearAll}
            className="text-[11px] font-medium px-2 py-0.5 rounded-md"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)', transition: 'color 150ms' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
          >
            Clear
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      {isMobile ? mobileFilterBar : (
      <>
      {openDropdown && <div className="fixed inset-0 z-10" onClick={() => { setOpenDropdown(null); setMemberSearch(''); setLabelSearch(''); setShowSaveInput(false); }} />}

      {/* Fix 5: position: relative + z-index: 20 ensures filter buttons sit above
          the fixed z-10 backdrop, so clicking Assignee/Status after Priority
          dropdown is open goes directly to the new dropdown without a double-click. */}
      <div
        className="flex items-center gap-2 px-6 py-2 flex-shrink-0 flex-wrap relative z-20"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {/* Assignee dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'assignee' ? null : 'assignee')}
            className="deft-pill min-h-[38px] md:min-h-[30px]"
            style={{
              background: filters.assigneeIds.length > 0 ? 'var(--accent-subtle)' : 'transparent',
              color: filters.assigneeIds.length > 0 ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${filters.assigneeIds.length > 0 ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <User size={12} />
            Assignee
            {filters.assigneeIds.length > 0 && (
              <span className="text-[10px] px-1 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                {filters.assigneeIds.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'assignee' && (
            <div
              className="absolute top-full left-0 mt-1 w-56 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {/* Quick: My tasks */}
              <button
                onClick={() => {
                  if (user) toggleAssignee(user.id);
                }}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px] font-medium"
                style={{
                  color: user && filters.assigneeIds.includes(user.id) ? 'var(--accent)' : 'var(--foreground)',
                  fontFamily: 'var(--font-body)',
                  borderBottom: '1px solid var(--border)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <User size={12} />
                My tasks
              </button>
              {/* Search */}
              <div className="px-2 py-1.5">
                <input
                  value={memberSearch}
                  onChange={e => setMemberSearch(e.target.value)}
                  placeholder="Search members..."
                  className="w-full px-2 py-1 text-[12px] rounded outline-none"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                  autoFocus
                />
              </div>
              <div className="max-h-40 overflow-y-auto">
                {filteredMembers.map(m => (
                  <button
                    key={m.id}
                    onClick={() => toggleAssignee(m.id)}
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                    style={{
                      color: filters.assigneeIds.includes(m.id) ? 'var(--accent)' : 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div
                      className="w-3.5 h-3.5 rounded border flex items-center justify-center"
                      style={{
                        borderColor: filters.assigneeIds.includes(m.id) ? 'var(--accent)' : 'var(--border)',
                        background: filters.assigneeIds.includes(m.id) ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {filters.assigneeIds.includes(m.id) && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Priority dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'priority' ? null : 'priority')}
            className="deft-pill min-h-[38px] md:min-h-[30px]"
            style={{
              background: filters.priorities.length > 0 ? 'var(--accent-subtle)' : 'transparent',
              color: filters.priorities.length > 0 ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${filters.priorities.length > 0 ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <AlertTriangle size={12} />
            Priority
            {filters.priorities.length > 0 && (
              <span className="text-[10px] px-1 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                {filters.priorities.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'priority' && (
            <div
              className="absolute top-full left-0 mt-1 w-48 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => togglePriority(opt.value)}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                  style={{
                    color: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'var(--foreground)',
                    fontFamily: 'var(--font-body)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div
                    className="w-3.5 h-3.5 rounded border flex items-center justify-center"
                    style={{
                      borderColor: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'var(--border)',
                      background: filters.priorities.includes(opt.value) ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {filters.priorities.includes(opt.value) && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                        <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <div className="w-2 h-2 rounded-full" style={{ background: opt.color }} />
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Status dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'status' ? null : 'status')}
            className="deft-pill min-h-[38px] md:min-h-[30px]"
            style={{
              background: filters.status.length > 0 ? 'var(--accent-subtle)' : 'transparent',
              color: filters.status.length > 0 ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${filters.status.length > 0 ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <CircleDashed size={12} />
            Status
            {filters.status.length > 0 && (
              <span className="text-[10px] px-1 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                {filters.status.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'status' && (
            <div
              className="absolute top-full left-0 mt-1 w-48 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => toggleStatus(opt.value)}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                  style={{
                    color: filters.status.includes(opt.value) ? 'var(--accent)' : 'var(--foreground)',
                    fontFamily: 'var(--font-body)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div
                    className="w-3.5 h-3.5 rounded border flex items-center justify-center"
                    style={{
                      borderColor: filters.status.includes(opt.value) ? 'var(--accent)' : 'var(--border)',
                      background: filters.status.includes(opt.value) ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {filters.status.includes(opt.value) && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                        <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Labels dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'labels' ? null : 'labels')}
            className="deft-pill min-h-[38px] md:min-h-[30px]"
            style={{
              background: filters.labels.length > 0 ? 'var(--accent-subtle)' : 'transparent',
              color: filters.labels.length > 0 ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${filters.labels.length > 0 ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <Tag size={12} />
            Labels
            {filters.labels.length > 0 && (
              <span className="text-[10px] px-1 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                {filters.labels.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'labels' && (
            <div
              className="absolute top-full left-0 mt-1 w-56 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {availableLabels.length > 0 ? (
                <>
                  <div className="px-2 py-1.5">
                    <input
                      value={labelSearch}
                      onChange={e => setLabelSearch(e.target.value)}
                      placeholder="Search labels..."
                      className="w-full px-2 py-1 text-[12px] rounded outline-none"
                      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                      autoFocus
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {filteredLabels.length === 0 ? (
                      <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                        No labels match
                      </div>
                    ) : (
                      filteredLabels.map(l => (
                        <button
                          key={l.id}
                          onClick={() => toggleLabel(l.id)}
                          className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                          style={{
                            color: filters.labels.includes(l.id) ? 'var(--accent)' : 'var(--foreground)',
                            fontFamily: 'var(--font-body)',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          <div
                            className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
                            style={{
                              borderColor: filters.labels.includes(l.id) ? 'var(--accent)' : 'var(--border)',
                              background: filters.labels.includes(l.id) ? 'var(--accent)' : 'transparent',
                            }}
                          >
                            {filters.labels.includes(l.id) && (
                              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                <path d="M1 4L3 6L7 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </div>
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: l.color }} />
                          <span className="truncate">{l.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                  No labels yet. Create one from a task.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Project dropdown */}
        {projects && projects.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setOpenDropdown(openDropdown === 'project' ? null : 'project')}
              className="deft-pill min-h-[38px] md:min-h-[30px]"
              style={{
                background: filters.projectId ? 'var(--accent-subtle)' : 'transparent',
                color: filters.projectId ? 'var(--accent)' : 'var(--foreground-secondary)',
                border: `1px solid ${filters.projectId ? 'var(--accent)' : 'var(--border)'}`,
                fontFamily: 'var(--font-heading)',
                transition: 'all 150ms',
              }}
            >
              <FolderOpen size={12} />
              Project
              <ChevronDown size={11} />
            </button>
            {openDropdown === 'project' && (
              <div
                className="absolute top-full left-0 mt-1 w-48 rounded-lg py-1 z-20"
                style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
              >
                <button
                  onClick={() => { onChange({ ...filters, projectId: null }); setOpenDropdown(null); }}
                  className="w-full text-left px-3 py-1.5 text-[12px]"
                  style={{ color: !filters.projectId ? 'var(--accent)' : 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  All projects
                </button>
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => { onChange({ ...filters, projectId: p.id }); setOpenDropdown(null); }}
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                    style={{
                      color: filters.projectId === p.id ? 'var(--accent)' : 'var(--foreground)',
                      fontFamily: 'var(--font-body)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div className="w-2 h-2 rounded-full" style={{ background: p.color || 'var(--accent)' }} />
                    {p.prefix || p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Due date dropdown */}
        <div className="relative">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'dueDate' ? null : 'dueDate')}
            className="deft-pill min-h-[38px] md:min-h-[30px]"
            style={{
              background: (filters.dueDate || filters.dateFrom) ? 'var(--accent-subtle)' : 'transparent',
              color: (filters.dueDate || filters.dateFrom) ? 'var(--accent)' : 'var(--foreground-secondary)',
              border: `1px solid ${(filters.dueDate || filters.dateFrom) ? 'var(--accent)' : 'var(--border)'}`,
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <Calendar size={12} />
            {filters.dueDate ? DUE_DATE_OPTIONS.find((d) => d.value === filters.dueDate)?.label : 'Due date'}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'dueDate' && (
            <div
              className="absolute top-full left-0 mt-1 w-52 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
            >
              {DUE_DATE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    onChange({ ...filters, dueDate: filters.dueDate === opt.value ? null : opt.value as Filters['dueDate'], dateFrom: null, dateTo: null });
                    setOpenDropdown(null);
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px]"
                  style={{
                    color: filters.dueDate === opt.value ? 'var(--accent)' : 'var(--foreground)',
                    fontFamily: 'var(--font-body)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {opt.label}
                </button>
              ))}
              {/* Custom date range */}
              <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border)' }}>
                <p className="text-[10px] font-medium mb-1.5" style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}>Custom range</p>
                <div className="flex gap-1.5">
                  <input
                    type="date"
                    value={filters.dateFrom || ''}
                    onChange={e => onChange({ ...filters, dateFrom: e.target.value || null, dueDate: null })}
                    className="flex-1 px-1.5 py-1 text-[11px] rounded outline-none"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                  />
                  <input
                    type="date"
                    value={filters.dateTo || ''}
                    onChange={e => onChange({ ...filters, dateTo: e.target.value || null, dueDate: null })}
                    className="flex-1 px-1.5 py-1 text-[11px] rounded outline-none"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Active filter pills */}
        {filters.assigneeIds.length > 0 &&
          filters.assigneeIds.map(id => {
            const m = members.find(x => x.id === id);
            return (
              <div
                key={id}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                {m?.name || 'Unknown'}
                <button onClick={() => toggleAssignee(id)} style={{ color: 'var(--muted)' }} className="ml-0.5">
                  <X size={10} />
                </button>
              </div>
            );
          })}

        {filters.priorities.length > 0 &&
          filters.priorities.map((p) => {
            const opt = PRIORITY_OPTIONS.find((o) => o.value === p);
            return (
              <div
                key={p}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: opt?.color }} />
                {opt?.label.split(' ')[0]}
                <button onClick={() => togglePriority(p)} style={{ color: 'var(--muted)' }} className="ml-0.5">
                  <X size={10} />
                </button>
              </div>
            );
          })}

        {filters.status.length > 0 &&
          filters.status.map((s) => (
            <div
              key={s}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
              style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
            >
              {statusLabel(s)}
              <button onClick={() => toggleStatus(s)} style={{ color: 'var(--muted)' }} className="ml-0.5">
                <X size={10} />
              </button>
            </div>
          ))}

        {filters.labels.length > 0 &&
          filters.labels.map((id) => {
            const l = availableLabels.find(x => x.id === id);
            return (
              <div
                key={id}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
              >
                <div className="w-1.5 h-1.5 rounded-full" style={{ background: l?.color || 'var(--muted)' }} />
                {l?.name || 'Label'}
                <button onClick={() => toggleLabel(id)} style={{ color: 'var(--muted)' }} className="ml-0.5">
                  <X size={10} />
                </button>
              </div>
            );
          })}

        {filters.projectId && projects && (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
            style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}>
            {projects.find(p => p.id === filters.projectId)?.prefix || 'Project'}
            <button onClick={() => onChange({ ...filters, projectId: null })} style={{ color: 'var(--muted)' }} className="ml-0.5">
              <X size={10} />
            </button>
          </div>
        )}

        {filters.dueDate && (
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
            style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}
          >
            {DUE_DATE_OPTIONS.find((d) => d.value === filters.dueDate)?.label}
            <button onClick={() => onChange({ ...filters, dueDate: null })} style={{ color: 'var(--muted)' }} className="ml-0.5">
              <X size={10} />
            </button>
          </div>
        )}

        {(filters.dateFrom || filters.dateTo) && (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
            style={{ background: 'var(--hover-tint)', color: 'var(--foreground-secondary)', fontFamily: 'var(--font-body)' }}>
            {filters.dateFrom || '...'} — {filters.dateTo || '...'}
            <button onClick={() => onChange({ ...filters, dateFrom: null, dateTo: null })} style={{ color: 'var(--muted)' }} className="ml-0.5">
              <X size={10} />
            </button>
          </div>
        )}

        {/* Saved views */}
        <div className="relative ml-auto">
          <button
            onClick={() => setOpenDropdown(openDropdown === 'views' ? null : 'views')}
            className="deft-pill min-h-[38px] md:min-h-[30px]"
            style={{
              background: 'transparent',
              color: 'var(--foreground-secondary)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-heading)',
              transition: 'all 150ms',
            }}
          >
            <Bookmark size={12} />
            Views
            {savedViews.length > 0 && (
              <span className="text-[10px] px-1 rounded-full" style={{ background: 'var(--muted)', color: 'white' }}>
                {savedViews.length}
              </span>
            )}
            <ChevronDown size={11} />
          </button>
          {openDropdown === 'views' && (
            <div className="absolute right-0 top-full mt-1 w-64 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
              {savedViews.length === 0 ? (
                <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                  No saved views yet.
                </div>
              ) : (
                savedViews.map(v => (
                  <div key={v.id} className="flex items-center px-3 py-1.5 text-[12px]"
                    style={{ color: 'var(--foreground)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-tint)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <button onClick={() => handleLoadView(v)} className="flex-1 text-left truncate">
                      {v.name}
                    </button>
                    <button onClick={(e) => handleDeleteView(v.id, e)} className="ml-1 p-0.5" style={{ color: 'var(--muted)' }}>
                      <X size={10} />
                    </button>
                  </div>
                ))
              )}
              {/* Save current */}
              <div className="px-3 py-2" style={{ borderTop: '1px solid var(--border)' }}>
                {hasActive ? (
                  showSaveInput ? (
                    <div className="flex gap-1">
                      <input
                        value={saveViewName}
                        onChange={e => setSaveViewName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleSaveView(); }}
                        placeholder="Save current filter set as..."
                        className="flex-1 px-2 py-1 text-[11px] rounded outline-none"
                        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
                        autoFocus
                      />
                      <button onClick={handleSaveView} className="p-1" style={{ color: 'var(--accent)' }}>
                        <Save size={12} />
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setShowSaveInput(true)}
                      className="text-[11px] font-medium" style={{ color: 'var(--accent)', fontFamily: 'var(--font-heading)' }}>
                      + Save current filter set as...
                    </button>
                  )
                ) : (
                  <p className="text-[11px]" style={{ color: 'var(--muted)', fontFamily: 'var(--font-body)' }}>
                    Apply a filter to save a view.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Clear all */}
        {hasActive && (
          <button
            onClick={clearAll}
            className="text-[11px] font-medium px-2 py-0.5 rounded-md ml-1"
            style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)', transition: 'color 150ms' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
          >
            Clear all
          </button>
        )}
      </div>
      </>
      )}
    </>
  );
}
