// Task rows as a guest may see them: a parent task hidden from the guest is
// not named, not even by id (task-visibility.ts). Owners, admins and members
// get their rows unchanged.
import { and, eq, inArray } from 'drizzle-orm';
import { projects, tasks } from '@deft/db/schema';
import { db } from './db.js';
import { peopleViewer } from './people-visibility.js';
import { visibleTaskCondition } from './task-visibility.js';

/**
 * `rows` with each `parent_task_id` that names a task hidden from `userId`
 * (as a guest of `orgId`: not a live task of that workspace they may see) set
 * to null. One role lookup, and one query when any row has a parent.
 */
export async function withoutHiddenParents<T extends { parent_task_id?: string | null }>(
  rows: readonly T[],
  orgId: string,
  userId: string,
): Promise<T[]> {
  const parentIds = [...new Set(rows.map((row) => row.parent_task_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (parentIds.length === 0) return [...rows];
  if (!(await peopleViewer(orgId, userId)).guest) return [...rows];
  const visible = new Set((await db.select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.project_id))
    .where(and(inArray(tasks.id, parentIds), eq(tasks.org_id, orgId), eq(tasks.is_deleted, false), visibleTaskCondition(userId))))
    .map((row) => row.id));
  return rows.map((row) => (row.parent_task_id && !visible.has(row.parent_task_id) ? { ...row, parent_task_id: null } : row));
}

/** One row (see `withoutHiddenParents`). */
export async function withoutHiddenParent<T extends { parent_task_id?: string | null }>(row: T, orgId: string, userId: string): Promise<T> {
  return (await withoutHiddenParents([row], orgId, userId))[0]!;
}
