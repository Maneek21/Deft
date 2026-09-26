import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appResourceBindings, jobQueue } from '@deft/db/schema';
import { db } from './db.js';
import { isAppResourceSyncSchedulerEnabled } from './env.js';
import type { AppResourceSyncAdmissionService } from './app-resource-sync-admission.js';
import { QUEUE_NAMES } from './queues.js';

export const APP_RESOURCE_SYNC_SCAN_JOB = 'app-resource-sync-scan';
export const APP_RESOURCE_SYNC_SCAN_CRON = 'cron:app-resource-sync-scan';
export const APP_RESOURCE_SYNC_SCAN_INTERVAL_MS = 60_000;
export const APP_RESOURCE_SYNC_SCAN_LIMIT = 20;
export const APP_RESOURCE_SYNC_SCAN_BUDGET_MS = 20_000;
const CursorSchema = z.strictObject({ after_binding_id: z.string().uuid().nullable() });
const initialCursor = { after_binding_id: null };

/** Queue metadata is a restart cursor, never provider/cursor/owner authority.
 * Retention can discard this position after a prolonged disabled interval;
 * restarting the pass remains safe because admission owns replay fencing. */
export async function ensureAppResourceSyncScan(delayMs = APP_RESOURCE_SYNC_SCAN_INTERVAL_MS): Promise<void> {
  if (!isAppResourceSyncSchedulerEnabled()) return;
  await db.execute(sql`
    INSERT INTO job_queue (id, queue, name, data, status, max_attempts, run_at, cron_key)
    VALUES (${randomUUID()}, ${QUEUE_NAMES.SCHEDULED_JOBS}, ${APP_RESOURCE_SYNC_SCAN_JOB},
      COALESCE((SELECT data FROM job_queue
        WHERE queue = ${QUEUE_NAMES.SCHEDULED_JOBS} AND name = ${APP_RESOURCE_SYNC_SCAN_JOB}
          AND cron_key = ${APP_RESOURCE_SYNC_SCAN_CRON}
        ORDER BY created_at DESC, id DESC LIMIT 1), ${JSON.stringify(initialCursor)}::jsonb),
      'pending', 2, now() + (${Math.max(0, delayMs)} * interval '1 millisecond'),
      ${APP_RESOURCE_SYNC_SCAN_CRON}) ON CONFLICT DO NOTHING
  `);
}

export type AppResourceSyncScanResult = Readonly<{
  state: 'disabled' | 'busy' | 'scanned';
  inspected: number; created: number; existing: number; blocked: number; not_due: number; rejected: number;
  wrapped: boolean;
}>;
type Delivery = Readonly<{ id: string; lockToken: string; signal?: AbortSignal }>;

/** One bounded host scan uses the existing Run admission and attempt queue.
 * The advisory transaction holds no resource/Run/queue row locks. Admission
 * uses a second connection, preserving member→App→binding→checkpoint order.
 * No scan ever dispatches input, resets a cursor, or rearms a Run. */
export async function scanAppResourceSyncBindings(
  delivery: Delivery,
  admission: Pick<AppResourceSyncAdmissionService, 'admitDue'>,
): Promise<AppResourceSyncScanResult> {
  const result = { state: 'scanned' as AppResourceSyncScanResult['state'], inspected: 0,
    created: 0, existing: 0, blocked: 0, not_due: 0, rejected: 0, wrapped: false };
  if (!isAppResourceSyncSchedulerEnabled()) return { ...result, state: 'disabled' };
  const startedAt = performance.now();
  const canContinue = () => !delivery.signal?.aborted && isAppResourceSyncSchedulerEnabled()
    && performance.now() - startedAt < APP_RESOURCE_SYNC_SCAN_BUDGET_MS;
  return db.transaction(async (lockTx) => {
    await lockTx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
    const lock = await lockTx.execute(sql`SELECT pg_try_advisory_xact_lock(
      hashtextextended('deft.app_resource_sync.scan.v1', 0)) AS acquired`);
    if (lock.rows[0]?.acquired !== true) return { ...result, state: 'busy' as const };
    const [job] = await lockTx.select({ data: jobQueue.data }).from(jobQueue).where(and(
      eq(jobQueue.id, delivery.id), eq(jobQueue.name, APP_RESOURCE_SYNC_SCAN_JOB),
      eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS), eq(jobQueue.cron_key, APP_RESOURCE_SYNC_SCAN_CRON),
      eq(jobQueue.status, 'running'), eq(jobQueue.lock_token, delivery.lockToken),
      sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
    )).limit(1);
    if (!job) throw new Error('Resource sync scan lease unavailable');
    const cursor = CursorSchema.parse(job.data);
    const bindings = await lockTx.select({ org_id: appResourceBindings.org_id,
      resource_binding_id: appResourceBindings.id }).from(appResourceBindings).where(and(
      eq(appResourceBindings.state, 'active'),
      cursor.after_binding_id ? gt(appResourceBindings.id, cursor.after_binding_id) : undefined,
    )).orderBy(asc(appResourceBindings.id)).limit(APP_RESOURCE_SYNC_SCAN_LIMIT + 1);
    const saveCursor = async (after: string | null) => {
      // A separate short transaction commits progress after every candidate.
      // The scanner advisory transaction must never retain this queue lock.
      const changed = await db.transaction(async (progressTx) => {
        await progressTx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await progressTx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
        return progressTx.update(jobQueue).set({ data: { after_binding_id: after } }).where(and(
          eq(jobQueue.id, delivery.id), eq(jobQueue.status, 'running'),
          eq(jobQueue.lock_token, delivery.lockToken),
          sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
        )).returning({ id: jobQueue.id });
      });
      if (changed.length !== 1) throw new Error('Resource sync scan lease lost');
    };
    for (const target of bindings.slice(0, APP_RESOURCE_SYNC_SCAN_LIMIT)) {
      if (!canContinue()) return result;
      try {
        const admitted = await admission.admitDue(target, {
          lock_timeout_ms: 500, statement_timeout_ms: 2_000,
          deadline_at: new Date(Date.now() + Math.max(1,
            APP_RESOURCE_SYNC_SCAN_BUDGET_MS - (performance.now() - startedAt))),
          signal: delivery.signal,
        });
        result[admitted.state] += 1;
      } catch {
        // Denied/stale/expired/key-unavailable or contended bindings cannot
        // starve later bindings. Never log a private target or raw DB error.
        result.rejected += 1;
      }
      result.inspected += 1;
      await saveCursor(target.resource_binding_id);
    }
    if (bindings.length <= APP_RESOURCE_SYNC_SCAN_LIMIT && canContinue()) {
      await saveCursor(null);
      result.wrapped = true;
    }
    return result;
  });
}
