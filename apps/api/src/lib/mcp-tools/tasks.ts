/**
 * task_query — Phase 3 read-only task search.
 *
 * Write tools (task_create, task_update, message_post) land in Phase 4 with
 * trust-level gating. Phase 3 only needs to let the agent read the board.
 */
import { and, eq, desc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db.js';
import { tasks } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

type TaskQueryFilter = {
  status?: string;
  assignee_id?: string;
  project_id?: string;
};

export type TaskQueryArgs = {
  caller_employee_slug: string;
  filter?: TaskQueryFilter;
  limit?: number;
};

const VALID_STATUS = new Set([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]);

export async function taskQuery(
  args: TaskQueryArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(Math.max(1, args.limit ?? 20), 50);
  const filter = args.filter ?? {};

  try {
    const conditions: SQL[] = [
      eq(tasks.org_id, ctx.org_id),
      eq(tasks.is_deleted, false),
    ];

    if (filter.status && VALID_STATUS.has(filter.status)) {
      conditions.push(eq(tasks.status, filter.status as 'todo'));
    }
    if (filter.assignee_id) {
      conditions.push(eq(tasks.assignee_id, filter.assignee_id));
    }
    if (filter.project_id) {
      conditions.push(eq(tasks.project_id, filter.project_id));
    }

    const rows = await db
      .select({
        id: tasks.id,
        project_id: tasks.project_id,
        number: tasks.number,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        assignee_id: tasks.assignee_id,
        due_date: tasks.due_date,
        updated_at: tasks.updated_at,
      })
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.updated_at))
      .limit(limit);

    return textResult(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`task_query failed: ${msg}`);
  }
}
