/**
 * The one decision of whether a human chat post wakes Defty, shared by the web
 * route (`POST /api/messages/:spaceId`) and the human MCP tools
 * (`message_post`, `send_message`). Both must wake Defty under exactly the same
 * conditions and through the same deduplicated `agent-reply` job.
 *
 * Lifecycle for a caller that inserts one message:
 *   1. `planDeftyWake` before the insert transaction (reads only).
 *   2. `enqueueExplicitDeftyWake(tx, …)` inside the insert transaction, so an
 *      explicit wake commits (or rolls back) with the message.
 *   3. `finishDeftyWake` after commit: implicit thread-follow and the visible
 *      "no reasoning provider" reply.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { messages, orgMembers, orgs, spaceMembers, spaces, userGroupMembers, userGroups, users } from '@deft/db/schema';
import { db } from './db.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from './ensure-defty-membership.js';
import { parseMentions } from './mentions.js';
import { resolveReasonProvider, type ResolvedReasonProvider } from './org-ai-config.js';
import { enqueue, QUEUE_NAMES, type QueueExecutor } from './queues.js';
import { shouldFollowThread } from './defty-thread-follow.js';
import { isPrivateDeftySpace } from './app-private-defty-message-guard.js';
import { getIO } from '../socket.js';

export type AgentReplyJobData = {
  spaceId: string;
  messageId: string;
  parentId?: string;
  orgId: string;
  userId: string;
  orgName: string;
  content: string;
  followed?: true;
};

/** One agent-reply job per trigger message. The dedupe key is derived from the
 * message id, so a retried or replayed enqueue is absorbed by the queue's
 * unique (org_id, dedupe_key) index instead of waking Defty twice. Pass the
 * message's transaction as `executor` so the job commits with the message. */
export function enqueueAgentReply(data: AgentReplyJobData, executor?: QueueExecutor): Promise<void> {
  return enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-reply', data, {
    orgId: data.orgId,
    dedupeKey: `agent-reply:${data.messageId}`,
    ...(executor ? { executor } : {}),
  });
}

async function resolveGroupMentionUserIds(content: string, orgId: string): Promise<string[]> {
  const handles = Array.from(
    new Set(
      Array.from(content.matchAll(/(^|[\s(>])@([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\b/g))
        .map((match) => match[2]?.toLowerCase())
        .filter((handle): handle is string => !!handle),
    ),
  );
  if (handles.length === 0) return [];

  const rows = await db
    .select({ user_id: userGroupMembers.user_id })
    .from(userGroups)
    .innerJoin(userGroupMembers, eq(userGroupMembers.group_id, userGroups.id))
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, userGroupMembers.user_id),
      eq(orgMembers.org_id, userGroups.org_id),
      eq(orgMembers.is_active, true),
    ))
    .where(and(
      eq(userGroups.org_id, orgId),
      inArray(userGroups.handle, handles),
    ));

  return Array.from(new Set(rows.map((row) => row.user_id)));
}

/** Direct `<@id|Name>` mentions plus active members of mentioned `@group` handles. */
export async function resolveMentionedUserIds(content: string, orgId: string): Promise<string[]> {
  const { userIds } = parseMentions(content);
  const groupUserIds = await resolveGroupMentionUserIds(content, orgId);
  return Array.from(new Set([...userIds, ...groupUserIds]));
}

/** Decide, before the message is inserted, whether this post explicitly wakes
 * Defty: a Defty mention (structured or legacy alias), or any post in a DM /
 * agent_conversation space Defty belongs to. Implicit thread-follow depends on
 * the committed trigger row and is decided after commit. */
async function resolveExplicitDeftyWake(params: {
  orgId: string;
  userId: string;
  spaceId: string;
  content: string;
  mentionedUserIds: string[];
}): Promise<boolean> {
  if (params.mentionedUserIds.length > 0) {
    const deftyMatch = await db
      .select({ id: users.id })
      .from(users)
      .where(and(
        inArray(users.id, params.mentionedUserIds),
        eq(users.email, DEFTY_EMAIL),
      ))
      .limit(1);
    if (deftyMatch.length > 0) return true;
  }
  // Backwards-compat fallback: legacy `<@agent|Deft>` and freeform `@defty`/`@deft`/`@agent` still trigger Defty.
  if (/@(agent|defty|deft)\b|<@agent\|Defty?>/i.test(params.content)) return true;
  const [spaceRow] = await db.select({ type: spaces.type })
    .from(spaces).where(and(eq(spaces.id, params.spaceId), eq(spaces.org_id, params.orgId))).limit(1);
  if (spaceRow && (spaceRow.type === 'dm' || spaceRow.type === 'agent_conversation')) {
    const deftyUserId = await ensureDeftyMembership(params.orgId);
    if (deftyUserId !== params.userId) {
      const [deftyMember] = await db.select({ user_id: spaceMembers.user_id })
        .from(spaceMembers)
        .where(and(eq(spaceMembers.space_id, params.spaceId), eq(spaceMembers.user_id, deftyUserId)))
        .limit(1);
      if (deftyMember) return true;
    }
  }
  return false;
}

export type DeftyWakeInput = {
  orgId: string;
  userId: string;
  spaceId: string;
  /** Content exactly as stored. */
  content: string;
  mentionedUserIds: string[];
  parentId?: string | null;
};

export type DeftyWakePlan = {
  explicit: boolean;
  providerReason: ResolvedReasonProvider | null;
  providerReady: boolean;
  orgName: string;
};

async function resolveDeftyProvider(orgId: string) {
  const providerReason = await resolveReasonProvider(orgId);
  const providerReady = Boolean(providerReason.apiKey) || providerReason.provider === 'ollama';
  let orgName = 'Unknown';
  if (providerReady) {
    const [org] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    orgName = org?.name ?? 'Unknown';
  }
  return { providerReason, providerReady, orgName };
}

/**
 * Step 1, before the insert. Defty dispatch is gated on the org having a usable
 * reasoning provider — not specifically Anthropic; the key usually lives in org
 * config, not env. A sealed private-Defty space never wakes the chat Defty
 * (the web route refuses to post there at all).
 */
export async function planDeftyWake(input: DeftyWakeInput): Promise<DeftyWakePlan> {
  const none: DeftyWakePlan = { explicit: false, providerReason: null, providerReady: false, orgName: 'Unknown' };
  if (await isPrivateDeftySpace(input.orgId, input.spaceId)) return none;
  const explicit = await resolveExplicitDeftyWake(input);
  if (!explicit) return none;
  return { explicit, ...(await resolveDeftyProvider(input.orgId)) };
}

/** Step 2, inside the insert transaction. A failed job insert fails the
 * transaction, so the caller never reports success for a message Defty
 * was asked to answer but will never see. */
export async function enqueueExplicitDeftyWake(
  tx: QueueExecutor,
  plan: DeftyWakePlan,
  input: DeftyWakeInput & { messageId: string },
): Promise<void> {
  if (!plan.explicit || !plan.providerReady) return;
  await enqueueAgentReply({
    spaceId: input.spaceId,
    messageId: input.messageId,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    orgId: input.orgId,
    userId: input.userId,
    orgName: plan.orgName,
    content: input.content,
  }, tx);
}

/** Step 3, after commit: implicit thread-follow, then the visible reply when
 * Defty was woken but no reasoning provider is usable. Never throws. */
export async function finishDeftyWake(
  plan: DeftyWakePlan,
  input: DeftyWakeInput & { messageId: string },
): Promise<void> {
  let woke = plan.explicit;
  let providerReason = plan.providerReason;
  let providerReady = plan.providerReady;
  // Follow an engaged Defty thread — no mention required. This reads the
  // committed trigger row, so it is decided (and enqueued) after commit.
  if (!woke && input.parentId) {
    try {
      const [spaceRow] = await db.select({ type: spaces.type })
        .from(spaces).where(and(eq(spaces.id, input.spaceId), eq(spaces.org_id, input.orgId))).limit(1);
      if (spaceRow && (spaceRow.type === 'public' || spaceRow.type === 'private' || spaceRow.type === 'group_dm')
        && !await isPrivateDeftySpace(input.orgId, input.spaceId)) {
        const humanMentions = input.mentionedUserIds.length > 0
          ? await db.select({ id: users.id }).from(users)
            .where(and(inArray(users.id, input.mentionedUserIds), eq(users.kind, 'human'))).limit(1)
          : [];
        const followed = await shouldFollowThread({
          orgId: input.orgId, spaceId: input.spaceId, triggerMessageId: input.messageId,
          spaceType: spaceRow.type, parentId: input.parentId,
          authorId: input.userId, content: input.content, mentionsHuman: humanMentions.length > 0,
        });
        if (followed) {
          woke = true;
          const provider = await resolveDeftyProvider(input.orgId);
          providerReason = provider.providerReason;
          providerReady = provider.providerReady;
          if (providerReady) {
            await enqueueAgentReply({
              spaceId: input.spaceId,
              messageId: input.messageId,
              parentId: input.parentId,
              orgId: input.orgId,
              userId: input.userId,
              orgName: provider.orgName,
              content: input.content,
              followed: true,
            });
          }
        }
      }
    } catch (err) {
      // An implicit thread-follow is best-effort: the message is already
      // committed and the user did not address Defty directly.
      console.error('Failed to enqueue agent reply (thread follow):', err);
    }
  }
  if (woke && !providerReady && providerReason) {
    await postProviderUnavailableReply(providerReason, input).catch((err) => {
      console.error('Failed to post Defty provider-unavailable reply:', err);
    });
  }
}

async function postProviderUnavailableReply(
  providerReason: ResolvedReasonProvider,
  input: DeftyWakeInput & { messageId: string },
): Promise<void> {
  const [spaceRow] = await db.select({ type: spaces.type })
    .from(spaces)
    .where(eq(spaces.id, input.spaceId))
    .limit(1);
  const isDmLike = spaceRow?.type === 'dm' || spaceRow?.type === 'group_dm' || spaceRow?.type === 'agent_conversation';
  const replyParentId = isDmLike ? (input.parentId ?? null) : (input.parentId || input.messageId);
  const deftyUserId = await ensureDeftyMembership(input.orgId);
  const [agentMessage] = await db.insert(messages).values({
    org_id: input.orgId,
    space_id: input.spaceId,
    user_id: deftyUserId,
    content: `I need a usable reasoning model before I can answer. The current Defty reasoning route resolves to ${providerReason.provider}, but no usable ${providerReason.provider === 'ollama' ? 'Ollama endpoint' : 'API key'} is configured. Ask an admin to configure a reasoning provider in Settings > AI.`,
    parent_id: replyParentId,
    metadata: {
      is_agent_reply: true,
      kind: 'defty_provider_unavailable',
      provider: providerReason.provider,
      model: providerReason.model,
    } as never,
  }).returning();

  const io = getIO();
  if (io && agentMessage) {
    io.to(`space:${input.spaceId}`).emit('message:new', {
      ...agentMessage,
      user_name: 'Defty',
      user_avatar: null,
      reactions: [],
      reply_count: 0,
      latest_reply_at: null,
    });
  }
}
