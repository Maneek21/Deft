import { and, eq, sql } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { db } from './db.js';

/**
 * How long an approval may stay `executing` before it counts as interrupted.
 *
 * The approve route claims a pending action (`approval_status = 'approved'`,
 * `result.lifecycle_state = 'executing'`, `result.started_at`) and then runs
 * the native executor in the same request. Native executors are a handful of
 * database writes and finish in seconds; any HTTP request that carries them
 * is cut off by proxies long before five minutes. A claim older than this is
 * therefore a request that died (process restart, crash, dropped
 * connection), not slow work, and five minutes is still short enough that a
 * user who comes back to the card is not left waiting.
 */
export const AGENT_ACTION_EXECUTION_LEASE_MS = 5 * 60_000;

/**
 * Actions whose executor is idempotent per action id, so an interrupted
 * execution may safely run again. create_task: the task bundle returns the
 * bundle already committed for the action (see task-bundle.ts).
 */
const RE_EXECUTABLE_ACTIONS = new Set(['create_task']);

export const INTERRUPTED_RETRYABLE_ERROR =
  'Approval was interrupted before it finished. Approve again to finish it; nothing will be created twice.';
export const INTERRUPTED_UNKNOWN_ERROR =
  'Approval was interrupted and it is not known whether the change was made. Check the target before asking for it again.';

export type StaleExecutionRecovery =
  | { outcome: 'not_stale' }
  | { outcome: 'reopened'; error: string }
  | { outcome: 'failed'; error: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** True when the row is a claimed approval whose execution lease expired. */
export function isExecutionLeaseExpired(
  row: { approval_status: string; result: unknown },
  now: Date = new Date(),
): boolean {
  const result = record(row.result);
  if (row.approval_status !== 'approved' || result?.lifecycle_state !== 'executing') return false;
  const startedAt = typeof result.started_at === 'string' ? Date.parse(result.started_at) : Number.NaN;
  // A claim without a readable start time cannot be shown to be fresh.
  if (!Number.isFinite(startedAt)) return true;
  return now.getTime() - startedAt >= AGENT_ACTION_EXECUTION_LEASE_MS;
}

/**
 * Recover one interrupted approval. The transition is a conditional update
 * on the exact claim (`result.started_at` unchanged), so a concurrent
 * recovery or a late-finishing executor wins cleanly and this call becomes a
 * no-op.
 *
 * - Re-executable actions return to `pending` with a retryable failure, so
 *   the next approve claims and runs them again.
 * - Anything else is recorded as failed (`executed_at` + `error`): it may or
 *   may not have taken effect, and running it again could do it twice.
 */
export async function recoverStaleActionExecution(
  orgId: string,
  actionId: string,
  now: Date = new Date(),
): Promise<StaleExecutionRecovery> {
  const [row] = await db
    .select({
      action: agentActions.action,
      approval_status: agentActions.approval_status,
      result: agentActions.result,
    })
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)))
    .limit(1);
  if (!row || !isExecutionLeaseExpired(row, now)) return { outcome: 'not_stale' };

  const claim = record(row.result)!;
  const startedAt = typeof claim.started_at === 'string' ? claim.started_at : null;
  const sameClaim = and(
    eq(agentActions.id, actionId),
    eq(agentActions.org_id, orgId),
    eq(agentActions.approval_status, 'approved'),
    sql`${agentActions.result}->>'lifecycle_state' = 'executing'`,
    startedAt === null
      ? sql`${agentActions.result}->>'started_at' IS NULL`
      : sql`${agentActions.result}->>'started_at' = ${startedAt}`,
  );
  const interruption = {
    lifecycle_state: 'failed',
    interrupted: true,
    started_at: startedAt,
    failed_at: now.toISOString(),
  };

  if (RE_EXECUTABLE_ACTIONS.has(row.action)) {
    const [reopened] = await db.update(agentActions).set({
      approval_status: 'pending',
      approved_at: null,
      result: { ...interruption, retryable: true } as any,
      error: INTERRUPTED_RETRYABLE_ERROR,
    }).where(sameClaim).returning({ id: agentActions.id });
    return reopened ? { outcome: 'reopened', error: INTERRUPTED_RETRYABLE_ERROR } : { outcome: 'not_stale' };
  }

  const [failed] = await db.update(agentActions).set({
    result: interruption as any,
    error: INTERRUPTED_UNKNOWN_ERROR,
    executed_at: now,
  }).where(sameClaim).returning({ id: agentActions.id });
  return failed ? { outcome: 'failed', error: INTERRUPTED_UNKNOWN_ERROR } : { outcome: 'not_stale' };
}

/** Maintenance sweep: recover every interrupted approval past its lease. */
export async function recoverStaleAgentActionExecutions(limit = 100): Promise<number> {
  const cutoff = new Date(Date.now() - AGENT_ACTION_EXECUTION_LEASE_MS).toISOString();
  const rows = await db
    .select({ id: agentActions.id, org_id: agentActions.org_id })
    .from(agentActions)
    .where(and(
      eq(agentActions.approval_status, 'approved'),
      sql`${agentActions.result}->>'lifecycle_state' = 'executing'`,
      sql`(${agentActions.result}->>'started_at' IS NULL OR ${agentActions.result}->>'started_at' < ${cutoff})`,
    ))
    .limit(limit);
  let recovered = 0;
  for (const row of rows) {
    const outcome = await recoverStaleActionExecution(row.org_id, row.id);
    if (outcome.outcome !== 'not_stale') recovered += 1;
  }
  if (recovered > 0) console.log(`[agent-actions] Recovered ${recovered} interrupted approval(s)`);
  return recovered;
}
