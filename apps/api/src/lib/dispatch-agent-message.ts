import { and, eq, inArray, ne } from 'drizzle-orm';
import { agentEmployees, spaceMembers, spaces } from '@deft/db/schema';
import { db } from './db.js';
import { parseMentions } from './mentions.js';
import { enqueue, QUEUE_NAMES, type QueueExecutor } from './queues.js';

export type AgentMessageDispatchResult = {
  queuedEmployeeIds: string[];
  isDirect: boolean;
};

/** The BYOA employees a message wakes, resolved without reading the message
 * row itself, so it can be computed before the message's transaction. */
export type AgentEmployeeMessageTargets = {
  employeeIds: string[];
  isDirect: boolean;
};

type TargetParams = {
  spaceId: string;
  orgId: string;
  actorUserId: string;
  content: string;
  mentionedUserIds?: string[];
};

/**
 * Resolve which active BYOA employees a post wakes: structured mentions (the
 * caller has already run normalizeChatMentions) of an employee who can see the space, plus every non-author
 * employee member of a dm / agent_conversation. Throws on database errors.
 */
export async function resolveAgentEmployeeMessageTargets(params: TargetParams): Promise<AgentEmployeeMessageTargets> {
  const [space] = await db
    .select({ type: spaces.type })
    .from(spaces)
    .where(and(eq(spaces.id, params.spaceId), eq(spaces.org_id, params.orgId)))
    .limit(1);
  if (!space) return { employeeIds: [], isDirect: false };

  const employees = await db
    .select({
      id: agentEmployees.id,
      user_id: agentEmployees.user_id,
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
  return { employeeIds: targets.map((employee) => employee.id), isDirect };
}

/**
 * Insert one `agent-employee-message` job per resolved employee. The dedupe key
 * is derived from (message, employee), so a retried or replayed enqueue is
 * absorbed by the queue's unique (org_id, dedupe_key) index. Pass the message's
 * transaction as `executor` so the jobs commit (or roll back) with the message.
 * Throws on failure.
 */
export async function enqueueAgentEmployeeMessageJobs(
  targets: AgentEmployeeMessageTargets,
  params: { messageId: string; spaceId: string; orgId: string },
  executor?: QueueExecutor,
): Promise<void> {
  for (const employeeId of targets.employeeIds) {
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-message', {
      messageId: params.messageId,
      spaceId: params.spaceId,
      orgId: params.orgId,
      employeeId,
      isDM: targets.isDirect,
    }, {
      orgId: params.orgId,
      dedupeKey: `agent-employee-message:${params.messageId}:${employeeId}`,
      ...(executor ? { executor } : {}),
    });
  }
}

/**
 * Resolve BYOA recipients and enqueue their durable message wake.
 * This is the single publication seam for UI, REST, and human MCP writes.
 *
 * By default failures are logged and swallowed (best-effort, post-commit).
 * Pass `executor` to insert the jobs in the caller's transaction and
 * `throwOnFailure: true` to propagate errors so that transaction rolls back.
 */
export async function dispatchAgentEmployeeMessage(params: TargetParams & {
  messageId: string;
  executor?: QueueExecutor;
  throwOnFailure?: boolean;
}): Promise<AgentMessageDispatchResult> {
  try {
    const targets = await resolveAgentEmployeeMessageTargets(params);
    await enqueueAgentEmployeeMessageJobs(targets, params, params.executor);
    return { queuedEmployeeIds: targets.employeeIds, isDirect: targets.isDirect };
  } catch (err) {
    if (params.throwOnFailure) throw err;
    console.error('[dispatch-agent-message] enqueue failed:', err);
    return { queuedEmployeeIds: [], isDirect: false };
  }
}
