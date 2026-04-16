// Handler: deprecation-warning — nightly count of legacy table rows
// Monitors agentMemory (user+org scope), decisions, and spaceKnowledge so we
// know when it is safe to drop them (counts must be 0 for 30 consecutive days).
import { db } from '../../lib/db.js';
import { agentMemory, decisions, spaceKnowledge } from '@deft/db/schema';
import { eq, or, sql } from 'drizzle-orm';

export async function handleDeprecationWarning(): Promise<void> {
  // Scoped counts: agentMemory writes from memory-extract would be scope='user' or 'org'
  // scope='conversation' rows are legitimate (native `remember` tool) and excluded.
  const [am] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMemory)
    .where(or(eq(agentMemory.scope, 'user'), eq(agentMemory.scope, 'org')));
  const [dec] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(decisions);
  const [sk] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(spaceKnowledge)
    .where(eq(spaceKnowledge.is_deleted, false));

  console.warn(
    `[deprecation] legacy tables: agentMemory(user+org)=${am.count}, decisions=${dec.count}, spaceKnowledge(not-deleted)=${sk.count}`,
  );

  if ((am?.count ?? 0) + (dec?.count ?? 0) + (sk?.count ?? 0) === 0) {
    console.warn('[deprecation] ALL legacy tables empty — safe to drop in next migration');
  }
}
