// Cron job scheduler — registers repeatable jobs in Postgres job_queue
import { ensureCronJob, QUEUE_NAMES } from './queues.js';

export async function initScheduler(): Promise<void> {
  // Re-enqueue cron jobs on startup (idempotent — skips if already pending)
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'standup-generate', 'cron:standup');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'nudge-check', 'cron:nudge');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'meeting-prep-check', 'cron:meeting-prep');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'people-graph', 'cron:people-graph');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'manager-pulse', 'cron:manager-pulse');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'burnout-detect', 'cron:burnout-detect');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'wiki-lint', 'cron:wiki-lint');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'deprecation-warning', 'cron:deprecation-warning');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'weekly-digest', 'cron:weekly-digest');
  // Task 4.14 — daily sweep that turns newer skill versions into
  // `skill_update_available` notifications for the employee's owner.
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'skill-update-check', 'cron:skill-update-check');
  // Phase 11 — Gateway connectivity ping (distinct from agent-heartbeat).
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'gateway-ping', 'gateway-ping');
  // Task 8.1 — split heartbeat cadence by kind.
  //   - native cron polls every 5min (runAgentQuery + MCP)
  //   - openclaw cron polls every 30min (SSE dispatch + Gateway)
  // The single-scan handler filters employees by `kind` based on the
  // incoming job name.
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'heartbeat-native', 'cron:heartbeat-native');
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'heartbeat-openclaw', 'cron:heartbeat-openclaw');
  // Task 8.5 — reset daily cost + action counters at UTC midnight. The
  // handler itself is idempotent, so a missed tick just catches up on
  // the next poll.
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'agent-daily-reset', 'agent-daily-reset');
  // Task 8.7 — trigger dispatcher cron entry points. The handler fans
  // out to employees subscribed to each trigger_kind (via
  // trigger_subscriptions[] + installed skills' agent_config.triggers).
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'trigger-dispatch', 'cron:trigger-dispatch');
  console.log('[scheduler] Cron jobs registered');
}

/**
 * Task 8.3 — cadence override. Cancels the currently-pending cron job
 * for the given scope and re-enqueues it with the new delay so a fresh
 * cadence takes effect on the next tick.
 *
 * `kind` maps to the job name the poller already dispatches on:
 *   - 'native'   → 'heartbeat-native'
 *   - 'openclaw' → 'heartbeat-openclaw'
 *
 * This is a best-effort helper — the worker's re-enqueue loop always
 * uses the latest `CRON_DELAYS[name]` value, so callers that want an
 * org-wide cadence flip can just change the delay map. For per-employee
 * overrides the handler reads `heartbeat_interval_min` at scan time.
 */
export async function rescheduleHeartbeat(
  kind: 'native' | 'openclaw',
): Promise<void> {
  const name = kind === 'native' ? 'heartbeat-native' : 'heartbeat-openclaw';
  const cronKey = `cron:${name}`;
  // Re-insertion is idempotent: ensureCronJob no-ops if a pending row
  // already exists for the cron_key. The worker's CRON_DELAYS map owns
  // the actual cadence.
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, name, cronKey);
}
