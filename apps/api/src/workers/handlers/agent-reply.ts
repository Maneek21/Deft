// Handler: process @agent/@deft mentions in chat and generate AI replies in-thread
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { messages, users, spaces, spaceMembers, agentActions } from '@deft/db/schema';
import { getApprovalTier } from '../../lib/agent-approval.js';
import { eq, and, desc, sql, ne, lt } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { ensureDeftyMembership, DEFTY_NAME } from '../../lib/ensure-defty-membership.js';
import { toPlainText, truncatePlainText } from '../../lib/plain-text.js';

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

function extractDiscussionTaskActionFromReply(replyText: string, sourceMessageId: string) {
  const plain = toPlainText(replyText);
  const normalized = plain.replace(/\*\*/g, '').replace(/^\s*[-*]\s*/gm, '');
  if (!/\b(?:task proposal|proposed task creation|title\s*:|i will create a detailed task|approve this task creation|queued for your approval)\b/i.test(normalized)) {
    return null;
  }
  if (/\b(?:clarify|clarification|need more information|not enough context)\b/i.test(normalized) && !/\btitle\s*:/i.test(normalized)) {
    return null;
  }

  const labelField = (label: string) => {
    const labels = 'title|project|description|assignee|priority|due date|source|owners|additional notes';
    const match = normalized.match(new RegExp(`\\b${label}\\s*:\\s*(.+?)(?=\\s+(?:${labels})\\s*:|$)`, 'i'));
    return match?.[1]?.replace(/^[#:\s-]+/, '').trim();
  };

  const title = labelField('title');
  if (!title) return null;

  const projectName = labelField('project');
  const assigneeName = labelField('assignee');
  const priorityMatch = normalized.match(/\bpriority\s*:\s*(p[0-3])\b/i)?.[1]?.toLowerCase();
  const dueDate = normalized.match(/\bdue date\s*:\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1];

  return {
    action: 'create_task',
    params: {
      title: truncatePlainText(title, 80),
      ...(projectName ? { project_name: truncatePlainText(projectName, 120) } : {}),
      ...(assigneeName ? { assignee_name: truncatePlainText(assigneeName, 120) } : {}),
      ...(priorityMatch ? { priority: priorityMatch } : {}),
      ...(dueDate ? { due_date: dueDate } : {}),
      description: plain,
      source_message_id: sourceMessageId,
    },
    approval_tier: getApprovalTier('create_task'),
    tool_use_id: null,
    source: 'mention',
  };
}

function fallbackDiscussionTaskTitle(content: string): string {
  const plain = toPlainText(content);
  const match = plain.match(/\bfor\s+(?:the\s+)?(.+?)(?:\.|,|;|$)/i);
  return truncatePlainText(match?.[1]?.trim() || 'Follow up from discussion', 80) || 'Follow up from discussion';
}

function buildDiscussionTaskFallbackAction(params: {
  command: string;
  sourceMessageId: string;
  sourceMessages: DiscussionSourceMessage[];
}) {
  const highlights = params.sourceMessages
    .slice(-12)
    .map(formatDiscussionHighlight)
    .filter((line) => line.trim().length > 3);
  const description = [
    'Review-only task proposal created from a Defty discussion command.',
    '',
    'The model did not return a usable tool call, so Defty preserved the recent source discussion for human review instead of taking silent action.',
    '',
    '**Source discussion highlights:**',
    ...highlights,
  ].join('\n');

  return {
    action: 'create_task',
    params: {
      title: fallbackDiscussionTaskTitle(params.command),
      description,
      source_message_id: params.sourceMessageId,
      metadata: {
        command_message_id: params.sourceMessageId,
        context_mode: 'discussion',
        discussion_source_message_ids: params.sourceMessages.map((message) => message.id),
      },
    },
    approval_tier: getApprovalTier('create_task'),
    tool_use_id: null,
    source: 'mention',
  };
}

function isDiscussionTaskCommand(content: string): boolean {
  return /\b(?:create|make|draft|turn|convert|summari[sz]e)\b.{0,80}\b(?:tasks?|todos?|tickets?)\b/i.test(content) &&
    /\b(?:discussion|thread|chat|conversation|above|this)\b/i.test(content);
}

function isDiscussionBoundaryMessage(content: string): boolean {
  const plain = toPlainText(content);
  return /(?:^|\s)@(agent|defty|deft)\b/i.test(plain) || isDiscussionTaskCommand(plain);
}

function isSocialOnlyDiscussionMessage(content: string): boolean {
  const plain = toPlainText(content)
    .toLowerCase()
    .replace(/\b(?:human|chat|dense|edge)[a-z0-9_-]*-[a-z0-9_-]{6,}\b/g, '');
  const hasSocialTopic = /\b(?:pizza|deep dish|thin crust|pineapple|jalapeno|mushroom|cheese|lunch|breakfast|dinner|snack|coffee|tea|cake|eat|eating|birthday|party|weekend|movie|music|sports)\b/i.test(plain);
  if (!hasSocialTopic) return false;

  const hasWorkSignal = /\b(?:task|todo|ticket|project|launch|buyer|route|truck|capacity|crate|harvest|handoff|sheet|qc|sampling|sample|label|pack|packing|cold|greenhouse|irrigation|pest|blocked|blocker|stuck|dependency|deadline|due|owner|owns|assign|confirm|update|status|decision|agreed|resolution|ship|delivery|market)\b/i.test(plain);
  return !hasWorkSignal;
}

function discussionTaskPrompt(content: string): string {
  return `${content}

This is an explicit Defty command to synthesize the surrounding discussion into work.
Use the recent discussion context already provided in the conversation history.
If the discussion clearly converged on work, queue a small number of precise create_task proposals.
Prefer one well-scoped task unless the user explicitly asked for multiple tasks.
Preserve material disagreement details, source documents/sheets mentioned, owner commitments, timing, and the final resolution.
The task description should make clear what each named person said or owns when that matters to execution.
Include the source message id automatically supplied by the system.
Do not create knowledge/wiki entries from this command; task proposals only.
If owner, project, or scope is genuinely ambiguous, ask a short clarification instead of guessing.`;
}

type DiscussionSourceMessage = {
  id: string;
  userName: string;
  content: string;
};

function formatDiscussionHighlight(message: DiscussionSourceMessage): string {
  const content = truncatePlainText(
    toPlainText(message.content)
      .replace(/^[A-Z0-9][A-Z0-9_-]{2,80}:\s*/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    260,
  );
  return `- ${message.userName}: ${content}`;
}

function enrichDiscussionTaskActions(
  actions: any[],
  sourceMessages: DiscussionSourceMessage[],
): any[] {
  if (sourceMessages.length === 0) return actions;
  const highlights = sourceMessages
    .slice(-12)
    .map(formatDiscussionHighlight)
    .filter((line) => line.trim().length > 3);
  if (highlights.length === 0) return actions;

  const appendix = `\n\n**Source discussion highlights:**\n${highlights.join('\n')}`;
  return actions.map((action) => {
    if (action?.action !== 'create_task' && action?.action !== 'task_create') return action;
    const params = action.params ?? {};
    const description = String(params.description ?? '').trim();
    const metadata = {
      ...(params.metadata ?? {}),
      discussion_source_message_ids: sourceMessages.map((message) => message.id),
      context_mode: 'discussion',
    };
    if (description.includes('Source discussion highlights')) {
      return {
        ...action,
        params: {
          ...params,
          metadata,
        },
      };
    }
    return {
      ...action,
      params: {
        ...params,
        description: `${description || 'Task created from discussion.'}${appendix}`,
        metadata,
      },
    };
  });
}

function withMentionProvenance(params: {
  action: any;
  commandMessageId: string;
  spaceId: string;
  discussionSourceMessages: DiscussionSourceMessage[];
}) {
  const { action, commandMessageId, spaceId, discussionSourceMessages } = params;
  if (!action || typeof action !== 'object') return action;
  const actionParams = action.params && typeof action.params === 'object' ? action.params : {};
  const isWriteAction = [
    'create_task',
    'task_create',
    'task_update',
    'update_task',
    'task_transition',
    'comment_on_task',
  ].includes(String(action.action ?? ''));
  if (!isWriteAction) return action;

  const sourceIds = discussionSourceMessages.map((message) => message.id);
  return {
    ...action,
    params: {
      ...actionParams,
      source_message_id: commandMessageId,
      source_space_id: spaceId,
      origin_message_id: commandMessageId,
      origin_space_id: spaceId,
      metadata: {
        ...(actionParams.metadata ?? {}),
        command_message_id: commandMessageId,
        context_mode: sourceIds.length > 0 ? 'discussion' : 'message',
        ...(sourceIds.length > 0 ? { discussion_source_message_ids: sourceIds } : {}),
      },
    },
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
    const wantsDiscussionTask = isDiscussionTaskCommand(cleanContent);
    const discussionSourceMessages: DiscussionSourceMessage[] = [];

    if (wantsDiscussionTask && !isDmLike && !parentId) {
      const [trigger] = await db
        .select({ created_at: messages.created_at })
        .from(messages)
        .where(and(
          eq(messages.id, messageId),
          eq(messages.org_id, orgId),
        ))
        .limit(1);

      if (trigger) {
        const recentChannelMessages = await db.select({
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
            lt(messages.created_at, trigger.created_at),
            ne(messages.user_id, agentUserId),
          ))
          .orderBy(desc(messages.created_at))
          .limit(80);

        const orderedRecentMessages = recentChannelMessages.reverse();
        let previousBoundaryIndex = -1;
        for (let index = orderedRecentMessages.length - 1; index >= 0; index -= 1) {
          if (isDiscussionBoundaryMessage(orderedRecentMessages[index]!.content)) {
            previousBoundaryIndex = index;
            break;
          }
        }
        const scopedRecentMessages = previousBoundaryIndex >= 0
          ? orderedRecentMessages.slice(previousBoundaryIndex + 1).slice(-40)
          : orderedRecentMessages.slice(-40);
        const workScopedRecentMessages = scopedRecentMessages.filter((msg) =>
          !isSocialOnlyDiscussionMessage(msg.content),
        );

        if (workScopedRecentMessages.length > 0) {
          conversationHistory.push({
            role: 'user',
            content: '[Recent channel discussion before this Defty request]',
          });
          for (const msg of workScopedRecentMessages) {
            discussionSourceMessages.push({
              id: msg.id,
              userName: msg.user_name,
              content: msg.content,
            });
            conversationHistory.push({
              role: 'user',
              content: `[${msg.user_name}]: ${msg.content}`,
            });
          }
        }
      }
    }

    const promptContent = wantsDiscussionTask
      ? discussionTaskPrompt(cleanContent || 'Create tasks from this discussion.')
      : cleanContent || 'Hey, what can you help me with?';

    // Call the agent reasoning engine with a 60s hard timeout so a stuck
    // MCP tool / Anthropic call can never wedge the worker.
    const AGENT_TIMEOUT_MS = 60_000;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), AGENT_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof runAgentQuery>>;
    try {
      result = await Promise.race([
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
        abortSignal: abort.signal,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('agent-reply: runAgentQuery timeout after 60s')), AGENT_TIMEOUT_MS),
      ),
      ]);
    } catch (err) {
      if (!wantsDiscussionTask || discussionSourceMessages.length === 0) throw err;
      const fallbackAction = buildDiscussionTaskFallbackAction({
        command: cleanContent,
        sourceMessageId: messageId,
        sourceMessages: discussionSourceMessages,
      });
      console.warn('[agent-reply] Falling back to deterministic discussion task proposal', {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      result = {
        text: 'I could not complete the full reasoning pass, so I prepared a conservative task proposal from the recent discussion for human review.',
        pendingActions: [fallbackAction],
        executedActions: [],
        assistantBlocks: [],
        model: 'deterministic-discussion-fallback',
        tokensIn: 0,
        tokensOut: 0,
        citations: [],
      } as Awaited<ReturnType<typeof runAgentQuery>>;
    } finally {
      clearTimeout(timeout);
    }

    if (!result.text) {
      if (!wantsDiscussionTask || discussionSourceMessages.length === 0) {
        console.warn('[agent-reply] Agent returned empty text, skipping reply');
        return;
      }
      const fallbackAction = buildDiscussionTaskFallbackAction({
        command: cleanContent,
        sourceMessageId: messageId,
        sourceMessages: discussionSourceMessages,
      });
      result = {
        text: 'I prepared a conservative task proposal from the recent discussion for human review.',
        pendingActions: [fallbackAction],
        executedActions: [],
        assistantBlocks: [],
        model: 'deterministic-discussion-fallback',
        tokensIn: 0,
        tokensOut: 0,
        citations: [],
      } as Awaited<ReturnType<typeof runAgentQuery>>;
    }

    const fallbackCreateTask = result.pendingActions.length === 0
      ? wantsDiscussionTask
        ? extractDiscussionTaskActionFromReply(result.text, messageId) ?? (
          discussionSourceMessages.length > 0
            ? buildDiscussionTaskFallbackAction({
              command: cleanContent,
              sourceMessageId: messageId,
              sourceMessages: discussionSourceMessages,
            })
            : null
        )
        : extractExplicitCreateTaskAction(promptContent, messageId)
      : null;
    const rawPendingActions = fallbackCreateTask ? [fallbackCreateTask] : result.pendingActions;
    const enrichedPendingActions = wantsDiscussionTask
      ? enrichDiscussionTaskActions(rawPendingActions, discussionSourceMessages)
      : rawPendingActions;
    const pendingActions = enrichedPendingActions.map((action: any) =>
      withMentionProvenance({
        action,
        commandMessageId: messageId,
        spaceId,
        discussionSourceMessages,
      }),
    );
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
