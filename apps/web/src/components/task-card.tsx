'use client';

/**
 * Thin wrapper around {@link TaskCardUnified} that renders the default
 * `board` variant. Retained as its own export to avoid churning every
 * `<TaskCard ... />` call site (task-board mobile, desktop columns and
 * drag overlay).
 */

import { TaskCardUnified, type UnifiedTask } from './task-card-unified';

/**
 * Board-variant task shape. We keep fields the board surfaces (labels,
 * project_color, creator_name, sort_order, etc.) typed even though
 * `UnifiedTask` treats them as optional. `status` is widened to `string`
 * because resolved-config skills can define arbitrary status IDs
 * (e.g. 'lead', 'qualified') that don't fit the core `UnifiedTaskStatus`
 * union — the card only consumes the value for display + STATUS_COLORS
 * lookup, both of which degrade gracefully.
 */
type Task = Omit<UnifiedTask, 'status'> & {
  status: string;
  description: string | null;
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
  project_name: string;
  project_color: string | null;
  labels: { id: string; name: string; color: string }[];
  parent_task_id: string | null;
  subtask_count: number;
  subtask_done_count: number;
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
  hidePrefixIds?: boolean;
};

export function TaskCard(props: Props) {
  // Cast because resolved-config statuses extend beyond the UnifiedTaskStatus
  // union; the unified renderer tolerates unknown values (STATUS_COLORS
  // falls back to var(--muted)).
  return <TaskCardUnified {...(props as any)} variant="board" />;
}
