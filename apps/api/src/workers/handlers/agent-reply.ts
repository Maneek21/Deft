// Handler: process @agent/@deft mentions in chat and generate AI replies in-thread
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { messages, users } from '@deft/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { runAgentQuery } from '../../lib/agent-runner.js';

/** Well-known agent user email — we ensure this user exists per-org */
const AGENT_EMAIL = 'deft-agent@system.local';
const AGENT_NAME = 'Deft';

/**
 * Ensure an agent system user exists in the users table.
 * Returns the agent user's ID.
 */
async function ensureAgentUser(): Promise<string> {
  const [existing] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, AGENT_EMAIL))
    .limit(1);

  if (existing) return existing.id;

  // Create the system user
  const [created] = await db.insert(users).values({
    email: AGENT_EMAIL,
    name: AGENT_NAME,
    email_verified: true,
  }).returning();

  console.log(`[agent-reply] Created agent system user: ${created!.id}`);
  return created!.id;
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
    // Determine the thread parent: if the triggering message is already in a thread,
    // reply under the same parent. Otherwise, reply under the triggering message itself.
    const threadParentId = parentId || messageId;

    // Load thread context (last 10 messages in the thread) for conversation history
    const threadMessages = await db.select({
      id: messages.id,
      content: messages.content,
      user_id: messages.user_id,
      user_name: users.name,
      created_at: messages.created_at,
    })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(
        and(
          eq(messages.parent_id, threadParentId),
          eq(messages.org_id, orgId),
          eq(messages.is_deleted, false),
        ),
      )
      .orderBy(desc(messages.created_at))
      .limit(10);

    // Also load the parent message itself for context
    const [parentMsg] = await db.select({
      id: messages.id,
      content: messages.content,
      user_id: messages.user_id,
      user_name: users.name,
    })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(eq(messages.id, threadParentId))
      .limit(1);

    // Build conversation history (oldest first)
    const conversationHistory: { role: string; content: string }[] = [];

    if (parentMsg && parentMsg.id !== messageId) {
      conversationHistory.push({
        role: 'user',
        content: `[${parentMsg.user_name}]: ${parentMsg.content}`,
      });
    }

    // Add thread messages (reverse to get oldest first, excluding the trigger message)
    const orderedThread = [...threadMessages].reverse();
    const agentUserId = await ensureAgentUser();

    for (const msg of orderedThread) {
      if (msg.id === messageId) continue; // skip the triggering message, it's sent as the main content
      conversationHistory.push({
        role: msg.user_id === agentUserId ? 'assistant' : 'user',
        content: msg.user_id === agentUserId ? msg.content : `[${msg.user_name}]: ${msg.content}`,
      });
    }

    // Strip the @agent/@deft mention from the content for a cleaner prompt
    const cleanContent = content.replace(/<@agent\|Deft>/gi, '').replace(/@(agent|deft)\b/gi, '').trim();
    const promptContent = cleanContent || 'Hey, what can you help me with?';

    // Call the agent reasoning engine
    const result = await runAgentQuery({
      content: promptContent,
      orgId,
      userId,
      orgName,
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
    });

    if (!result.text) {
      console.warn('[agent-reply] Agent returned empty text, skipping reply');
      return;
    }

    // Insert the agent's reply as a message in the space
    const [agentMessage] = await db.insert(messages).values({
      org_id: orgId,
      space_id: spaceId,
      user_id: agentUserId,
      content: result.text,
      parent_id: threadParentId,
      metadata: {
        is_agent_reply: true,
        citations: result.citations.length > 0 ? result.citations : undefined,
        pending_actions: result.pendingActions.length > 0 ? result.pendingActions : undefined,
      },
    }).returning();

    // Get the agent user info for the broadcast
    const [agentUserData] = await db.select({
      name: users.name,
      avatar_url: users.avatar_url,
    }).from(users).where(eq(users.id, agentUserId)).limit(1);

    const messageWithUser = {
      ...agentMessage,
      user_name: agentUserData?.name ?? AGENT_NAME,
      user_avatar: agentUserData?.avatar_url ?? null,
      reactions: [],
      reply_count: 0,
      latest_reply_at: null,
    };

    // Broadcast via Socket.io
    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('message:new', messageWithUser);

      // Also emit thread:updated for the parent message
      const [replyStats] = await db.select({
        count: sql<number>`count(*)::int`,
        latest: sql<string>`to_char(max(${messages.created_at}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
        .from(messages)
        .where(
          and(
            eq(messages.parent_id, threadParentId),
            eq(messages.is_deleted, false),
          ),
        );

      io.to(`space:${spaceId}`).emit('thread:updated', {
        parent_id: threadParentId,
        reply_count: replyStats?.count ?? 1,
        latest_reply_at: replyStats?.latest ?? agentMessage!.created_at,
      });
    }

    console.log(`[agent-reply] Posted agent reply ${agentMessage!.id} in thread ${threadParentId}`);
  } catch (err) {
    console.error('[agent-reply] Failed to generate agent reply:', err);
    throw err; // Re-throw so BullMQ can retry
  }
}
