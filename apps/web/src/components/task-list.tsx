'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { ChevronDown, ChevronUp, ArrowUpDown, Check, Loader2, Tags } from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';
import { TaskCardUnified } from './task-card-unified';
import type { ResolvedStatus, PriorityVocab } from '@/hooks/use-project-resolved-config';
import { priorityLabel } from '@/hooks/use-project-resolved-config';
import { PersonAvatar } from './person-avatar';
import {
  isTaskTableColumnVisible,
  taskTableColumnConfig,
  TASK_TABLE_COLUMNS,
  type TaskTableColumnId,
  type TaskViewConfigV1,
} from '@/lib/task-view-config';

type Task = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  // Resolved-config driven; wide string (e.g. 'lead' / 'qualified' for Sales).
  status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  created_by: string;
  creator_name: string | null;
  due_date: string | null;
  start_date: string | null;
  sort_order: number;
  source_message_id: string | null;
  is_deleted: boolean;
  project_id: string;
  project_prefix: string;
  project_name: string;
  project_color: string | null;
  labels: { id: string; name: string; color: string }[];
  parent_task_id: string | null;
  subtask_count: number;
  subtask_done_count: number;
  estimation?: string | null;
  created_at: string;
  updated_at: string;
};

type Props = {
  tasks: Task[];
  projectPrefix: string;
  onTaskClick: (task: Task) => void;
  onTaskPatch: (taskId: string, patch: TaskPatch) => Promise<boolean>;
  members: { id: string; name: string; avatar_url: string | null }[];
  availableLabels: { id: string; name: string; color: string }[];
  selectedTaskId: string | null;
  selectionMode?: boolean;
  selectedTaskIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  /** Task 4.9 — resolved skill config drives status dropdown + prefix + priority labels. */
  statuses?: ResolvedStatus[];
  hidePrefixIds?: boolean;
  priorityVocab?: PriorityVocab;
  viewConfig: TaskViewConfigV1;
  onViewConfigChange: (config: TaskViewConfigV1) => void;
  onInlineCreate?: (title: string, defaults: TaskPatch) => Promise<boolean>;
};

type TaskPatch = Partial<Pick<Task, 'title' | 'status' | 'priority' | 'assignee_id' | 'due_date' | 'start_date' | 'estimation'>> & {
  label_ids?: string[];
};

type SortField = 'number' | 'title' | 'status' | 'priority' | 'assignee' | 'start_date' | 'due_date' | 'estimation' | 'labels' | 'updated_at';
type SortDir = 'asc' | 'desc';
type GroupField = 'status' | 'priority' | 'assignee' | 'due_date' | 'project' | 'labels';

const DEFAULT_STATUS_OPTIONS = [
  { value: 'backlog', label: statusLabel('backlog'), color: '#6b7280' },
  { value: 'todo', label: statusLabel('todo'), color: '#3b82f6' },
  { value: 'in_progress', label: statusLabel('in_progress'), color: '#f59e0b' },
  { value: 'in_review', label: statusLabel('in_review'), color: '#8b5cf6' },
  { value: 'done', label: statusLabel('done'), color: '#10b981' },
  { value: 'cancelled', label: statusLabel('cancelled'), color: '#ef4444' },
];

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--muted)',
  todo: 'var(--foreground-secondary)',
  in_progress: 'var(--accent)',
  in_review: '#8B5CF6',
  done: 'var(--success)',
  cancelled: 'var(--danger)',
};

const PRIORITY_ORDER = { p0: 0, p1: 1, p2: 2, p3: 3 };
const PAGE_SIZE = 50;
const PRIORITY_STYLES: Record<string, { bg: string; color: string }> = {
  p0: { bg: 'rgba(220, 38, 38, 0.15)', color: '#DC2626' },
  p1: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' },
  p2: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6' },
  p3: { bg: 'rgba(107, 114, 128, 0.15)', color: '#6B7280' },
};

function formatDueDate(dateStr: string | null, status?: string): { text: string; color: string; badge?: string; badgeBg?: string } | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((due.getTime() - today.getTime()) / 86400000);

  const isDone = status === 'done' || status === 'cancelled';
  const sameYear = date.getFullYear() === now.getFullYear();
  const dateText = sameYear
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  if (isDone) {
    return { text: dateText, color: 'var(--muted)' };
  }

  if (diffDays < 0) {
    return { text: dateText, color: 'var(--danger)', badge: 'Overdue', badgeBg: 'rgba(220, 38, 38, 0.12)' };
  }
  if (diffDays === 0) {
    return { text: 'Due today', color: '#F59E0B', badge: 'Due today', badgeBg: 'rgba(245, 158, 11, 0.12)' };
  }
  if (diffDays === 1) {
    return { text: 'Due tomorrow', color: 'var(--foreground-secondary)' };
  }
  return { text: dateText, color: 'var(--foreground-secondary)' };
}

function dateInputValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function sortValue(task: Task, field: SortField): string | number {
  switch (field) {
    case 'number': return task.number;
    case 'title': return task.title;
    case 'status': return task.status;
    case 'priority': return PRIORITY_ORDER[task.priority];
    case 'assignee': return task.assignee_name || '';
    case 'start_date': return task.start_date || '';
    case 'due_date': return task.due_date || '';
    case 'estimation': return task.estimation || '';
    case 'labels': return task.labels.map((label) => label.name).join(',');
    case 'updated_at': return task.updated_at;
  }
}

function dueBucket(value: string | null): string {
  if (!value) return 'No due date';
  const due = new Date(value);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) return 'Overdue';
  if (days === 0) return 'Today';
  if (days <= 7) return 'Next 7 days';
  return 'Later';
}

function taskGroup(task: Task, field: string): string {
  switch (field as GroupField) {
    case 'status': return statusLabel(task.status);
    case 'priority': return task.priority.toUpperCase();
    case 'assignee': return task.assignee_name || 'Unassigned';
    case 'due_date': return dueBucket(task.due_date);
    case 'project': return task.project_name;
    case 'labels': return task.labels[0]?.name || 'No labels';
    default: return '';
  }
}

export function TaskTable({ tasks, projectPrefix, onTaskClick, onTaskPatch, members, availableLabels, selectedTaskId, selectionMode, selectedTaskIds, onToggleSelect, statuses, hidePrefixIds, priorityVocab, viewConfig, onViewConfigChange, onInlineCreate }: Props) {
  const STATUS_OPTIONS = useMemo(() => {
    if (!statuses || statuses.length === 0) return DEFAULT_STATUS_OPTIONS;
    return [...statuses]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ value: s.id, label: s.label, color: s.color }));
  }, [statuses]);

  const statusColorFor = (id: string): string =>
    STATUS_OPTIONS.find((s) => s.value === id)?.color || STATUS_COLORS[id] || 'var(--muted)';
  const configuredSorts = viewConfig.sort.filter((clause): clause is typeof clause & { field: SortField } =>
    TASK_TABLE_COLUMNS.some((column) => column.id === clause.field));
  const primarySort = configuredSorts[0] ?? { field: 'number' as SortField, direction: 'desc' as SortDir, nulls: 'last' as const };
  const [inlineDropdown, setInlineDropdown] = useState<{ taskId: string; field: string } | null>(null);
  const [editingTitle, setEditingTitle] = useState<{ taskId: string; value: string } | null>(null);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [newTask, setNewTask] = useState<{ key: string; title: string } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  // Fix 3: client-side pagination — show 50 rows at a time
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleSort = (field: SortField, additive = false) => {
    setVisibleCount(PAGE_SIZE);
    const existing = configuredSorts.find((clause) => clause.field === field);
    const next = { field, direction: existing?.direction === 'asc' ? 'desc' as const : 'asc' as const, nulls: 'last' as const };
    const sort = additive
      ? [...configuredSorts.filter((clause) => clause.field !== field), next].slice(-3)
      : [next];
    onViewConfigChange({
      ...viewConfig,
      sort,
    });
  };

  const sorted = [...tasks].sort((a, b) => {
      const groupField = viewConfig.groupBy?.field;
      if (groupField) {
        const groupComparison = taskGroup(a, groupField).localeCompare(taskGroup(b, groupField));
        if (groupComparison) return viewConfig.groupBy?.direction === 'desc' ? -groupComparison : groupComparison;
      }
      for (const clause of configuredSorts.length ? configuredSorts : [primarySort]) {
        const left = sortValue(a, clause.field);
        const right = sortValue(b, clause.field);
        const cmp = typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
        if (cmp) return clause.direction === 'desc' ? -cmp : cmp;
      }
      return a.id.localeCompare(b.id);
    });

  // Fix 3: page-sliced rows
  const visibleRows = sorted.slice(0, visibleCount);

  const SortIcon = ({ field }: { field: SortField }) => {
    const index = configuredSorts.findIndex((clause) => clause.field === field);
    if (index < 0) return <ArrowUpDown size={11} style={{ opacity: 0.3 }} />;
    return <span className="flex items-center gap-0.5">{configuredSorts[index]?.direction === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />}{configuredSorts.length > 1 && <span>{index + 1}</span>}</span>;
  };

  const columns = TASK_TABLE_COLUMNS
    .filter((column) => isTaskTableColumnVisible(viewConfig, column.id))
    .map((column) => {
      const saved = taskTableColumnConfig(viewConfig, column.id);
      return { ...column, ...saved, width: saved.width ?? column.width };
    })
    .sort((a, b) => a.position - b.position);
  const columnVisible = (id: TaskTableColumnId) => isTaskTableColumnVisible(viewConfig, id);
  const rowPadding = viewConfig.density === 'compact' ? 'py-1.5' : 'py-2.5';

  const save = async (taskId: string, field: string, patch: TaskPatch) => {
    const key = `${taskId}:${field}`;
    // ponytail: serialize table writes for v1; per-cell concurrency can wait until users need it.
    if (savingCell) return false;
    setSavingCell(key);
    const ok = await onTaskPatch(taskId, patch);
    setSavingCell(null);
    return ok;
  };

  const inlineCreateRow = (key: string, defaults: TaskPatch = {}) => !onInlineCreate ? null : (
    <tr key={`create:${key}`}>
      <td colSpan={columns.length + (selectionMode ? 1 : 0)} className="px-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
        <input
          value={newTask?.key === key ? newTask.title : ''}
          onFocus={() => setNewTask((current) => current?.key === key ? current : { key, title: '' })}
          onChange={(event) => setNewTask({ key, title: event.target.value })}
          onKeyDown={async (event) => {
            if (event.key === 'Escape') setNewTask(null);
            if (event.key === 'Enter' && newTask?.title.trim()) {
              event.preventDefault();
              if (await onInlineCreate(newTask.title.trim(), defaults)) setNewTask(null);
            }
          }}
          placeholder="+ Add task"
          aria-label={`Add task${key === 'all' ? '' : ` to ${key}`}`}
          className="w-full bg-transparent px-1 py-1 text-[12px] outline-none"
          style={{ color: 'var(--foreground)' }}
        />
      </td>
    </tr>
  );

  if (isMobile) {
    return (
      <div className="h-full overflow-auto px-4 py-2 space-y-2">
        {sorted.length === 0 && (
          <div className="flex items-center justify-center py-16" style={{ color: 'var(--muted)' }}>
            <p className="text-[14px]" style={{ fontFamily: 'var(--font-body)' }}>No tasks match the current filters</p>
          </div>
        )}
        {visibleRows.map((task) => {
          const isSelected = task.id === selectedTaskId;
          const isChecked = selectionMode && selectedTaskIds?.has(task.id);
          return (
            <div key={task.id} className="overflow-hidden rounded-lg" style={{ border: '1px solid var(--border)', background: 'var(--card-bg)' }}>
              <TaskCardUnified
                variant="list"
                task={task as any}
                projectPrefix={projectPrefix}
                onClick={() => onTaskClick(task)}
                isSelected={isSelected}
                selectionMode={selectionMode}
                isChecked={isChecked}
                onToggleSelect={onToggleSelect}
                hidePrefixIds={hidePrefixIds}
              />
              <div className="grid grid-cols-3 gap-1 px-3 pb-3" onClick={(event) => event.stopPropagation()}>
                <select
                  aria-label={`Status for ${task.title}`}
                  value={task.status}
                  disabled={savingCell !== null}
                  onChange={(event) => void save(task.id, 'status', { status: event.target.value })}
                  className="task-table-select min-w-0 rounded-md px-2 py-1.5 text-[11px]"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
                >
                  {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <select
                  aria-label={`Priority for ${task.title}`}
                  value={task.priority}
                  disabled={savingCell !== null}
                  onChange={(event) => void save(task.id, 'priority', { priority: event.target.value as Task['priority'] })}
                  className="task-table-select min-w-0 rounded-md px-2 py-1.5 text-[11px]"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)' }}
                >
                  {(['p0', 'p1', 'p2', 'p3'] as const).map((priority) => <option key={priority} value={priority}>{priorityLabel(priority, priorityVocab)}</option>)}
                </select>
                <input
                  type="date"
                  aria-label={`Due date for ${task.title}`}
                  value={dateInputValue(task.due_date)}
                  disabled={savingCell !== null}
                  onChange={(event) => void save(task.id, 'due_date', { due_date: event.target.value || null })}
                  className="min-w-0 rounded-md px-1 py-1.5 text-[10px]"
                  style={{ background: 'var(--surface-container-low)', border: '1px solid var(--border)', color: 'var(--foreground-secondary)', colorScheme: 'dark light' }}
                />
              </div>
            </div>
          );
        })}
        {/* Fix 3: Load more */}
        {visibleCount < sorted.length && (
          <div className="flex justify-center py-3">
            <button
              onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
              className="text-[12px] font-medium px-4 py-1.5 rounded-md"
              style={{ color: 'var(--accent)', border: '1px solid var(--border)', fontFamily: 'var(--font-heading)' }}
            >
              Load more ({sorted.length - visibleCount} remaining)
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {/* Click-away */}
      {inlineDropdown && <div className="fixed inset-0 z-10" onClick={() => setInlineDropdown(null)} />}

      <table className="w-full min-w-[900px]" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            {selectionMode && (
              <th
                className="px-2 py-2 sticky top-0"
                style={{
                  background: 'var(--surface)',
                  borderBottom: '1px solid var(--border)',
                  width: '32px',
                }}
              />
            )}
            {columns.map((col) => (
              <React.Fragment key={col.id}>
                <th
                  onClick={(event) => handleSort(col.id, event.shiftKey)}
                  title="Click to sort; Shift-click to add up to three sorts"
                  className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none sticky top-0"
                  style={{
                    color: 'var(--muted)',
                    fontFamily: 'var(--font-heading)',
                    background: 'var(--surface)',
                    borderBottom: '1px solid var(--border)',
                    width: typeof col.width === 'number' ? `${col.width}px` : col.width === '1fr' ? undefined : col.width,
                    whiteSpace: col.id === 'status' ? 'nowrap' : undefined,
                    minWidth: col.id === 'status' ? '100px' : undefined,
                    left: col.id === 'number' ? (selectionMode ? 32 : 0) : col.id === 'title' ? (selectionMode ? 112 : 80) : undefined,
                    zIndex: col.id === 'number' || col.id === 'title' ? 4 : 2,
                  }}
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    <SortIcon field={col.id} />
                  </div>
                </th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((task) => {
            const priorityStyle = PRIORITY_STYLES[task.priority];
            const isSelected = task.id === selectedTaskId;
            const isChecked = selectionMode && selectedTaskIds?.has(task.id);

            const group = viewConfig.groupBy ? taskGroup(task, viewConfig.groupBy.field) : null;
            const rowIndex = visibleRows.indexOf(task);
            const previous = visibleRows[rowIndex - 1];
            const next = visibleRows[rowIndex + 1];
            const showGroup = group && (!previous || taskGroup(previous, viewConfig.groupBy!.field) !== group);
            const groupEnds = group && (!next || taskGroup(next, viewConfig.groupBy!.field) !== group);
            const inherited: TaskPatch = viewConfig.groupBy?.field === 'status' ? { status: task.status }
              : viewConfig.groupBy?.field === 'priority' ? { priority: task.priority }
              : viewConfig.groupBy?.field === 'assignee' ? { assignee_id: task.assignee_id }
              : {};
            return (
              <React.Fragment key={task.id}>
              {showGroup && (
                <tr>
                  <td colSpan={columns.length + (selectionMode ? 1 : 0)} className="sticky left-0 px-3 py-1.5 text-[11px] font-semibold uppercase" style={{ color: 'var(--muted)', background: 'var(--surface-container-low)', borderBottom: '1px solid var(--border)' }}>
                    {group}
                  </td>
                </tr>
              )}
              <tr
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget) onTaskClick(task);
                  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target === event.currentTarget) {
                    event.preventDefault();
                    const sibling = event.key === 'ArrowDown' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
                    if (sibling instanceof HTMLElement) sibling.focus();
                  }
                }}
                onClick={() => {
                  if (selectionMode && onToggleSelect) {
                    onToggleSelect(task.id);
                  } else {
                    onTaskClick(task);
                  }
                }}
                className="cursor-pointer group"
                style={{
                  background: isSelected ? 'var(--accent-subtle)' : 'transparent',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--hover-tint)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'transparent';
                }}
              >
                {/* Checkbox (selection mode) */}
                {selectionMode && (
                  <td
                    className="px-2 py-2.5"
                    style={{ borderBottom: '1px solid var(--border)', width: '32px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSelect?.(task.id);
                    }}
                  >
                    <div
                      className="w-5 h-5 md:w-4 md:h-4 min-w-[20px] min-h-[20px] rounded border flex items-center justify-center"
                      style={{
                        borderColor: isChecked ? 'var(--accent)' : 'var(--border)',
                        background: isChecked ? 'var(--accent)' : 'transparent',
                        transition: 'all 150ms',
                      }}
                    >
                      {isChecked && <Check size={10} strokeWidth={3} style={{ color: 'white' }} />}
                    </div>
                  </td>
                )}

                {/* ID */}
                <td
                  hidden={!columnVisible('number')}
                  className={`px-3 ${rowPadding} text-[12px] font-medium`}
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)', borderBottom: '1px solid var(--border)', position: 'sticky', left: selectionMode ? 32 : 0, zIndex: 2, background: isSelected ? 'var(--accent-subtle)' : 'var(--surface)' }}
                >
                  {hidePrefixIds ? '' : `${projectPrefix || task.project_prefix}-${task.number}`}
                </td>

                {/* Title */}
                <td
                  hidden={!columnVisible('title')}
                  className={`px-3 ${rowPadding} text-[13px]`}
                  style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)', borderBottom: '1px solid var(--border)', position: 'sticky', left: selectionMode ? 112 : 80, zIndex: 2, background: isSelected ? 'var(--accent-subtle)' : 'var(--surface)' }}
                  onClick={(event) => event.stopPropagation()}
                >
                  {editingTitle?.taskId === task.id ? (
                    <input
                      autoFocus
                      value={editingTitle.value}
                      aria-label={`Title for ${projectPrefix || task.project_prefix}-${task.number}`}
                      onChange={(event) => setEditingTitle({ taskId: task.id, value: event.target.value })}
                      onBlur={() => setEditingTitle(null)}
                      onKeyDown={async (event) => {
                        if (event.key === 'Escape') setEditingTitle(null);
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          const title = editingTitle.value.trim();
                          if (title && title !== task.title && await save(task.id, 'title', { title })) setEditingTitle(null);
                        }
                      }}
                      className="w-full rounded-md px-2 py-1 text-[13px] outline-none"
                      style={{ background: 'var(--surface-container-low)', border: '1px solid var(--accent)', color: 'var(--foreground)' }}
                    />
                  ) : (
                    <button
                      className="w-full truncate text-left rounded px-1 py-1"
                      onClick={() => setEditingTitle({ taskId: task.id, value: task.title })}
                      onDoubleClick={() => onTaskClick(task)}
                      title="Edit title; double-click for task details"
                    >
                      {task.title}
                    </button>
                  )}
                </td>

                {/* Status */}
                <td
                  hidden={!columnVisible('status')}
                  className={`px-3 ${rowPadding}`}
                  style={{ borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', minWidth: '100px' }}
                >
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setInlineDropdown(
                          inlineDropdown?.taskId === task.id && inlineDropdown?.field === 'status'
                            ? null
                            : { taskId: task.id, field: 'status' }
                        );
                      }}
                      className="flex items-center gap-1.5 text-[12px] font-medium px-2 py-0.5 rounded-md"
                      style={{
                        color: 'var(--foreground)',
                        fontFamily: 'var(--font-body)',
                        transition: 'background 150ms',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div className="w-2 h-2 rounded-full" style={{ background: statusColorFor(task.status) }} />
                      {STATUS_OPTIONS.find((s) => s.value === task.status)?.label ?? statusLabel(task.status)}
                    </button>
                    {inlineDropdown?.taskId === task.id && inlineDropdown?.field === 'status' && (
                      <div
                        className="absolute top-full left-0 mt-1 w-40 rounded-lg py-1 z-20"
                        style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
                      >
                        {STATUS_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            onClick={(e) => {
                              e.stopPropagation();
                              void save(task.id, 'status', { status: opt.value });
                              setInlineDropdown(null);
                            }}
                            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px]"
                            style={{
                              color: task.status === opt.value ? 'var(--accent)' : 'var(--foreground)',
                              fontFamily: 'var(--font-body)',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                          >
                            <div className="w-2 h-2 rounded-full" style={{ background: statusColorFor(opt.value) }} />
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </td>

                {/* Priority */}
                <td
                  hidden={!columnVisible('priority')}
                  className={`px-3 ${rowPadding}`}
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <select
                    aria-label={`Priority for ${task.title}`}
                    value={task.priority}
                    disabled={savingCell !== null}
                    onChange={(event) => void save(task.id, 'priority', { priority: event.target.value as Task['priority'] })}
                    className="task-table-select rounded-md px-2 py-1 text-[11px] font-semibold outline-none"
                    style={{
                      background: priorityStyle.bg,
                      color: priorityStyle.color,
                      border: 0,
                      fontFamily: 'var(--font-heading)',
                    }}
                  >
                    {(['p0', 'p1', 'p2', 'p3'] as const).map((priority) => (
                      <option key={priority} value={priority}>{priorityLabel(priority, priorityVocab)}</option>
                    ))}
                  </select>
                </td>

                {/* Assignee */}
                <td
                  hidden={!columnVisible('assignee')}
                  className={`px-3 ${rowPadding}`}
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center gap-1.5">
                    {task.assignee_name && <PersonAvatar name={task.assignee_name} avatarUrl={task.assignee_avatar} size={20} />}
                    <select
                      aria-label={`Assignee for ${task.title}`}
                      value={task.assignee_id ?? ''}
                      disabled={savingCell !== null}
                      onChange={(event) => void save(task.id, 'assignee', { assignee_id: event.target.value || null })}
                      className="task-table-select min-w-0 max-w-[110px] bg-transparent text-[12px] outline-none"
                      style={{ color: task.assignee_name ? 'var(--foreground)' : 'var(--muted)' }}
                    >
                      <option value="">Unassigned</option>
                      {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                    </select>
                  </div>
                </td>

                {/* Start Date */}
                <td hidden={!columnVisible('start_date')} className={`px-3 ${rowPadding}`} style={{ borderBottom: '1px solid var(--border)' }} onClick={(event) => event.stopPropagation()}>
                  <input
                    type="date"
                    aria-label={`Start date for ${task.title}`}
                    value={dateInputValue(task.start_date)}
                    disabled={savingCell !== null}
                    onChange={(event) => void save(task.id, 'start_date', { start_date: event.target.value || null })}
                    className="w-[104px] bg-transparent text-[11px] outline-none"
                    style={{ color: task.start_date ? 'var(--foreground-secondary)' : 'var(--muted)', colorScheme: 'dark light' }}
                  />
                </td>

                {/* Due Date */}
                <td
                  hidden={!columnVisible('due_date')}
                  className={`px-3 ${rowPadding} text-[12px]`}
                  style={{
                    fontFamily: 'var(--font-body)',
                    borderBottom: '1px solid var(--border)',
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="date"
                    aria-label={`Due date for ${task.title}`}
                    value={dateInputValue(task.due_date)}
                    disabled={savingCell !== null}
                    onChange={(event) => void save(task.id, 'due_date', { due_date: event.target.value || null })}
                    className="w-[104px] bg-transparent text-[11px] outline-none"
                    style={{ color: formatDueDate(task.due_date, task.status)?.color ?? 'var(--muted)', colorScheme: 'dark light' }}
                  />
                </td>

                {/* Estimate */}
                <td hidden={!columnVisible('estimation')} className={`px-3 ${rowPadding}`} style={{ borderBottom: '1px solid var(--border)' }} onClick={(event) => event.stopPropagation()}>
                  <select
                    aria-label={`Estimate for ${task.title}`}
                    value={task.estimation ?? ''}
                    disabled={savingCell !== null}
                    onChange={(event) => void save(task.id, 'estimation', { estimation: event.target.value || null })}
                    className="task-table-select rounded-md bg-transparent px-1 py-1 text-[11px] outline-none"
                    style={{ color: task.estimation ? 'var(--foreground-secondary)' : 'var(--muted)' }}
                  >
                    <option value="">None</option>
                    {['xs', 's', 'm', 'l', 'xl'].map((estimate) => <option key={estimate} value={estimate}>{estimate.toUpperCase()}</option>)}
                  </select>
                </td>

                {/* Labels */}
                <td hidden={!columnVisible('labels')} className={`px-3 ${rowPadding}`} style={{ borderBottom: '1px solid var(--border)' }} onClick={(event) => event.stopPropagation()}>
                  <div className="relative">
                    <button
                      aria-label={`Labels for ${task.title}`}
                      onClick={() => setInlineDropdown(inlineDropdown?.taskId === task.id && inlineDropdown.field === 'labels' ? null : { taskId: task.id, field: 'labels' })}
                      className="flex max-w-[160px] items-center gap-1 overflow-hidden rounded-md px-1 py-1 text-[11px]"
                      style={{ color: task.labels.length ? 'var(--foreground-secondary)' : 'var(--muted)' }}
                    >
                      <Tags size={12} />
                      <span className="truncate">{task.labels.length ? task.labels.map((label) => label.name).join(', ') : 'Add labels'}</span>
                    </button>
                    {inlineDropdown?.taskId === task.id && inlineDropdown.field === 'labels' && (
                      <div className="absolute right-0 top-full z-20 mt-1 max-h-56 w-52 overflow-auto rounded-lg p-1" style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}>
                        {availableLabels.map((label) => {
                          const checked = task.labels.some((current) => current.id === label.id);
                          return (
                            <label key={label.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-[var(--hover-tint)]">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={savingCell !== null}
                                onChange={() => void save(task.id, 'labels', { label_ids: checked ? task.labels.filter((current) => current.id !== label.id).map((current) => current.id) : [...task.labels.map((current) => current.id), label.id] })}
                              />
                              <span className="h-2 w-2 rounded-full" style={{ background: label.color }} />
                              <span className="truncate">{label.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </td>

                {/* Updated */}
                <td
                  hidden={!columnVisible('updated_at')}
                  className={`px-3 ${rowPadding} text-[12px]`}
                  style={{
                    color: 'var(--muted)',
                    fontFamily: 'var(--font-body)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    {savingCell?.startsWith(`${task.id}:`) && <Loader2 size={12} className="animate-spin" />}
                    {new Date(task.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </td>
              </tr>
              {groupEnds && inlineCreateRow(group, inherited)}
              </React.Fragment>
            );
          })}
          {!viewConfig.groupBy && inlineCreateRow('all')}
        </tbody>
      </table>

      {sorted.length === 0 && (
        <div className="flex items-center justify-center py-16" style={{ color: 'var(--muted)' }}>
          <p className="text-[14px]" style={{ fontFamily: 'var(--font-body)' }}>No tasks match the current filters</p>
        </div>
      )}
      {/* Fix 3: Load more button */}
      {visibleCount < sorted.length && (
        <div className="flex justify-center py-4">
          <button
            onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
            className="text-[12px] font-medium px-4 py-1.5 rounded-md"
            style={{ color: 'var(--accent)', border: '1px solid var(--border)', fontFamily: 'var(--font-heading)' }}
          >
            Load more ({sorted.length - visibleCount} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
