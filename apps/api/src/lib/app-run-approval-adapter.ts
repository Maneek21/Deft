import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunSafeOutcomeSchema,
  type AppRunSubmission,
} from '@deft/shared';
import { agentActions, agentEmployees } from '@deft/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import { PostgresAppRunLiveAuthorization } from './app-run-live-authorization.js';
import {
  PostgresAppRunRepository,
  type AppRunSafeView,
  type AppRunTransaction,
} from './app-run-repository.js';
import {
  noOpAppRunReceiptWriter,
  type AppRunReceiptWriter,
} from './app-run-receipts.js';
import {
  noOpAppRunAttentionProjector,
  type AppRunAttentionProjector,
} from './app-run-attention.js';

export const APP_RUN_APPROVAL_ACTION = 'app_run_invoke';

export type AppRunApprovalResolution =
  | { status: 'approved'; message?: string; result?: unknown }
  | { status: 'rejected'; message?: string }
  | { status: 'error'; code: 'NOT_FOUND' | 'INVALID_STATE'; message: string };

export interface AppRunApprovalAdapter {
  create(input: Readonly<{
    tx: AppRunTransaction;
    run: AppRunSafeView;
    submission: AppRunSubmission;
    now: Date;
  }>): Promise<string>;
}

type AppRunApprovalLiveAuthorization = Pick<
  PostgresAppRunLiveAuthorization,
  'authorizeApprovalInTransaction'
>;

async function approvalOwnerUserId(
  tx: AppRunTransaction,
  submission: AppRunSubmission,
): Promise<string> {
  if (submission.initiating_actor.actor_type === 'human') {
    return submission.initiating_actor.user_id;
  }
  if (submission.initiating_actor.actor_type === 'agent_employee') {
    const [employee] = await tx.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, submission.org_id),
        eq(agentEmployees.id, submission.initiating_actor.agent_employee_id),
      )).limit(1);
    if (employee) return employee.user_id;
  }
  throw new Error('APP_RUN_ACCESS_DENIED');
}

export const postgresAppRunApprovalAdapter = Object.freeze<AppRunApprovalAdapter>({
  async create({ tx, run, submission, now }) {
    const actionId = crypto.randomUUID();
    const userId = await approvalOwnerUserId(tx, submission);
    const [created] = await tx.insert(agentActions).values({
      id: actionId,
      org_id: run.org_id,
      user_id: userId,
      agent_employee_id: submission.execution_actor.actor_type === 'agent_employee'
        ? submission.execution_actor.agent_employee_id
        : null,
      source: 'app_run',
      app_run_id: run.id,
      action: APP_RUN_APPROVAL_ACTION,
      params: {
        run_id: run.id,
        capability_label: run.operation_name.slice(0, 200),
        provider_label: run.provider_instance_id.slice(0, 200),
        resource_ids: submission.safe_preview.resource_refs.map((ref) => ref.resource_id),
        safe_preview: submission.safe_preview,
      },
      approval_tier: 'full',
      approval_status: 'pending',
      created_at: now,
      updated_at: now,
    }).returning({ id: agentActions.id });
    if (!created) throw new Error('APP_RUN_ILLEGAL_TRANSITION');
    return created.id;
  },
});

export class PostgresAppRunApprovalResolver {
  constructor(
    private readonly repository = new PostgresAppRunRepository(),
    private readonly liveAuthorization: AppRunApprovalLiveAuthorization = new PostgresAppRunLiveAuthorization(),
    private readonly now: () => Date = () => new Date(),
    private readonly receiptWriter: AppRunReceiptWriter = noOpAppRunReceiptWriter,
    private readonly attention: AppRunAttentionProjector = noOpAppRunAttentionProjector,
  ) {}

  async approve(
    actionId: string,
    approverUserId: string,
  ): Promise<AppRunApprovalResolution> {
    const result = await db.transaction(async (tx): Promise<AppRunApprovalResolution> => {
      const action = await this.#lockAction(tx, actionId);
      if (!action?.app_run_id || action.action !== APP_RUN_APPROVAL_ACTION) {
        return { status: 'error', code: 'NOT_FOUND', message: 'App Run approval was not found' };
      }
      let run = await this.repository.lockRun(tx, action.org_id, action.app_run_id);
      if (!run) return { status: 'error', code: 'NOT_FOUND', message: 'App Run approval was not found' };

      if (run.execution_release_kind === 'approved') {
        await this.#markApproved(tx, action.id, approverUserId, run);
        await this.#writeApprovalReceipt(
          tx,
          action.id,
          run,
          { actor_type: 'human', user_id: action.approved_by_user_id ?? approverUserId },
          'approved',
          run.execution_released_at ?? this.now(),
        );
        return { status: 'approved', message: 'already approved', result: this.#safeResult(run, true) };
      }
      if (run.state === 'cancelled') {
        await this.#markRejected(tx, action.id);
        return { status: 'rejected', message: 'already rejected' };
      }
      if (run.state === 'expired' || run.state === 'failed') {
        await this.#markExpired(tx, action.id);
        return { status: 'error', code: 'INVALID_STATE', message: 'App Run approval is no longer valid' };
      }
      if (action.approval_status === 'rejected') {
        return { status: 'rejected', message: 'already rejected' };
      }
      if (action.approval_status === 'expired') {
        return { status: 'error', code: 'INVALID_STATE', message: 'App Run approval is no longer valid' };
      }
      if (
        run.state !== 'pending_approval'
        || !await this.liveAuthorization.authorizeApprovalInTransaction(tx, run)
      ) {
        const now = this.now();
        await this.#markExpired(tx, action.id);
        if (run.state === 'pending_approval') {
          run = await this.repository.transition(tx, {
            run,
            state: 'expired',
            actor: { actor_type: 'human', user_id: approverUserId },
            now,
            event_type: 'approval_resolved',
            error_code: 'APP_RUN_AUTHORIZATION_STALE',
            safe_outcome: AppRunSafeOutcomeSchema.parse({
              success: false,
              provider_call_attempted: false,
              result_status: 'unavailable',
              error_code: 'APP_RUN_AUTHORIZATION_STALE',
            }),
          });
          await this.#writeApprovalReceipt(
            tx,
            action.id,
            run,
            { actor_type: 'human', user_id: approverUserId },
            'expired',
            run.terminal_at ?? now,
          );
        }
        return { status: 'error', code: 'INVALID_STATE', message: 'App Run authorization changed before approval' };
      }

      run = await this.repository.recordApprovedExecutionRelease(
        tx,
        run,
        { actor_type: 'human', user_id: approverUserId },
        this.now(),
      );
      await this.#markApproved(tx, action.id, approverUserId, run);
      await this.#writeApprovalReceipt(
        tx,
        action.id,
        run,
        { actor_type: 'human', user_id: approverUserId },
        'approved',
        run.execution_released_at ?? this.now(),
      );
      return { status: 'approved', result: this.#safeResult(run, true) };
    });
    await this.#resolveApprovalAttention(actionId, approverUserId);
    return result;
  }

  async reject(
    actionId: string,
    rejecterUserId: string,
  ): Promise<AppRunApprovalResolution> {
    const result = await db.transaction(async (tx): Promise<AppRunApprovalResolution> => {
      const action = await this.#lockAction(tx, actionId);
      if (!action?.app_run_id || action.action !== APP_RUN_APPROVAL_ACTION) {
        return { status: 'error', code: 'NOT_FOUND', message: 'App Run approval was not found' };
      }
      let run = await this.repository.lockRun(tx, action.org_id, action.app_run_id);
      if (!run) return { status: 'error', code: 'NOT_FOUND', message: 'App Run approval was not found' };

      if (run.execution_release_kind === 'approved') {
        await this.#markApproved(tx, action.id, action.approved_by_user_id ?? rejecterUserId, run);
        return { status: 'approved', message: 'already approved', result: this.#safeResult(run, true) };
      }
      if (run.state === 'cancelled' || action.approval_status === 'rejected') {
        await this.#markRejected(tx, action.id);
        return { status: 'rejected', message: 'already rejected' };
      }
      if (run.state !== 'pending_approval') {
        await this.#markExpired(tx, action.id);
        return { status: 'error', code: 'INVALID_STATE', message: 'App Run approval is no longer valid' };
      }

      const now = this.now();
      await this.#markRejected(tx, action.id);
      run = await this.repository.transition(tx, {
        run,
        state: 'cancelled',
        actor: { actor_type: 'human', user_id: rejecterUserId },
        now,
        event_type: 'approval_resolved',
        error_code: 'APP_RUN_APPROVAL_REJECTED',
        safe_outcome: AppRunSafeOutcomeSchema.parse({
          success: false,
          provider_call_attempted: false,
          result_status: 'unavailable',
          error_code: 'APP_RUN_APPROVAL_REJECTED',
        }),
      });
      await this.#writeApprovalReceipt(
        tx,
        action.id,
        run,
        { actor_type: 'human', user_id: rejecterUserId },
        'rejected',
        run.terminal_at ?? now,
      );
      return { status: 'rejected' };
    });
    await this.#resolveApprovalAttention(actionId, rejecterUserId);
    return result;
  }

  async #lockAction(tx: AppRunTransaction, actionId: string) {
    await tx.execute(sql`SELECT id FROM agent_actions WHERE id = ${actionId} FOR UPDATE`);
    const [action] = await tx.select().from(agentActions)
      .where(eq(agentActions.id, actionId)).limit(1);
    return action ?? null;
  }

  async #markApproved(
    tx: AppRunTransaction,
    actionId: string,
    approverUserId: string,
    run: AppRunSafeView,
  ): Promise<void> {
    await tx.update(agentActions).set({
      approval_status: 'approved',
      approved_at: this.now(),
      approved_by_user_id: approverUserId,
      result: this.#safeResult(run, true),
      error: null,
      updated_at: this.now(),
    }).where(eq(agentActions.id, actionId));
  }

  async #markRejected(tx: AppRunTransaction, actionId: string): Promise<void> {
    await tx.update(agentActions).set({
      approval_status: 'rejected',
      result: null,
      error: 'App Run approval rejected',
      updated_at: this.now(),
    }).where(eq(agentActions.id, actionId));
  }

  async #markExpired(tx: AppRunTransaction, actionId: string): Promise<void> {
    await tx.update(agentActions).set({
      approval_status: 'expired',
      result: null,
      error: 'App Run authorization changed before approval',
      updated_at: this.now(),
    }).where(eq(agentActions.id, actionId));
  }

  #safeResult(run: AppRunSafeView, released: boolean): Record<string, unknown> {
    return {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      run_id: run.id,
      run_state: run.state,
      execution_released: released,
    };
  }

  async #writeApprovalReceipt(
    tx: AppRunTransaction,
    actionId: string,
    run: AppRunSafeView,
    actor: Readonly<{ actor_type: 'human'; user_id: string }>,
    decision: 'approved' | 'rejected' | 'expired',
    occurredAt: Date,
  ): Promise<void> {
    await this.receiptWriter.write(tx, {
      receipt_key: `approval:${actionId}`,
      receipt_kind: 'approval',
      run,
      actor,
      facts: { decision, action_id: actionId },
      occurred_at: occurredAt,
    });
  }

  async #resolveApprovalAttention(actionId: string, actorUserId: string): Promise<void> {
    try {
      const [action] = await db.select({
        org_id: agentActions.org_id,
        approval_status: agentActions.approval_status,
      }).from(agentActions).where(eq(agentActions.id, actionId)).limit(1);
      if (!action || action.approval_status === 'pending') return;
      await this.attention.resolveApproval(
        action.org_id,
        actionId,
        actorUserId,
        action.approval_status,
      );
    } catch (error) {
      console.warn('[app-runs] approval Attention resolution failed:',
        error instanceof Error ? error.message : 'unknown error');
    }
  }
}

export const postgresAppRunApprovalResolver = new PostgresAppRunApprovalResolver();
