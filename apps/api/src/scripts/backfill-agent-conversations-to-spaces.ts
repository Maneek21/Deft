// One-shot backfill: migrate agent_conversations + agent_messages into
// spaces (type='agent_conversation') + messages (with metadata.agent_blocks).
// Phase 2 of agent-chat unification. Idempotent — safe to re-run.
//
// Usage: pnpm --filter @deft/api exec tsx src/scripts/backfill-agent-conversations-to-spaces.ts

import { db } from '../lib/db.js';
import {
  agentConversations,
  agentMessages,
  agentEmployees,
  spaces,
  messages,
  spaceMembers,
} from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { ensureDeftyMembership } from '../lib/ensure-defty-membership.js';

async function main() {
  const allConvos = await db.select().from(agentConversations);
  console.log(`[backfill] found ${allConvos.length} agent_conversations`);
  let convosOk = 0;
  let convosFailed = 0;
  let msgsOk = 0;
  let msgsFailed = 0;

  for (const c of allConvos) {
    try {
      // Resolve agent user id
      let agentUserId: string;
      if (c.agent_employee_id) {
        const [emp] = await db.select({ user_id: agentEmployees.user_id })
          .from(agentEmployees)
          .where(eq(agentEmployees.id, c.agent_employee_id))
          .limit(1);
        if (!emp) {
          console.warn(`[backfill] convo ${c.id} references missing employee ${c.agent_employee_id} — skipping`);
          convosFailed++;
          continue;
        }
        agentUserId = emp.user_id;
      } else {
        agentUserId = await ensureDeftyMembership(c.org_id);
      }

      // Ensure spaces row with same id (idempotent via onConflictDoNothing)
      await db.insert(spaces).values({
        id: c.id,
        org_id: c.org_id,
        name: c.title || 'Conversation',
        type: 'agent_conversation',
        created_by: c.user_id,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }).onConflictDoNothing();

      // Ensure both members
      await db.insert(spaceMembers).values([
        { space_id: c.id, user_id: c.user_id },
        { space_id: c.id, user_id: agentUserId },
      ]).onConflictDoNothing();

      convosOk++;

      // Migrate messages
      const msgs = await db.select().from(agentMessages).where(eq(agentMessages.conversation_id, c.id));
      for (const m of msgs) {
        try {
          const isAgent = m.role === 'assistant';
          const metadata: Record<string, unknown> = {};
          if (isAgent) metadata.is_agent_reply = true;
          if (m.content_blocks) metadata.agent_blocks = m.content_blocks;
          if (m.citations) metadata.citations = m.citations;
          if (m.tool_calls) metadata.tool_calls = m.tool_calls;
          if (m.hidden) metadata.hidden = m.hidden;
          if (m.model) metadata.model = m.model;
          if (m.tokens_in != null) metadata.tokens_in = m.tokens_in;
          if (m.tokens_out != null) metadata.tokens_out = m.tokens_out;
          // Detect tool_result rows by inspecting content_blocks
          if (Array.isArray(m.content_blocks) && m.content_blocks.some((b: any) => b.type === 'tool_result')) {
            metadata.kind = 'tool_result';
          }
          await db.insert(messages).values({
            id: m.id,
            org_id: c.org_id,
            space_id: c.id,
            user_id: isAgent ? agentUserId : c.user_id,
            content: m.content || '',
            metadata,
            created_at: m.created_at,
            updated_at: m.updated_at,
          }).onConflictDoNothing();
          msgsOk++;
        } catch (msgErr) {
          console.error(`[backfill] message ${m.id} failed:`, msgErr instanceof Error ? msgErr.message : msgErr);
          msgsFailed++;
        }
      }
    } catch (err) {
      console.error(`[backfill] convo ${c.id} failed:`, err);
      convosFailed++;
    }
  }

  console.log(`[backfill] complete: convos ${convosOk} ok / ${convosFailed} failed; msgs ${msgsOk} ok / ${msgsFailed} failed`);
  process.exit(convosFailed > 0 || msgsFailed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[backfill] fatal', e); process.exit(1); });
