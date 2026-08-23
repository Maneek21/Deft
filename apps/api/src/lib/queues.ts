// Durable PostgreSQL job queue. Delivery is at-least-once: handlers that
// perform side effects must be idempotent, because a worker can lose its lease
// after the side effect commits but before it settles the queue row.
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { OBSERVE_CHAT_MESSAGE_JOB, markObservationFailedFromJobData } from './chat-observation.js';

export const QUEUE_NAMES = {
  AGENT_JOBS: 'agent-jobs',
  SCHEDULED_JOBS: 'scheduled-jobs',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type QueueExecutor = {
  execute: typeof db.execute;
};

export type EnqueueOptions = {
  delay?: number;
  maxAttempts?: number;
  orgId?: string | null;
  dedupeKey?: string | null;
  /** Use a Drizzle transaction to atomically commit domain state + its job. */
  executor?: QueueExecutor;
};

export type DequeuedJob = {
  id: string;
  name: string;
  data: Record<string, any>;
  attempts: number;
  cronKey: string | null;
  lockedBy: string;
  lockToken: string;
  lockExpiresAt: Date;
};

export type DequeueOptions = {
  lockedBy?: string;
  leaseMs?: number;
};

export type FailJobOptions = {
  /** Terminal failures are never retried, regardless of max_attempts. */
  terminal?: boolean;
};

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_WORKER_ID = `deft:${process.pid}:${crypto.randomUUID()}`;

function resultRows(result: unknown): Array<Record<string, any>> {
  return ((result as { rows?: Array<Record<string, any>> }).rows ??
    (Array.isArray(result) ? result : [])) as Array<Record<string, any>>;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0
    ? Math.max(1, Math.floor(value!))
    : fallback;
}

function inferOrgId(data: Record<string, unknown>, explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  if (typeof data.orgId === 'string' && data.orgId) return data.orgId;
  if (typeof data.org_id === 'string' && data.org_id) return data.org_id;
  return null;
}

export function jobPriorityRank(queueName: QueueName | string, jobName: string): number {
  if (queueName !== QUEUE_NAMES.AGENT_JOBS) return 3;
  if (['agent-reply', 'agent-employee-message', 'agent-employee-task'].includes(jobName)) return 0;
  if (['employee-trigger', 'agent-employee-trigger', 'plan-executor'].includes(jobName)) return 1;
  if (jobName === OBSERVE_CHAT_MESSAGE_JOB) return 5;
  return 3;
}

/**
 * Enqueue a job. Existing callers can omit opts; producers that need durable
 * idempotency should provide a deterministic dedupeKey. A dedupe key remains
 * reserved until its terminal queue row is pruned by retention.
 */
export async function enqueue(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts?: EnqueueOptions,
): Promise<void> {
  const executor = opts?.executor ?? db;
  const delay = Math.max(0, opts?.delay ?? 0);
  const maxAttempts = positiveInteger(opts?.maxAttempts, 3);
  const orgId = inferOrgId(data, opts?.orgId);
  const dedupeKey = opts?.dedupeKey?.trim() || null;

  // A bare ON CONFLICT handles both the tenant-aware dedupe constraint and any
  // future producer-specific uniqueness without requiring executor metadata.
  await executor.execute(sql`
    INSERT INTO job_queue (
      id, org_id, queue, name, data, status, max_attempts, run_at, dedupe_key
    ) VALUES (
      ${crypto.randomUUID()},
      ${orgId},
      ${queueName},
      ${jobName},
      ${JSON.stringify(data)}::jsonb,
      'pending',
      ${maxAttempts},
      now() + (${delay} * interval '1 millisecond'),
      ${dedupeKey}
    )
    ON CONFLICT DO NOTHING
  `);
}

/** Atomically claim the next due job and establish a renewable ownership lease. */
export async function dequeueJob(
  queueName: QueueName,
  opts?: DequeueOptions,
): Promise<DequeuedJob | null> {
  const lockedBy = opts?.lockedBy?.trim() || DEFAULT_WORKER_ID;
  const lockToken = crypto.randomUUID();
  const leaseMs = positiveInteger(opts?.leaseMs, DEFAULT_LEASE_MS);
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = 'running',
        started_at = now(),
        completed_at = NULL,
        error = NULL,
        attempts = attempts + 1,
        locked_by = ${lockedBy},
        lock_token = ${lockToken},
        lock_expires_at = now() + (${leaseMs} * interval '1 millisecond')
    WHERE id = (
      SELECT id FROM job_queue
      WHERE status = 'pending'
        AND queue = ${queueName}
        AND run_at <= now()
      ORDER BY
        CASE
          WHEN queue = ${QUEUE_NAMES.AGENT_JOBS} AND name IN ('agent-reply', 'agent-employee-message', 'agent-employee-task') THEN 0
          WHEN queue = ${QUEUE_NAMES.AGENT_JOBS} AND name IN ('employee-trigger', 'agent-employee-trigger', 'plan-executor') THEN 1
          WHEN queue = ${QUEUE_NAMES.AGENT_JOBS} AND name = ${OBSERVE_CHAT_MESSAGE_JOB} THEN 5
          ELSE 3
        END,
        created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, name, data, attempts, cron_key, locked_by, lock_token, lock_expires_at
  `);

  const row = resultRows(result)[0];
  if (!row) return null;

  return {
    id: String(row.id),
    name: String(row.name),
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    attempts: Number(row.attempts),
    cronKey: typeof row.cron_key === 'string' ? row.cron_key : null,
    lockedBy: String(row.locked_by),
    lockToken: String(row.lock_token),
    lockExpiresAt: row.lock_expires_at instanceof Date
      ? row.lock_expires_at
      : new Date(String(row.lock_expires_at)),
  };
}

/** Extend a live lease. An expired lease cannot be resurrected by its old owner. */
export async function renewJobLease(
  jobId: string,
  lockToken: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<boolean> {
  const normalizedLeaseMs = positiveInteger(leaseMs, DEFAULT_LEASE_MS);
  const result = await db.execute(sql`
    UPDATE job_queue
    SET lock_expires_at = now() + (${normalizedLeaseMs} * interval '1 millisecond')
    WHERE id = ${jobId}
      AND status = 'running'
      AND lock_token = ${lockToken}
      AND lock_expires_at > now()
    RETURNING id
  `);
  return resultRows(result).length === 1;
}

/** Settle a job only if this worker still owns its current claim token. */
export async function completeJob(jobId: string, lockToken: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = 'completed',
        completed_at = now(),
        error = NULL,
        locked_by = NULL,
        lock_token = NULL,
        lock_expires_at = NULL
    WHERE id = ${jobId}
      AND status = 'running'
      AND lock_token = ${lockToken}
      AND lock_expires_at > now()
    RETURNING id
  `);
  return resultRows(result).length === 1;
}

/**
 * Fail a claimed job. Retry state and exponential backoff are decided in the
 * same token-guarded UPDATE, so an expired owner cannot overwrite a reclaim.
 */
export async function failJob(
  jobId: string,
  lockToken: string,
  error: string,
  opts?: FailJobOptions,
): Promise<boolean> {
  const terminal = opts?.terminal === true;
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = CASE
          WHEN ${terminal} OR attempts >= max_attempts THEN 'failed'
          ELSE 'pending'
        END,
        run_at = CASE
          WHEN ${terminal} OR attempts >= max_attempts THEN run_at
          ELSE now() + (
            LEAST(1000 * power(2, GREATEST(attempts - 1, 0)), 60000)
            * interval '1 millisecond'
          )
        END,
        started_at = CASE
          WHEN ${terminal} OR attempts >= max_attempts THEN started_at
          ELSE NULL
        END,
        completed_at = CASE
          WHEN ${terminal} OR attempts >= max_attempts THEN now()
          ELSE NULL
        END,
        error = ${error},
        locked_by = NULL,
        lock_token = NULL,
        lock_expires_at = NULL
    WHERE id = ${jobId}
      AND status = 'running'
      AND lock_token = ${lockToken}
      AND lock_expires_at > now()
    RETURNING name, data, status
  `);

  const row = resultRows(result)[0];
  if (!row) return false;
  if (row.name === OBSERVE_CHAT_MESSAGE_JOB) {
    await markObservationFailedFromJobData({
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      retrying: row.status === 'pending',
      error,
    });
  }
  return true;
}

/** Atomically register at most one pending/running occurrence per cron key. */
export async function ensureCronJob(
  queueName: QueueName,
  jobName: string,
  cronKey: string,
  data?: Record<string, unknown>,
  delay?: number,
): Promise<void> {
  const delayMs = Math.max(0, delay ?? 0);
  await db.execute(sql`
    INSERT INTO job_queue (
      id, queue, name, data, status, max_attempts, run_at, cron_key
    ) VALUES (
      ${crypto.randomUUID()},
      ${queueName},
      ${jobName},
      ${JSON.stringify(data ?? {})}::jsonb,
      'pending',
      2,
      now() + (${delayMs} * interval '1 millisecond'),
      ${cronKey}
    )
    ON CONFLICT DO NOTHING
  `);
}

/** Recover only jobs whose ownership lease has expired (or legacy rows lacked one). */
export async function cleanupStaleJobs(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE job_queue
    SET status = CASE
          WHEN attempts < max_attempts THEN 'pending'
          ELSE 'failed'
        END,
        error = 'stale: worker lease expired before settlement',
        run_at = CASE
          WHEN attempts < max_attempts THEN now() + interval '5 seconds'
          ELSE run_at
        END,
        started_at = CASE WHEN attempts < max_attempts THEN NULL ELSE started_at END,
        completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
        locked_by = NULL,
        lock_token = NULL,
        lock_expires_at = NULL
    WHERE status = 'running'
      AND (lock_expires_at IS NULL OR lock_expires_at <= now())
    RETURNING name, data, status, error
  `);
  const rows = resultRows(result);
  for (const row of rows) {
    if (row.name !== OBSERVE_CHAT_MESSAGE_JOB) continue;
    await markObservationFailedFromJobData({
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      retrying: row.status === 'pending',
      error: String(row.error),
    });
  }
  return rows.length;
}

/** Remove terminal queue history after the configured retention period. */
export async function pruneFinishedJobs(retentionMs = DEFAULT_RETENTION_MS): Promise<number> {
  const normalizedRetentionMs = positiveInteger(retentionMs, DEFAULT_RETENTION_MS);
  const cutoff = new Date(Date.now() - normalizedRetentionMs);
  const result = await db.execute(sql`
    DELETE FROM job_queue
    WHERE status IN ('completed', 'failed')
      AND completed_at IS NOT NULL
      AND completed_at < ${cutoff}
    RETURNING id
  `);
  return resultRows(result).length;
}

export { QUEUE_NAMES as default };
