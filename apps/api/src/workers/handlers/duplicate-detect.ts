// Handler: detect potential duplicate tasks by title similarity
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  tasks,
  projects,
  notifications,
} from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { emitToUser } from '../../socket.js';

/** Split a title into normalized words for comparison */
function tokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2), // ignore short words like "a", "to", "of"
  );
}

/** Jaccard similarity: |intersection| / |union| */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function handleDuplicateDetect(job: JobData): Promise<void> {
  const { taskId, title, projectId, orgId } = job.data;
  console.log('[duplicate-detect] Checking for duplicates of task', taskId);

  try {
    // Get the creator of the new task
    const [newTask] = await db
      .select({ created_by: tasks.created_by })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!newTask) {
      console.log('[duplicate-detect] Task not found, skipping');
      return;
    }

    // Query all non-done tasks in the same project (excluding this task)
    const existingTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        number: tasks.number,
        created_by: tasks.created_by,
        project_prefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.org_id, orgId),
          eq(tasks.project_id, projectId),
          eq(tasks.is_deleted, false),
          sql`${tasks.status} NOT IN ('done', 'cancelled')`,
          sql`${tasks.id} != ${taskId}`,
        ),
      );

    if (existingTasks.length === 0) return;

    const newTokens = tokenize(title);
    if (newTokens.size === 0) return;

    // Get the new task's number and prefix for notification
    const [taskInfo] = await db
      .select({
        number: tasks.number,
        project_prefix: projects.prefix,
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!taskInfo) return;

    const newIdentifier = `${taskInfo.project_prefix}-${taskInfo.number}`;

    for (const existing of existingTasks) {
      const existingTokens = tokenize(existing.title);
      const similarity = jaccardSimilarity(newTokens, existingTokens);

      if (similarity > 0.5 && existing.created_by !== newTask.created_by) {
        const existingIdentifier = `${existing.project_prefix}-${existing.number}`;

        const message = `Possible duplicate: ${newIdentifier} '${title}' may overlap with ${existingIdentifier} '${existing.title}'`;

        // Notify the creator of the new task
        const [notification] = await db
          .insert(notifications)
          .values({
            org_id: orgId,
            user_id: newTask.created_by,
            type: 'agent_suggestion',
            title: 'Possible Duplicate Task',
            body: message,
            link: `/tasks?task=${newIdentifier}`,
            metadata: {
              nudge_type: 'duplicate_detected',
              new_task_id: taskId,
              existing_task_id: existing.id,
              similarity: Math.round(similarity * 100),
            },
          })
          .returning();

        if (notification) {
          emitToUser(newTask.created_by, 'notification:new', notification);
        }

        console.log(
          `[duplicate-detect] Found potential duplicate: ${newIdentifier} ↔ ${existingIdentifier} (${Math.round(similarity * 100)}% overlap)`,
        );

        // Only flag the best match (first one over threshold)
        break;
      }
    }
  } catch (err) {
    console.error('[duplicate-detect] Error:', err);
    throw err;
  }
}
