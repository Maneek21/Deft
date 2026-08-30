import type { AppRunActor } from '@deft/shared';
import { agentEmployees, orgMembers } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import type { AppRunSafeView, AppRunTransaction } from './app-run-repository.js';

export type AppRunAccessAction = 'inspect' | 'result' | 'cancel' | 'reconcile';

export interface AppRunAuthorizer {
  authorize(input: Readonly<{
    action: AppRunAccessAction;
    org_id: string;
    actor: AppRunActor;
    run: AppRunSafeView;
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

/** Live owner access for exact result replay and cancellation. Operator-wide
 * inspection remains behind the separate operations authorizer. */
export class PostgresAppRunAuthorizer implements AppRunAuthorizer {
  async authorize(input: Parameters<AppRunAuthorizer['authorize']>[0]): Promise<boolean> {
    if (input.org_id !== input.run.org_id || !actorMatchesRun(input.actor, input.run)) return false;
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
