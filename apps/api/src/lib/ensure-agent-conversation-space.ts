// Idempotent helper: ensures a spaces row of type 'agent_conversation' exists
// for an agent conversation, with both the user and the agent as members.
// Phase 2 of agent-chat unification.

import { db } from './db.js';
import { spaces, spaceMembers } from '@deft/db/schema';
import { eq } from 'drizzle-orm';

export type EnsureAgentConversationSpaceArgs = {
  orgId: string;
  userId: string;
  agentUserId: string;
  conversationId: string;
  title: string;
};

export async function ensureAgentConversationSpace(args: EnsureAgentConversationSpaceArgs): Promise<void> {
  const { orgId, userId, agentUserId, conversationId, title } = args;

  // 1. Ensure spaces row exists with this exact id.
  const [existing] = await db.select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, conversationId))
    .limit(1);

  if (!existing) {
    await db.insert(spaces).values({
      id: conversationId,
      org_id: orgId,
      name: title,
      type: 'agent_conversation',
      created_by: userId,
    }).onConflictDoNothing();
  }

  // 2. Ensure both members are present.
  await db.insert(spaceMembers).values([
    { space_id: conversationId, user_id: userId },
    { space_id: conversationId, user_id: agentUserId },
  ]).onConflictDoNothing();
}
