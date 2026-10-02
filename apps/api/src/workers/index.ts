// PostgreSQL job workers — poll job_queue and dispatch leased jobs to handlers.
import {
  dequeueJob,
  completeJob,
  deferJob,
  failJob,
  ensureCronJob,
  cleanupStaleJobs,
  pruneFinishedJobs,
  renewJobLease,
  RetryLaterJobError,
  QUEUE_NAMES,
  type DequeuedJob,
  type QueueName,
} from '../lib/queues.js';
import { sweepExpiredStagedAttachments } from '../lib/attachment-retention.js';
import { APP_AUTOMATIONS_ENABLED, APP_RUNS_ENABLED, isAppAttachmentBrokerEnabled } from '../lib/env.js';
import { APP_RESOURCE_SYNC_SCAN_JOB, ensureAppResourceSyncScan } from '../lib/app-resource-sync-scanner.js';
import { APP_AUTOMATION_SCAN_CRON, ensureAppAutomationScan } from '../lib/app-automation-scan-progress.js';
import type { JobHandler } from './types.js';

// ─── Cron re-enqueue delays ───
const CRON_DELAYS: Record<string, number> = {
  'standup-generate': 5 * 60_000, // timezone-aware scan; durable run key prevents duplicates
  'nudge-check': 3600000,         // 1 hour
  'meeting-prep-check': 5 * 60_000, // overlapping 30-minute lookahead
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
  'attention-maintenance': 15 * 60_000,
  'app-automation-scan': 60_000,
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
  'attention-maintenance': 'cron:attention-maintenance',
  'app-automation-scan': 'cron:app-automation-scan',
};

const JOB_TIMEOUT_MS = Number.parseInt(process.env.DEFT_JOB_TIMEOUT_MS ?? '120000', 10);
const WORKER_POLL_INTERVAL_MS = Number.parseInt(process.env.DEFT_WORKER_POLL_INTERVAL_MS ?? '1000', 10);
const WORKER_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.DEFT_WORKER_BATCH_SIZE ?? '5', 10));
const JOB_LEASE_MS = Math.max(
  10_000,
  Number.parseInt(process.env.DEFT_JOB_LEASE_MS ?? '60000', 10),
);
const LEASE_RENEW_INTERVAL_MS = Math.max(1_000, Math.floor(JOB_LEASE_MS / 3));
const STALE_CLEANUP_INTERVAL_MS = Math.max(5_000, Math.min(60_000, Math.floor(JOB_LEASE_MS / 2)));
const RETENTION_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.DEFT_JOB_RETENTION_SWEEP_MS ?? '3600000', 10),
);
const JOB_RETENTION_MS = Math.max(
  60_000,
  Number.parseInt(process.env.DEFT_JOB_RETENTION_MS ?? String(7 * 24 * 60 * 60_000), 10),
);
const WORKER_SHUTDOWN_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.DEFT_WORKER_SHUTDOWN_TIMEOUT_MS ?? '10000', 10),
);
const ATTENTION_PROJECTION_BATCH_SIZE = Math.max(
  WORKER_BATCH_SIZE,
  Number.parseInt(process.env.DEFT_ATTENTION_PROJECTION_BATCH_SIZE ?? '25', 10),
);

type HandlerResolver = (queueName: string, jobName: string) => Promise<JobHandler | null>;

export type WorkerProcessOverrides = {
  resolveHandler?: HandlerResolver;
  timeoutMs?: number;
  leaseMs?: number;
  renewIntervalMs?: number;
  recurrence?: { cronKey: string; delayMs: number } | null;
};

class JobTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobTimeoutError';
  }
}

const activeControllers = new Map<string, {
  controller: AbortController;
  jobs: number;
  settled: Promise<void>;
  capacityReserved: boolean;
}>();
type TrackExecution = (settled: Promise<void>) => void;

async function runClaimedWork<T>(
  jobs: DequeuedJob[],
  label: string,
  work: (signal: AbortSignal) => Promise<T>,
  overrides?: WorkerProcessOverrides,
  trackExecution?: TrackExecution,
): Promise<T> {
  const timeoutMs = overrides?.timeoutMs ?? JOB_TIMEOUT_MS;
  const leaseMs = overrides?.leaseMs ?? JOB_LEASE_MS;
  const renewIntervalMs = overrides?.renewIntervalMs
    ?? Math.max(1_000, Math.min(LEASE_RENEW_INTERVAL_MS, Math.floor(leaseMs / 3)));
  const executionId = crypto.randomUUID();
  const controller = new AbortController();
  let renewalSettled: Promise<void> = Promise.resolve();
  // Keep tracking the underlying handler after Promise.race returns. Most
  // handlers are not cancellation-aware yet, so shutdown health must not call
  // an ignored AbortSignal "finished".
  const workPromise = Promise.resolve().then(() => work(controller.signal));
  const settled = workPromise.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    activeControllers.delete(executionId);
  });
  activeControllers.set(executionId, { controller, jobs: jobs.length, settled, capacityReserved: !!trackExecution });
  trackExecution?.(settled.then(() => renewalSettled));

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let renewalInFlight = false;
  const renewal = setInterval(() => {
    if (renewalInFlight || controller.signal.aborted) return;
    renewalInFlight = true;
    renewalSettled = Promise.all(jobs.map((job) => renewJobLease(job.id, job.lockToken, leaseMs)))
      .then((renewed) => {
        if (renewed.some((owned) => !owned) && !controller.signal.aborted) {
          controller.abort(new Error(`${label} lost its job lease`));
        }
      })
      .catch((err) => {
        console.warn(`[worker] Lease renewal failed for ${label}:`, (err as Error).message);
      })
      .finally(() => {
        renewalInFlight = false;
      });
  }, renewIntervalMs);
  renewal.unref?.();

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const reason = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error(`${label} aborted`));
    }, { once: true });
  });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(new JobTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  }

  try {
    return await Promise.race([workPromise, aborted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    clearInterval(renewal);
    // Scanner SQL has server-enforced limits and cooperative transaction
    // rollback. Keep its worker slot until that bounded rollback has settled;
    // otherwise a timed-out scan could overlap with its replacement.
    if (jobs.length > 0 && jobs.every(job => job.name === 'app-automation-scan')) {
      await settled;
    }
  }
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
    case 'app-run-attempt': {
      const mod = await import('../lib/app-run-worker-handler.js');
      return mod.handleAppRunAttempt;
    }
    case 'app-run-attention': {
      const mod = await import('../lib/app-run-maintenance-attention.js');
      return mod.handleAppRunAttention;
    }
    case 'app-public-ingress': {
      const mod = await import('../lib/app-public-worker-handler.js');
      return mod.handleAppPublicIngress;
    }
    case 'certification-noop': {
      // Synthetic 60-person certification intentionally measures queue claim,
      // completion, and recovery without invoking a product side effect.
      return async () => {};
    }
    default:
      return null;
  }
}

async function getScheduledJobHandler(jobName: string): Promise<JobHandler | null> {
  switch (jobName) {
    case 'app-resource-sync-scan': {
      const mod = await import('./handlers/app-resource-sync-scan.js');
      return mod.handleAppResourceSyncScan;
    }
    case 'app-automation-scan': {
      const mod = await import('./handlers/app-automation-scan.js');
      return mod.handleAppAutomationScan;
    }
    case 'app-automation-fire': {
      const mod = await import('./handlers/app-automation-fire.js');
      return mod.handleAppAutomationFire;
    }
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
    case 'scheduled-message-send': {
      const mod = await import('./handlers/scheduled-message-send.js');
      return mod.handleScheduledMessageSend;
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
    case 'attention-maintenance': {
      const mod = await import('./handlers/attention-maintenance.js');
      return mod.handleAttentionMaintenance;
    }
    case 'attention-delivery': {
      const mod = await import('./handlers/attention-delivery.js');
      return mod.handleAttentionDelivery;
    }
    case 'notification-attention-sync': {
      const mod = await import('./handlers/notification-attention-sync.js');
      return mod.handleNotificationAttentionSync;
    }
    default:
      return null;
  }
}

export async function _getScheduledJobHandlerForTest(jobName: string): Promise<JobHandler | null> {
  return getScheduledJobHandler(jobName);
}

export async function _getAgentJobHandlerForTest(jobName: string): Promise<JobHandler | null> {
  return getAgentJobHandler(jobName);
}

async function getHandler(queueName: string, jobName: string): Promise<JobHandler | null> {
  if (queueName === QUEUE_NAMES.AGENT_JOBS) return getAgentJobHandler(jobName);
  if (queueName === QUEUE_NAMES.SCHEDULED_JOBS) return getScheduledJobHandler(jobName);
  return null;
}

async function processDequeuedJob(
  queueName: string,
  job: DequeuedJob,
  overrides?: WorkerProcessOverrides,
  trackExecution?: TrackExecution,
): Promise<void> {
  let settledOwned = false;
  let succeeded = false;
  try {
    const handler = await (overrides?.resolveHandler ?? getHandler)(queueName, job.name);
    if (!handler) {
      const reason = `Unknown ${queueName} job: ${job.name}`;
      const settled = await failJob(job.id, job.lockToken, reason, { terminal: true });
      settledOwned = settled;
      if (settled) console.error(`[worker] ${reason}; terminal-failed ${job.id.slice(0, 8)}`);
      return;
    }

    await runClaimedWork(
      [job],
      `Job ${job.name} (${job.id.slice(0, 8)})`,
      async (signal) => {
        const runtimeJob = {
          id: job.id,
          name: job.name,
          data: job.data,
          attempts: job.attempts,
          lockToken: job.lockToken,
          leaseExpiresAt: job.lockExpiresAt,
          signal,
        };
        await handler(runtimeJob);
      },
      overrides,
      trackExecution,
    );
    const settled = await completeJob(job.id, job.lockToken);
    settledOwned = settled;
    succeeded = settled;
    if (settled) {
      console.log(`[worker] Job ${job.name} (${job.id.slice(0, 8)}) completed`);
    } else {
      console.warn(`[worker] Job ${job.name} (${job.id.slice(0, 8)}) finished after losing its lease`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RetryLaterJobError) {
      const settled = await deferJob(job.id, job.lockToken, message, err.delayMs);
      if (settled) console.warn(`[worker] Job ${job.name} deferred:`, message);
      return;
    }
    // Until every handler cooperatively cancels its I/O, retrying immediately
    // after a timeout can overlap with the still-running original promise.
    // Terminal-fail the occurrence; operators can inspect/replay it explicitly.
    const settled = await failJob(job.id, job.lockToken, message, {
      terminal: err instanceof JobTimeoutError,
    });
    settledOwned = settled;
    if (settled) console.error(`[worker] Job ${job.name} failed:`, message);
  } finally {
    if (job.name === 'app-automation-scan' && job.cronKey === APP_AUTOMATION_SCAN_CRON) {
      if (settledOwned) {
        try { await ensureAppAutomationScan({ mode: succeeded ? 'success' : 'failure', completed_job_id: job.id }); }
        catch { console.warn('[worker] Could not schedule next automation scan'); }
      }
    }
    if (job.name === APP_RESOURCE_SYNC_SCAN_JOB) {
      try { await ensureAppResourceSyncScan(); }
      catch { console.warn('[worker] Could not schedule next resource sync scan'); }
    }
    // A terminally failed occurrence must not stop its recurring chain. If the
    // failure is retryable, the active-cron constraint leaves the retry as the
    // sole occurrence and this insert becomes a no-op.
    const recurrence = job.name === 'app-automation-scan' && (!APP_AUTOMATIONS_ENABLED || job.cronKey === APP_AUTOMATION_SCAN_CRON)
      ? null
      : overrides?.recurrence !== undefined
      ? overrides.recurrence
      : job.cronKey && CRON_DELAYS[job.name]
        ? { cronKey: job.cronKey, delayMs: CRON_DELAYS[job.name]! }
        : null;
    if (recurrence) {
      try {
        await ensureCronJob(
          queueName as QueueName,
          job.name,
          recurrence.cronKey,
          {},
          recurrence.delayMs,
        );
      } catch (err) {
        console.warn(`[worker] Could not schedule the next ${job.name} occurrence:`, (err as Error).message);
      }
    }
  }
}

async function processAttentionProjectionGroup(
  queueName: string,
  jobs: DequeuedJob[],
  overrides?: WorkerProcessOverrides,
  trackExecution?: TrackExecution,
): Promise<void> {
  const notificationIds = Array.from(new Set(jobs.flatMap((job) =>
    Array.isArray(job.data?.notificationIds) ? job.data.notificationIds : [],
  )));
  const timestamps = jobs
    .map((job) => typeof job.data?.enqueuedAt === 'string' ? Date.parse(job.data.enqueuedAt) : Number.NaN)
    .filter(Number.isFinite);
  const merged = {
    id: jobs[0]!.id,
    name: 'notification-attention-sync',
    attempts: Math.max(...jobs.map((job) => job.attempts)),
    data: {
      orgId: jobs[0]!.data?.orgId,
      notificationIds,
      enqueuedAt: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : undefined,
    },
  };
  try {
    const handler = await (overrides?.resolveHandler ?? getHandler)(queueName, merged.name);
    if (!handler) {
      await Promise.all(jobs.map((job) => failJob(
        job.id,
        job.lockToken,
        `Unknown ${queueName} job: ${merged.name}`,
        { terminal: true },
      )));
      return;
    }

    await runClaimedWork(
      jobs,
      `Job group ${merged.name} (${jobs.length} jobs)`,
      async (signal) => {
        const runtimeJob = { ...merged, signal };
        await handler(runtimeJob);
      },
      overrides,
      trackExecution,
    );
    const settled = await Promise.all(jobs.map((job) => completeJob(job.id, job.lockToken)));
    const settledCount = settled.filter(Boolean).length;
    console.log(`[worker] Job group ${merged.name} settled ${settledCount}/${jobs.length} jobs`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Promise.all(jobs.map((job) => failJob(job.id, job.lockToken, message, {
      terminal: err instanceof JobTimeoutError,
    })));
    console.error(`[worker] Job group ${merged.name} failed:`, message);
  }
}

const reservedQueueSlots = new Map<QueueName, number>();
const processingInFlight = new Set<Promise<void>>();

function releaseQueueSlots(queueName: QueueName, count: number): void {
  const remaining = (reservedQueueSlots.get(queueName) ?? 0) - count;
  if (remaining > 0) reservedQueueSlots.set(queueName, remaining);
  else reservedQueueSlots.delete(queueName);
}

function launchClaimedGroup(queueName: QueueName, jobs: DequeuedJob[], grouped: boolean,
  overrides?: WorkerProcessOverrides): Promise<void> {
  const executions: Promise<void>[] = [];
  const track: TrackExecution = settled => { executions.push(settled); };
  const processing = (grouped
    ? processAttentionProjectionGroup(queueName, jobs, overrides, track)
    : processDequeuedJob(queueName, jobs[0]!, overrides, track))
    .catch(error => { console.warn(`[workers] ${queueName} settlement failed:`, error instanceof Error ? error.message : String(error)); });
  // Timeout may settle a delivery before its handler cooperates. Capacity is
  // retained until BOTH queue settlement and all underlying work settle.
  const lifecycle = processing.then(async () => { await Promise.all(executions); }).finally(() => {
    releaseQueueSlots(queueName, jobs.length);
    processingInFlight.delete(lifecycle);
    lastPollAt = new Date();
  });
  processingInFlight.add(lifecycle);
  return processing;
}

async function pollQueueBatch(
  queueName: QueueName,
  opts?: { claimWhenStopped?: boolean; processOverrides?: WorkerProcessOverrides; backgroundDispatch?: boolean },
): Promise<void> {
  const jobs: DequeuedJob[] = [];
  const batchSize = queueName === QUEUE_NAMES.SCHEDULED_JOBS
    ? ATTENTION_PROJECTION_BATCH_SIZE
    : WORKER_BATCH_SIZE;
  const free = batchSize - (reservedQueueSlots.get(queueName) ?? 0);
  if (free <= 0) return; // Full capacity is not a heartbeat or a dequeue.
  let claimError: unknown;
  for (let i = 0; i < free; i += 1) {
    if (!workersRunning && !opts?.claimWhenStopped) break;
    if ((reservedQueueSlots.get(queueName) ?? 0) >= batchSize) break;
    reservedQueueSlots.set(queueName, (reservedQueueSlots.get(queueName) ?? 0) + 1);
    try {
      const job = await dequeueJob(queueName, { leaseMs: opts?.processOverrides?.leaseMs ?? JOB_LEASE_MS });
      if (!job) { releaseQueueSlots(queueName, 1); break; }
      jobs.push(job);
    } catch (error) {
      releaseQueueSlots(queueName, 1); claimError = error; break;
    }
  }
  if (jobs.length === 0) {
    if (claimError) throw claimError;
    if (workersRunning || opts?.claimWhenStopped) lastPollAt = new Date();
    return;
  }
  const projectionGroups = new Map<string, DequeuedJob[]>();
  const ordinaryJobs: DequeuedJob[] = [];
  for (const job of jobs) {
    if (job.name !== 'notification-attention-sync') {
      ordinaryJobs.push(job);
      continue;
    }
    const orgId = typeof job.data?.orgId === 'string' ? job.data.orgId : `invalid:${job.id}`;
    const group = projectionGroups.get(orgId) ?? [];
    group.push(job);
    projectionGroups.set(orgId, group);
  }
  const processing = [
    ...ordinaryJobs.map((job) => launchClaimedGroup(queueName, [job], false, opts?.processOverrides)),
    ...Array.from(projectionGroups.values()).map((group) =>
      launchClaimedGroup(queueName, group, true, opts?.processOverrides)),
  ];
  if (!opts?.backgroundDispatch) await Promise.all(processing);
  if (claimError) throw claimError;
}

export async function _processDequeuedJobForTest(
  queueName: QueueName,
  job: DequeuedJob,
  overrides?: WorkerProcessOverrides,
): Promise<void> {
  await processDequeuedJob(queueName, job, overrides);
}

export async function _pollQueueBatchForTest(
  queueName: QueueName,
  overrides?: WorkerProcessOverrides,
): Promise<void> {
  while (pollInFlight.has(queueName)) await pollInFlight.get(queueName);
  const promise = pollQueueBatch(queueName, { claimWhenStopped: true, processOverrides: overrides })
    .finally(() => { if (pollInFlight.get(queueName) === promise) pollInFlight.delete(queueName); });
  pollInFlight.set(queueName, promise);
  await promise;
}

// ─── Lifecycle ───
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let staleCleanupInterval: ReturnType<typeof setInterval> | null = null;
let retentionInterval: ReturnType<typeof setInterval> | null = null;
let workersRunning = false;
let workerStartedAt: Date | null = null;
let lastPollAt: Date | null = null;
let startingPromise: Promise<void> | null = null;
let stoppingPromise: Promise<void> | null = null;
const pollInFlight = new Map<QueueName, Promise<void>>();
const backgroundInFlight = new Set<Promise<unknown>>();

function trackBackground<T>(promise: Promise<T>): Promise<T> {
  backgroundInFlight.add(promise);
  void promise.finally(() => backgroundInFlight.delete(promise));
  return promise;
}

async function reconcileRecurringJobs(): Promise<void> {
  await ensureAppResourceSyncScan();
  await ensureAppAutomationScan({ mode: 'startup' });
  await Promise.all(Object.entries(CRON_KEYS)
    .filter(([jobName]) => jobName !== 'agent-heartbeat'
      && jobName !== 'app-automation-scan')
    .map(([jobName, cronKey]) => ensureCronJob(
      QUEUE_NAMES.SCHEDULED_JOBS,
      jobName,
      cronKey,
      {},
      CRON_DELAYS[jobName],
    )));
}

async function runStaleMaintenance(): Promise<void> {
  await Promise.all([
    (async () => {
      const count = await cleanupStaleJobs();
      if (count > 0) console.log(`[workers] Recovered ${count} expired job lease(s)`);
      // Repair a recurring occurrence after its durable queue settlement.
      await reconcileRecurringJobs();
    })(),
    import('../lib/app-private-state-retention.js').then(mod => mod.purgeExpiredPrivateAppState()),
    APP_RUNS_ENABLED ? import('../lib/app-run-maintenance.js').then(mod => mod.runAppRunMaintenance('recovery')) : Promise.resolve(),
  ]);
}

async function runRetentionMaintenance(): Promise<void> {
  const [pruned, attachments] = await Promise.all([
    pruneFinishedJobs(JOB_RETENTION_MS),
    sweepExpiredStagedAttachments(),
    APP_RUNS_ENABLED ? import('../lib/app-run-maintenance.js').then(mod => mod.runAppRunMaintenance('retention')) : Promise.resolve(),
    isAppAttachmentBrokerEnabled()?import('../lib/app-attachment-cleanup.js').then(async mod=>{
      const result=await mod.appAttachmentCleanup.run();
      if(result.failed)console.warn(`[app-attachments] ${result.failed} retained stage(s) require purge retry`);
    }):Promise.resolve(),
  ]);
  if (pruned > 0) console.log(`[workers] Pruned ${pruned} expired terminal job(s)`);
  if (attachments.deletedRows > 0) {
    console.log(`[workers] Pruned ${attachments.deletedRows} expired staged attachment(s)`);
  }
  if (attachments.orphanedStorageKeys.length > 0) {
    console.warn(
      `[workers] ${attachments.orphanedStorageKeys.length} attachment storage object(s) need cleanup retry`,
    );
  }
}

function dispatchPolls(): void {
  if (!workersRunning) return;
  for (const queueName of Object.values(QUEUE_NAMES)) {
    if (pollInFlight.has(queueName)) continue;
    let promise!: Promise<void>;
    promise = pollQueueBatch(queueName, { backgroundDispatch: true })
      .catch((err) => {
        console.warn(`[workers] ${queueName} poll failed:`, (err as Error).message);
      })
      .finally(() => {
        if (pollInFlight.get(queueName) === promise) pollInFlight.delete(queueName);
      });
    pollInFlight.set(queueName, promise);
  }
}

export type WorkerStatus = {
  running: boolean;
  startedAt: string | null;
  lastPollAt: string | null;
  inFlight: number;
};

export function getWorkerStatus(): WorkerStatus {
  return {
    running: workersRunning,
    startedAt: workerStartedAt?.toISOString() ?? null,
    lastPollAt: lastPollAt?.toISOString() ?? null,
    inFlight: Array.from(reservedQueueSlots.values()).reduce((total, count) => total + count, 0)
      + Array.from(activeControllers.values()).reduce((total, active) => total + (active.capacityReserved ? 0 : active.jobs), 0),
  };
}

async function startWorkersInternal(opts?: {
  skipStartupWork?: boolean;
  disableWorkDispatch?: boolean;
}): Promise<void> {
  if (workersRunning) return;
  if (stoppingPromise) await stoppingPromise;

  // Cleanup must finish before server.ts registers cron jobs. Otherwise an
  // exhausted legacy running occurrence can block registration and then be
  // terminal-failed after the scheduler has already moved on.
  if (!opts?.skipStartupWork) {
    const recovered = await cleanupStaleJobs();
    if (recovered > 0) console.log(`[workers] Recovered ${recovered} stale job(s) on startup`);
    await runRetentionMaintenance();

    const hydrationResults = await Promise.allSettled([
      import('./handlers/reminder-fire.js').then((mod) => mod.rehydratePendingReminders()),
      import('./handlers/scheduled-message-send.js')
        .then((mod) => mod.rehydratePendingScheduledMessages()),
    ]);
    for (const result of hydrationResults) {
      if (result.status === 'rejected') {
        console.warn('[workers] scheduled work rehydrate failed:', result.reason);
      }
    }
  }

  workersRunning = true;
  workerStartedAt = new Date();
  lastPollAt = null;

  staleCleanupInterval = setInterval(() => {
    if (opts?.disableWorkDispatch) return;
    void trackBackground(runStaleMaintenance().catch((err) => {
      console.warn('[workers] stale lease maintenance failed:', (err as Error).message);
    }));
  }, STALE_CLEANUP_INTERVAL_MS);
  staleCleanupInterval.unref?.();

  retentionInterval = setInterval(() => {
    if (opts?.disableWorkDispatch) return;
    void trackBackground(runRetentionMaintenance()
      .catch((err) => console.warn('[workers] retention sweep failed:', (err as Error).message)));
  }, RETENTION_SWEEP_INTERVAL_MS);
  retentionInterval.unref?.();

  pollingInterval = setInterval(() => {
    if (!opts?.disableWorkDispatch) dispatchPolls();
  }, WORKER_POLL_INTERVAL_MS);
  pollingInterval.unref?.();
  if (!opts?.disableWorkDispatch) dispatchPolls();

  console.log(
    `[workers] PostgreSQL job poller started (${WORKER_POLL_INTERVAL_MS}ms interval, batch ${WORKER_BATCH_SIZE})`,
  );
}

export async function startWorkers(): Promise<void> {
  if (workersRunning) return;
  if (!startingPromise) {
    startingPromise = startWorkersInternal().finally(() => {
      startingPromise = null;
    });
  }
  await startingPromise;
}

/** Lifecycle-only seam: starts/clears real timers without touching queue data. */
export async function _startWorkersForTest(): Promise<void> {
  if (workersRunning) return;
  if (!startingPromise) {
    startingPromise = startWorkersInternal({ skipStartupWork: true, disableWorkDispatch: true })
      .finally(() => {
        startingPromise = null;
      });
  }
  await startingPromise;
}

export async function stopWorkers(opts?: { timeoutMs?: number }): Promise<void> {
  if (stoppingPromise) return stoppingPromise;
  if (startingPromise) await startingPromise;
  if (!workersRunning && !pollingInterval && !staleCleanupInterval && !retentionInterval
    && !pollInFlight.size && !processingInFlight.size && !activeControllers.size && !backgroundInFlight.size) return;

  const timeoutMs = Math.max(1, opts?.timeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS);
  stoppingPromise = (async () => {
    workersRunning = false;
    if (APP_RUNS_ENABLED) {
      void trackBackground(import('../lib/app-run-maintenance.js').then(mod => mod.stopAppRunMaintenance()));
      // A gate may have been withdrawn after a cleanup pass started. Stop the
      // existing bounded pass even then; importing does not allocate its pool.
      void trackBackground(import('../lib/app-attachment-cleanup.js').then(mod=>mod.appAttachmentCleanup.stop()));
    }
    if (pollingInterval) clearInterval(pollingInterval);
    if (staleCleanupInterval) clearInterval(staleCleanupInterval);
    if (retentionInterval) clearInterval(retentionInterval);
    pollingInterval = null;
    staleCleanupInterval = null;
    retentionInterval = null;

    const started = performance.now();
    const drainUntil = async (deadline: number, reason?: Error): Promise<boolean> => {
      // A claim already awaiting SQL can add processing/controllers after
      // shutdown starts. Re-snapshot until everything settles, not just once.
      while (pollInFlight.size || processingInFlight.size || backgroundInFlight.size || activeControllers.size) {
        if (reason) for (const { controller } of activeControllers.values()) controller.abort(reason);
        const remaining = deadline - performance.now();
        if (remaining <= 0) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.allSettled([...pollInFlight.values(), ...processingInFlight.values(),
            ...backgroundInFlight.values(), ...Array.from(activeControllers.values(), active => active.settled)]),
          new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(20, remaining)); }),
        ]);
        if (timer) clearTimeout(timer);
      }
      return true;
    };
    if (!await drainUntil(started + Math.max(1, Math.floor(timeoutMs * 0.8)))) {
      const reason = new Error(`Worker shutdown exceeded ${timeoutMs}ms`);
      if (!await drainUntil(started + timeoutMs, reason)) {
        console.warn(`[workers] Shutdown deadline reached with ${activeControllers.size} execution(s) and ${pollInFlight.size} claim poll(s) still active`);
      }
    }
    workerStartedAt = null;
  })().finally(() => {
    stoppingPromise = null;
  });

  return stoppingPromise;
}
