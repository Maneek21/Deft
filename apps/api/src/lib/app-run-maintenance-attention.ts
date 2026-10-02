import { and, eq, sql } from 'drizzle-orm';
import { appRuns, attentionEvents, jobQueue } from '@deft/db/schema';
import { z } from 'zod';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { safeRunSelection, type AppRunSafeView, type AppRunTransaction } from './app-run-repository.js';
import { PostgresAppRunAttentionProjector } from './app-run-attention.js';
import type { JobHandler } from '../workers/types.js';
import { createAppRunMaintenanceDatabase, APP_RUN_MAINTENANCE_LIMITS } from './app-run-maintenance-db.js';
import { env } from './env.js';
import { db } from './db.js';

export const APP_RUN_ATTENTION_JOB = 'app-run-attention';
const Locator = z.strictObject({ orgId: z.string().min(1).max(128), runId: z.string().min(1).max(128) });

export async function enqueueRecoveredAppRunAttention(tx: AppRunTransaction, run: AppRunSafeView): Promise<void> {
  if (!['unknown_outcome', 'failed'].includes(run.state)) return;
  await enqueue(QUEUE_NAMES.AGENT_JOBS, APP_RUN_ATTENTION_JOB, { orgId: run.org_id, runId: run.id },
    { executor: tx, orgId: run.org_id, dedupeKey: `app-run-attention:${run.id}:${run.state}`, maxAttempts: 5 });
}

/** Delayed/retried delivery derives current state, never the queued old kind. */
export const handleAppRunAttention: JobHandler = async job => {
  if (job.name !== APP_RUN_ATTENTION_JOB || job.signal?.aborted) throw new Error('Invalid App Run Attention job');
  const locator = Locator.parse(job.data);
  const database = createAppRunMaintenanceDatabase(env.DATABASE_URL);
  const effects: Array<() => Promise<void>> = [];
  let reconciled: AppRunSafeView | undefined;
  try { await database.transaction(async tx => {
    const [queued] = await tx.select().from(jobQueue).where(and(eq(jobQueue.id, job.id), eq(jobQueue.org_id, locator.orgId))).limit(1);
    const stored = Locator.safeParse(queued?.data);
    if (!queued || queued.queue !== QUEUE_NAMES.AGENT_JOBS || queued.name !== APP_RUN_ATTENTION_JOB
      || !stored.success || stored.data.orgId !== locator.orgId || stored.data.runId !== locator.runId
      || !['unknown_outcome', 'failed'].some(state => queued.dedupe_key === `app-run-attention:${locator.runId}:${state}`)) {
      throw new Error('Invalid App Run Attention queue identity');
    }
    await tx.execute(sql`SELECT id FROM app_runs WHERE org_id=${locator.orgId} AND id=${locator.runId} FOR UPDATE`);
    const [run] = await tx.select(safeRunSelection).from(appRuns).where(and(eq(appRuns.org_id, locator.orgId), eq(appRuns.id, locator.runId))).limit(1);
    if (!run) throw new Error('App Run Attention source unavailable');
    const kind = run.reconciled_at ? 'reconciled' : run.state === 'unknown_outcome' ? 'unknown_outcome' : run.state === 'failed' ? 'failure' : null;
    // Reconciliation/cancellation lock this same Run and project after commit.
    // Holding the fence through projection closes read -> resolve -> write races.
    if (kind === 'reconciled') reconciled = run;
    else if (kind) await new PostgresAppRunAttentionProjector(true, { executor: tx,
      afterCommit: effect => effects.push(effect) }).projectRunState(run, kind);
  }, job.signal ?? new AbortController().signal, performance.now() + APP_RUN_MAINTENANCE_LIMITS.budget_ms);
  } finally { await database.close(); }
  for (const effect of effects) await effect();
  // Reconciliation is terminal and cannot become an unresolved outcome again.
  // Its existing source-event dedupe also makes delayed delivery idempotent.
  if (reconciled) {
    const [event] = await db.select({ id: attentionEvents.id }).from(attentionEvents).where(and(
      eq(attentionEvents.org_id, reconciled.org_id), eq(attentionEvents.source_event_id, `app-run:${reconciled.id}:reconciled`),
      eq(attentionEvents.event_type, 'source_event'))).limit(1);
    if (!event) await new PostgresAppRunAttentionProjector().projectRunState(reconciled, 'reconciled');
  }
};
