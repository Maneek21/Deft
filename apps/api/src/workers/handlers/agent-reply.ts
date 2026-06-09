// Handler: process @agent/@deft mentions in chat and generate AI replies in-thread
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { messages, users, spaces, spaceMembers, agentActions } from '@deft/db/schema';
import { getApprovalTier } from '../../lib/agent-approval.js';
import { eq, and, desc, sql, ne } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { ensureDeftyMembership, DEFTY_NAME } from '../../lib/ensure-defty-membership.js';

function extractExplicitCreateTaskAction(content: string, sourceMessageId: string) {
  const title = content.match(/\b(?:task|todo|ticket)\s+(?:titled|called|named)\s+"([^"]+)"/i)?.[1]
    ?? content.match(/\b(?:task|todo|ticket)\s+(?:titled|called|named)\s+'([^']+)'/i)?.[1];
  const projectName = content.match(/\bproject\s+"([^"]+)"/i)?.[1]
    ?? content.match(/\bproject\s+'([^']+)'/i)?.[1];

  if (!title || !projectName || !/\b(create|add|make|open|track)\b/i.test(content)) {
    return null;
  }

  const assigneeName = content.match(/\bassigned to\s+([^.;\n]+?)(?:\s+(?:and|with|for|due)\b|[.;\n]|$)/i)?.[1]?.trim();
  const description = content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  return {
    action: 'create_task',
    params: {
      title,
      project_name: projectName,
      ...(assigneeName ? { assignee_name: assigneeName } : {}),
      description,
      source_message_id: sourceMessageId,
    },
    approval_tier: getApprovalTier('create_task'),
    tool_use_id: null,
    source: 'deterministic_create_task_fallback',
  };
}

export async function handleAgentReply(job: JobData): Promise<void> {
  const {
    orgId,
    spaceId,
    messageId,
    parentId,
    userId,
    orgName,
    content,
  } = job.data as {
    orgId: string;
    spaceId: string;
    messageId: string;
    parentId?: string;
    userId: string;
    orgName: string;
    content: string;
  };

  console.log(`[agent-reply] Processing agent reply for message ${messageId} in space ${spaceId}`);

  try {
    // Load space context — type drives both threading behavior and the
    // system-prompt hint so the agent adapts tone (DM vs channel).
    const [space] = await db
      .select({ type: spaces.type, name: spaces.name })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);

    const isDmLike = space?.type === 'dm' || space?.type === 'group_dm' || space?.type === 'agent_conversation';

    // Threading rule:
    // - In channels: thread off the triggering message (or its parent thread root)
    //   so the channel isn't cluttered.
    // - In DMs: reply flat (no parent_id) UNLESS the user explicitly threaded —
    //   DMs read like a normal conversation, not a tree of threads.
    const threadParentId = isDmLike ? (parentId ?? null) : (parentId || messageId);
    // The thread we load history from — for DMs without explicit threading,
    // we still want recent flat history; agent-runner gets it via conversationHistory.
    const historyParentId = parentId || messageId;

    // Load conversation history.
    // - DM (no explicit thread): last 10 top-level messages in the space.
    // - Channel or explicit thread: last 10 messages in the thread + the
    //   thread root for context.
    const agentUserId = await ensureDeftyMembership(orgId);
    const conversationHistory: { role: string; content: string }[] = [];

    if (isDmLike && !parentId) {
      const recent = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
      })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(and(
          eq(messages.space_id, spaceId),
          eq(messages.org_id, orgId),
          eq(messages.is_deleted, false),
          sql`${messages.parent_id} IS NULL`,
          ne(messages.id, messageId),
        ))
        .orderBy(desc(messages.created_at))
        .limit(10);
      for (const msg of recent.reverse()) {
        conversationHistory.push({
          role: msg.user_id === agentUserId ? 'assistant' : 'user',
          content: msg.user_id === agentUserId ? msg.content : `[${msg.user_name}]: ${msg.content}`,
        });
      }
    } else {
      const threadMessages = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
      })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(and(
          eq(messages.parent_id, historyParentId),
          eq(messages.org_id, orgId),
          eq(messages.is_deleted, false),
        ))
        .orderBy(desc(messages.created_at))
        .limit(10);

      const [parentMsg] = await db.select({
        id: messages.id,
        content: messages.content,
        user_id: messages.user_id,
        user_name: users.name,
      })
        .from(messages)
        .innerJoin(users, eq(messages.user_id, users.id))
        .where(eq(messages.id, historyParentId))
        .limit(1);

      if (parentMsg && parentMsg.id !== messageId) {
        conversationHistory.push({
          role: parentMsg.user_id === agentUserId ? 'assistant' : 'user',
          content: parentMsg.user_id === agentUserId ? parentMsg.content : `[${parentMsg.user_name}]: ${parentMsg.content}`,
        });
      }

      for (const msg of [...threadMessages].reverse()) {
        if (msg.id === messageId) continue;
        conversationHistory.push({
          role: msg.user_id === agentUserId ? 'assistant' : 'user',
          content: msg.user_id === agentUserId ? msg.content : `[${msg.user_name}]: ${msg.content}`,
        });
      }
    }

    // Resolve the other DM member's name (if any) for the system prompt hint.
    let otherMemberName: string | undefined;
    if (isDmLike) {
      const [other] = await db.select({ name: users.name })
        .from(spaceMembers)
        .innerJoin(users, eq(users.id, spaceMembers.user_id))
        .where(and(
          eq(spaceMembers.space_id, spaceId),
          ne(spaceMembers.user_id, agentUserId),
        ))
        .limit(1);
      otherMemberName = other?.name;
    }

    // Strip the @agent/@deft mention from the content for a cleaner prompt
    const cleanContent = content.replace(/<@[^|]*\|Defty?>/gi, '').replace(/@(agent|defty|deft)\b/gi, '').trim();
    const promptContent = cleanContent || 'Hey, what can you help me with?';

    // Call the agent reasoning engine with a 60s hard timeout so a stuck
    // MCP tool / Anthropic call can never wedge the worker.
    const AGENT_TIMEOUT_MS = 60_000;
    const result = await Promise.race([
      runAgentQuery({
        content: promptContent,
        orgId,
        userId,
        orgName,
        conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
        // Task 3.2 — thread the triggering message id so write actions like
        // create_task can inherit source_message_id without the LLM having
        // to know about it.
        sourceMessageId: messageId,
        spaceContext: space ? {
          type: space.type as 'dm' | 'group_dm' | 'agent_conversation' | 'public' | 'private',
          name: space.name,
          otherMemberName,
        } : undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('agent-reply: runAgentQuery timeout after 60s')), AGENT_TIMEOUT_MS),
      ),
    ]);

    if (!result.text) {
      console.warn('[agent-reply] Agent returned empty text, skipping reply');
      return;
    }

    const fallbackCreateTask = result.pendingActions.length === 0
      ? extractExplicitCreateTaskAction(promptContent, messageId)
      : null;
    const pendingActions = fallbackCreateTask ? [fallbackCreateTask] : result.pendingActions;
    if (fallbackCreateTask) {
      console.warn('[agent-reply] Added deterministic create_task fallback for explicit task-create prompt', {
        messageId,
        title: fallbackCreateTask.params.title,
      });
    }

    // Insert the agent's reply as a message in the space.
    // Phase 2 — populate agent_blocks / model / tokens so <AgentMessageBlocks/>
    // can render tool chips, citations footer, and the model+tokens detail
    // (parity with the agent-stream-loop path).
    const [agentMessage] = await db.insert(messages).values({
      org_id: orgId,
      space_id: spaceId,
      user_id: agentUserId,
      content: result.text,
      parent_id: threadParentId,
      metadata: {
        is_agent_reply: true,
        agent_blocks: result.assistantBlocks ?? undefined,
        model: result.model,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        citations: result.citations.length > 0 ? result.citations : undefined,
        pending_actions: pendingActions.length > 0 ? pendingActions : undefined,
      } as never,
    }).returning();

    // Persist pending write actions as agent_actions rows so the inline
    // <AgentActionCard/> on the reply and the /inbox?tab=approvals queue
    // can render them. Without this, write-intent chat mentions were
    // ghost-queued — stored in metadata.pending_actions but invisible to
    // the approval UI (parity with agent-stream-loop.ts:208).
    if (pendingActions.length > 0) {
      try {
        await db.insert(agentActions).values(
          pendingActions.map((p: any) => ({
            org_id: orgId,
            user_id: userId,
            conversation_id: spaceId,
            message_id: agentMessage!.id,
            action: p.action,
            params: p.params,
            approval_tier: (p.approval_tier ?? getApprovalTier(p.action)) as 'auto' | 'quick' | 'full',
            approval_status: 'pending' as const,
            source: p.source ?? 'mention',
            tool_use_id: p.tool_use_id ?? null,
          })),
        );
      } catch (err) {
        console.error('[agent-reply] Failed to persist pending agent_actions:', err);
      }
    }

    // Get the agent user info for the broadcast
    const [agentUserData] = await db.select({
      name: users.name,
      avatar_url: users.avatar_url,
    }).from(users).where(eq(users.id, agentUserId)).limit(1);

    const messageWithUser = {
      ...agentMessage,
      user_name: agentUserData?.name ?? DEFTY_NAME,
      user_avatar: agentUserData?.avatar_url ?? null,
      reactions: [],
      reply_count: 0,
      latest_reply_at: null,
    };

    // Broadcast via Socket.io
    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('message:new', messageWithUser);

      // Only emit thread:updated when the reply is actually in a thread.
      if (threadParentId) {
        const [replyStats] = await db.select({
          count: sql<number>`count(*)::int`,
          latest: sql<string>`to_char(max(${messages.created_at}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
          .from(messages)
          .where(and(
            eq(messages.parent_id, threadParentId),
            eq(messages.is_deleted, false),
          ));

        io.to(`space:${spaceId}`).emit('thread:updated', {
          parent_id: threadParentId,
          reply_count: replyStats?.count ?? 1,
          latest_reply_at: replyStats?.latest ?? agentMessage!.created_at,
        });
      }
    }

    console.log(`[agent-reply] Posted agent reply ${agentMessage!.id} in space ${spaceId}${threadParentId ? ` thread ${threadParentId}` : ' (flat)'}`);
  } catch (err) {
    console.error('[agent-reply] Failed to generate agent reply:', err);
    throw err; // Re-throw so BullMQ can retry
  }
}
