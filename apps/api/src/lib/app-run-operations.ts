import {
  agentActions,
  appRunAttempts,
  appRunEvents,
  appRunReceipts,
  appRuns,
  attentionItems,
  orgMembers,
} from '@deft/db/schema';
import type { AppRunActor, AppRunState } from '@deft/shared';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  noOpAppRunAttentionProjector,
  type AppRunAttentionProjector,
} from './app-run-attention.js';
import { AppRunError } from './app-run-errors.js';
import {
  PostgresAppRunRepository,
  safeRunSelection,
  type AppRunSafeView,
} from './app-run-repository.js';
import {
  noOpAppRunReceiptWriter,
  type AppRunReceiptWriter,
} from './app-run-receipts.js';
import { db } from './db.js';

export type AppRunOperationalAction = 'list' | 'metrics' | 'audit' | 'repair';

export interface AppRunOperationsAuthorizer {
  authorize(input: Readonly<{
    action: AppRunOperationalAction;
    org_id: string;
    actor: AppRunActor;
  }>): Promise<boolean>;
}

export const denyAllAppRunOperationsAuthorizer: AppRunOperationsAuthorizer = Object.freeze({
  async authorize() { return false; },
});

/** Read-only operational access is decided from the current org membership,
 * never from a role cached in the request token. Repair remains separately
 * dependency-injected and is intentionally denied by this runtime authorizer. */
export const postgresAppRunReadOperationsAuthorizer: AppRunOperationsAuthorizer = Object.freeze({
  async authorize(input: Parameters<AppRunOperationsAuthorizer['authorize']>[0]) {
    if (input.action === 'repair' || input.actor.actor_type !== 'human') return false;
    const [membership] = await db.select({
      role: orgMembers.role,
      is_active: orgMembers.is_active,
    }).from(orgMembers).where(and(
      eq(orgMembers.org_id, input.org_id),
      eq(orgMembers.user_id, input.actor.user_id),
    )).limit(1);
    return Boolean(
      membership?.is_active
      && (membership.role === 'owner' || membership.role === 'admin'),
    );
  },
});

export type AppRunRepairGap = Readonly<{
  run_id: string;
  gap: 'missing_terminal_event' | 'missing_receipt' | 'missing_attention' | 'missing_approval_action';
  artifact: 'run' | 'attempt' | 'approval' | 'attention';
  attempt_id?: string;
  action_id?: string;
}>;

export type AppRunOperationalMetric = Readonly<{
  state: AppRunState;
  risk_class: AppRunSafeView['risk_class'];
  provider_kind: AppRunSafeView['provider_kind'];
  count: number;
}>;

function boundedLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 50, 100));
}

function actorUserId(actor: AppRunActor): string | null {
  return actor.actor_type === 'human' ? actor.user_id : null;
}

function payloadAttemptId(payload: Record<string, unknown>): string | null {
  return typeof payload.attempt_id === 'string' ? payload.attempt_id : null;
}

function payloadToState(payload: Record<string, unknown>): string | null {
  return typeof payload.to_state === 'string' ? payload.to_state : null;
}

export class AppRunOperationsService {
  constructor(
    private readonly repository = new PostgresAppRunRepository(),
    private readonly authorizer: AppRunOperationsAuthorizer = denyAllAppRunOperationsAuthorizer,
    private readonly receipts: AppRunReceiptWriter = noOpAppRunReceiptWriter,
    private readonly attention: AppRunAttentionProjector = noOpAppRunAttentionProjector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(input: Readonly<{
    org_id: string;
    actor: AppRunActor;
    states?: readonly AppRunState[];
    limit?: number;
  }>): Promise<readonly AppRunSafeView[]> {
    await this.#authorize('list', input.org_id, input.actor);
    const states = input.states?.length ? [...new Set(input.states)] : null;
    return db.select(safeRunSelection).from(appRuns).where(and(
      eq(appRuns.org_id, input.org_id),
      ...(states ? [inArray(appRuns.state, states)] : []),
    )).orderBy(desc(appRuns.updated_at), desc(appRuns.id)).limit(boundedLimit(input.limit));
  }

  async metrics(input: Readonly<{
    org_id: string;
    actor: AppRunActor;
  }>): Promise<readonly AppRunOperationalMetric[]> {
    await this.#authorize('metrics', input.org_id, input.actor);
    const rows = await db.select({
      state: appRuns.state,
      risk_class: appRuns.risk_class,
      provider_kind: appRuns.provider_kind,
      count: sql<number>`count(*)::int`,
    }).from(appRuns).where(eq(appRuns.org_id, input.org_id))
      .groupBy(appRuns.state, appRuns.risk_class, appRuns.provider_kind)
      .orderBy(asc(appRuns.state), asc(appRuns.risk_class), asc(appRuns.provider_kind));
    return rows.map((row) => Object.freeze(row));
  }

  async auditGaps(input: Readonly<{
    org_id: string;
    actor: AppRunActor;
    run_id?: string;
    limit?: number;
  }>): Promise<readonly AppRunRepairGap[]> {
    await this.#authorize('audit', input.org_id, input.actor);
    return this.#auditGaps(input.org_id, input.run_id, input.limit);
  }

  async repair(input: Readonly<{
    org_id: string;
    run_id: string;
    actor: AppRunActor;
  }>): Promise<readonly AppRunRepairGap[]> {
    await this.#authorize('repair', input.org_id, input.actor);
    const gaps = await this.#auditGaps(input.org_id, input.run_id, 100);
    if (gaps.length === 0) return [];

    const repaired = await this.repository.transaction(async (tx) => {
      const run = await this.repository.lockRun(tx, input.org_id, input.run_id);
      if (!run) throw new AppRunError('APP_RUN_ACCESS_DENIED');
      const now = this.now();
      const eventId = crypto.randomUUID();
      const attempts = await tx.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, input.org_id),
        eq(appRunAttempts.run_id, input.run_id),
      ));
      const actions = await tx.select().from(agentActions).where(and(
        eq(agentActions.org_id, input.org_id),
        eq(agentActions.app_run_id, input.run_id),
        eq(agentActions.action, 'app_run_invoke'),
      ));

      if (gaps.some((gap) => gap.gap === 'missing_terminal_event' && gap.artifact === 'run')) {
        await this.repository.appendEvent(tx, {
          id: crypto.randomUUID(),
          org_id: run.org_id,
          run_id: run.id,
          event_type: 'run_transitioned',
          actor: input.actor,
          payload: { to_state: run.state, repaired: true },
          now,
        });
      }
      for (const gap of gaps.filter((item) =>
        item.gap === 'missing_terminal_event' && item.artifact === 'attempt')) {
        const attempt = attempts.find((item) => item.id === gap.attempt_id);
        if (!attempt) continue;
        await this.repository.appendEvent(tx, {
          id: crypto.randomUUID(),
          org_id: run.org_id,
          run_id: run.id,
          event_type: 'attempt_terminal',
          actor: input.actor,
          payload: { attempt_id: attempt.id, state: attempt.state, repaired: true },
          now,
        });
      }
      for (const gap of gaps.filter((item) => item.gap === 'missing_receipt')) {
        if (gap.artifact === 'attempt') {
          const attempt = attempts.find((item) => item.id === gap.attempt_id);
          if (!attempt) continue;
          await this.receipts.write(tx, {
            receipt_key: `attempt-terminal:${attempt.id}`,
            receipt_kind: 'attempt_terminal',
            run,
            attempt_id: attempt.id,
            actor: input.actor,
            facts: { attempt_state: attempt.state, repaired: true },
            occurred_at: attempt.updated_at,
          });
        } else if (gap.artifact === 'approval') {
          const action = actions.find((item) => item.id === gap.action_id);
          if (!action) continue;
          await this.receipts.write(tx, {
            receipt_key: `approval:${action.id}`,
            receipt_kind: 'approval',
            run,
            actor: action.approved_by_user_id
              ? { actor_type: 'human', user_id: action.approved_by_user_id }
              : input.actor,
            facts: { decision: action.approval_status, repaired: true },
            occurred_at: action.approved_at ?? action.updated_at,
          });
        }
      }

      await this.repository.appendEvent(tx, {
        id: eventId,
        org_id: run.org_id,
        run_id: run.id,
        event_type: 'repair_gap',
        actor: input.actor,
        payload: {
          repaired_gap_count: gaps.length,
          repaired_gap_kinds: [...new Set(gaps.map((gap) => gap.gap))],
        },
        now,
      });
      await this.receipts.write(tx, {
        receipt_key: `repair:${eventId}`,
        receipt_kind: 'repair',
        run,
        actor: input.actor,
        facts: {
          repaired_gap_count: gaps.length,
          repaired_gap_kinds: [...new Set(gaps.map((gap) => gap.gap))],
        },
        occurred_at: now,
      });
      return run;
    });

    try {
      if (gaps.some((gap) => gap.artifact === 'approval')) {
        await this.attention.projectApprovalRequested(repaired.org_id, repaired.id);
      }
      if (repaired.state === 'unknown_outcome') {
        await this.attention.projectRunState(repaired, 'unknown_outcome');
      } else if (repaired.state === 'failed') {
        await this.attention.projectRunState(repaired, 'failure');
      }
      const remaining = await this.#auditGaps(repaired.org_id, repaired.id, 100);
      if (remaining.length > 0) {
        await this.attention.projectRunState(repaired, 'repair_gap');
      } else {
        await this.attention.resolveRun(
          repaired.org_id,
          repaired.id,
          actorUserId(input.actor)!,
          'repaired',
        );
      }
    } catch (error) {
      console.warn('[app-runs] repair Attention projection failed:',
        error instanceof Error ? error.message : 'unknown error');
    }
    return gaps;
  }

  async #auditGaps(
    orgId: string,
    runId: string | undefined,
    limit: number | undefined,
  ): Promise<readonly AppRunRepairGap[]> {
    const runs = await db.select(safeRunSelection).from(appRuns).where(and(
      eq(appRuns.org_id, orgId),
      ...(runId ? [eq(appRuns.id, runId)] : []),
    )).orderBy(desc(appRuns.updated_at), desc(appRuns.id)).limit(boundedLimit(limit));
    if (runs.length === 0) return [];
    const runIds = runs.map((run) => run.id);
    const [attempts, actions, events, receipts] = await Promise.all([
      db.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId),
        inArray(appRunAttempts.run_id, runIds),
        inArray(appRunAttempts.state, ['succeeded', 'failed', 'cancelled', 'unknown_outcome']),
      )),
      db.select().from(agentActions).where(and(
        eq(agentActions.org_id, orgId),
        inArray(agentActions.app_run_id, runIds),
        eq(agentActions.action, 'app_run_invoke'),
      )),
      db.select().from(appRunEvents).where(and(
        eq(appRunEvents.org_id, orgId),
        inArray(appRunEvents.run_id, runIds),
      )),
      db.select().from(appRunReceipts).where(and(
        eq(appRunReceipts.org_id, orgId),
        inArray(appRunReceipts.run_id, runIds),
      )),
    ]);
    const actionIds = actions.map((action) => action.id);
    const attention = await db.select({
      source_type: attentionItems.source_type,
      source_id: attentionItems.source_id,
    }).from(attentionItems).where(and(
      eq(attentionItems.org_id, orgId),
      or(
        and(eq(attentionItems.source_type, 'app_run'), inArray(attentionItems.source_id, runIds)),
        ...(actionIds.length > 0
          ? [and(eq(attentionItems.source_type, 'agent_action'), inArray(attentionItems.source_id, actionIds))]
          : []),
      ),
    ));
    const gaps: AppRunRepairGap[] = [];
    const terminalRunStates = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'unknown_outcome']);

    for (const run of runs) {
      const runEvents = events.filter((event) => event.run_id === run.id);
      const runReceipts = receipts.filter((receipt) => receipt.run_id === run.id);
      const action = actions.find((candidate) => candidate.app_run_id === run.id);
      if (run.review_requirement === 'always' && !action) {
        gaps.push({ run_id: run.id, gap: 'missing_approval_action', artifact: 'approval' });
      }
      if (
        action
        && action.approval_status === 'pending'
        && !attention.some((item) => item.source_type === 'agent_action' && item.source_id === action.id)
      ) gaps.push({
        run_id: run.id,
        gap: 'missing_attention',
        artifact: 'approval',
        action_id: action.id,
      });
      if (
        action
        && action.approval_status !== 'pending'
        && !runReceipts.some((receipt) =>
          receipt.receipt_kind === 'approval' && receipt.receipt_key === `approval:${action.id}`)
      ) gaps.push({
        run_id: run.id,
        gap: 'missing_receipt',
        artifact: 'approval',
        action_id: action.id,
      });
      if (
        (run.state === 'failed' || run.state === 'unknown_outcome')
        && !attention.some((item) => item.source_type === 'app_run' && item.source_id === run.id)
      ) gaps.push({ run_id: run.id, gap: 'missing_attention', artifact: 'attention' });
      if (
        terminalRunStates.has(run.state)
        && !runEvents.some((event) =>
          (event.event_type === 'run_transitioned' || event.event_type === 'reconciliation_recorded')
          && payloadToState(event.payload) === run.state)
      ) gaps.push({ run_id: run.id, gap: 'missing_terminal_event', artifact: 'run' });

      for (const attempt of attempts.filter((candidate) => candidate.run_id === run.id)) {
        if (!runEvents.some((event) =>
          event.event_type === 'attempt_terminal'
          && payloadAttemptId(event.payload) === attempt.id)) {
          gaps.push({
            run_id: run.id,
            gap: 'missing_terminal_event',
            artifact: 'attempt',
            attempt_id: attempt.id,
          });
        }
        if (!runReceipts.some((receipt) =>
          receipt.receipt_kind === 'attempt_terminal'
          && receipt.attempt_id === attempt.id)) {
          gaps.push({
            run_id: run.id,
            gap: 'missing_receipt',
            artifact: 'attempt',
            attempt_id: attempt.id,
          });
        }
      }
    }
    return gaps.slice(0, boundedLimit(limit));
  }

  async #authorize(
    action: AppRunOperationalAction,
    orgId: string,
    actor: AppRunActor,
  ): Promise<void> {
    if (!await this.authorizer.authorize({ action, org_id: orgId, actor })) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
    if (action === 'repair' && actorUserId(actor) === null) {
      throw new AppRunError('APP_RUN_ACCESS_DENIED');
    }
  }
}
