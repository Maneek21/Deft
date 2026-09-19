import { agentEmployees } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import { getActiveAgentToolPolicy } from './agent-tool-policy.js';
import { canonicalDeftyEmployeeCondition } from './defty-identity.js';
import { deftyModuleActor, employeeModuleActor } from './module-service.js';
import { requireActiveOrgMembership } from './org-membership.js';

/** App authority follows the requesting human for Defty, and the assigned
 * employee for external runtimes. The shared conversation model gives both
 * an employee ID, so that ID alone cannot choose the App caller surface. */
export async function buildNativeAppActionActor(input: {
  orgId: string;
  userId: string;
  agentEmployeeId?: string;
  conversationId?: string;
}) {
  if (input.agentEmployeeId) {
    const policy = await getActiveAgentToolPolicy(input.orgId, input.agentEmployeeId);
    if (!policy) throw new Error('Agent employee is inactive, deleted, or outside this organization');
    const [canonicalDefty] = await db.select({ id: agentEmployees.id }).from(agentEmployees).where(and(
      eq(agentEmployees.org_id, input.orgId),
      eq(agentEmployees.id, input.agentEmployeeId),
      eq(agentEmployees.is_active, true),
      canonicalDeftyEmployeeCondition(),
    )).limit(1);
    if (!canonicalDefty) {
      return employeeModuleActor({
        orgId: input.orgId,
        employeeId: input.agentEmployeeId,
        trustLevel: policy.trustLevel,
        source: 'runtime',
      });
    }
  }
  const membership = await requireActiveOrgMembership(input.orgId, input.userId);
  return deftyModuleActor({
    orgId: input.orgId,
    userId: input.userId,
    role: membership.role,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  });
}
