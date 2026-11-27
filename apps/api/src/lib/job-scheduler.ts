// Cron job scheduler — registers repeatable jobs in Postgres job_queue
import { ensureCronJob, QUEUE_NAMES } from './queues.js';
import { APP_AUTOMATIONS_ENABLED } from './env.js';
import { ensureAppResourceSyncScan } from './app-resource-sync-scanner.js';
import { isPausedStart } from './paused-start.js';

export async function initScheduler(): Promise<void> {
  // A paused start registers no cron job (server.ts also skips this call).
  if (isPausedStart()) return;
  // Re-enqueue cron jobs on startup (idempotent — skips if already pending)
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'standup-generate', 'cron:standup');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'nudge-check', 'cron:nudge');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'meeting-prep-check', 'cron:meeting-prep');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'ics-sync', 'cron:ics-sync');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'chat-observation-backfill', 'cron:chat-observation-backfill');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'chat-knowledge-batch', 'cron:chat-knowledge-batch');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'attention-maintenance', 'cron:attention-maintenance');
  // Agent edit suggestions pending for 14 days expire (M6): once a day, each
  // day's run keyed `document-suggestion-expiry:<yyyy-mm-dd>`.
  const { ensureDocumentSuggestionExpiry } = await import('../workers/handlers/document-suggestion-expiry.js');
  await ensureDocumentSuggestionExpiry();
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'people-graph', 'cron:people-graph');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'manager-pulse', 'cron:manager-pulse');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'burnout-detect', 'cron:burnout-detect');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'wiki-lint', 'cron:wiki-lint');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'weekly-digest', 'cron:weekly-digest');
  // BYOA agents pull pending work over MCP, so no server-side push scan
  // is required. The heartbeat cron only fires for in-process schedulers
  // that need a periodic tick.
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'heartbeat-native', 'cron:heartbeat-native');
  // Task 8.5 — reset daily cost + action counters at UTC midnight. The
  // handler itself is idempotent, so a missed tick just catches up on
  // the next poll.
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'agent-daily-reset', 'agent-daily-reset');
  // Task 8.7 — trigger dispatcher cron entry points. The handler fans
  // out to employees subscribed to each trigger_kind (via
  // trigger_subscriptions[] + installed skills' agent_config.triggers).
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'trigger-dispatch', 'cron:trigger-dispatch');
  if (APP_AUTOMATIONS_ENABLED) {
    await ensureCronJob(
      QUEUE_NAMES.SCHEDULED_JOBS,
      'app-automation-scan',
      'cron:app-automation-scan',
    );
  }
  await ensureAppResourceSyncScan(0);
  console.log('[scheduler] Cron jobs registered');
}

/**
 * Cadence override helper — re-inserts the native-heartbeat cron entry.
 * ensureCronJob is idempotent, so this is a no-op when a pending row
 * already exists. The worker's CRON_DELAYS map owns the actual cadence.
 */
export async function rescheduleHeartbeat(
  kind: 'native' = 'native',
): Promise<void> {
  void kind;
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'heartbeat-native', 'cron:heartbeat-native');
}
