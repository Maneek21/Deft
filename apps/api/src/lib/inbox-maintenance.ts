export const TASK_NUDGE_TYPES = ['stalled', 'overdue', 'upcoming_due'] as const;

export type TaskNudgeType = (typeof TASK_NUDGE_TYPES)[number];

export type InboxMaintenanceRow = {
  id: string;
  user_id: string;
  title: string;
  is_read: boolean;
  metadata: unknown;
  created_at: Date | string;
};

export type InboxCompactionGroup = {
  key: string;
  userId: string;
  nudgeType: TaskNudgeType;
  keep: InboxMaintenanceRow;
  compact: InboxMaintenanceRow[];
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function taskNudgeTypeForRow(row: InboxMaintenanceRow): TaskNudgeType | null {
  const value = metadataRecord(row.metadata).nudge_type;
  return TASK_NUDGE_TYPES.includes(value as TaskNudgeType) ? value as TaskNudgeType : null;
}

export function planLegacyTaskNudgeCompaction(
  rows: InboxMaintenanceRow[],
): InboxCompactionGroup[] {
  const grouped = new Map<string, InboxMaintenanceRow[]>();

  for (const row of rows) {
    if (row.is_read) continue;
    const nudgeType = taskNudgeTypeForRow(row);
    if (!nudgeType) continue;
    const key = `${row.user_id}:${nudgeType}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  return Array.from(grouped.entries())
    .map(([key, group]) => {
      const ordered = [...group].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      const keep = ordered[0];
      if (!keep) return null;
      return {
        key,
        userId: keep.user_id,
        nudgeType: taskNudgeTypeForRow(keep) as TaskNudgeType,
        keep,
        compact: ordered.slice(1),
      } satisfies InboxCompactionGroup;
    })
    .filter((group): group is InboxCompactionGroup => group !== null && group.compact.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function addInboxCompactionMetadata(params: {
  metadata: unknown;
  runId: string;
  compactedAt: string;
  keptNotificationId: string;
}) {
  return {
    ...metadataRecord(params.metadata),
    inbox_compaction: {
      run_id: params.runId,
      compacted_at: params.compactedAt,
      reason: 'superseded_task_nudge',
      previous_is_read: false,
      kept_notification_id: params.keptNotificationId,
    },
  };
}

export function removeInboxCompactionMetadata(metadata: unknown) {
  const next = { ...metadataRecord(metadata) };
  delete next.inbox_compaction;
  return next;
}

export function inboxCompactionRunId(metadata: unknown): string | null {
  const compaction = metadataRecord(metadata).inbox_compaction;
  if (!compaction || typeof compaction !== 'object' || Array.isArray(compaction)) return null;
  const runId = (compaction as Record<string, unknown>).run_id;
  return typeof runId === 'string' && runId.length > 0 ? runId : null;
}
