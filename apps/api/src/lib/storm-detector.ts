// apps/api/src/lib/storm-detector.ts
import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from './db.js';
import { messages } from '@deft/db/schema';

export const STORM_THRESHOLD = 5;
export const STORM_WINDOW_MS = 10 * 60 * 1000;

export type StormCheck = {
  tripped: boolean;
  count: number;
  windowMs: number;
};

/**
 * Count an agent's thread replies within the storm window.
 * - Per-agent: scoped to one users.id
 * - Per-thread: scoped to one parent_message_id (the thread root)
 * - Excludes deleted rows
 *
 * Tripped means count >= STORM_THRESHOLD. Callers should NOT post when
 * tripped; they should surface a STORM_DETECTED error to the agent runtime.
 */
export async function checkReplyStorm(
  agentUserId: string,
  threadParentId: string,
  now?: Date,
): Promise<StormCheck> {
  const cutoff = new Date((now ?? new Date()).getTime() - STORM_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.user_id, agentUserId),
        eq(messages.parent_id, threadParentId),
        eq(messages.is_deleted, false),
        gt(messages.created_at, cutoff),
      ),
    );

  const count = row?.count ?? 0;
  return {
    tripped: count >= STORM_THRESHOLD,
    count,
    windowMs: STORM_WINDOW_MS,
  };
}
