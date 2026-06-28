// Postgres-based job queue for Deft background jobs — replaces BullMQ/Redis
import { db } from './db.js';
import { jobQueue } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { OBSERVE_CHAT_MESSAGE_JOB, markObservationFailedFromJobData } from './chat-observation.js';

export const QUEUE_NAMES = {
  AGENT_JOBS: 'agent-jobs',
  SCHEDULED_JOBS: 'scheduled-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Enqueue a job onto a named queue.
 *
 * @param queueName - Which queue to add the job to
 * @param jobName   - Logical job name (dispatched to a handler in the worker)
 * @param data      - Arbitrary JSON payload
 * @param opts      - Optional: delay (ms), maxAttempts
 */
export async function enqueue(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts?: { delay?: number; maxAttempts?: number },
): Promise<void> {
  const runAt = opts?.delay
    ? new Date(Date.now() + opts.delay)
    : new Date();

  await db.insert(jobQueue).values({
    queue: queueName,
    name: jobName,
    data,
    status: 'pending',
    max_attempts: opts?.maxAttempts ?? 3,
    run_at: runAt,
  });
}

/**
 * Dequeue the next available job using SELECT ... FOR UPDATE SKIP LOCKED.
 * Atomically claims the job by setting status='running'.
 */
export async function dequeueJob(
  queueName: QueueName,
): Promise<{ id: string; name: string; data: any; attempts: number } | null> {
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = 'running',
        started_at = now(),
        attempts = attempts + 1
    WHERE id = (
      SELECT id FROM job_queue
      WHERE status = 'pending'
        AND queue = ${queueName}
        AND run_at <= now()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, name, data, attempts
  `);

  const row = (result as any).rows?.[0] ?? (result as any)[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    attempts: row.attempts,
  };
}

/**
 * Mark a job as completed.
 */
export async function completeJob(jobId: string): Promise<void> {
  await db
    .update(jobQueue)
    .set({ status: 'completed', completed_at: new Date() })
    .where(eq(jobQueue.id, jobId));
}

/**
 * Mark a job as failed. If attempts < max_attempts, requeue with exponential backoff.
 */
export async function failJob(jobId: string, error: string): Promise<void> {
  // Fetch current state
  const [job] = await db
    .select({
      attempts: jobQueue.attempts,
      max_attempts: jobQueue.max_attempts,
      name: jobQueue.name,
      data: jobQueue.data,
    })
    .from(jobQueue)
    .where(eq(jobQueue.id, jobId))
    .limit(1);

  if (!job) return;

  if (job.attempts < job.max_attempts) {
    if (job.name === OBSERVE_CHAT_MESSAGE_JOB) {
      await markObservationFailedFromJobData({ data: job.data, retrying: true, error });
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, ...
    const backoffMs = Math.min(1000 * Math.pow(2, job.attempts - 1), 60000);
    await db
      .update(jobQueue)
      .set({
        status: 'pending',
        run_at: new Date(Date.now() + backoffMs),
        error,
      })
      .where(eq(jobQueue.id, jobId));
  } else {
    if (job.name === OBSERVE_CHAT_MESSAGE_JOB) {
      await markObservationFailedFromJobData({ data: job.data, retrying: false, error });
    }
    await db
      .update(jobQueue)
      .set({ status: 'failed', error })
      .where(eq(jobQueue.id, jobId));
  }
}

/**
 * Ensure a cron job exists (idempotent).
 * If no pending job with this cron_key exists, insert one.
 */
export async function ensureCronJob(
  queueName: QueueName,
  jobName: string,
  cronKey: string,
  data?: Record<string, unknown>,
  delay?: number,
): Promise<void> {
  // Check if a pending job with this cron_key already exists
  const [existing] = await db
    .select({ id: jobQueue.id })
    .from(jobQueue)
    .where(and(eq(jobQueue.cron_key, cronKey), eq(jobQueue.status, 'pending')))
    .limit(1);

  if (existing) return;

  const runAt = delay ? new Date(Date.now() + delay) : new Date();

  await db.insert(jobQueue).values({
    queue: queueName,
    name: jobName,
    data: data ?? {},
    status: 'pending',
    max_attempts: 2,
    run_at: runAt,
    cron_key: cronKey,
  });
}

/**
 * Reset stale jobs stuck in 'running' status (worker crash recovery).
 * Jobs running for more than 5 minutes are considered stale.
 */
export async function cleanupStaleJobs(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = CASE
      WHEN attempts < max_attempts THEN 'pending'
      ELSE 'failed'
    END,
    error = 'stale: worker timeout after 5 minutes',
    run_at = CASE
      WHEN attempts < max_attempts THEN now() + interval '5 seconds'
      ELSE run_at
    END
    WHERE status = 'running'
      AND started_at < now() - interval '5 minutes'
    RETURNING id
  `);
  const rows = (result as any).rows ?? (result as any);
  return Array.isArray(rows) ? rows.length : 0;
}

export { QUEUE_NAMES as default };
