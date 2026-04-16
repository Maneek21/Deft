'use client';

/**
 * TaskCardUnified
 *
 * One component, six variants — board / list / chat / calendar / dashboard / notification.
 *
 * The default (`board`) retains the full behaviour of the original TaskCard:
 * dnd-kit drag handle, hover menu (duplicate / copy link / delete), selection
 * mode checkbox, labels, subtask progress, blocked pill, priority + estimation
 * header, and the stacked-avatar bottom row.
 *
 * Other variants strip the card back:
 *  - `list`      — compact row: title, status dot, priority, assignee, due date
 *  - `chat`      — inline pill: prefix-N + title + status chip (rendered as a Link)
 *  - `calendar`  — tight card in a date cell: prefix-N + title + assignee dot
 *  - `dashboard` — title + due date + assignee (widget list row)
 *  - `notification` — row with title + due date + optional View button
 *
 * Callers that only have a minimal task shape (dashboard API responses, the
 * notification panel) can pass a `UnifiedTask` partial — the component only
 * reads the fields each variant actually needs.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreHorizontal, Calendar, Check, Lock, ListChecks } from 'lucide-react';
import { statusLabel } from '@/lib/task-status-labels';

// Canonical engineering statuses; kept as a named export so older callers
// still get auto-complete, but skill-driven configs (Sales pipeline etc.)
// can supply arbitrary status IDs — the card accepts any string.
export type UnifiedTaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'
  | (string & {});
export type UnifiedTaskPriority = 'p0' | 'p1' | 'p2' | 'p3';

/**
 * Minimal common task shape. Variants read only what they need — board needs
 * everything, dashboard/list need a subset, chat/notification are happy with
 * title + prefix + number + status.
 */
export type UnifiedTask = {
  id: string;
  number: number;
  title: string;
  status: UnifiedTaskStatus;
  priority: UnifiedTaskPriority;
  project_prefix: string;

  // Optional across variants — board uses all, others may skip.
  description?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  assignee_avatar?: string | null;
  additional_assignees?: { user_id: string; user_name: string | null; user_avatar: string | null }[];
  due_date?: string | null;
  start_date?: string | null;
  sort_order?: number;
  source_message_id?: string | null;
  is_deleted?: boolean;
  project_id?: string;
  project_name?: string;
  project_color?: string | null;
  labels?: { id: string; name: string; color: string }[];
  parent_task_id?: string | null;
  subtask_count?: number;
  subtask_done_count?: number;
  estimation?: string | null;
  is_blocked?: boolean;
  blocked_by_label?: string;
  // Task 4.12 — recurrence cadence; when set, board variant renders a
  // small "Recurring" chip.
  recurrence?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  created_at?: string;
  updated_at?: string;
};

export type TaskCardVariant = 'board' | 'list' | 'chat' | 'calendar' | 'dashboard' | 'notification';

type CommonProps = {
  task: UnifiedTask;
  projectPrefix?: string;
  onClick?: () => void;
  hidePrefixIds?: boolean;
};

type BoardProps = CommonProps & {
  variant?: 'board';
  isSelected?: boolean;
  isDragOverlay?: boolean;
  onDuplicate?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  selectionMode?: boolean;
  isChecked?: boolean;
  onToggleSelect?: (taskId: string) => void;
};

type ListProps = CommonProps & {
  variant: 'list';
  isSelected?: boolean;
  selectionMode?: boolean;
  isChecked?: boolean;
  onToggleSelect?: (taskId: string) => void;
};

type ChatProps = CommonProps & {
  variant: 'chat';
  /** When false, the pill is rendered as a plain span (e.g. inside an existing anchor). */
  asLink?: boolean;
};

type CalendarProps = CommonProps & {
  variant: 'calendar';
};

type DashboardProps = CommonProps & {
  variant: 'dashboard';
  /** Highlight the card as overdue (dashboard Today list flags overdue items). */
  isOverdue?: boolean;
};

type NotificationProps = CommonProps & {
  variant: 'notification';
  onView?: () => void;
};

export type TaskCardUnifiedProps =
  | BoardProps
  | ListProps
  | ChatProps
  | CalendarProps
  | DashboardProps
  | NotificationProps;

// ── Shared formatting helpers ────────────────────────────────────────────────

const PRIORITY_STYLES: Record<UnifiedTaskPriority, { bg: string; color: string; label: string }> = {
  p0: { bg: 'rgba(220, 38, 38, 0.15)', color: '#DC2626', label: 'P0' },
  p1: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B', label: 'P1' },
  p2: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6', label: 'P2' },
  p3: { bg: 'rgba(107, 114, 128, 0.15)', color: '#6B7280', label: 'P3' },
};

const STATUS_COLORS: Record<string, string> = {
  backlog: 'var(--muted)',
  todo: 'var(--foreground-secondary)',
  in_progress: 'var(--accent)',
  in_review: '#8B5CF6',
  done: 'var(--success)',
  cancelled: 'var(--danger)',
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--muted)';
}

type DueInfo = { text: string; color: string; badge?: string; badgeBg?: string };

function formatDueDate(dateStr: string | null | undefined, status?: string): DueInfo | null {
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

  if (isDone) return { text: dateText, color: 'var(--muted)' };
  if (diffDays < 0) {
    return { text: dateText, color: 'var(--danger)', badge: 'Overdue', badgeBg: 'rgba(220, 38, 38, 0.12)' };
  }
  if (diffDays === 0) {
    return { text: 'Due today', color: '#F59E0B', badge: 'Due today', badgeBg: 'rgba(245, 158, 11, 0.12)' };
  }
  if (diffDays === 1) return { text: 'Due tomorrow', color: 'var(--muted)' };
  return { text: dateText, color: 'var(--muted)' };
}

function assigneeInitial(task: UnifiedTask): string | null {
  return task.assignee_name?.charAt(0).toUpperCase() || null;
}

// ── Main component ───────────────────────────────────────────────────────────

export function TaskCardUnified(props: TaskCardUnifiedProps) {
  const variant: TaskCardVariant = (props as { variant?: TaskCardVariant }).variant ?? 'board';
  switch (variant) {
    case 'list':
      return <ListVariant {...(props as ListProps)} />;
    case 'chat':
      return <ChatVariant {...(props as ChatProps)} />;
    case 'calendar':
      return <CalendarVariant {...(props as CalendarProps)} />;
    case 'dashboard':
      return <DashboardVariant {...(props as DashboardProps)} />;
    case 'notification':
      return <NotificationVariant {...(props as NotificationProps)} />;
    case 'board':
    default:
      return <BoardVariant {...(props as BoardProps)} />;
  }
}

// ── Board variant — original TaskCard, full fidelity ────────────────────────

function BoardVariant({
  task,
  projectPrefix,
  onClick,
  hidePrefixIds,
  isSelected,
  isDragOverlay,
  onDuplicate,
  onDelete,
  selectionMode,
  isChecked,
  onToggleSelect,
}: BoardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task?.id ?? '', disabled: isDragOverlay || !task });

  if (!task) return null;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const priority = PRIORITY_STYLES[task.priority];
  const initial = assigneeInitial(task);
  const dueInfo = formatDueDate(task.due_date, task.status);

  const handleDuplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onDuplicate?.(task.id);
  };

  const handleCopyLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    const url = `${window.location.origin}/tasks?task=${task.project_prefix}-${task.number}`;
    navigator.clipboard.writeText(url);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onDelete?.(task.id);
  };

  const handleCardClick = () => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(task.id);
    } else {
      onClick?.();
    }
  };

  const showChecked = selectionMode && isChecked;
  const subtaskCount = task.subtask_count ?? 0;
  const subtaskDone = task.subtask_done_count ?? 0;
  const labels = task.labels ?? [];

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        background: showChecked ? 'var(--accent-subtle)' : isSelected ? 'var(--accent-subtle)' : 'var(--card-bg)',
        border: `1px solid ${showChecked ? 'var(--accent)' : isSelected ? 'var(--accent)' : 'var(--border)'}`,
        boxShadow: isDragOverlay ? 'var(--shadow-lg)' : 'none',
        transition: 'box-shadow 150ms, border-color 150ms',
        cursor: 'pointer',
      }}
      className="rounded-lg p-3 group relative"
      onClick={handleCardClick}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
      }}
      onMouseLeave={(e) => {
        if (!isDragOverlay) e.currentTarget.style.boxShadow = 'none';
        setMenuOpen(false);
      }}
    >
      {/* Hover menu */}
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="p-1 rounded-md"
            style={{ background: 'var(--card-bg)', color: 'var(--muted)', boxShadow: 'var(--shadow-sm)' }}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-36 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}
            >
              <button
                className="w-full text-left px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={handleDuplicate}
              >
                Duplicate
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={handleCopyLink}
              >
                Copy link
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--danger)', fontFamily: 'var(--font-body)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={handleDelete}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2">
        {/* Selection checkbox */}
        {selectionMode && (
          <div
            className="mt-0.5 flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center cursor-pointer"
            style={{
              borderColor: isChecked ? 'var(--accent)' : 'var(--border)',
              background: isChecked ? 'var(--accent)' : 'transparent',
              transition: 'all 150ms',
            }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.(task.id);
            }}
          >
            {isChecked && <Check size={10} strokeWidth={3} style={{ color: 'white' }} />}
          </div>
        )}

        {/* Drag handle */}
        {!selectionMode && (
          <div
            {...attributes}
            {...listeners}
            className="mt-0.5 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing flex-shrink-0"
            style={{ color: 'var(--muted)', transition: 'opacity 150ms' }}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={14} />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Top row: task ID + priority + estimation */}
          <div className="flex items-center justify-between mb-1">
            {!hidePrefixIds && (
              <span
                className="text-[11px] font-medium"
                style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
              >
                {projectPrefix || task.project_prefix}-{task.number}
              </span>
            )}
            <div className="flex items-center gap-1.5 ml-auto">
              {task.estimation && (
                <span
                  className="text-[9px] font-medium px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--surface-container-high)', color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                >
                  {task.estimation.toUpperCase()}
                </span>
              )}
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{ background: priority.bg, color: priority.color, fontFamily: 'var(--font-heading)' }}
              >
                {priority.label}
              </span>
            </div>
          </div>

          {/* Title */}
          <p
            className="text-[13px] font-medium leading-snug"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
          >
            {task.title}
          </p>

          {/* Labels + Task 4.12 recurring chip */}
          {(labels.length > 0 || task.recurrence) && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {labels.map((label) => (
                <span
                  key={label.id}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                  style={{ background: `${label.color}20`, color: label.color }}
                >
                  {label.name}
                </span>
              ))}
              {task.recurrence && (
                <span
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded-full inline-flex items-center gap-0.5"
                  style={{ background: 'var(--surface-container-low)', color: 'var(--muted)' }}
                  title={`Repeats ${task.recurrence}`}
                >
                  {'\u21BB'} Recurring
                </span>
              )}
            </div>
          )}

          {/* Subtask progress */}
          {subtaskCount > 0 && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <ListChecks size={12} style={{ color: 'var(--muted)' }} />
              <div className="flex items-center gap-1.5 flex-1">
                <div
                  className="flex-1 h-1 rounded-full overflow-hidden"
                  style={{ background: 'var(--border)' }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(subtaskDone / subtaskCount) * 100}%`,
                      background: subtaskDone === subtaskCount ? 'var(--success)' : 'var(--accent)',
                      transition: 'width 200ms',
                    }}
                  />
                </div>
                <span
                  className="text-[10px] font-medium whitespace-nowrap"
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                >
                  {subtaskDone}/{subtaskCount}
                </span>
              </div>
            </div>
          )}

          {/* Blocked indicator */}
          {task.is_blocked && (
            <div
              className="flex items-center gap-1 mt-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{
                background: 'rgba(220, 38, 38, 0.1)',
                color: 'var(--danger)',
                fontFamily: 'var(--font-heading)',
              }}
              title={task.blocked_by_label || 'Blocked'}
            >
              <Lock size={10} />
              {task.blocked_by_label || 'Blocked'}
            </div>
          )}

          {/* Due date */}
          {dueInfo && (
            <div className="flex items-center gap-1 text-[11px] mt-1.5">
              {dueInfo.badge ? (
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{ background: dueInfo.badgeBg, color: dueInfo.color }}
                >
                  <Calendar size={10} strokeWidth={1.5} />
                  {dueInfo.badge}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1" style={{ color: dueInfo.color }}>
                  <Calendar size={11} strokeWidth={1.5} />
                  {dueInfo.text}
                </span>
              )}
            </div>
          )}

          {/* Bottom row: primary assignee + secondary avatars + overflow */}
          <div className="flex items-center justify-end mt-2">
            {(() => {
              const extras = task.additional_assignees ?? [];
              const shownExtras = extras.slice(0, 2);
              const overflow = extras.length - shownExtras.length;
              return (
                <div className="flex items-center -space-x-1.5">
                  {shownExtras.map((a) => (
                    <div
                      key={a.user_id}
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0"
                      style={{ background: 'var(--muted)', border: '1.5px solid var(--card-bg)' }}
                      title={a.user_name || ''}
                    >
                      {(a.user_name || '?').charAt(0).toUpperCase()}
                    </div>
                  ))}
                  {overflow > 0 && (
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium flex-shrink-0"
                      style={{ background: 'var(--surface-container-high)', color: 'var(--muted)', border: '1.5px solid var(--card-bg)' }}
                      title={`+${overflow} more`}
                    >
                      +{overflow}
                    </div>
                  )}
                  {initial && (
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0"
                      style={{ background: 'var(--accent)', border: '1.5px solid var(--card-bg)' }}
                      title={`Primary: ${task.assignee_name || ''}`}
                    >
                      {initial}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── List variant — compact row ──────────────────────────────────────────────

function ListVariant({
  task,
  projectPrefix,
  onClick,
  hidePrefixIds,
  isSelected,
  selectionMode,
  isChecked,
  onToggleSelect,
}: ListProps) {
  const priority = PRIORITY_STYLES[task.priority];
  const dueInfo = formatDueDate(task.due_date, task.status);
  const label = statusLabel(task.status);
  const checked = selectionMode && isChecked;

  const handleClick = () => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(task.id);
    } else {
      onClick?.();
    }
  };

  return (
    <div
      onClick={handleClick}
      className="rounded-lg p-3 cursor-pointer"
      style={{
        background: checked || isSelected ? 'var(--accent-subtle)' : 'var(--card-bg)',
        border: `1px solid ${checked || isSelected ? 'var(--accent)' : 'var(--border)'}`,
        transition: 'all 150ms',
      }}
    >
      <div className="flex items-start gap-2">
        {selectionMode && (
          <div
            className="mt-0.5 flex-shrink-0 w-5 h-5 md:w-4 md:h-4 min-w-[20px] min-h-[20px] rounded border flex items-center justify-center"
            style={{
              borderColor: isChecked ? 'var(--accent)' : 'var(--border)',
              background: isChecked ? 'var(--accent)' : 'transparent',
            }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.(task.id);
            }}
          >
            {isChecked && <Check size={10} strokeWidth={3} style={{ color: 'white' }} />}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
              style={{ background: priority.bg, color: priority.color, fontFamily: 'var(--font-heading)' }}
            >
              {priority.label}
            </span>
            {!hidePrefixIds && (
              <span
                className="text-[11px] font-medium"
                style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
              >
                {projectPrefix || task.project_prefix}-{task.number}
              </span>
            )}
          </div>
          <p
            className="text-[13px] font-medium leading-snug mb-1.5 break-words"
            style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)', overflowWrap: 'anywhere' }}
          >
            {task.title}
          </p>
          <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: 'var(--muted)' }}>
            {task.assignee_name && <span>{task.assignee_name}</span>}
            {task.assignee_name && <span style={{ color: 'var(--border)' }}>·</span>}
            <span className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(task.status) }} />
              {label}
            </span>
            {dueInfo && (
              <>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span className="flex items-center gap-1" style={{ color: dueInfo.color }}>
                  <Calendar size={10} strokeWidth={1.5} />
                  {dueInfo.text}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Chat variant — inline pill ──────────────────────────────────────────────

function ChatVariant({ task, projectPrefix, onClick, hidePrefixIds, asLink = true }: ChatProps) {
  const href = `/tasks?task=${task.project_prefix}-${task.number}`;
  const prefix = projectPrefix || task.project_prefix;
  const statusText = statusLabel(task.status);

  const body = (
    <>
      {!hidePrefixIds && (
        <span className="font-mono text-[11px] opacity-70">
          {prefix}-{task.number}
        </span>
      )}
      <span className="truncate max-w-[180px]">{task.title}</span>
      <span
        className="text-[10px] font-medium px-1 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
        style={{ background: 'var(--card-bg)', color: statusColor(task.status) }}
      >
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(task.status) }} />
        {statusText}
      </span>
    </>
  );

  const sharedClass =
    'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded text-[12px] font-medium align-baseline';
  const sharedStyle = {
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    textDecoration: 'none' as const,
  };

  if (!asLink) {
    return (
      <span className={sharedClass} style={sharedStyle} onClick={onClick}>
        {body}
      </span>
    );
  }

  return (
    <Link
      href={href}
      onClick={onClick}
      className={`${sharedClass} hover:opacity-80 cursor-pointer`}
      style={sharedStyle}
    >
      {body}
    </Link>
  );
}

// ── Calendar variant — compact card in a date cell ──────────────────────────

function CalendarVariant({ task, projectPrefix, onClick, hidePrefixIds }: CalendarProps) {
  const prefix = projectPrefix || task.project_prefix;
  const initial = assigneeInitial(task);

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 w-full text-left px-1.5 py-0.5 rounded text-[11px] truncate transition-colors hover:opacity-80"
      style={{ background: 'var(--accent-subtle)' }}
    >
      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--accent)' }} />
      {!hidePrefixIds && (
        <span className="text-[9px] font-mono flex-shrink-0" style={{ color: 'var(--muted)' }}>
          {prefix}-{task.number}
        </span>
      )}
      <span className="truncate flex-1" style={{ color: 'var(--foreground)' }}>
        {task.title}
      </span>
      {initial && (
        <div
          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium text-white flex-shrink-0"
          style={{ background: 'var(--accent)' }}
          title={task.assignee_name || ''}
        >
          {initial}
        </div>
      )}
    </button>
  );
}

// ── Dashboard variant — widget list row ─────────────────────────────────────

function DashboardVariant({ task, projectPrefix, onClick, hidePrefixIds, isOverdue }: DashboardProps) {
  const priority = PRIORITY_STYLES[task.priority];
  const prefix = projectPrefix || task.project_prefix;
  const dueInfo = formatDueDate(task.due_date, task.status);

  // Rendered as a div rather than a button so callers can wrap in a <Link>
  // (dashboard widgets are routed to the task page).
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg -mx-2 w-full text-left"
      style={{ cursor: onClick ? 'pointer' : undefined }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {!hidePrefixIds && (
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--muted)' }}>
          {prefix}-{task.number}
        </span>
      )}
      <span
        className="text-[12px] font-medium flex-1 truncate"
        style={{ color: isOverdue ? 'var(--danger)' : 'var(--foreground)', fontFamily: 'var(--font-body)' }}
      >
        {task.title}
      </span>
      <span
        className="text-[9px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
        style={{ background: priority.bg, color: priority.color, fontFamily: 'var(--font-heading)' }}
      >
        {priority.label}
      </span>
      {task.assignee_name && (
        <div
          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium text-white flex-shrink-0"
          style={{ background: 'var(--accent)' }}
          title={task.assignee_name}
        >
          {task.assignee_name.charAt(0).toUpperCase()}
        </div>
      )}
      {isOverdue ? (
        <span className="text-[9px] font-medium flex-shrink-0" style={{ color: 'var(--danger)' }}>
          overdue
        </span>
      ) : dueInfo ? (
        <span className="text-[10px] flex-shrink-0" style={{ color: dueInfo.color }}>
          {dueInfo.text}
        </span>
      ) : null}
    </div>
  );
}

// ── Notification variant — row with title + due + View button ───────────────

function NotificationVariant({ task, onClick, onView }: NotificationProps) {
  const dueInfo = formatDueDate(task.due_date, task.status);

  return (
    <div
      className="flex items-center gap-2 w-full"
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="flex-1 min-w-0">
        <p
          className="text-[13px] leading-snug truncate"
          style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
        >
          {task.title}
        </p>
        {dueInfo && (
          <p className="text-[11px] mt-0.5 flex items-center gap-1" style={{ color: dueInfo.color }}>
            <Calendar size={10} strokeWidth={1.5} />
            {dueInfo.text}
          </p>
        )}
      </div>
      {onView && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
          className="text-[11px] font-medium px-2 py-1 rounded-md flex-shrink-0"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', fontFamily: 'var(--font-body)' }}
        >
          View
        </button>
      )}
    </div>
  );
}
