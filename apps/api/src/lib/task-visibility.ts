import { eq, or, sql } from 'drizzle-orm';
import { projects, taskAssignees, taskWatchers, tasks } from '@deft/db/schema';

export function unrestrictedTaskCondition() {
  return sql`coalesce(${tasks.metadata}->>'visibility', 'org') != 'restricted'`;
}

/**
 * Restricted tasks are hidden from org-wide surfaces unless the caller has a
 * direct relationship to the task. The check expects queries to join projects.
 */
export function visibleTaskCondition(userId: string) {
  return or(
    unrestrictedTaskCondition(),
    eq(tasks.assignee_id, userId),
    eq(tasks.created_by, userId),
    eq(projects.lead_id, userId),
    sql`coalesce(${tasks.metadata}->'visible_user_ids', '[]'::jsonb) ? ${userId}`,
    sql`exists (
      select 1 from ${taskWatchers}
      where ${taskWatchers.task_id} = ${tasks.id}
        and ${taskWatchers.user_id} = ${userId}
    )`,
    sql`exists (
      select 1 from ${taskAssignees}
      where ${taskAssignees.task_id} = ${tasks.id}
        and ${taskAssignees.user_id} = ${userId}
    )`,
  );
}
