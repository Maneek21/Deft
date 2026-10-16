import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { jobQueue } from '@deft/db/schema';
import { appAutomationScanDatabase } from './app-automation-scan-db.js';
import { APP_AUTOMATIONS_ENABLED } from './env.js';
import { QUEUE_NAMES } from './queues.js';

export const APP_AUTOMATION_SCAN_JOB = 'app-automation-scan';
export const APP_AUTOMATION_SCAN_CRON = 'cron:app-automation-scan';
const Id = z.string().min(1).max(256);
const DefinitionCursor = z.strictObject({ organization_id: Id, definition_id: Id });
const FireCursor = z.strictObject({ organization_id: Id, fire_id: Id });
export const AppAutomationScanProgressSchema = z.strictObject({
  version: z.literal(1),
  next_lane: z.enum(['definitions', 'fires']),
  complete: z.boolean(),
  definitions: z.strictObject({
    done: z.boolean(), after: DefinitionCursor.nullable(),
    partial: DefinitionCursor.extend({ definition_epoch: z.number().int().positive(),
      next_logical_local_date: z.iso.date() }).nullable(),
  }),
  fires: z.strictObject({ done: z.boolean(), after: FireCursor.nullable() }),
});
export type AppAutomationScanProgress = z.infer<typeof AppAutomationScanProgressSchema>;
export type AppAutomationScanDelivery = Readonly<{ id: string; lockToken: string }>;

export function initialAppAutomationScanProgress(): AppAutomationScanProgress {
  return { version: 1, next_lane: 'fires', complete: false,
    definitions: { done: false, after: null, partial: null }, fires: { done: false, after: null } };
}
/** Retained metadata is a bounded traversal hint, never eligibility or authority. */
export function parseAppAutomationScanProgress(data: unknown): AppAutomationScanProgress {
  const parsed = AppAutomationScanProgressSchema.safeParse(
    data && typeof data === 'object' ? (data as Record<string, unknown>).automation_scan : undefined,
  );
  return parsed.success ? parsed.data : initialAppAutomationScanProgress();
}

export async function loadAppAutomationScanProgress(delivery: AppAutomationScanDelivery, signal?: AbortSignal) {
  return appAutomationScanDatabase().transaction(async tx => {
    const [row] = await tx.select({ data: jobQueue.data }).from(jobQueue).where(and(
      eq(jobQueue.id, delivery.id), eq(jobQueue.name, APP_AUTOMATION_SCAN_JOB),
      eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS), eq(jobQueue.cron_key, APP_AUTOMATION_SCAN_CRON),
      eq(jobQueue.status, 'running'), eq(jobQueue.lock_token, delivery.lockToken),
      sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
    )).limit(1);
    if (!row) throw new Error('App automation scan lease unavailable');
    const progress = parseAppAutomationScanProgress(row.data);
    return progress.complete ? initialAppAutomationScanProgress() : progress;
  }, signal);
}

export async function saveAppAutomationScanProgress(
  delivery: AppAutomationScanDelivery, progress: AppAutomationScanProgress,
  signal?: AbortSignal, deadline?: number,
): Promise<void> {
  await appAutomationScanDatabase().transaction(async tx => {
    // Lock by immutable identity first. A predicate on a single UPDATE can be
    // evaluated before a no-op lock wait and then retain a stale lease clock.
    const locked = await tx.select({ id: jobQueue.id }).from(jobQueue).where(and(
      eq(jobQueue.id, delivery.id), eq(jobQueue.name, APP_AUTOMATION_SCAN_JOB),
      eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS), eq(jobQueue.cron_key, APP_AUTOMATION_SCAN_CRON),
    )).for('update');
    if (locked.length !== 1) throw new Error('App automation scan lease unavailable');
    const changed = await tx.update(jobQueue).set({
      data: { automation_scan: AppAutomationScanProgressSchema.parse(progress) },
    }).where(and(
      eq(jobQueue.id, delivery.id), eq(jobQueue.status, 'running'),
      eq(jobQueue.lock_token, delivery.lockToken), sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
    )).returning({ id: jobQueue.id });
    if (changed.length !== 1) throw new Error('App automation scan lease lost');
    const live = await tx.select({ id: jobQueue.id }).from(jobQueue).where(and(
      eq(jobQueue.id, delivery.id), eq(jobQueue.lock_token, delivery.lockToken),
      eq(jobQueue.status, 'running'), sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
    ));
    if (live.length !== 1) throw new Error('App automation scan lease expired during progress write');
  }, signal, deadline);
}

/** Only a successfully settled partial slice earns an immediate successor.
 * Startup and failure preserve hints but always use the ordinary cadence. */
export async function ensureAppAutomationScan(options: Readonly<{
  completed_job_id?: string; mode: 'success' | 'failure' | 'startup';
}>): Promise<void> {
  if (!APP_AUTOMATIONS_ENABLED) return;
  await appAutomationScanDatabase().transaction(async tx => {
    const [previous] = await tx.select({ id: jobQueue.id, data: jobQueue.data, status: jobQueue.status })
      .from(jobQueue).where(and(eq(jobQueue.name, APP_AUTOMATION_SCAN_JOB),
        eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS), eq(jobQueue.cron_key, APP_AUTOMATION_SCAN_CRON)))
      .orderBy(desc(jobQueue.created_at), desc(jobQueue.id)).limit(1);
    const [completed] = options.mode === 'success' && options.completed_job_id
      ? await tx.select({ data: jobQueue.data }).from(jobQueue).where(and(
        eq(jobQueue.id, options.completed_job_id), eq(jobQueue.name, APP_AUTOMATION_SCAN_JOB),
        eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS),
        eq(jobQueue.cron_key, APP_AUTOMATION_SCAN_CRON), eq(jobQueue.status, 'completed'),
      )).limit(1) : [];
    const progress = parseAppAutomationScanProgress(previous?.data);
    const immediate = !!completed && !progress.complete && (previous?.id === options.completed_job_id
      || (previous?.status === 'pending'
        && JSON.stringify(previous.data) === JSON.stringify(completed.data)));
    await tx.insert(jobQueue).values({
      id: randomUUID(), queue: QUEUE_NAMES.SCHEDULED_JOBS, name: APP_AUTOMATION_SCAN_JOB,
      cron_key: APP_AUTOMATION_SCAN_CRON, data: { automation_scan: progress },
      status: 'pending', max_attempts: 2,
      run_at: new Date(Date.now() + (immediate ? 0 : 60_000)),
    }).onConflictDoNothing();
    if (immediate) {
      // Maintenance may have inserted the same successor between settlement
      // and this call. Bring that exact pending hint forward without touching
      // running work or replacing another delivery's progress.
      await tx.update(jobQueue).set({ run_at: sql`LEAST(${jobQueue.run_at}, clock_timestamp())` }).where(and(
        eq(jobQueue.name, APP_AUTOMATION_SCAN_JOB), eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS),
        eq(jobQueue.cron_key, APP_AUTOMATION_SCAN_CRON), eq(jobQueue.status, 'pending'),
        sql`${jobQueue.data} = ${JSON.stringify({ automation_scan: progress })}::jsonb`,
      ));
    }
  });
}
