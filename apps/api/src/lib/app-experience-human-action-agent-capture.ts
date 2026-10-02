import { and, eq, sql } from 'drizzle-orm';
import { agentEmployees, appRuntimeBindings, appRuntimeRegistrations, appRuntimeAgentPolicies } from '@deft/db/schema';
import { AppRunAuthorizationSnapshotSchema } from '@deft/shared';
import { isAgentToolDisabled } from './agent-tool-policy.js';
import { AppRunError } from './app-run-errors.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { ReviewedRuntimeCapture } from './app-run-service.js';
import { humanActionDigest } from './app-experience-human-action-contract.js';

export const RUNTIME_AGENT_TOOL = 'app_runtime_action_request';
export async function captureRuntimeAgent<T extends ReviewedRuntimeCapture>(tx: AppRunTransaction,
  input: { org_id: string; agent_employee_id: string; runtime_binding_id: string },
  capture: (tx: AppRunTransaction, caller: { org_id: string; user_id: string; runtime_binding_id: string }) => Promise<T>) {
  const [locator] = await tx.select({ owner: agentEmployees.user_id }).from(agentEmployees).where(and(
    eq(agentEmployees.org_id, input.org_id), eq(agentEmployees.id, input.agent_employee_id))).limit(1);
  const [operator] = await tx.select({ id: appRuntimeRegistrations.operator_user_id }).from(appRuntimeBindings)
    .innerJoin(appRuntimeRegistrations, and(eq(appRuntimeRegistrations.org_id, appRuntimeBindings.org_id),
      eq(appRuntimeRegistrations.id, appRuntimeBindings.runtime_registration_id)))
    .where(and(eq(appRuntimeBindings.org_id, input.org_id), eq(appRuntimeBindings.id, input.runtime_binding_id))).limit(1);
  if (!locator || !operator) throw new AppRunError('APP_RUN_ACCESS_DENIED');
  for (const id of [...new Set([locator.owner, operator.id])].sort()) {
    await tx.execute(sql`SELECT id FROM org_members WHERE org_id=${input.org_id} AND user_id=${id} FOR SHARE`);
  }
  const [employee] = await tx.select().from(agentEmployees).where(and(eq(agentEmployees.org_id, input.org_id),
    eq(agentEmployees.id, input.agent_employee_id))).limit(1).for('share');
  if (!employee || employee.user_id !== locator.owner || !employee.is_active || employee.is_deleted || employee.unhealthy
    || isAgentToolDisabled(employee.disabled_tools, RUNTIME_AGENT_TOOL)) throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const current = await capture(tx, { org_id: input.org_id, user_id: employee.user_id, runtime_binding_id: input.runtime_binding_id });
  if (current.protocol_version !== '7') throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const [policy] = await tx.select().from(appRuntimeAgentPolicies).where(and(eq(appRuntimeAgentPolicies.org_id, input.org_id),
    eq(appRuntimeAgentPolicies.owner_user_id, employee.user_id), eq(appRuntimeAgentPolicies.runtime_binding_id, input.runtime_binding_id)))
    .limit(1).for('share');
  if (!policy || policy.mode !== 'require_approval') throw new AppRunError('APP_RUN_ACCESS_DENIED');
  const authority_refs = [...current.authorization_snapshot.authority_refs,
    { authority_kind: 'employee_health' as const, authority_id: employee.id, version: humanActionDigest({
      owner: employee.user_id, version: employee.app_run_authorization_version, trust: employee.trust_level,
      disabled: [...(employee.disabled_tools ?? [])].sort(), healthy: !employee.unhealthy, active: employee.is_active }) },
    { authority_kind: 'employee_budget' as const, authority_id: employee.id, version: humanActionDigest({
      version: employee.app_run_authorization_version, limit: employee.max_daily_actions }) },
    { authority_kind: 'policy' as const, authority_id: `runtime-agent:${policy.runtime_binding_id}:${policy.owner_user_id}`,
      version: humanActionDigest({ revision: policy.revision, mode: policy.mode }) },
  ].sort((a, b) => `${a.authority_kind}\0${a.authority_id}`.localeCompare(`${b.authority_kind}\0${b.authority_id}`));
  return { ...current, agent_employee_id: employee.id, agent_owner_user_id: employee.user_id,
    authorization_snapshot: AppRunAuthorizationSnapshotSchema.parse({ ...current.authorization_snapshot,
      authenticated_subject: { actor_type: 'agent_employee', agent_employee_id: employee.id, user_id: employee.user_id }, authority_refs }) };
}
