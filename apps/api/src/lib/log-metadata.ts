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

// Only code-defined remediation strings are emitted; never the original
// message, environment value, path, or a free-form system error code.
const STARTUP_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['DEFT_HOSTED must be exactly', 'Invalid DEFT_HOSTED: use exactly true or false, or leave it unset.'],
  ['DEFT_PAUSED_START must be exactly', 'Invalid DEFT_PAUSED_START: use exactly true or false, or leave it unset.'],
  ['Hosted workspace limits are invalid', 'Invalid DEFT_HOSTED_LIMIT_* setting: each must be a whole number in its range (see docs/self-hosting.md), or unset for the default.'],
  ['DEFT_PAUSED_REASON must be one of', 'Invalid DEFT_PAUSED_REASON: use exactly restore_review, billing or emergency_stop, or leave it unset.'],
  ['JWT_SECRET and JWT_REFRESH_SECRET must be different', 'JWT_SECRET and JWT_REFRESH_SECRET must be different in production.'],
  ['JWT_SECRET must be', 'Invalid JWT_SECRET: use a non-template secret of at least 32 characters without surrounding whitespace.'],
  ['JWT_REFRESH_SECRET must be', 'Invalid JWT_REFRESH_SECRET: use a non-template secret of at least 32 characters without surrounding whitespace.'],
  ['ENCRYPTION_KEY must be', 'Invalid ENCRYPTION_KEY: use a non-default secret of at least 32 characters in production.'],
  ['DEFT_SETUP_TOKEN_SHA256 must be', 'Invalid DEFT_SETUP_TOKEN_SHA256: use a SHA-256 hash in 64 lowercase hex characters.'],
  ['DEFT_SETUP_TOKEN_EXPIRES_AT must be', 'Invalid DEFT_SETUP_TOKEN_EXPIRES_AT: use a real ISO 8601 timestamp with a zone.'],
  ['DEFT_SETUP_TOKEN_EXPIRES_AT is required', 'DEFT_SETUP_TOKEN_EXPIRES_AT is required when DEFT_SETUP_TOKEN_SHA256 is set.'],
  ['Hosted mode needs a usable seat statement setup:', 'Invalid hosted seat setup: check DEFT_CELL_ID, DEFT_SEAT_PUBLIC_KEYS, DEFT_SEAT_STATEMENT_URL, DEFT_SEAT_FETCH_TOKEN and DEFT_HOSTED_SEATS_URL.'],
];

export function logStartupHint(error: unknown): string {
  try {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'EADDRINUSE') return 'EADDRINUSE: API listen port is already in use; check PORT or API_PORT.';
      if (error.code === 'EACCES') return 'EACCES: access denied; check the API listen port and filesystem permissions.';
      if (error.code === 'APP_RUN_KEYRING_INVALID') return 'Invalid App Run keyring configuration; check the App Run keyring setting.';
      if (error.code === 'APP_RUN_LEGACY_ROLLOUT_INVALID') return 'Legacy MCP cutover needs Run execution enabled.';
      if (error.code === 'APP_RUN_ORIGIN_ROLLOUT_INVALID') return 'App-origin Run intake needs Run execution and Apps enabled.';
      if (error.code === 'APP_AUTOMATION_ROLLOUT_INVALID') return 'App automations need Apps, Run execution and app-origin intake enabled.';
    }
    const message = error instanceof Error ? error.message : undefined;
    if (typeof message !== 'string') return 'Unclassified fatal error';
    for (const [prefix, hint] of STARTUP_HINTS) if (message.startsWith(prefix)) return hint;
    if (message.includes('hosted-only setting')) return 'Hosted-only settings require DEFT_HOSTED=true; otherwise remove DEFT_SETUP_TOKEN_*, DEFT_SEAT_* / DEFT_CELL_ID, DEFT_HOSTED_SEATS_URL and DEFT_HOSTED_LIMIT_* settings.';
  } catch { /* Malformed error objects must not break the fatal handler. */ }
  return 'Unclassified fatal error';
}
