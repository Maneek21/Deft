import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { appSyncCheckpoints, jobQueue } from '@deft/db/schema';
import { db } from './db.js';
import { enqueue, QUEUE_NAMES, RetryLaterJobError } from './queues.js';
import { isAppResourceSyncSchedulerEnabled } from './env.js';
import { APP_RESOURCE_SYNC_CONTINUATION_DELAY_MS } from './app-resource-sync-cadence.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AppResourceSyncAdmissionService } from './app-resource-sync-admission.js';

// Reuse the scheduled sync handler, but never advance the installation scan cursor.
const JOB = 'app-resource-sync-scan';
const SuccessorSchema = z.strictObject({ kind: z.literal('continuation'),
  org_id: z.string().uuid(), resource_binding_id: z.string().uuid(),
  checkpoint_id: z.string().uuid(), generation: z.number().int().positive(),
  cursor_sequence: z.number().int().positive(), run_id: z.string().uuid(),
  observation: z.boolean() });

/** Called only after page validation, capacity accounting and checkpoint CAS.
 * Settlement/receipt failure rolls back this job with the page. No provider
 * cursor, records or credentials are retained in queue metadata. */
export async function enqueueResourceSyncSuccessor(tx: AppRunTransaction,
  input: z.infer<typeof SuccessorSchema>) {
  if (!isAppResourceSyncSchedulerEnabled()) return;
  const data = SuccessorSchema.parse(input);
  await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, JOB, data, { executor: tx,
    delay: APP_RESOURCE_SYNC_CONTINUATION_DELAY_MS, maxAttempts: 5,
    dedupeKey: `resource-sync:${data.checkpoint_id}:${data.generation}:${data.cursor_sequence}` });
}

/** One delivery admits at most one bounded page, then yields to other accounts.
 * The ordinary admission path rechecks live authority and serializes duplicate
 * deliveries/scanner races. Stale generations cannot nominate fresh work. */
export async function deliverResourceSyncSuccessor(
  delivery: { id: string; lockToken: string; signal?: AbortSignal },
  admission: Pick<AppResourceSyncAdmissionService, 'admitDue'>,
  observationAdmission?: Pick<AppResourceSyncAdmissionService, 'admitObservation'>,
) {
  if (!isAppResourceSyncSchedulerEnabled()) throw new RetryLaterJobError('Resource sync paused', 60_000);
  delivery.signal?.throwIfAborted();
  const [job] = await db.select({ data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.id, delivery.id), eq(jobQueue.name, JOB), eq(jobQueue.queue, QUEUE_NAMES.SCHEDULED_JOBS),
    eq(jobQueue.status, 'running'), eq(jobQueue.lock_token, delivery.lockToken),
    sql`${jobQueue.lock_expires_at} > clock_timestamp()`,
  )).limit(1);
  if (!job) throw new Error('Resource sync successor lease unavailable');
  const data = SuccessorSchema.parse(job.data);
  const [checkpoint] = await db.select({ id: appSyncCheckpoints.id }).from(appSyncCheckpoints).where(and(
    eq(appSyncCheckpoints.org_id, data.org_id), eq(appSyncCheckpoints.id, data.checkpoint_id),
    eq(appSyncCheckpoints.resource_binding_id, data.resource_binding_id), eq(appSyncCheckpoints.state, 'active'),
    eq(appSyncCheckpoints.generation, data.generation), eq(appSyncCheckpoints.cursor_sequence, data.cursor_sequence),
    eq(appSyncCheckpoints.last_applied_run_id, data.run_id),
  )).limit(1);
  if (!checkpoint) return;
  delivery.signal?.throwIfAborted();
  const limits = { lock_timeout_ms: 500, statement_timeout_ms: 2_000,
    deadline_at: new Date(Date.now() + 10_000), signal: delivery.signal };
  const target = { org_id: data.org_id, resource_binding_id: data.resource_binding_id };
  if (data.observation && !observationAdmission) throw new RetryLaterJobError('Observation sync paused', 60_000);
  const result = data.observation ? await observationAdmission!.admitObservation(target, limits)
    : await admission.admitDue(target, limits);
  // Completion's terminal clock can be slightly later than checkpoint time.
  if (result.state === 'not_due') throw new RetryLaterJobError('Resource sync successor not due',
    Math.max(1, Date.parse(result.due_at) - Date.now()));
}
