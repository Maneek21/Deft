import { AppRunAuthorizationSnapshotSchema, type AppRunActor } from '@deft/shared';
import { agentActions, agentEmployees, appRuns, orgMembers } from '@deft/db/schema';
import { and, eq, type SQLWrapper } from 'drizzle-orm';
import { db } from './db.js';
import type { AppRunSafeView, AppRunTransaction } from './app-run-repository.js';

export type AppRunAccessAction = 'inspect' | 'result' | 'cancel' | 'reconcile';

export type AppRunReadAuthorityRef = Readonly<{
  authority_kind: 'token_scope';
  authority_id: string;
  version: string;
}>;

export interface AppRunAuthorizer {
  authorize(input: Readonly<{
    action: AppRunAccessAction;
    org_id: string;
    actor: AppRunActor;
    run: AppRunSafeView;
    required_authority_ref: AppRunReadAuthorityRef | null;
  }>): Promise<boolean>;
}

export const denyAllAppRunAuthorizer: AppRunAuthorizer = Object.freeze({
  async authorize() {
    return false;
  },
});

function actorMatchesRun(actor: AppRunActor, run: AppRunSafeView): boolean {
  const actorId = actor.actor_type === 'human'
    ? actor.user_id
    : actor.actor_type === 'agent_employee'
      ? actor.agent_employee_id
      : actor.actor_type === 'system'
        ? actor.system_id
        : actor.automation_id;
  return (
    actor.actor_type === run.initiating_actor_type && actorId === run.initiating_actor_id
  ) || (
    actor.actor_type === run.execution_actor_type && actorId === run.execution_actor_id
  );
}

/**
 * Run initiators and execution actors retain their actor-bound Run authority.
 * A human who approved the host-created App Run approval may additionally read
 * its safe Run projection and verified receipt ledger. Approval never grants
 * access to provider output, cancellation, reconciliation, or MCP token-bound
 * reads. Operator-wide inspection remains behind the operations authorizer.
 * This predicate does not check membership; both inspection and history callers
 * must independently require a current active organization membership.
 */
export function approvedAppRunReviewerCondition(orgId: string, runId: string | SQLWrapper, userId: string) {
  return and(
    eq(agentActions.org_id, orgId),
    eq(agentActions.app_run_id, runId),
    eq(agentActions.source, 'app_run'),
    eq(agentActions.action, 'app_run_invoke'),
    eq(agentActions.approval_status, 'approved'),
    eq(agentActions.approved_by_user_id, userId),
  );
}

export class PostgresAppRunAuthorizer implements AppRunAuthorizer {
  async authorize(input: Parameters<AppRunAuthorizer['authorize']>[0]): Promise<boolean> {
    if (input.org_id !== input.run.org_id) return false;
    const actorMatches = actorMatchesRun(input.actor, input.run);
    if (!actorMatches && !await this.#isApprovedReviewer(input)) return false;
    if (input.required_authority_ref) {
      const required = input.required_authority_ref;
      const [stored] = await db.select({
        authorization_snapshot: appRuns.authorization_snapshot,
      }).from(appRuns).where(and(
        eq(appRuns.org_id, input.org_id),
        eq(appRuns.id, input.run.id),
      )).limit(1);
      if (!stored) return false;
      const snapshot = AppRunAuthorizationSnapshotSchema.safeParse(stored.authorization_snapshot);
      if (
        !snapshot.success
        || !snapshot.data.authority_refs.some((ref) => (
          ref.authority_kind === required.authority_kind
          && ref.authority_id === required.authority_id
          && ref.version === required.version
        ))
      ) return false;
    }
    if (input.actor.actor_type === 'human') {
      const [membership] = await db.select({ id: orgMembers.id }).from(orgMembers).where(and(
        eq(orgMembers.org_id, input.org_id),
        eq(orgMembers.user_id, input.actor.user_id),
        eq(orgMembers.is_active, true),
      )).limit(1);
      return Boolean(membership);
    }
    if (input.actor.actor_type === 'agent_employee') {
      const [employee] = await db.select({ user_id: agentEmployees.user_id })
        .from(agentEmployees).where(and(
          eq(agentEmployees.org_id, input.org_id),
          eq(agentEmployees.id, input.actor.agent_employee_id),
          eq(agentEmployees.is_active, true),
          eq(agentEmployees.is_deleted, false),
        )).limit(1);
      if (!employee) return false;
      const [membership] = await db.select({ id: orgMembers.id }).from(orgMembers).where(and(
        eq(orgMembers.org_id, input.org_id),
        eq(orgMembers.user_id, employee.user_id),
        eq(orgMembers.is_active, true),
      )).limit(1);
      return Boolean(membership);
    }
    return false;
  }

  async #isApprovedReviewer(
    input: Parameters<AppRunAuthorizer['authorize']>[0],
  ): Promise<boolean> {
    // The exact-token authority snapshot is intentionally not transferable to
    // a reviewer. This exception is for a host-authenticated human reviewer.
    if (
      input.action !== 'inspect'
      || input.required_authority_ref !== null
      || input.actor.actor_type !== 'human'
    ) return false;
    const [approval] = await db.select({ id: agentActions.id }).from(agentActions).where(and(
      approvedAppRunReviewerCondition(input.org_id, input.run.id, input.actor.user_id),
    )).limit(1);
    return Boolean(approval);
  }
}

export interface AppRunExecutionAuthorizer {
  authorizeExecution(input: Readonly<{
    org_id: string;
    run: AppRunSafeView;
    tx: AppRunTransaction;
    stage: 'prepare' | 'claim' | 'provider_call';
    now: Date;
  }>): Promise<boolean>;
}

export const denyAllAppRunExecutionAuthorizer: AppRunExecutionAuthorizer = Object.freeze({
  async authorizeExecution() {
    return false;
  },
});
