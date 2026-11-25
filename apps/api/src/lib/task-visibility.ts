// Who may see a task. Two rules, both here:
//
// - A restricted task (metadata.visibility = 'restricted') is seen only by
//   the people it names (assignee, co-assignee, creator, watcher, named
//   viewer) and its project's lead.
// - A guest sees tasks in projects they lead or belong to, and tasks that
//   name them. A guest belongs to a project linked to a space of that
//   workspace they are a member of (archived or not). A task names them as
//   its assignee, a co-assignee, its creator or a named viewer; watching is a
//   subscription and does not count. The restricted rule applies to a guest
//   too. Owners, admins and members are not affected. The role is read from
//   org_members for the task's workspace, as people-visibility.ts does, never
//   from a session or token claim.
//
// Every condition here is total (true or false, never NULL), so `NOT` of one
// means "hidden". This module reads no database itself, so the workspace
// exporter can use it.
import { or, sql, eq, type SQL, type SQLWrapper } from 'drizzle-orm';
import { projectSpaces, projects, spaceMembers, spaces, taskAssignees, taskWatchers, tasks } from '@deft/db/schema';
import { fullWorkspaceViewSql } from './people-visibility-sql.js';

/** The task columns the rules read, for a query that names `tasks` by an alias. */
export type TaskVisibilityColumns = Readonly<{
  id: SQLWrapper;
  orgId: SQLWrapper;
  projectId: SQLWrapper;
  assigneeId: SQLWrapper;
  createdBy: SQLWrapper;
  metadata: SQLWrapper;
}>;

const TABLE_COLUMNS: TaskVisibilityColumns = {
  id: tasks.id,
  orgId: tasks.org_id,
  projectId: tasks.project_id,
  assigneeId: tasks.assignee_id,
  createdBy: tasks.created_by,
  metadata: tasks.metadata,
};

/** The columns of `tasks` under the SQL alias `alias` (for example `t`). */
export function taskAliasColumns(alias: string): TaskVisibilityColumns {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Invalid task alias: ${alias}`);
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    id: column('id'),
    orgId: column('org_id'),
    projectId: column('project_id'),
    assigneeId: column('assignee_id'),
    createdBy: column('created_by'),
    metadata: column('metadata'),
  };
}

export function unrestrictedTaskCondition() {
  return sql`coalesce(${tasks.metadata}->>'visibility', 'org') != 'restricted'`;
}

// Every check below is a lookup by key (a scalar subquery), never IN or
// EXISTS: PostgreSQL plans those twice (per row and hashed), and these
// conditions sit inside checks it plans on every Inbox read and approval
// review (lib/attention.ts).

/**
 * True when the task names `userId`: assignee, co-assignee, creator or named
 * viewer, and (when `watchers`) a watcher. Never NULL.
 */
function taskNamesUserSql(userId: string | SQLWrapper, task: TaskVisibilityColumns, watchers: boolean): SQL {
  const watcher = watchers ? sql`OR ${taskWatchedBySql(userId, task)}` : sql``;
  return sql`(COALESCE(${task.assigneeId} = ${userId}, false)
    OR COALESCE(${task.createdBy} = ${userId}, false)
    OR coalesce(${task.metadata}->'visible_user_ids', '[]'::jsonb) ? ${userId}
    ${watcher}
    OR COALESCE((SELECT true FROM ${taskAssignees} named_assignee
      WHERE named_assignee.task_id = ${task.id} AND named_assignee.user_id = ${userId} LIMIT 1), false))`;
}

function taskWatchedBySql(userId: string | SQLWrapper, task: TaskVisibilityColumns): SQL {
  return sql`COALESCE((SELECT true FROM ${taskWatchers} named_watcher
      WHERE named_watcher.task_id = ${task.id} AND named_watcher.user_id = ${userId} LIMIT 1), false)`;
}

/**
 * What a guest may see, without the role check: a task that names them
 * (watching never counts for a guest), a task of a project they lead, or an
 * unrestricted task of a project linked to a space of the task's workspace
 * they are a member of (archived or not). So the restricted rule is included:
 * a restricted task needs the guest named on it or leading its project.
 * Never NULL. Use it only behind the role check (`guestTaskScopeSql`,
 * `taskHiddenFromGuestSql`).
 */
export function memberProjectOrNamedTaskSql(userId: string | SQLWrapper, task: TaskVisibilityColumns): SQL {
  return sql`(${taskNamesUserSql(userId, task, false)}
    OR COALESCE((SELECT true FROM ${projects} member_led_project
      WHERE member_led_project.id = ${task.projectId} AND member_led_project.lead_id = ${userId}), false)
    OR (COALESCE((SELECT true FROM ${projectSpaces} member_link
        JOIN ${spaceMembers} member_space_member
          ON member_space_member.space_id = member_link.space_id AND member_space_member.user_id = ${userId}
        JOIN ${spaces} member_space ON member_space.id = member_link.space_id AND member_space.org_id = ${task.orgId}
        WHERE member_link.project_id = ${task.projectId} LIMIT 1), false)
      AND coalesce(${task.metadata}->>'visibility', 'org') != 'restricted'))`;
}

/**
 * The guest rule alone: true unless `userId` is a guest of the task's
 * workspace and may not see it (`memberProjectOrNamedTaskSql`, which applies
 * the restricted rule to a guest). Always true for an owner, admin or member;
 * for them combine it with the restricted rule (`visibleTaskCondition` does
 * both). Never NULL.
 */
export function guestTaskScopeSql(userId: string | SQLWrapper, task: TaskVisibilityColumns = TABLE_COLUMNS): SQL {
  return sql`(${fullWorkspaceViewSql(userId, task.orgId)}
    OR ${memberProjectOrNamedTaskSql(userId, task)})`;
}

/**
 * True when the task `taskId` of `orgId` exists and `userId`, as a guest of
 * that workspace, may not see it. Always false for an owner, admin or member,
 * and for an id that names no task. For a surface that names a task by id
 * (an Inbox item, a notification) rather than reading the task.
 */
export function taskHiddenFromGuestSql(userId: string | SQLWrapper, taskId: SQLWrapper, orgId: SQLWrapper): SQL {
  return sql`COALESCE((SELECT ${guestTaskScopeSql(userId, taskAliasColumns('guest_hidden_task'))} IS NOT TRUE
    FROM ${tasks} guest_hidden_task
    WHERE guest_hidden_task.id = ${taskId} AND guest_hidden_task.org_id = ${orgId}), false)`;
}

/**
 * Both rules, for a query that does not join `projects` (the project lead is
 * read by a subquery): on `tasks` itself by default, or on `tasks` under an
 * alias (`taskAliasColumns`). Every surface that returns task rows, titles
 * or counts uses this or `visibleTaskCondition`, never `guestTaskScopeSql`
 * alone (that is the guest rule only).
 */
export function visibleTaskSql(userId: string | SQLWrapper, task: TaskVisibilityColumns = TABLE_COLUMNS): SQL {
  return sql`COALESCE(((coalesce(${task.metadata}->>'visibility', 'org') != 'restricted'
      OR ${taskNamesUserSql(userId, task, true)}
      OR COALESCE((SELECT true FROM ${projects} led_project
        WHERE led_project.id = ${task.projectId} AND led_project.lead_id = ${userId}), false))
    AND ${guestTaskScopeSql(userId, task)}), false)`;
}

/**
 * Restricted tasks are hidden from org-wide surfaces unless the caller has a
 * direct relationship to the task, and a guest sees only the tasks of their
 * projects and the tasks that name them. The check expects queries to join
 * projects.
 */
export function visibleTaskCondition(userId: string): SQL {
  const restrictedRule = or(
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
  // Total: a NULL (an unassigned task, a project with no lead) reads as false.
  return sql`COALESCE((${restrictedRule} AND ${guestTaskScopeSql(userId)}), false)`;
}

/**
 * The part of a task's metadata that restricts it (`visibility` and
 * `visible_user_ids`), to carry onto a task made from it (a duplicate, the
 * next occurrence of a recurring task) so the copy is hidden from the same
 * people. `alsoNamed` are the people the original names in other ways that
 * the copy does not keep (its creator, co-assignees, watchers): they become
 * named viewers of the copy, so it reaches the same people. Undefined for a
 * task that is not restricted.
 */
export function taskRestrictionMetadata(
  metadata: unknown,
  alsoNamed: ReadonlyArray<string | null | undefined> = [],
): { visibility: 'restricted'; visible_user_ids: string[] } | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const source = metadata as Record<string, unknown>;
  if (source.visibility !== 'restricted') return undefined;
  // The rule reads `visible_user_ids` with jsonb `?`: array elements, or the
  // keys of an object. Both forms carry over.
  const viewers = source.visible_user_ids;
  const named = Array.isArray(viewers)
    ? viewers.filter((id): id is string => typeof id === 'string')
    : viewers && typeof viewers === 'object' ? Object.keys(viewers) : [];
  return {
    visibility: 'restricted',
    visible_user_ids: [...new Set([...named, ...alsoNamed.filter((id): id is string => typeof id === 'string' && id.length > 0)])],
  };
}
