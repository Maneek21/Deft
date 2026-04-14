/**
 * thread_fetch MCP tool — Phase 3 read-only conversation history fetch.
 *
 * Given a parent message id, returns the parent + its replies in chronological
 * order. The employee uses this to get context before replying in a thread.
 *
 * message_post (write) is Phase 4 and gated by trust level.
 */
import { and, eq, asc, or } from 'drizzle-orm';
import { db } from '../db.js';
import { messages, users } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

export type ThreadFetchArgs = {
  caller_employee_slug: string;
  parent_message_id: string;
  limit?: number;
};

export async function threadFetch(
  args: ThreadFetchArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.parent_message_id) {
    return errorResult('thread_fetch requires parent_message_id');
  }
  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);

  try {
    const rows = await db
      .select({
        id: messages.id,
        parent_id: messages.parent_id,
        user_id: messages.user_id,
        user_name: users.name,
        content: messages.content,
        created_at: messages.created_at,
        edited_at: messages.edited_at,
        is_deleted: messages.is_deleted,
        space_id: messages.space_id,
      })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(
        and(
          eq(messages.org_id, ctx.org_id),
          or(
            eq(messages.id, args.parent_message_id),
            eq(messages.parent_id, args.parent_message_id),
          ),
        ),
      )
      .orderBy(asc(messages.created_at))
      .limit(limit);

    return textResult(
      rows.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        user_id: r.user_id,
        user_name: r.user_name,
        content: r.is_deleted ? '[deleted]' : r.content,
        created_at: r.created_at,
        edited_at: r.edited_at,
        space_id: r.space_id,
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`thread_fetch failed: ${msg}`);
  }
}
