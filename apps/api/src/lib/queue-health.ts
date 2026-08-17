import { sql } from 'drizzle-orm';
import { db } from './db.js';

export type QueueWorkerStatus = {
  running: boolean;
  startedAt: Date | string | null;
  lastPollAt: Date | string | null;
  inFlight: number;
};

type QueueHealthRow = {
  pending?: number | string | null;
  running?: number | string | null;
  completed?: number | string | null;
  failed?: number | string | null;
  oldest_ready_lag_seconds?: number | string | null;
  expired_leases?: number | string | null;
  recent_terminal_failures?: number | string | null;
};

export type QueueHealthSnapshot = {
  status: 'ok' | 'degraded';
  pending: number;
  running: number;
  completed: number;
  failed: number;
  oldest_ready_lag_seconds: number;
  expired_leases: number;
  recent_terminal_failures: number;
  worker: {
    running: boolean;
    started_at: string | null;
    last_poll_at: string | null;
    heartbeat_age_seconds: number | null;
    heartbeat_stale: boolean;
    in_flight: number;
  };
};

export const QUEUE_WORKER_STALE_AFTER_MS = 15_000;

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function dateOrNull(value: Date | string | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Convert the aggregate SQL row and process-local worker status into the
 * stable, JSON-safe public health contract. Kept pure for deterministic tests.
 */
export function summarizeQueueHealth(
  row: QueueHealthRow | undefined,
  workerStatus: QueueWorkerStatus,
  now = new Date(),
): QueueHealthSnapshot {
  const lastPollAt = dateOrNull(workerStatus.lastPollAt);
  const startedAt = dateOrNull(workerStatus.startedAt);
  const heartbeatAgeSeconds = lastPollAt
    ? Math.max(0, (now.getTime() - lastPollAt.getTime()) / 1000)
    : null;
  const heartbeatStale = !workerStatus.running
    || heartbeatAgeSeconds === null
    || heartbeatAgeSeconds * 1000 > QUEUE_WORKER_STALE_AFTER_MS;
  const expiredLeases = numeric(row?.expired_leases);

  return {
    status: heartbeatStale || expiredLeases > 0 ? 'degraded' : 'ok',
    pending: numeric(row?.pending),
    running: numeric(row?.running),
    completed: numeric(row?.completed),
    failed: numeric(row?.failed),
    oldest_ready_lag_seconds: numeric(row?.oldest_ready_lag_seconds),
    expired_leases: expiredLeases,
    recent_terminal_failures: numeric(row?.recent_terminal_failures),
    worker: {
      running: workerStatus.running,
      started_at: startedAt?.toISOString() ?? null,
      last_poll_at: lastPollAt?.toISOString() ?? null,
      heartbeat_age_seconds: heartbeatAgeSeconds,
      heartbeat_stale: heartbeatStale,
      in_flight: numeric(workerStatus.inFlight),
    },
  };
}

/**
 * Read operational queue signals in one aggregate query. A running row with a
 * missing lease is treated as expired so legacy or partially-migrated rows are
 * visible instead of silently disappearing from health output.
 */
export async function getQueueHealthSnapshot(
  workerStatus: QueueWorkerStatus,
  now = new Date(),
): Promise<QueueHealthSnapshot> {
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'completed')::int AS completed,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      COALESCE(
        GREATEST(
          EXTRACT(EPOCH FROM (now() - min(run_at) FILTER (
            WHERE status = 'pending' AND run_at <= now()
          ))),
          0
        ),
        0
      )::double precision AS oldest_ready_lag_seconds,
      count(*) FILTER (
        WHERE status = 'running'
          AND (lock_expires_at IS NULL OR lock_expires_at <= now())
      )::int AS expired_leases,
      count(*) FILTER (
        WHERE status = 'failed'
          AND completed_at >= now() - interval '24 hours'
      )::int AS recent_terminal_failures
    FROM job_queue
  `);
  const rows = (result as { rows?: QueueHealthRow[] }).rows
    ?? (result as unknown as QueueHealthRow[]);
  return summarizeQueueHealth(rows[0], workerStatus, now);
}
