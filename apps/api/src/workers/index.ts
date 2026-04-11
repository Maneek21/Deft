// Postgres-based job workers — polls job_queue table and dispatches to handlers
import { dequeueJob, completeJob, failJob, ensureCronJob, QUEUE_NAMES } from '../lib/queues.js';
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
};

const CRON_KEYS: Record<string, string> = {
  'standup-generate': 'cron:standup',
  'nudge-check': 'cron:nudge',
  'meeting-prep-check': 'cron:meeting-prep',
  'people-graph': 'cron:people-graph',
  'manager-pulse': 'cron:manager-pulse',
  'burnout-detect': 'cron:burnout-detect',
  'weekly-digest': 'cron:weekly-digest',
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
