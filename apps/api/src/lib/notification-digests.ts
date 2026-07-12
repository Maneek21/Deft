export type TaskNudgeType = 'stalled' | 'overdue' | 'upcoming_due';

type TaskNudgeMetadata = {
  nudge_type?: unknown;
  task_id?: unknown;
  task_ids?: unknown;
  task_identifier?: unknown;
  task_identifiers?: unknown;
  [key: string]: unknown;
};

const NUDGE_LABELS: Record<TaskNudgeType, { singular: string; plural: string }> = {
  stalled: { singular: 'Stalled task', plural: 'stalled tasks' },
  overdue: { singular: 'Overdue task', plural: 'overdue tasks' },
  upcoming_due: { singular: 'Task due soon', plural: 'tasks due soon' },
};

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function buildTaskNudgeDigest(params: {
  nudgeType: TaskNudgeType;
  taskId: string;
  taskIdentifier: string;
  existingMetadata?: TaskNudgeMetadata | null;
}) {
  const { nudgeType, taskId, taskIdentifier, existingMetadata } = params;
  const labels = NUDGE_LABELS[nudgeType];
  const taskIds = Array.from(new Set([
    ...stringValues(existingMetadata?.task_ids),
    typeof existingMetadata?.task_id === 'string' ? existingMetadata.task_id : '',
    taskId,
  ].filter(Boolean)));
  const taskIdentifiers = Array.from(new Set([
    ...stringValues(existingMetadata?.task_identifiers),
    typeof existingMetadata?.task_identifier === 'string' ? existingMetadata.task_identifier : '',
    taskIdentifier,
  ].filter(Boolean)));
  const count = taskIds.length;
  const visibleIdentifiers = taskIdentifiers.slice(0, 3);
  const remaining = Math.max(0, count - visibleIdentifiers.length);
  const subject = visibleIdentifiers.join(', ');
  const body = count === 1
    ? `${taskIdentifier} needs your attention.`
    : `${subject}${remaining > 0 ? ` and ${remaining} more` : ''} need your attention.`;

  return {
    title: count === 1 ? labels.singular : `${count} ${labels.plural}`,
    body,
    link: count === 1 ? `/tasks?task=${taskIdentifier}` : '/tasks?view=list',
    metadata: {
      ...(existingMetadata ?? {}),
      nudge_type: nudgeType,
      task_id: taskIds[0],
      task_identifier: taskIdentifiers[0],
      task_ids: taskIds,
      task_identifiers: taskIdentifiers,
      bundled_count: count,
    },
  };
}
