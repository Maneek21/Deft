import { and, eq, inArray } from 'drizzle-orm';
import { agentEmployees, orgMembers, users } from '@deft/db/schema';
import { db } from './db.js';
import { orgMemberPrivilegeHistory } from '@deft/db/two-step';
import { isProtectedMembership } from './membership-guard.js';

/**
 * The one way to manage an agent employee.
 *
 * THE RULE (owner's decision, 17 Nov). An agent employee whose membership is,
 * or ever was, owner or admin is managed only by the workspace owner.
 * "Managed" is anything that changes its credentials, its active state, its
 * authority or what can wake it: its MCP keys and channel keys, API keys
 * bound to it, pause, resume and mark healthy (over HTTP and over MCP), its
 * webhooks, its budget, its triggers, its certification, its settings,
 * deleting it, and cloning it. Agents that are and always were member-level
 * are managed as before: each route's own permission check decides.
 *
 * THE CHOKE POINT. Every such write runs inside `manageAgent(...)`'s `work`
 * callback, on the transaction it is handed:
 *   1. the agent's account row, then its membership row, are locked FOR NO
 *      KEY UPDATE on that transaction's own connection (the order a role
 *      change takes, so a promotion waits for the write or the write waits
 *      for the promotion; never both, never a second pooled connection);
 *   2. whether the agent is protected is read under those locks (current
 *      role, or org_member_privilege_history);
 *   3. a protected agent is refused unless the caller is the active owner;
 *   4. `work(tx, agent)` runs; it must use `tx` only. Using the global `db`
 *      inside it would take a second pooled connection while this one is
 *      held (round 8's deadlock), and test/protected-agent-writers.test.ts
 *      fails if any writer of an agent's credentials or state is outside a
 *      `work` callback or uses `db` inside one.
 *
 * An operation on several agents (reassigning a trigger away from peers)
 * calls `authorizeAgentManagement(tx, ...)` for each further agent inside
 * the first agent's `work`.
 */

export type AgentManagementTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ManagementActor = { userId: string; orgId: string };
export type ManagedAgent = {
  employeeId: string;
  /** The agent's own user (its membership). Null only for broken legacy rows. */
  userId: string | null;
  /** Is or was owner or admin. */
  protected: boolean;
};

export type AgentManagementRefusal = { status: 403 | 404; error: string; code: 'FORBIDDEN' | 'NOT_FOUND' };
export type AgentManagementResult<T> = { ok: true; value: T; agent: ManagedAgent } | ({ ok: false } & AgentManagementRefusal);

export const PROTECTED_AGENT_REFUSAL = 'Only the owner can manage an agent that is or was an owner or admin';

class Refused extends Error {
  constructor(readonly refusal: AgentManagementRefusal) {
    super(refusal.error);
  }
}

/**
 * Inside an open transaction: lock the agent's account and membership, decide
 * the rule, and return the agent, or throw a refusal that `manageAgent` turns
 * into its result (and that rolls the transaction back).
 */
export async function authorizeAgentManagement(tx: AgentManagementTx, actor: ManagementActor, employeeId: string): Promise<ManagedAgent> {
  const [employee] = await tx.select({ id: agentEmployees.id, user_id: agentEmployees.user_id }).from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, actor.orgId))).limit(1);
  if (!employee) throw new Refused({ status: 404, error: 'Agent employee not found', code: 'NOT_FOUND' });
  if (!employee.user_id) return { employeeId: employee.id, userId: null, protected: false };

  // Same order as a role change (membership-guard lockMembership): account, then membership.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, employee.user_id)).for('no key update');
  const [membership] = await tx.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, actor.orgId), eq(orgMembers.user_id, employee.user_id))).for('no key update');
  const isProtected = membership ? await isProtectedMembership(tx, actor.orgId, employee.user_id, membership.role) : false;
  if (isProtected) {
    const [acting] = await tx.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, actor.orgId), eq(orgMembers.user_id, actor.userId), eq(orgMembers.is_active, true))).limit(1);
    if (acting?.role !== 'owner') throw new Refused({ status: 403, error: PROTECTED_AGENT_REFUSAL, code: 'FORBIDDEN' });
  }
  return { employeeId: employee.id, userId: employee.user_id, protected: isProtected };
}

/** The choke point: authorize under the agent's locks, then run `work` on the same transaction. */
export async function manageAgent<T>(
  actor: ManagementActor,
  employeeId: string,
  work: (tx: AgentManagementTx, agent: ManagedAgent) => Promise<T>,
): Promise<AgentManagementResult<T>> {
  try {
    return await db.transaction(async (tx) => {
      const agent = await authorizeAgentManagement(tx, actor, employeeId);
      const value = await work(tx, agent);
      return { ok: true as const, value, agent };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, ...err.refusal };
    throw err;
  }
}

/**
 * For a write that may or may not be bound to an agent (an API key): with an
 * agent, exactly `manageAgent`; without one, `work` runs on a plain
 * transaction with no agent. Either way the write is inside the choke point.
 */
export async function manageAgentIfBound<T>(
  actor: ManagementActor,
  employeeId: string | null | undefined,
  work: (tx: AgentManagementTx, agent: ManagedAgent | null) => Promise<T>,
): Promise<{ ok: true; value: T; agent: ManagedAgent | null } | ({ ok: false } & AgentManagementRefusal)> {
  if (employeeId) return manageAgent(actor, employeeId, work);
  const value = await db.transaction((tx) => work(tx, null));
  return { ok: true, value, agent: null };
}

/** Throw from inside `work` to refuse and roll back (for example a peer found protected). */
export function refuseAgentManagement(refusal: AgentManagementRefusal): never {
  throw new Refused(refusal);
}

/**
 * Read-only, for showing or hiding controls (GET responses): is this agent
 * owner-only, and may this person manage it? The write itself is decided
 * again under the lock by `manageAgent`.
 */
export async function agentManagementView(
  actor: ManagementActor & { role: string | null | undefined },
  agentUserId: string | null,
): Promise<{ owner_only: boolean; can_manage: boolean }> {
  let ownerOnly = false;
  if (agentUserId) {
    const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, actor.orgId), eq(orgMembers.user_id, agentUserId))).limit(1);
    ownerOnly = Boolean(membership && await isProtectedMembership(db, actor.orgId, agentUserId, membership.role));
  }
  return managementFor(actor.role, ownerOnly);
}

/** For a list (GET /api/agent-employees): the agent users in this org that are owner-only. */
export async function ownerOnlyAgentUsers(orgId: string): Promise<Set<string>> {
  const privileged = await db.select({ user_id: orgMembers.user_id }).from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), inArray(orgMembers.role, ['owner', 'admin'])));
  const former = await db.select({ user_id: orgMemberPrivilegeHistory.user_id }).from(orgMemberPrivilegeHistory)
    .where(eq(orgMemberPrivilegeHistory.org_id, orgId));
  return new Set([...privileged, ...former].map((row) => row.user_id));
}

export function managementFor(viewerRole: string | null | undefined, ownerOnly: boolean): { owner_only: boolean; can_manage: boolean } {
  return { owner_only: ownerOnly, can_manage: viewerRole === 'owner' || (viewerRole === 'admin' && !ownerOnly) };
}
