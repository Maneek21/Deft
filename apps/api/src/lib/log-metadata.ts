// Runtime validation matters here: even typed job records can originate in a
// database or external runtime. Never stringify arbitrary values or errors.
export function logNumber(value: unknown): number | '<redacted>' {
  return typeof value === 'number' && Number.isFinite(value) ? value : '<redacted>';
}

export function logId(value: unknown): string {
  return typeof value === 'string'
    && /^(?:[a-f0-9]{8}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(value)
    ? value : '<redacted>';
}

const JOB_NAMES = new Set([
  'agent-reply', 'observe-chat-message', 'task-extract', 'cross-reference',
  'native-mention-reconcile', 'native-mention-publish', 'native-mention-deliver',
  'embed-content', 'memory-extract', 'memory-capture', 'chat-knowledge-batch',
  'blocked-alert', 'duplicate-detect', 'clip-process', 'agent-employee-message',
  'agent-employee-task', 'plan-executor', 'agent-employee-trigger', 'employee-trigger',
  'workflow-execute', 'app-run-attempt', 'app-run-attention', 'app-public-ingress',
  'certification-noop', 'app-integration-knowledge', 'app-integration-knowledge-repair',
  'app-resource-sync-scan', 'app-automation-scan', 'app-automation-fire',
  'standup-generate', 'nudge-check', 'meeting-prep-check', 'people-graph',
  'manager-pulse', 'burnout-detect', 'weekly-digest', 'wiki-lint', 'agent-daily-reset',
  'reminder-fire', 'scheduled-message-send', 'agent-heartbeat', 'heartbeat-native',
  'trigger-dispatch', 'ics-sync', 'github-sync-scan', 'github-sync-connection',
  'chat-observation-backfill', 'attention-maintenance', 'app-integration-notification',
  'attention-delivery', 'notification-attention-sync',
]);

export function logJobName(value: unknown): string {
  return typeof value === 'string' && JOB_NAMES.has(value) ? value : 'unknown-job';
}

export function logQueueName(value: unknown): string {
  return value === 'agent-jobs' || value === 'scheduled-jobs' ? value : 'unknown-queue';
}

export function logSignal(value: unknown): string {
  return value === 'SIGTERM' || value === 'SIGINT' ? value : 'unknown-signal';
}

const CAPACITY_FIELDS = {
  notification_fanout: ['requested', 'allowed', 'policy_read_ms', 'notification_insert_ms',
    'attention_sync_ms', 'attention_enqueue_ms', 'total_ms'],
  attention_projection: ['notifications', 'projected_items', 'queue_delay_ms', 'projection_ms', 'end_to_end_ms'],
} as const;

/** Fixed field names, finite measurements and a closed delivery mode only. */
export function logCapacityProfile(event: keyof typeof CAPACITY_FIELDS, measurements: Record<string, unknown>): string {
  if (event !== 'notification_fanout' && event !== 'attention_projection') {
    return '[capacity-profile] {"event":"unknown"}';
  }
  const output: Record<string, string | number | null> = { event };
  for (const key of CAPACITY_FIELDS[event]) {
    const value = measurements[key];
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) output[key] = value;
  }
  if (event === 'notification_fanout'
    && (measurements.attention_mode === 'queued' || measurements.attention_mode === 'synchronous_fallback')) {
    output.attention_mode = measurements.attention_mode;
  }
  return `[capacity-profile] ${JSON.stringify(output)}`;
}
