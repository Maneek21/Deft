'use client';

import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoreHorizontal, Calendar, Check, Lock, ListChecks } from 'lucide-react';

type Task = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  created_by: string;
  creator_name: string | null;
  due_date: string | null;
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
  is_blocked?: boolean;
  blocked_by_label?: string;
  created_at: string;
  updated_at: string;
};

type Props = {
  task: Task;
  projectPrefix: string;
  onClick: () => void;
  isSelected?: boolean;
  isDragOverlay?: boolean;
  onDuplicate?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  selectionMode?: boolean;
  isChecked?: boolean;
  onToggleSelect?: (taskId: string) => void;
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

  // If task is done/cancelled, show neutral styling regardless of due date
  if (isDone) {
    return { text: dateText, color: 'var(--muted)' };
  }

  if (diffDays < 0) {
    // Overdue
    return {
      text: dateText,
      color: 'var(--danger)',
      badge: 'Overdue',
      badgeBg: 'rgba(220, 38, 38, 0.12)',
    };
  }
  if (diffDays === 0) {
    // Due today
    return {
      text: 'Due today',
      color: '#F59E0B',
      badge: 'Due today',
      badgeBg: 'rgba(245, 158, 11, 0.12)',
    };
  }
  if (diffDays === 1) {
    // Due tomorrow
    return {
      text: 'Due tomorrow',
      color: 'var(--muted)',
    };
  }
  // Due this week (within 7 days)
  return { text: dateText, color: 'var(--muted)' };
}

const PRIORITY_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  p0: { bg: 'rgba(220, 38, 38, 0.15)', color: '#DC2626', label: 'P0' },
  p1: { bg: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B', label: 'P1' },
  p2: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3B82F6', label: 'P2' },
  p3: { bg: 'rgba(107, 114, 128, 0.15)', color: '#6B7280', label: 'P3' },
};

export function TaskCard({ task, projectPrefix, onClick, isSelected, isDragOverlay, onDuplicate, onDelete, selectionMode, isChecked, onToggleSelect }: Props) {
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
  const assigneeInitial = task.assignee_name?.charAt(0).toUpperCase() || null;
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
      onClick();
    }
  };

  const showChecked = selectionMode && isChecked;

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
          <button onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            className="p-1 rounded-md" style={{ background: 'var(--card-bg)', color: 'var(--muted)', boxShadow: 'var(--shadow-sm)' }}>
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-36 rounded-lg py-1 z-20"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)' }}>
              <button className="w-full text-left px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={handleDuplicate}>Duplicate</button>
              <button className="w-full text-left px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--foreground)', fontFamily: 'var(--font-body)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={handleCopyLink}>Copy link</button>
              <button className="w-full text-left px-3 py-1.5 text-[12px]"
                style={{ color: 'var(--danger)', fontFamily: 'var(--font-body)' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover-tint)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={handleDelete}>Delete</button>
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
          {/* Top row: task ID + priority */}
          <div className="flex items-center justify-between mb-1">
            <span
              className="text-[11px] font-medium"
              style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
            >
              {projectPrefix || task.project_prefix}-{task.number}
            </span>
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
              style={{
                background: priority.bg,
                color: priority.color,
                fontFamily: 'var(--font-heading)',
              }}
            >
              {priority.label}
            </span>
          </div>

          {/* Title */}
          <p
            className="text-[13px] font-medium leading-snug"
            style={{
              color: 'var(--foreground)',
              fontFamily: 'var(--font-body)',
            }}
          >
            {task.title}
          </p>

          {/* Labels */}
          {task.labels?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {task.labels.map((label) => (
                <span
                  key={label.id}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                  style={{
                    background: `${label.color}20`,
                    color: label.color,
                  }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}

          {/* Subtask progress */}
          {task.subtask_count > 0 && (
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
                      width: `${(task.subtask_done_count / task.subtask_count) * 100}%`,
                      background: task.subtask_done_count === task.subtask_count ? 'var(--success)' : 'var(--accent)',
                      transition: 'width 200ms',
                    }}
                  />
                </div>
                <span
                  className="text-[10px] font-medium whitespace-nowrap"
                  style={{ color: 'var(--muted)', fontFamily: 'var(--font-heading)' }}
                >
                  {task.subtask_done_count}/{task.subtask_count}
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
                  style={{
                    background: dueInfo.badgeBg,
                    color: dueInfo.color,
                  }}
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

          {/* Bottom row: assignee */}
          <div className="flex items-center justify-end mt-2">
            {assigneeInitial && (
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-white flex-shrink-0"
                style={{ background: 'var(--accent)' }}
                title={task.assignee_name || ''}
              >
                {assigneeInitial}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
