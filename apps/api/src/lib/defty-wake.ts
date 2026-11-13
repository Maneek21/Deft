/**
 * The one decision of whether a human chat post wakes Defty, shared by the web
 * route (`POST /api/messages/:spaceId`) and the human MCP tools
 * (`message_post`, `send_message`). Both must wake Defty under exactly the same
 * conditions and through the same deduplicated `agent-reply` job.
 *
 * Lifecycle for a caller that inserts one message:
 *   1. `planDeftyWake` before the insert transaction (reads only).
 *   2. `enqueueDeftyWake(tx, …)` inside the insert transaction, so the wake
 *      (explicit, or an implicit thread-follow) commits with the message.
 *   3. `finishDeftyWake` after commit: the visible "no reasoning provider" reply.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { agentEmployees, messages, orgMembers, orgs, spaceMembers, spaces, userGroupMembers, userGroups, users } from '@deft/db/schema';
import { db } from './db.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from './ensure-defty-membership.js';
import { parseMentions } from './mentions.js';
import { resolveReasonProvider, type ResolvedReasonProvider } from './org-ai-config.js';
import { enqueue, QUEUE_NAMES, type QueueExecutor } from './queues.js';
import { loadThreadFollowContext, shouldFollowThread } from './defty-thread-follow.js';
import { isPrivateDeftySpace } from './app-private-defty-message-guard.js';
import { claimDeftyReplySlot } from './defty-reply-guard.js';
import { getIO } from '../socket.js';
import { normalizePlainAgentMentions } from './agent-mention-normalization.js';
import type { CoreDatabaseTransaction } from './database-transaction.js';

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

export type NormalizedChatContent =
  | { ok: true; content: string }
  | { ok: false; error: string; code: 'AMBIGUOUS_AGENT_MENTION' };

/**
 * Normalise a human's chat post before it is stored and before any wake
 * decision: plain `@defty` / `@deft` / `@agent` become a structured Defty
 * mention, and a plain `@token` that exactly and uniquely matches an active
 * agent employee's slug or one-token name becomes a structured mention of that
 * employee. Any other token stays plain text. Used by the web route and the
 * human MCP post tools.
 */
export async function normalizeChatMentions(orgId: string, content: string): Promise<NormalizedChatContent> {
  let normalizedContent = content;
  if (!/<@[^|]+\|Defty?>/i.test(normalizedContent)) {
    const hasLegacyAgent = /(^|[^a-z0-9_])@(defty|deft|agent)\b/i.test(normalizedContent);
    if (hasLegacyAgent) {
      const deftyUserId = await ensureDeftyMembership(orgId);
      normalizedContent = normalizedContent.replace(
        /(^|[^a-z0-9_])@(defty|deft|agent)\b/gi,
        (_match, prefix) => `${prefix}<@${deftyUserId}|Defty>`,
      );
    }
  }

  const plainMentionScan = normalizedContent.replace(/<@[^>]+>/g, '');
  if (/(^|[^a-z0-9_])@[a-z0-9_-]/i.test(plainMentionScan)) {
    const agentIdentities = await db
      .select({
        userId: agentEmployees.user_id,
        name: agentEmployees.name,
        slug: agentEmployees.slug,
      })
      .from(agentEmployees)
      .innerJoin(users, eq(agentEmployees.user_id, users.id))
      .where(and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
      ));
    // Active human members of this org compete for the same token: a human
    // whose whole name is the token makes it ambiguous, so it stays plain.
    const humanNames = await db
      .select({ name: users.name })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.user_id))
      .where(and(
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.is_active, true),
        eq(users.kind, 'human'),
      ));
    const plainAgentMentions = normalizePlainAgentMentions(
      normalizedContent,
      agentIdentities.flatMap((agent) => agent.userId ? [{
        userId: agent.userId,
        name: agent.name,
        slug: agent.slug,
      }] : []),
      humanNames.map((human) => human.name),
    );
    normalizedContent = plainAgentMentions.content;
  }
  return { ok: true, content: normalizedContent };
}

/** Direct `<@id|Name>` mentions plus active members of mentioned `@group` handles. */
export async function resolveMentionedUserIds(content: string, orgId: string): Promise<string[]> {
  const { userIds } = parseMentions(content);
  const groupUserIds = await resolveGroupMentionUserIds(content, orgId);
  return Array.from(new Set([...userIds, ...groupUserIds]));
}

/** Decide, before the message is inserted, whether this post explicitly wakes
 * Defty: a Defty mention (structured or legacy alias), or any post in a DM /
 * agent_conversation space Defty belongs to. Implicit thread-follow is decided
 * inside the insert transaction (enqueueDeftyWake). */
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
  /** Set when an unaddressed reply here may follow an engaged Defty thread. */
  followSpaceType: string | null;
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
  const none: DeftyWakePlan = { explicit: false, followSpaceType: null, providerReason: null, providerReady: false, orgName: 'Unknown' };
  if (await isPrivateDeftySpace(input.orgId, input.spaceId)) return none;
  const explicit = await resolveExplicitDeftyWake(input);
  if (!explicit) {
    if (!input.parentId) return none;
    const [spaceRow] = await db.select({ type: spaces.type })
      .from(spaces).where(and(eq(spaces.id, input.spaceId), eq(spaces.org_id, input.orgId))).limit(1);
    const followable = spaceRow && (spaceRow.type === 'public' || spaceRow.type === 'private' || spaceRow.type === 'group_dm');
    if (!followable) return none;
    // Resolved now, outside the message transaction: step 2 must not take a
    // second pooled connection while the transaction holds one (four
    // concurrent follow-ups would otherwise exhaust the ordinary pool).
    return { ...none, followSpaceType: spaceRow.type, ...(await resolveDeftyProvider(input.orgId)) };
  }
  return { explicit, followSpaceType: null, ...(await resolveDeftyProvider(input.orgId)) };
}

type WakeTransaction = CoreDatabaseTransaction;

/** What step 2 decided; step 3 needs it for the no-provider reply. */
export type DeftyWakeOutcome = {
  woke: boolean;
  providerReason: ResolvedReasonProvider | null;
  providerReady: boolean;
};

/**
 * Step 2, inside the insert transaction. Every read here goes through `tx`
 * (or its savepoint): no global `db` or other pool while the transaction is
 * open; anything that needs one is resolved in step 1.
 *
 * An explicit wake's job joins the transaction: a failed job insert fails it,
 * so the caller never reports success for a message Defty was asked to answer
 * but will never see.
 *
 * An implicit thread-follow is decided here too, reading through the
 * transaction (which sees its own trigger row), and its job joins the same
 * commit, so a crash after commit cannot lose the wake. It runs in a savepoint:
 * the user did not address Defty, so a follow failure is logged and the human
 * message still commits. Both paths share the per-message dedupe key, so a
 * message is never enqueued twice.
 */
export async function enqueueDeftyWake(
  tx: WakeTransaction,
  plan: DeftyWakePlan,
  input: DeftyWakeInput & { messageId: string },
): Promise<DeftyWakeOutcome> {
  if (plan.explicit) {
    if (plan.providerReady) {
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
    return { woke: true, providerReason: plan.providerReason, providerReady: plan.providerReady };
  }
  const none: DeftyWakeOutcome = { woke: false, providerReason: null, providerReady: false };
  const parentId = input.parentId;
  const spaceType = plan.followSpaceType;
  if (!parentId || !spaceType) return none;
  try {
    return await tx.transaction(async (savepoint) => {
      const humanMentions = input.mentionedUserIds.length > 0
        ? await savepoint.select({ id: users.id }).from(users)
          .where(and(inArray(users.id, input.mentionedUserIds), eq(users.kind, 'human'))).limit(1)
        : [];
      const followed = await shouldFollowThread({
        orgId: input.orgId, spaceId: input.spaceId, triggerMessageId: input.messageId,
        spaceType, parentId,
        authorId: input.userId, content: input.content, mentionsHuman: humanMentions.length > 0,
      }, {
        loadContext: (value) => loadThreadFollowContext(value, savepoint),
      });
      if (!followed) return none;
      if (plan.providerReady) {
        await enqueueAgentReply({
          spaceId: input.spaceId,
          messageId: input.messageId,
          parentId,
          orgId: input.orgId,
          userId: input.userId,
          orgName: plan.orgName,
          content: input.content,
          followed: true,
        }, savepoint);
      }
      return { woke: true, providerReason: plan.providerReason, providerReady: plan.providerReady };
    });
  } catch (err) {
    console.error('Failed to enqueue agent reply (thread follow):', err);
    return none;
  }
}

/** Step 3, after commit: the visible reply when Defty was woken but no
 * reasoning provider is usable. Never throws. */
export async function finishDeftyWake(
  outcome: DeftyWakeOutcome | null,
  input: DeftyWakeInput & { messageId: string },
): Promise<void> {
  if (!outcome?.woke || outcome.providerReady || !outcome.providerReason) return;
  await postProviderUnavailableReply(outcome.providerReason, input).catch((err) => {
    console.error('Failed to post Defty provider-unavailable reply:', err);
  });
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

/**
 * Called when an `agent-reply` job has failed for good (its queue attempts are
 * exhausted, or it was failed as terminal). Posts one plain reply so the
 * requester is not left with a stopped working indicator. It goes through the
 * same one-reply guard as the handler, so a reply that already committed for
 * the trigger is never followed by a second one. The requester must still be
 * an active member of the (unarchived) space and the trigger must still exist,
 * as for the handler itself.
 */
export async function postDeftyReplyFailureNotice(jobData: unknown): Promise<void> {
  if (!jobData || typeof jobData !== 'object') return;
  const data = jobData as Record<string, unknown>;
  const { orgId, spaceId, messageId, userId } = data;
  const parentId = typeof data.parentId === 'string' ? data.parentId : undefined;
  if (typeof orgId !== 'string' || typeof spaceId !== 'string' || typeof messageId !== 'string' || typeof userId !== 'string') return;
  const [space] = await db.select({ type: spaces.type }).from(spaces)
    .innerJoin(spaceMembers, and(eq(spaceMembers.space_id, spaces.id), eq(spaceMembers.user_id, userId)))
    .innerJoin(orgMembers, and(eq(orgMembers.org_id, spaces.org_id), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)))
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId), eq(spaces.is_archived, false)))
    .limit(1);
  if (!space) return;
  const [trigger] = await db.select({ created_at: messages.created_at }).from(messages).where(and(
    eq(messages.id, messageId), eq(messages.org_id, orgId), eq(messages.space_id, spaceId),
    eq(messages.user_id, userId), eq(messages.is_deleted, false),
  )).limit(1);
  if (!trigger) return;
  const agentUserId = await ensureDeftyMembership(orgId);
  const isDmLike = space.type === 'dm' || space.type === 'group_dm' || space.type === 'agent_conversation';
  const parent = isDmLike ? (parentId ?? null) : (parentId || messageId);
  const replyTrigger = { orgId, spaceId, agentUserId, triggerMessageId: messageId, triggerCreatedAt: trigger.created_at };
  const posted = await db.transaction(async (tx) => {
    if (await claimDeftyReplySlot(tx, replyTrigger)) return null;
    const [row] = await tx.insert(messages).values({
      org_id: orgId,
      space_id: spaceId,
      user_id: agentUserId,
      content: 'I could not finish this reply. Please try again.',
      parent_id: parent,
      metadata: { is_agent_reply: true, reply_to_message_id: messageId, kind: 'defty_reply_failed' } as never,
    }).returning();
    return row ?? null;
  });
  const io = getIO();
  if (io && posted) {
    io.to(`space:${spaceId}`).emit('message:new', {
      ...posted, user_name: 'Defty', user_avatar: null, reactions: [], reply_count: 0, latest_reply_at: null,
    });
  }
}
