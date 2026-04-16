'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { ChevronDown, ChevronUp, ArrowUpDown, Calendar, Check } from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';
import { TaskCardUnified } from './task-card-unified';
import type { ResolvedStatus, PriorityVocab, CanonicalPriority } from '@/hooks/use-project-resolved-config';
import { priorityLabel } from '@/hooks/use-project-resolved-config';

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
  onStatusChange: (taskId: string, newStatus: string) => void;
  selectedTaskId: string | null;
  selectionMode?: boolean;
  selectedTaskIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  /** Task 4.9 — resolved skill config drives status dropdown + prefix + priority labels. */
  statuses?: ResolvedStatus[];
  hidePrefixIds?: boolean;
  priorityVocab?: PriorityVocab;
};

type SortField = 'number' | 'title' | 'status' | 'priority' | 'assignee' | 'due_date' | 'updated_at';
type SortDir = 'asc' | 'desc';

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

export function TaskList({ tasks, projectPrefix, onTaskClick, onStatusChange, selectedTaskId, selectionMode, selectedTaskIds, onToggleSelect, statuses, hidePrefixIds, priorityVocab }: Props) {
  const STATUS_OPTIONS = useMemo(() => {
    if (!statuses || statuses.length === 0) return DEFAULT_STATUS_OPTIONS;
    return [...statuses]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ value: s.id, label: s.label, color: s.color }));
  }, [statuses]);

  const statusColorFor = (id: string): string =>
    STATUS_OPTIONS.find((s) => s.value === id)?.color || STATUS_COLORS[id] || 'var(--muted)';
  const [sortField, setSortField] = useState<SortField>('number');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [inlineDropdown, setInlineDropdown] = useState<{ taskId: string; field: string } | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sorted = useMemo(() => {
    return [...tasks].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'number': cmp = a.number - b.number; break;
        case 'title': cmp = a.title.localeCompare(b.title); break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
        case 'priority': cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]; break;
        case 'assignee': cmp = (a.assignee_name || '').localeCompare(b.assignee_name || ''); break;
        case 'due_date': cmp = (a.due_date || '').localeCompare(b.due_date || ''); break;
        case 'updated_at': cmp = a.updated_at.localeCompare(b.updated_at); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [tasks, sortField, sortDir]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={11} style={{ opacity: 0.3 }} />;
    return sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />;
  };

  const columns: { field: SortField; label: string; width: string }[] = [
    { field: 'number', label: 'ID', width: '80px' },
    { field: 'title', label: 'Title', width: '1fr' },
    { field: 'status', label: 'Status', width: '130px' },
    { field: 'priority', label: 'Priority', width: '80px' },
    { field: 'assignee', label: 'Assignee', width: '140px' },
    { field: 'due_date', label: 'Due', width: '110px' },
    { field: 'updated_at', label: 'Updated', width: '110px' },
  ];


  const hasAnyEstimation = tasks.some(t => t.estimation);

  if (isMobile) {
    return (
      <div className="h-full overflow-auto px-4 py-2 space-y-2">
        {sorted.length === 0 && (
          <div className="flex items-center justify-center py-16" style={{ color: 'var(--muted)' }}>
            <p className="text-[14px]" style={{ fontFamily: 'var(--font-body)' }}>No tasks match the current filters</p>
          </div>
        )}
        {sorted.map((task) => {
          const isSelected = task.id === selectedTaskId;
          const isChecked = selectionMode && selectedTaskIds?.has(task.id);
          return (
            <TaskCardUnified
              key={task.id}
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
          );
        })}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {/* Click-away */}
      {inlineDropdown && <div className="fixed inset-0 z-10" onClick={() => setInlineDropdown(null)} />}

      <table className="w-full min-w-[800px]" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
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
              <React.Fragment key={col.field}>
                <th
                  onClick={() => handleSort(col.field)}
                  className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none sticky top-0"
                  style={{
                    color: 'var(--muted)',
                    fontFamily: 'var(--font-heading)',
                    background: 'var(--surface)',
                    borderBottom: '1px solid var(--border)',
                    width: col.width === '1fr' ? undefined : col.width,
                    whiteSpace: col.field === 'status' ? 'nowrap' : undefined,
                    minWidth: col.field === 'status' ? '100px' : undefined,
                  }}
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    <SortIcon field={col.field} />
                  </div>
                </th>
                {col.field === 'priority' && hasAnyEstimation && (
                  <th
                    className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide select-none sticky top-0"
                    style={{
                      color: 'var(--muted)',
                      fontFamily: 'var(--font-heading)',
                      background: 'var(--surface)',
                      borderBottom: '1px solid var(--border)',
                      width: '60px',
                    }}
                  >
                    Est.
                  </th>
                )}
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((task) => {
            const priorityStyle = PRIORITY_STYLES[task.priority];
            const priorityText = priorityLabel(task.priority as CanonicalPriority, priorityVocab);
            const isSelected = task.id === selectedTaskId;
            const isChecked = selectionMode && selectedTaskIds?.has(task.id);

            return (
              <tr
                key={task.id}
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
                  className="px-3 py-2.5 text-[12px] font-medium"
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)', borderBottom: '1px solid var(--border)' }}
                >
                  {hidePrefixIds ? '' : `${projectPrefix || task.project_prefix}-${task.number}`}
                </td>

                {/* Title */}
                <td
                  className="px-3 py-2.5 text-[13px]"
                  style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)', borderBottom: '1px solid var(--border)' }}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate">{task.title}</span>
                    {task.labels.length > 0 && (
                      <div className="flex gap-1 flex-shrink-0">
                        {task.labels.slice(0, 2).map((l) => (
                          <span
                            key={l.id}
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                            style={{ background: `${l.color}20`, color: l.color }}
                          >
                            {l.name}
                          </span>
                        ))}
                        {task.labels.length > 2 && (
                          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                            +{task.labels.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </td>

                {/* Status */}
                <td
                  className="px-3 py-2.5"
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
                              onStatusChange(task.id, opt.value);
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
                  className="px-3 py-2.5"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                    style={{
                      background: priorityStyle.bg,
                      color: priorityStyle.color,
                      fontFamily: 'var(--font-heading)',
                    }}
                  >
                    {priorityText}
                  </span>
                </td>

                {/* Est. */}
                {hasAnyEstimation && (
                  <td
                    className="px-3 py-2.5"
                    style={{ borderBottom: '1px solid var(--border)' }}
                  >
                    {task.estimation ? (
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--surface-container-high)', color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                      >
                        {task.estimation.toUpperCase()}
                      </span>
                    ) : null}
                  </td>
                )}

                {/* Assignee */}
                <td
                  className="px-3 py-2.5"
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  {task.assignee_name ? (
                    <div className="flex items-center gap-2">
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0"
                        style={{ background: 'var(--accent)' }}
                      >
                        {task.assignee_name.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-[12px] truncate" style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}>
                        {task.assignee_name}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[12px]" style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>

                {/* Due Date */}
                <td
                  className="px-3 py-2.5 text-[12px]"
                  style={{
                    fontFamily: 'var(--font-body)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {(() => {
                    const dueInfo = formatDueDate(task.due_date, task.status);
                    if (!dueInfo) return <span style={{ color: 'var(--muted)' }}>—</span>;
                    if (dueInfo.badge) {
                      return (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                          style={{ background: dueInfo.badgeBg, color: dueInfo.color }}
                        >
                          <Calendar size={10} strokeWidth={1.5} />
                          {dueInfo.badge}
                        </span>
                      );
                    }
                    return (
                      <span className="flex items-center gap-1" style={{ color: dueInfo.color }}>
                        <Calendar size={11} strokeWidth={1.5} />
                        {dueInfo.text}
                      </span>
                    );
                  })()}
                </td>

                {/* Updated */}
                <td
                  className="px-3 py-2.5 text-[12px]"
                  style={{
                    color: 'var(--muted)',
                    fontFamily: 'var(--font-body)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  {new Date(task.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {sorted.length === 0 && (
        <div className="flex items-center justify-center py-16" style={{ color: 'var(--muted)' }}>
          <p className="text-[14px]" style={{ fontFamily: 'var(--font-body)' }}>No tasks match the current filters</p>
        </div>
      )}
    </div>
  );
}
