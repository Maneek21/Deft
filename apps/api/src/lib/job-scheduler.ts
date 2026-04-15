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
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'weekly-digest', 'cron:weekly-digest');
  // Phase 11 — Gateway connectivity ping (distinct from agent-heartbeat).
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'gateway-ping', 'gateway-ping');
  console.log('[scheduler] Cron jobs registered');
}
