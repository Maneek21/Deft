import { and, eq, inArray, ne } from 'drizzle-orm';
import { agentEmployees, spaceMembers, spaces } from '@deft/db/schema';
import { db } from './db.js';
import { normalizePlainAgentMentions } from './agent-mention-normalization.js';
import { parseMentions } from './mentions.js';
import { enqueue, QUEUE_NAMES } from './queues.js';

export type AgentMessageDispatchResult = {
  queuedEmployeeIds: string[];
  isDirect: boolean;
};

/**
 * Resolve BYOA recipients and enqueue their durable message wake.
 * This is the single publication seam for UI, REST, and human MCP writes.
 */
export async function dispatchAgentEmployeeMessage(params: {
  messageId: string;
  spaceId: string;
  orgId: string;
  actorUserId: string;
  content: string;
  mentionedUserIds?: string[];
}): Promise<AgentMessageDispatchResult> {
  try {
    const [space] = await db
      .select({ type: spaces.type })
      .from(spaces)
      .where(and(eq(spaces.id, params.spaceId), eq(spaces.org_id, params.orgId)))
      .limit(1);
    if (!space) return { queuedEmployeeIds: [], isDirect: false };

    const employees = await db
      .select({
        id: agentEmployees.id,
        user_id: agentEmployees.user_id,
        name: agentEmployees.name,
        slug: agentEmployees.slug,
      })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, params.orgId),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
        ne(agentEmployees.runtime_kind, 'defty_system'),
      ));

    const targetUserIds = new Set<string>([
      ...(params.mentionedUserIds ?? []),
      ...parseMentions(params.content).userIds,
      ...normalizePlainAgentMentions(
        params.content,
        employees.map((employee) => ({
          userId: employee.user_id,
          name: employee.name,
          slug: employee.slug,
        })),
      ).resolvedUserIds,
    ]);
    const isDirect = space.type === 'dm' || space.type === 'agent_conversation';
    let accessibleUserIds: Set<string> | null = null;
    if (space.type !== 'public') {
      const members = await db
        .select({ user_id: spaceMembers.user_id })
        .from(spaceMembers)
        .where(eq(spaceMembers.space_id, params.spaceId));
      accessibleUserIds = new Set(members.map((member) => member.user_id));
      if (isDirect) {
        for (const member of members) {
          if (member.user_id !== params.actorUserId) targetUserIds.add(member.user_id);
        }
      }
    }

    const targets = targetUserIds.size === 0
      ? []
      : employees.filter((employee) => (
          targetUserIds.has(employee.user_id)
          && (!accessibleUserIds || accessibleUserIds.has(employee.user_id))
        ));
    for (const employee of targets) {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-message', {
        messageId: params.messageId,
        spaceId: params.spaceId,
        orgId: params.orgId,
        employeeId: employee.id,
        isDM: isDirect,
      }, {
        orgId: params.orgId,
        dedupeKey: `agent-employee-message:${params.messageId}:${employee.id}`,
      });
    }
    return { queuedEmployeeIds: targets.map((employee) => employee.id), isDirect };
  } catch (err) {
    console.error('[dispatch-agent-message] enqueue failed:', err);
    return { queuedEmployeeIds: [], isDirect: false };
  }
}
