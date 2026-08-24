import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { labels, projects, taskAssignees, taskLabels, tasks, users } from '@deft/db/schema';
import { db } from './db.js';
import { visibleTaskCondition } from './task-visibility.js';
import { allowedNextStatuses, ENGINEERING_DEFAULTS } from './task-status-machine.js';

const STATUSES = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3']);
const SORT_FIELDS = new Set(['number', 'title', 'status', 'priority', 'assignee', 'start_date', 'due_date', 'estimation', 'updated_at', 'project']);

export type CompactTaskQuery = {
  project_id?: string;
  mine?: boolean;
  assignee_ids?: string[];
  statuses?: string[];
  priorities?: string[];
  label_ids?: string[];
  due?: 'overdue' | 'today' | 'this_week';
  date_from?: string;
  date_to?: string;
  sort?: { field?: string; direction?: 'asc' | 'desc' };
  limit?: number;
};

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function orderExpression(field: string): SQL {
  switch (field) {
    case 'number': return sql`${tasks.number}`;
    case 'title': return sql`lower(${tasks.title})`;
    case 'status': return sql`${tasks.status}`;
    case 'priority': return sql`case ${tasks.priority} when 'p0' then 0 when 'p1' then 1 when 'p2' then 2 else 3 end`;
    case 'assignee': return sql`lower(${users.name})`;
    case 'start_date': return sql`${tasks.start_date}`;
    case 'due_date': return sql`${tasks.due_date}`;
    case 'estimation': return sql`${tasks.estimation}`;
    case 'project': return sql`lower(${projects.name})`;
    default: return sql`${tasks.updated_at}`;
  }
}

export async function queryCompactTasks(input: CompactTaskQuery, actor: { orgId: string; userId: string }) {
  const statuses = [...new Set(input.statuses ?? [])];
  const priorities = [...new Set(input.priorities ?? [])];
  if (statuses.some((status) => !STATUSES.has(status))) throw new Error('Invalid task status filter');
  if (priorities.some((priority) => !PRIORITIES.has(priority))) throw new Error('Invalid task priority filter');
  const from = date(input.date_from);
  const to = date(input.date_to);
  if ((input.date_from && !from) || (input.date_to && !to)) throw new Error('Invalid task date filter');
  const conditions: SQL[] = [
    eq(tasks.org_id, actor.orgId),
    eq(tasks.is_deleted, false),
    eq(tasks.is_template, false),
    isNull(tasks.parent_task_id),
  ];
  const visibility = visibleTaskCondition(actor.userId);
  if (visibility) conditions.push(visibility);
  if (input.project_id) conditions.push(eq(tasks.project_id, input.project_id));
  if (input.mine) conditions.push(or(
    eq(tasks.assignee_id, actor.userId),
    sql`exists (select 1 from ${taskAssignees} where ${taskAssignees.task_id} = ${tasks.id} and ${taskAssignees.user_id} = ${actor.userId})`,
  )!);
  if (input.assignee_ids?.length) conditions.push(inArray(tasks.assignee_id, [...new Set(input.assignee_ids)]));
  if (statuses.length) conditions.push(inArray(tasks.status, statuses as Array<'todo'>));
  if (priorities.length) conditions.push(inArray(tasks.priority, priorities as Array<'p2'>));
  if (input.label_ids?.length) {
    const labelIds = [...new Set(input.label_ids)];
    conditions.push(sql`exists (select 1 from ${taskLabels} where ${taskLabels.task_id} = ${tasks.id} and ${taskLabels.label_id} in (${sql.join(labelIds.map((id) => sql`${id}`), sql`, `)}))`);
  }
  if (input.due === 'overdue') conditions.push(sql`${tasks.due_date} < current_date`);
  if (input.due === 'today') conditions.push(sql`${tasks.due_date} >= current_date and ${tasks.due_date} < current_date + interval '1 day'`);
  if (input.due === 'this_week') conditions.push(sql`${tasks.due_date} >= current_date and ${tasks.due_date} < current_date + interval '8 days'`);
  if (from) conditions.push(gte(tasks.due_date, from));
  if (to) conditions.push(sql`${tasks.due_date} < (${input.date_to}::date + interval '1 day')`);

  const sortField = SORT_FIELDS.has(input.sort?.field ?? '') ? input.sort!.field! : 'updated_at';
  const direction = input.sort?.direction === 'asc' ? asc : desc;
  const rows = await db.select({
    id: tasks.id,
    task_key: sql<string>`${projects.prefix} || '-' || ${tasks.number}`,
    title: tasks.title,
    status: tasks.status,
    priority: tasks.priority,
    assignee_id: tasks.assignee_id,
    assignee_name: users.name,
    start_date: tasks.start_date,
    due_date: tasks.due_date,
    estimation: tasks.estimation,
    project_id: projects.id,
    project_name: projects.name,
    updated_at: tasks.updated_at,
  })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .leftJoin(users, eq(tasks.assignee_id, users.id))
    .where(and(...conditions))
    .orderBy(direction(orderExpression(sortField)), asc(tasks.id))
    .limit(Math.min(Math.max(1, input.limit ?? 20), 100));

  const labelRows = rows.length
    ? await db.select({ task_id: taskLabels.task_id, id: labels.id, name: labels.name, color: labels.color })
      .from(taskLabels).innerJoin(labels, eq(taskLabels.label_id, labels.id))
      .where(inArray(taskLabels.task_id, rows.map((row) => row.id)))
    : [];
  const byTask = new Map<string, Array<{ id: string; name: string; color: string }>>();
  for (const label of labelRows) {
    const list = byTask.get(label.task_id) ?? [];
    list.push({ id: label.id, name: label.name, color: label.color });
    byTask.set(label.task_id, list);
  }
  return rows.map((row) => ({
    ...row,
    allowed_next_statuses: allowedNextStatuses(row.status, ENGINEERING_DEFAULTS),
    labels: byTask.get(row.id) ?? [],
  }));
}
