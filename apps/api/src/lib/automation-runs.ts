import { and, eq } from 'drizzle-orm';
import { automationRuns } from '@deft/db/schema';
import { db } from './db.js';

export type AutomationRunKind = 'standup' | 'meeting_prep';
export type AutomationRunStatus =
  | 'scheduled'
  | 'gathering_context'
  | 'draft_ready'
  | 'delivered'
  | 'failed';
export type AutomationGenerator = 'native' | 'agent' | 'fallback';

export async function claimAutomationRun(input: {
  orgId: string;
  kind: AutomationRunKind;
  subjectId?: string | null;
  userId?: string | null;
  agentEmployeeId?: string | null;
  idempotencyKey: string;
  scheduledFor: Date;
  context?: Record<string, unknown>;
}) {
  const [inserted] = await db
    .insert(automationRuns)
    .values({
      org_id: input.orgId,
      kind: input.kind,
      subject_id: input.subjectId ?? null,
      user_id: input.userId ?? null,
      agent_employee_id: input.agentEmployeeId ?? null,
      idempotency_key: input.idempotencyKey,
      scheduled_for: input.scheduledFor,
      status: 'scheduled',
      context: input.context ?? {},
    })
    .onConflictDoNothing({
      target: [automationRuns.org_id, automationRuns.idempotency_key],
    })
    .returning();

  if (inserted) return { claimed: true as const, run: inserted };

  const [existing] = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.org_id, input.orgId),
        eq(automationRuns.idempotency_key, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`Automation run conflict without row: ${input.idempotencyKey}`);
  }
  const isStale = existing.status !== 'delivered'
    && Date.now() - existing.updated_at.getTime() > 15 * 60_000;
  if (existing.status === 'failed' || isStale) {
    const [retried] = await db
      .update(automationRuns)
      .set({
        status: 'scheduled',
        error: null,
        started_at: null,
        completed_at: null,
      })
      .where(
        and(
          eq(automationRuns.id, existing.id),
          eq(automationRuns.status, existing.status),
          eq(automationRuns.updated_at, existing.updated_at),
        ),
      )
      .returning();
    if (retried) return { claimed: true as const, run: retried };

    const [newer] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, existing.id))
      .limit(1);
    return { claimed: false as const, run: newer ?? existing };
  }
  return { claimed: false as const, run: existing };
}

export async function updateAutomationRun(
  runId: string,
  updates: {
    status?: AutomationRunStatus;
    generator?: AutomationGenerator;
    context?: Record<string, unknown>;
    output?: Record<string, unknown>;
    resultEntityId?: string | null;
    error?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
  },
) {
  const [updated] = await db
    .update(automationRuns)
    .set({
      ...(updates.status ? { status: updates.status } : {}),
      ...(updates.generator ? { generator: updates.generator } : {}),
      ...(updates.context ? { context: updates.context } : {}),
      ...(updates.output ? { output: updates.output } : {}),
      ...(updates.resultEntityId !== undefined ? { result_entity_id: updates.resultEntityId } : {}),
      ...(updates.error !== undefined ? { error: updates.error } : {}),
      ...(updates.startedAt !== undefined ? { started_at: updates.startedAt } : {}),
      ...(updates.completedAt !== undefined ? { completed_at: updates.completedAt } : {}),
    })
    .where(eq(automationRuns.id, runId))
    .returning();
  return updated ?? null;
}

export async function failAutomationRun(runId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return updateAutomationRun(runId, {
    status: 'failed',
    error: message.slice(0, 2000),
    completedAt: new Date(),
  });
}
