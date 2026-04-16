export const STATUS_LABELS = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
} as const;

export type TaskStatus = keyof typeof STATUS_LABELS;

export function statusLabel(s: string): string {
  return STATUS_LABELS[s as TaskStatus] ?? s;
}
