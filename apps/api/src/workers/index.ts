// Postgres-based job workers — polls job_queue table and dispatches to handlers
import { dequeueJob, completeJob, failJob, ensureCronJob, cleanupStaleJobs, QUEUE_NAMES } from '../lib/queues.js';
import type { JobHandler } from './types.js';

// ─── Cron re-enqueue delays ───
const CRON_DELAYS: Record<string, number> = {
  'standup-generate': 3600000,    // 1 hour
  'nudge-check': 3600000,         // 1 hour
  'meeting-prep-check': 900000,   // 15 min
  'people-graph': 86400000,       // 24 hours
  'manager-pulse': 86400000,      // 24 hours
  'burnout-detect': 86400000,     // 24 hours
  'weekly-digest': 604800000,     // 7 days
  'wiki-lint': 86400000,          // 24 hours
  'agent-daily-reset': 86400000,  // 24 hours
  'agent-heartbeat': 60000,       // 60 seconds (legacy — kept for rollout)
  // Single heartbeat scan for BYOA agents. The handler re-derives the
  // per-employee due set from
  // `last_heartbeat_at + heartbeat_interval_min`, so this is _scan_ cadence
  // not _fire_ cadence.
  'heartbeat-native': 5 * 60_000,
  // Task 8.7 — trigger dispatcher scan. 60s cadence so cron triggers
  // fire close to their scheduled time.
  'trigger-dispatch': 60_000,
  // ICS calendar sync scan. The handler re-derives the per-subscription
  // due set from `last_synced_at + sync_interval_min`, so this is _scan_
  // cadence not _fire_ cadence.
  'ics-sync': 60_000,
  'chat-observation-backfill': 5 * 60_000,
  'chat-knowledge-batch': 30 * 60_000,
};

const CRON_KEYS: Record<string, string> = {
  'standup-generate': 'cron:standup',
  'nudge-check': 'cron:nudge',
  'meeting-prep-check': 'cron:meeting-prep',
  'people-graph': 'cron:people-graph',
  'manager-pulse': 'cron:manager-pulse',
  'burnout-detect': 'cron:burnout-detect',
  'weekly-digest': 'cron:weekly-digest',
  'wiki-lint': 'cron:wiki-lint',
  'agent-daily-reset': 'agent-daily-reset',
  'agent-heartbeat': 'agent-heartbeat',
  'heartbeat-native': 'cron:heartbeat-native',
  'trigger-dispatch': 'cron:trigger-dispatch',
  'ics-sync': 'cron:ics-sync',
  'chat-observation-backfill': 'cron:chat-observation-backfill',
  'chat-knowledge-batch': 'cron:chat-knowledge-batch',
};

const JOB_TIMEOUT_MS = Number.parseInt(process.env.DEFT_JOB_TIMEOUT_MS ?? '120000', 10);
const WORKER_POLL_INTERVAL_MS = Number.parseInt(process.env.DEFT_WORKER_POLL_INTERVAL_MS ?? '1000', 10);
const WORKER_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.DEFT_WORKER_BATCH_SIZE ?? '5', 10));

function runWithTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  if (!Number.isFinite(JOB_TIMEOUT_MS) || JOB_TIMEOUT_MS <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${JOB_TIMEOUT_MS}ms`)),
      JOB_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

// ─── Lazy-loaded handler registry ───
async function getAgentJobHandler(jobName: string): Promise<JobHandler | null> {
  switch (jobName) {
    case 'agent-reply': {
      const mod = await import('./handlers/agent-reply.js');
      return mod.handleAgentReply;
    }
    case 'observe-chat-message': {
      const mod = await import('./handlers/observe-chat-message.js');
      return mod.handleObserveChatMessage;
    }
    case 'task-extract': {
      const mod = await import('./handlers/task-extract.js');
      return mod.handleTaskExtract;
    }
    case 'cross-reference': {
      const mod = await import('./handlers/cross-reference.js');
      return mod.handleCrossReference;
    }
    case 'embed-content': {
      const mod = await import('./handlers/embed-content.js');
      return mod.handleEmbedContent;
    }
    case 'memory-extract': {
      const mod = await import('./handlers/memory-extract.js');
      return mod.handleMemoryExtract;
    }
    case 'memory-capture': {
      const mod = await import('./handlers/memory-capture.js');
      return mod.handleMemoryCapture;
    }
    case 'chat-knowledge-batch': {
      const mod = await import('./handlers/chat-knowledge-batch.js');
      return mod.handleChatKnowledgeBatch;
    }
    case 'blocked-alert': {
      const mod = await import('./handlers/blocked-alert.js');
      return mod.handleBlockedAlert;
    }
    case 'duplicate-detect': {
      const mod = await import('./handlers/duplicate-detect.js');
      return mod.handleDuplicateDetect;
    }
    case 'clip-process': {
      const mod = await import('./handlers/clip-process.js');
      return mod.handleClipProcess;
    }
    case 'agent-employee-message': {
      const mod = await import('./handlers/agent-employee-message.js');
      return mod.handleAgentEmployeeMessage;
    }
    case 'agent-employee-task': {
      const mod = await import('./handlers/agent-employee-task.js');
      return mod.handleAgentEmployeeTask;
    }
    case 'plan-executor': {
      const mod = await import('./handlers/plan-executor.js');
      return mod.handlePlanExecutor;
    }
    case 'agent-employee-trigger': {
      const mod = await import('./handlers/agent-employee-trigger.js');
      return mod.handleAgentEmployeeTrigger;
    }
    case 'employee-trigger': {
      // Phase 6 — synthetic TriggerInvocation dispatcher. Receives cron-
      // and webhook-originated jobs enqueued by existing handlers when
      // an employee subscribes to that trigger kind.
      const mod = await import('./handlers/employee-trigger.js');
      return mod.handleEmployeeTrigger;
    }
    case 'workflow-execute': {
      // Task 5.7 — basic workflows executor. Runs the actions for a
      // workflow_rule whose trigger matched (currently only
      // task.status_changed) against a single task.
      const mod = await import('./handlers/workflow-execute.js');
      return mod.handleWorkflowExecute;
    }
    default:
      return null;
  }
}

async function getScheduledJobHandler(jobName: string): Promise<JobHandler | null> {
  switch (jobName) {
    case 'chat-knowledge-batch': {
      const mod = await import('./handlers/chat-knowledge-batch.js');
      return mod.handleChatKnowledgeBatch;
    }
    case 'standup-generate': {
      const mod = await import('./handlers/standup-generate.js');
      return mod.handleStandupGenerate;
    }
    case 'nudge-check': {
      const mod = await import('./handlers/nudge-check.js');
      return mod.handleNudgeCheck;
    }
    case 'meeting-prep-check': {
      const mod = await import('./handlers/meeting-prep-check.js');
      return mod.handleMeetingPrepCheck;
    }
    case 'people-graph': {
      const mod = await import('./handlers/people-graph.js');
      return mod.handlePeopleGraph;
    }
    case 'manager-pulse': {
      const mod = await import('./handlers/manager-pulse.js');
      return mod.handleManagerPulse;
    }
    case 'burnout-detect': {
      const mod = await import('./handlers/burnout-detect.js');
      return mod.handleBurnoutDetect;
    }
    case 'weekly-digest': {
      const mod = await import('./handlers/weekly-digest.js');
      return mod.handleWeeklyDigest;
    }
    case 'wiki-lint': {
      const mod = await import('./handlers/wiki-lint.js');
      return mod.handleWikiLint;
    }
    case 'agent-daily-reset': {
      const mod = await import('./handlers/agent-daily-reset.js');
      return mod.handleAgentDailyReset;
    }
    case 'reminder-fire': {
      // Block 0.4 — fires a single reminder row. Enqueued by
      // POST /api/reminders with delay = remind_at - now. Rehydrated at
      // startup for reminders that survived a restart.
      const mod = await import('./handlers/reminder-fire.js');
      return mod.reminderFireHandler;
    }
    case 'agent-heartbeat':
    case 'heartbeat-native': {
      // Single heartbeat scan for BYOA agents — queues an
      // `agent_actions` row that the BYOA client picks up via
      // `poll_pending_work`.
      const mod = await import('./handlers/agent-employee-heartbeat.js');
      return mod.handleAgentEmployeeHeartbeat;
    }
    case 'trigger-dispatch': {
      // Task 8.7 — cron/webhook/event fan-out for employees subscribed
      // to a given trigger_kind.
      const mod = await import('./handlers/trigger-dispatch.js');
      return mod.handleTriggerDispatch;
    }
    case 'ics-sync': {
      // ICS calendar feed sync — fetch all due ics_subscriptions, parse,
      // upsert events with source='ics'.
      const mod = await import('./handlers/ics-sync.js');
      return mod.handleIcsSync;
    }
    case 'chat-observation-backfill': {
      const mod = await import('./handlers/chat-observation-backfill.js');
      return mod.handleChatObservationBackfill;
    }
    default:
      return null;
  }
}

export async function _getScheduledJobHandlerForTest(jobName: string): Promise<JobHandler | null> {
  return getScheduledJobHandler(jobName);
}

async function getHandler(queueName: string, jobName: string): Promise<JobHandler | null> {
  if (queueName === QUEUE_NAMES.AGENT_JOBS) return getAgentJobHandler(jobName);
  if (queueName === QUEUE_NAMES.SCHEDULED_JOBS) return getScheduledJobHandler(jobName);
  return null;
}

async function processDequeuedJob(
  queueName: string,
  job: { id: string; name: string; data: any },
): Promise<void> {
  const handler = await getHandler(queueName, job.name);
  if (!handler) {
    await completeJob(job.id);
    return;
  }

  try {
    await runWithTimeout(
      handler({ id: job.id, name: job.name, data: job.data }),
      `Job ${job.name} (${job.id.slice(0, 8)})`,
    );
    await completeJob(job.id);
    console.log(`[worker] Job ${job.name} (${job.id.slice(0, 8)}) completed`);

    const cronKey = CRON_KEYS[job.name];
    const cronDelay = CRON_DELAYS[job.name];
    if (cronKey && cronDelay) {
      await ensureCronJob(
        queueName as any,
        job.name,
        cronKey,
        {},
        cronDelay,
      );
    }
  } catch (err) {
    await failJob(job.id, (err as Error).message);
    console.error(`[worker] Job ${job.name} failed:`, (err as Error).message);
  }
}

async function pollQueueBatch(queueName: string): Promise<void> {
  const jobs: Array<{ id: string; name: string; data: any }> = [];
  for (let i = 0; i < WORKER_BATCH_SIZE; i += 1) {
    const job = await dequeueJob(queueName as any);
    if (!job) break;
    jobs.push(job);
  }
  if (jobs.length === 0) return;
  await Promise.all(jobs.map((job) => processDequeuedJob(queueName, job)));
}

// ─── Public API ───
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

export function startWorkers(): void {
  if (pollingInterval) return;

  // Cleanup stale jobs on startup
  cleanupStaleJobs().then(count => {
    if (count > 0) console.log(`[workers] Recovered ${count} stale job(s) on startup`);
  }).catch(() => {});

  // Block 0.4 — rehydrate pending reminders into the scheduled-jobs queue
  // so sub-24h reminders scheduled before a restart still fire.
  import('./handlers/reminder-fire.js')
    .then((mod) => mod.rehydratePendingReminders())
    .catch((err) => console.warn('[workers] reminder rehydrate failed:', err));

  // Run stale cleanup every 60 seconds
  setInterval(() => {
    cleanupStaleJobs().then(count => {
      if (count > 0) console.log(`[workers] Recovered ${count} stale job(s)`);
    }).catch(() => {});
  }, 60000);

  pollingInterval = setInterval(async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      await Promise.all(
        Object.values(QUEUE_NAMES).map((queueName) => pollQueueBatch(queueName)),
      );
    } catch {
      // Don't crash the poller on individual errors.
    } finally {
      pollInFlight = false;
    }
  }, WORKER_POLL_INTERVAL_MS);

  console.log(
    `[workers] Postgres job poller started (${WORKER_POLL_INTERVAL_MS}ms interval, batch ${WORKER_BATCH_SIZE})`,
  );
}

export function stopWorkers(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
