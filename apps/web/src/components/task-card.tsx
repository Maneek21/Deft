'use client';

/**
 * Thin wrapper around {@link TaskCardUnified} that renders the default
 * `board` variant. Retained as its own export to avoid churning every
 * `<TaskCard ... />` call site (task-board mobile, desktop columns and
 * drag overlay).
 */

import { TaskCardUnified, type UnifiedTask } from './task-card-unified';

type Task = UnifiedTask & {
  // The board-specific call sites pass the full Task shape — these fields
  // are non-optional at the data source, so we keep them surfaced here for
  // call-site type safety even though `UnifiedTask` treats them as optional.
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
};

export function TaskCard(props: Props) {
  return <TaskCardUnified {...props} variant="board" />;
}
