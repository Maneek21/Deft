import { QUEUE_NAMES, enqueue } from './queues.js';
import type { AppRunSafeView, AppRunTransaction } from './app-run-repository.js';

export const APP_RUN_ATTEMPT_JOB = 'app-run-attempt';

export interface AppRunAttemptScheduler {
  scheduleInTransaction(
    tx: AppRunTransaction,
    run: AppRunSafeView,
    now: Date,
  ): Promise<string | null>;
}

export interface AppRunAttemptQueue {
  enqueue(
    tx: AppRunTransaction,
    orgId: string,
    runId: string,
    attemptId: string,
  ): Promise<void>;
}

export const noOpAppRunAttemptScheduler: AppRunAttemptScheduler = Object.freeze({
  async scheduleInTransaction() { return null; },
});

export const noOpAppRunAttemptQueue: AppRunAttemptQueue = Object.freeze({
  async enqueue() {},
});

/** Queue identity contains only the exact durable attempt coordinates. The
 * input and provider credentials stay behind their respective repositories. */
export const postgresAppRunAttemptQueue: AppRunAttemptQueue = Object.freeze({
  async enqueue(
    tx: AppRunTransaction,
    orgId: string,
    runId: string,
    attemptId: string,
  ) {
    await enqueue(
      QUEUE_NAMES.AGENT_JOBS,
      APP_RUN_ATTEMPT_JOB,
      { orgId, runId, attemptId },
      {
        executor: tx,
        orgId,
        dedupeKey: `app-run-attempt:${attemptId}`,
        maxAttempts: 5,
      },
    );
  },
});
