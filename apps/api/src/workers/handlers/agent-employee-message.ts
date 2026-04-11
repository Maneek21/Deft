// Handler: agent-employee-message — processes DMs and @mentions directed at agent employees
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentEmployees, messages, users, orgs } from '@deft/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getIO } from '../../socket.js';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { sql } from 'drizzle-orm';

interface AgentEmployeeMessageData {
  messageId: string;
  spaceId: string;
  orgId: string;
  employeeId: string;
  isDM: boolean;
}

export async function handleAgentEmployeeMessage(job: JobData): Promise<void> {
  const { messageId, spaceId, orgId, employeeId, isDM } = job.data as AgentEmployeeMessageData;

  console.log(`[agent-employee-message] Processing ${isDM ? 'DM' : '@mention'} for employee ${employeeId} in space ${spaceId}`);

  // Block agent→agent mentions (prevent loops)
  const [triggerMsg] = await db.select().from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!triggerMsg) return;

  const [author] = await db.select().from(users)
    .where(eq(users.id, triggerMsg.user_id))
    .limit(1);
  if (author?.is_agent) return; // Agent employees cannot trigger other agents

  // 1. Load employee and verify it's active
  const [employee] = await db.select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, true)))
    .limit(1);

  if (!employee) {
    console.warn(`[agent-employee-message] Employee ${employeeId} not found or inactive, skipping`);
    return;
  }

  // 2. Load org name
  const [org] = await db.select({ name: orgs.name })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  const orgName = org?.name ?? 'Unknown';

  // 3. Load the triggering message
  const [triggerMessage] = await db.select({
    id: messages.id,
    content: messages.content,
    user_id: messages.user_id,
    parent_id: messages.parent_id,
  })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!triggerMessage) {
    console.warn(`[agent-employee-message] Message ${messageId} not found, skipping`);
    return;
  }

  // 4. Load conversation history
  const historyLimit = isDM ? 20 : 10;
  const recentMessages = await db.select({
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
        eq(messages.space_id, spaceId),
        eq(messages.org_id, orgId),
        eq(messages.is_deleted, false),
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(historyLimit);

  // Build conversation history (oldest first)
  const conversationHistory: { role: string; content: string }[] = [];
  const orderedHistory = [...recentMessages].reverse();

  for (const msg of orderedHistory) {
    if (msg.id === messageId) continue;
    conversationHistory.push({
      role: msg.user_id === employee.user_id ? 'assistant' : 'user',
      content: msg.user_id === employee.user_id ? msg.content : `[${msg.user_name}]: ${msg.content}`,
    });
  }

  // 5. Build augmented system prompt
  const dailyActionsRemaining = employee.max_daily_actions - employee.daily_action_count;
  const communicationGuideline = isDM
    ? 'This is a direct message. Be thorough and detailed in your responses.'
    : 'This is a channel @mention. Be concise and focused in your response.';

  const systemPrompt = `${employee.system_prompt}

---
# Identity & Context
You are ${employee.name}, a ${employee.role} at ${orgName}.
${employee.expertise_description ? `\nExpertise: ${employee.expertise_description}` : ''}

## Communication Guidelines
${communicationGuideline}

## Action Budget
You have ${dailyActionsRemaining} actions remaining today out of ${employee.max_daily_actions}.
`;

  // Strip @mention from content
  const cleanContent = triggerMessage.content
    .replace(new RegExp(`<@${employee.slug}\\|[^>]*>`, 'gi'), '')
    .replace(new RegExp(`@${employee.slug}\\b`, 'gi'), '')
    .replace(new RegExp(`@${employee.name}\\b`, 'gi'), '')
    .trim() || 'Hello';

  // 6. Call agent runner
  const result = await runAgentQuery({
    content: cleanContent,
    orgId,
    userId: employee.user_id,
    orgName,
    conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
    mode: 'background',
    systemPromptOverride: systemPrompt,
    trustLevelOverride: employee.trust_level,
  });

  if (!result.text) {
    console.warn('[agent-employee-message] Agent returned empty text, skipping reply');
    return;
  }

  // 7. Post reply as a message in the space
  const threadParentId = triggerMessage.parent_id || messageId;

  const [agentMessage] = await db.insert(messages).values({
    org_id: orgId,
    space_id: spaceId,
    user_id: employee.user_id,
    content: result.text,
    parent_id: threadParentId,
    metadata: {
      agent_employee_id: employeeId,
      is_agent_reply: true,
      citations: result.citations.length > 0 ? result.citations : undefined,
    },
  }).returning();

  // Increment daily action count (atomic to prevent race conditions)
  await db.execute(
    sql`UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = ${employeeId} AND daily_action_count < max_daily_actions`
  );

  // 8. Broadcast via socket.io
  const [agentUserData] = await db.select({
    name: users.name,
    avatar_url: users.avatar_url,
  }).from(users).where(eq(users.id, employee.user_id)).limit(1);

  const messageWithUser = {
    ...agentMessage,
    user_name: agentUserData?.name ?? employee.name,
    user_avatar: agentUserData?.avatar_url ?? null,
    reactions: [],
    reply_count: 0,
    latest_reply_at: null,
  };

  const io = getIO();
  if (io) {
    io.to(`space:${spaceId}`).emit('message:new', messageWithUser);

    // Emit thread:updated for the parent message
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

  console.log(`[agent-employee-message] Posted reply ${agentMessage!.id} from employee ${employee.name} in space ${spaceId}`);
}
