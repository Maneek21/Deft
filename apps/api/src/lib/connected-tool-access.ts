import { and, eq, isNull } from 'drizzle-orm';
import { agentActions, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { loadActionRequesterId, requesterActionColumns } from './agent-action-requester.js';

/**
 * Connected (MCP) tools are available to workspace members, admins and
 * owners. A call is made for its requester: the requester of its action row
 * when one exists, otherwise the user the call executes for.
 */
export const CONNECTED_TOOL_UNAVAILABLE_ERROR = 'Connected tools are available to workspace members.';

export function isConnectedToolName(toolName: unknown): boolean {
  return typeof toolName === 'string' && toolName.startsWith('mcp__');
}

/** True when the user's role in the workspace is guest. */
export async function isWorkspaceGuest(orgId: string, userId: string): Promise<boolean> {
  const [guest] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId), eq(orgMembers.role, 'guest')))
    .limit(1);
  return Boolean(guest);
}

/** The requester of a connected call: its action row's requester, else the actor. */
export async function connectedCallRequesterId(
  orgId: string,
  actorUserId: string,
  actionId?: string,
): Promise<string> {
  if (!actionId) return actorUserId;
  const [row] = await db
    .select(requesterActionColumns)
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)))
    .limit(1);
  return row ? loadActionRequesterId(row) : actorUserId;
}

/** Settle an action whose connected call was refused before any provider call. */
export async function settleRefusedConnectedAction(orgId: string, actionId: string): Promise<void> {
  await db
    .update(agentActions)
    .set({ error: CONNECTED_TOOL_UNAVAILABLE_ERROR, executed_at: new Date(), updated_at: new Date() })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId), isNull(agentActions.executed_at)));
}

export interface ConnectedCallAccess {
  /** Resolves true when the call may proceed; settles a refused action row. */
  allows(orgId: string, actorUserId: string, actionId?: string): Promise<boolean>;
}

export const workspaceConnectedCallAccess: ConnectedCallAccess = {
  async allows(orgId, actorUserId, actionId) {
    const requesterId = await connectedCallRequesterId(orgId, actorUserId, actionId);
    if (!(await isWorkspaceGuest(orgId, requesterId))) return true;
    if (actionId) await settleRefusedConnectedAction(orgId, actionId);
    return false;
  },
};
