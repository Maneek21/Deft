// Handler: memory-extract — extracts memorable facts and decisions from classified messages
// and stores them in agent_memory + decisions tables.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentMemory, decisions } from '@deft/db/schema';

interface MemoryExtractJobData {
  messageId: string;
  spaceId: string;
  content: string;
  orgId: string;
  userId: string;
  facts: string[];
  decision: string | null;
}

/**
 * Generate a snake_case key from a fact string (first 3-4 meaningful words).
 */
function generateKeyFromFact(fact: string): string {
  const words = fact
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 4);
  return words.join('_') || 'fact';
}

export async function handleMemoryExtract(job: JobData): Promise<void> {
  const { messageId, spaceId, content, orgId, userId, facts, decision } =
    job.data as MemoryExtractJobData;

  // Store each memorable fact as org-scoped memory
  for (const fact of facts) {
    try {
      const key = generateKeyFromFact(fact);

      await db
        .insert(agentMemory)
        .values({
          org_id: orgId,
          user_id: userId,
          conversation_id: null,
          scope: 'org',
          key,
          value: fact,
        })
        .onConflictDoUpdate({
          target: [agentMemory.user_id, agentMemory.conversation_id, agentMemory.key],
          set: { value: fact, updated_at: new Date() },
        });

      console.log(`[memory-extract] Stored org fact: "${key}" from message ${messageId}`);
    } catch (err) {
      console.error(`[memory-extract] Failed to store fact "${fact}":`, (err as Error).message);
    }
  }

  // Store decision in the decisions table + agent memory
  if (decision) {
    try {
      // Insert into decisions table
      await db.insert(decisions).values({
        org_id: orgId,
        space_id: spaceId,
        message_id: messageId,
        decision_text: decision,
        decided_by: userId,
        context: content.slice(0, 500),
        tags: null,
        is_reversed: false,
      });

      // Also store in agent memory with decision: prefix
      const decisionKey = 'decision:' + generateKeyFromFact(decision);
      await db
        .insert(agentMemory)
        .values({
          org_id: orgId,
          user_id: userId,
          conversation_id: null,
          scope: 'org',
          key: decisionKey,
          value: decision,
        })
        .onConflictDoUpdate({
          target: [agentMemory.user_id, agentMemory.conversation_id, agentMemory.key],
          set: { value: decision, updated_at: new Date() },
        });

      console.log(`[memory-extract] Stored decision from message ${messageId}: "${decision}"`);
    } catch (err) {
      console.error(`[memory-extract] Failed to store decision:`, (err as Error).message);
    }
  }
}
