/**
 * Shared task dependency helpers.
 *
 * Extracted from apps/api/src/routes/tasks.ts so both the HTTP route handler
 * and the agent add_dependency tool can reuse the same cycle detector.
 */
import { db } from './db.js';
import { taskRelationships, tasks } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * BFS over the blocks graph to detect whether adding an edge fromId -> toId
 * would close a cycle. Only considers `blocks` edges (blocked_by gets
 * normalized to blocks at the route layer; relates_to / duplicates are
 * semantic pointers, not orderings, and cannot form cycles). Org isolation
 * is enforced by joining source_task -> tasks and filtering on tasks.org_id.
 *
 * Safety cap: traversal aborts after visiting 1000 nodes.
 */
export async function detectBlocksCycle(
  fromId: string,
  toId: string,
  orgId: string,
): Promise<boolean> {
  if (fromId === toId) return true;

  const visited = new Set<string>([toId]);
  const queue: string[] = [toId];
  const MAX_NODES = 1000;

  while (queue.length > 0 && visited.size <= MAX_NODES) {
    const current = queue.shift()!;
    const rows = await db
      .select({ target: taskRelationships.target_task_id })
      .from(taskRelationships)
      .innerJoin(tasks, eq(taskRelationships.source_task_id, tasks.id))
      .where(
        and(
          eq(taskRelationships.source_task_id, current),
          eq(taskRelationships.type, 'blocks'),
          eq(tasks.org_id, orgId),
        ),
      );
    for (const r of rows) {
      const next = r.target;
      if (next === fromId) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
