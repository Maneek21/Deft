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
  'agent-heartbeat': 60000,       // 60 seconds
  'gateway-ping': 60000,          // 60 seconds — Phase 11
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
  'gateway-ping': 'gateway-ping',
};

// ─── Lazy-loaded handler registry ───
async function getAgentJobHandler(jobName: string): Promise<JobHandler | null> {
  switch (jobName) {
    case 'agent-reply': {
      const mod = await import('./handlers/agent-reply.js');
      return mod.handleAgentReply;
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
    case 'deploy-provision': {
      // Phase 8 — wizard submission handler. Dispatches to the correct
      // DeploymentProvider and persists provider_instances + updates the
      // employee row based on the result.
      const mod = await import('./handlers/deploy-provision.js');
      return mod.handleDeployProvision;
    }
    default:
      return null;
  }
}

async function getScheduledJobHandler(jobName: string): Promise<JobHandler | null> {
  switch (jobName) {
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
    case 'agent-heartbeat': {
      const mod = await import('./handlers/agent-employee-heartbeat.js');
      return mod.handleAgentEmployeeHeartbeat;
    }
    case 'gateway-ping': {
      // Phase 11 — per-Gateway connectivity ping. Distinct from the
      // proactive wake-up agent-heartbeat handler above; this one only
      // verifies the OpenClaw Gateway is reachable and updates per-row
      // connection_status/gateway_ping_fail_count.
      const mod = await import('./handlers/gateway-ping.js');
      return mod.handleGatewayPing;
    }
    default:
      return null;
  }
}

async function getHandler(queueName: string, jobName: string): Promise<JobHandler | null> {
  if (queueName === QUEUE_NAMES.AGENT_JOBS) return getAgentJobHandler(jobName);
  if (queueName === QUEUE_NAMES.SCHEDULED_JOBS) return getScheduledJobHandler(jobName);
  return null;
}

// ─── Public API ───
let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startWorkers(): void {
  if (pollingInterval) return;

  // Cleanup stale jobs on startup
  cleanupStaleJobs().then(count => {
    if (count > 0) console.log(`[workers] Recovered ${count} stale job(s) on startup`);
  }).catch(() => {});

  // Run stale cleanup every 60 seconds
  setInterval(() => {
    cleanupStaleJobs().then(count => {
      if (count > 0) console.log(`[workers] Recovered ${count} stale job(s)`);
    }).catch(() => {});
  }, 60000);

  // Poll every 3 seconds
  pollingInterval = setInterval(async () => {
    for (const queueName of Object.values(QUEUE_NAMES)) {
      try {
        const job = await dequeueJob(queueName);
        if (!job) continue;

        const handler = await getHandler(queueName, job.name);
        if (!handler) {
          await completeJob(job.id);
          continue;
        }

        try {
          await handler({ id: job.id, name: job.name, data: job.data });
          await completeJob(job.id);
          console.log(`[worker] Job ${job.name} (${job.id.slice(0, 8)}) completed`);

          // Re-enqueue cron jobs after completion
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
      } catch (err) {
        // Don't crash the poller on individual errors
      }
    }
  }, 3000);

  console.log('[workers] Postgres job poller started (3s interval)');
}

export function stopWorkers(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
