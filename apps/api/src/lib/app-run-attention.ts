import { agentActions, agentEmployees } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  resolveAttentionBySource,
  syncApprovalToAttention,
  upsertAttentionItem,
} from './attention.js';
import { db } from './db.js';
import type { AppRunSafeView } from './app-run-repository.js';

export type AppRunAttentionKind = 'failure' | 'unknown_outcome' | 'repair_gap' | 'reconciled';

export interface AppRunAttentionProjector {
  projectApprovalRequested(orgId: string, runId: string): Promise<void>;
  resolveApproval(orgId: string, actionId: string, actorUserId: string, resolution: string): Promise<void>;
  resolveRun(orgId: string, runId: string, actorUserId: string, resolution: string): Promise<void>;
  projectRunState(run: AppRunSafeView, kind: AppRunAttentionKind): Promise<void>;
}

export const noOpAppRunAttentionProjector: AppRunAttentionProjector = Object.freeze({
  async projectApprovalRequested() {},
  async resolveApproval() {},
  async resolveRun() {},
  async projectRunState() {},
});

export class PostgresAppRunAttentionProjector implements AppRunAttentionProjector {
  constructor(private readonly deliver = true) {}

  async projectApprovalRequested(orgId: string, runId: string): Promise<void> {
    const [action] = await db.select().from(agentActions).where(and(
      eq(agentActions.org_id, orgId),
      eq(agentActions.app_run_id, runId),
      eq(agentActions.action, 'app_run_invoke'),
    )).limit(1);
    if (action) await syncApprovalToAttention(action, { deliver: this.deliver });
  }

  async resolveApproval(
    orgId: string,
    actionId: string,
    actorUserId: string,
    resolution: string,
  ): Promise<void> {
    await resolveAttentionBySource({
      orgId,
      sourceType: 'agent_action',
      sourceId: actionId,
      resolution,
      actorUserId,
    });
  }

  async resolveRun(
    orgId: string,
    runId: string,
    actorUserId: string,
    resolution: string,
  ): Promise<void> {
    await resolveAttentionBySource({
      orgId,
      sourceType: 'app_run',
      sourceId: runId,
      resolution,
      actorUserId,
    });
  }

  async projectRunState(run: AppRunSafeView, kind: AppRunAttentionKind): Promise<void> {
    const userId = await this.#recipientUserId(run);
    if (!userId) return;
    if (kind === 'reconciled') {
      await this.resolveRun(run.org_id, run.id, userId, 'reconciled');
    }
    const occurredAt = kind === 'unknown_outcome'
      ? run.unknown_outcome_at
      : kind === 'reconciled'
        ? run.reconciled_at
        : run.terminal_at;
    const presentation = kind === 'unknown_outcome'
      ? {
          lane: 'needs_you' as const,
          priority: 'critical' as const,
          title: 'App Run outcome needs review',
          body: `${run.operation_name} may have reached its provider; do not retry it blindly.`,
        }
      : kind === 'repair_gap'
        ? {
            lane: 'needs_you' as const,
            priority: 'critical' as const,
            title: 'App Run ledger needs repair',
            body: `${run.operation_name} is missing a required audit projection.`,
          }
        : kind === 'failure'
          ? {
              lane: 'needs_you' as const,
              priority: 'high' as const,
              title: 'App Run failed',
              body: `${run.operation_name} did not complete successfully.`,
            }
          : {
              lane: 'updates' as const,
              priority: 'normal' as const,
              title: 'App Run outcome reconciled',
              body: `${run.operation_name} now has an operator-recorded outcome.`,
            };
    await upsertAttentionItem({
      orgId: run.org_id,
      userId,
      kind: `app_run_${kind}`,
      lane: presentation.lane,
      priority: presentation.priority,
      dedupeKey: `app-run:${kind}:${run.id}`,
      sourceType: 'app_run',
      sourceId: run.id,
      sourceEventId: `app-run:${run.id}:${kind}`,
      title: presentation.title,
      body: presentation.body,
      metadata: {
        run_id: run.id,
        root_run_id: run.root_run_id,
        parent_run_id: run.parent_run_id,
        depth: run.depth,
        run_state: run.state,
        provider_kind: run.provider_kind,
        operation_name: run.operation_name,
        risk_class: run.risk_class,
      },
      occurredAt: occurredAt ?? run.updated_at,
    }, { deliver: this.deliver });
  }

  async #recipientUserId(run: AppRunSafeView): Promise<string | null> {
    if (run.initiating_actor_type === 'human') return run.initiating_actor_id;
    if (run.initiating_actor_type !== 'agent_employee') return null;
    const [employee] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees).where(and(
        eq(agentEmployees.org_id, run.org_id),
        eq(agentEmployees.id, run.initiating_actor_id),
      )).limit(1);
    return employee?.user_id ?? null;
  }
}
