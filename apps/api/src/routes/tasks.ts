import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, asc, sql, inArray, ilike, or, isNull, type SQL } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { projects, tasks, taskComments, taskActivity, taskLabels, labels, users, projectSpaces, messages, taskRelationships, files, savedViews, taskWatchers, taskAssignees, taskReactions, wikiPages, wikiCitations, orgMembers, workflowRules, agentEmployees, agentActions, agentChannelEvents, spaces, spaceMembers } from '@deft/db/schema';
import { getIO, emitToUser } from '../socket.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { canDeleteTask } from '../lib/task-permissions.js';
import { visibleTaskCondition } from '../lib/task-visibility.js';
import { visibleWikiPageCondition } from '../lib/wiki-visibility.js';
import { allowedNextStatuses, isValidTransition } from '../lib/task-status-machine.js';
import { getProjectResolvedConfig } from '../lib/project-resolved-config.js';
import { detectBlocksCycle } from '../lib/task-dependency.js';
import { dispatchAgentEmployeeTask, publishTaskChannelEventForAssignee } from '../lib/dispatch-agent-task.js';
import { reserveNextTaskNumber } from '../lib/task-numbering.js';
import { resolveAssignableAssigneeId } from '../lib/resolve-assignee.js';
import { createNotificationIfAllowed } from '../lib/notification-policy.js';
import { resolveAttentionBySource } from '../lib/attention.js';
import { toPlainText } from '../lib/plain-text.js';
import {
  decodeTaskTableCursor,
  encodeTaskTableCursor,
  parseTaskTableQuery,
  type TaskTableSort,
  type TaskTableSortField,
} from '../lib/task-table-query.js';
import { bulkTaskUpdateSchema, bulkUpdateTasks, BulkTaskUpdateError } from '../lib/task-bulk-update.js';

export const taskRoutes = new Hono();

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  sort_order: z.number().nullable().optional(),
  source_message_id: z.string().nullable().optional(),
  parent_task_id: z.string().nullable().optional(),
  // Task 4.11 — free-form skill-defined custom fields keyed by field id.
  metadata: z.record(z.string(), z.any()).nullable().optional(),
});

// Schema for root POST /api/tasks — project_id comes from the body instead of
// the path param.
const createTaskWithProjectSchema = createTaskSchema.extend({
  project_id: z.string().uuid({ message: 'project_id must be a valid UUID' }),
});

const updateTaskSchema = z.object({
  expected_updated_at: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  assignee_id: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  estimation: z.string().nullable().optional(),
  label_ids: z.array(z.string().uuid()).optional(),
  sort_order: z.number().optional(),
  // Task 0.6 — project_id intentionally omitted. Tasks cannot be moved across
  // projects via PATCH because cross-references (PREFIX-N) in chat messages,
  // comments, wiki citations, etc. would silently break. The handler also has
  // an explicit 400 PROJECT_CHANGE_UNSUPPORTED branch as belt-and-suspenders
  // in case the field bypasses Zod (e.g. passthrough elsewhere).
  parent_task_id: z.string().nullable().optional(),
  recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullable().optional(),
  // Task 4.11 — partial-update of skill-defined custom fields.
  metadata: z.record(z.string(), z.any()).nullable().optional(),
});

const bulkTaskIdsSchema = z.array(z.string().min(1)).min(1).max(50);
const bulkTaskDeleteSchema = z.object({ task_ids: bulkTaskIdsSchema });

async function validateAssignableAssigneeId(assigneeId: unknown, orgId: string): Promise<string | null | undefined> {
  if (assigneeId === undefined) return undefined;
  if (assigneeId === null || assigneeId === '') return null;
  if (typeof assigneeId !== 'string' || assigneeId.trim().length === 0) return null;
  const trimmed = assigneeId.trim();
  const resolved = await resolveAssignableAssigneeId(trimmed, orgId);
  return resolved ? resolved.id : undefined;
}

const createDependencySchema = z.object({
  target_task_id: z.string().min(1),
  type: z.enum(['blocks', 'blocked_by', 'relates_to', 'duplicates']),
});

const createCommentSchema = z.object({
  content: z.string().min(1),
});

const createLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
});

const addLabelSchema = z.object({
  label_id: z.string().min(1),
});

// Helper: get labels for a set of task IDs
async function getLabelsForTasks(taskIds: string[]) {
  if (taskIds.length === 0) return new Map<string, { id: string; name: string; color: string }[]>();

  const rows = await db.select({
    task_id: taskLabels.task_id,
    label_id: labels.id,
    label_name: labels.name,
    label_color: labels.color,
  })
    .from(taskLabels)
    .innerJoin(labels, eq(taskLabels.label_id, labels.id))
    .where(inArray(taskLabels.task_id, taskIds))
    .orderBy(taskLabels.task_id, sql`lower(${labels.name})`, labels.id);

  const result = new Map<string, { id: string; name: string; color: string }[]>();
  for (const row of rows) {
    if (!result.has(row.task_id)) {
      result.set(row.task_id, []);
    }
    result.get(row.task_id)!.push({
      id: row.label_id,
      name: row.label_name,
      color: row.label_color,
    });
  }

  return result;
}

async function getVisibleTaskForOrg(taskId: string, orgId: string, userId: string) {
  const [task] = await db.select({
    id: tasks.id,
    org_id: tasks.org_id,
    project_id: tasks.project_id,
    number: tasks.number,
    title: tasks.title,
    description: tasks.description,
    status: tasks.status,
    priority: tasks.priority,
    assignee_id: tasks.assignee_id,
    created_by: tasks.created_by,
    due_date: tasks.due_date,
    start_date: tasks.start_date,
    estimation: tasks.estimation,
    is_template: tasks.is_template,
    recurrence: tasks.recurrence,
    recurrence_source_id: tasks.recurrence_source_id,
    sort_order: tasks.sort_order,
    source_message_id: tasks.source_message_id,
    parent_task_id: tasks.parent_task_id,
    is_deleted: tasks.is_deleted,
    metadata: tasks.metadata,
    created_at: tasks.created_at,
    updated_at: tasks.updated_at,
  })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.org_id, orgId),
        visibleTaskCondition(userId),
      )
    )
    .limit(1);
  return task ?? null;
}

/**
 * Task 6.4 — extract `@name` / `@user_id` tokens from a free-form HTML/text
 * payload and resolve them against the org's member roster. Case-insensitive
 * partial match against `name`/`email`, first exact match wins; direct
 * user_id matches short-circuit the name lookup so agents-as-users resolve
 * without ambiguity. Returns the matched user_ids, de-duplicated.
 */
async function resolveMentions(content: string | null | undefined, orgId: string, authorId: string): Promise<string[]> {
  if (!content) return [];
  // Strip HTML tags so `@name` mentions inside TipTap paragraph markup still
  // match the raw regex. TipTap wraps content in <p> / <span> / etc.
  const plain = toPlainText(content);
  const tokens = Array.from(plain.matchAll(/@([a-zA-Z0-9_.\-]+)/g))
    .map((m) => m[1])
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
  if (tokens.length === 0) return [];

  // Pull the org's active member user list once; small N, much faster than
  // one query per token.
  const members = await db.select({
    id: users.id,
    name: users.name,
    email: users.email,
  })
    .from(users)
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, users.id),
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.is_active, true),
    ));

  const resolved = new Set<string>();
  for (const token of tokens) {
    const lowerToken = token.toLowerCase();
    // Direct id match first (handles @<uuid>-style references).
    const byId = members.find((m) => m.id === token);
    if (byId) {
      if (byId.id !== authorId) resolved.add(byId.id);
      continue;
    }
    // Exact name match (case-insensitive), prefer first exact hit.
    const exact = members.find((m) => (m.name ?? '').toLowerCase() === lowerToken);
    if (exact) {
      if (exact.id !== authorId) resolved.add(exact.id);
      continue;
    }
    // Exact email-local-part match.
    const byEmail = members.find((m) => (m.email ?? '').toLowerCase().split('@')[0] === lowerToken);
    if (byEmail) {
      if (byEmail.id !== authorId) resolved.add(byEmail.id);
      continue;
    }
    // Fall back to first case-insensitive partial match on name.
    const partial = members.find((m) => (m.name ?? '').toLowerCase().includes(lowerToken));
    if (partial && partial.id !== authorId) resolved.add(partial.id);
  }

  return Array.from(resolved);
}

/**
 * Task 6.4 — create `mention` notifications for each resolved user + emit the
 * socket event so their notification panel updates live. Silently no-ops when
 * there are no mentions.
 */
async function dispatchMentionNotifications(params: {
  content: string | null | undefined;
  taskId: string;
  orgId: string;
  authorId: string;
  authorName: string | null;
  taskPrefix: string;
  taskNumber: number;
  surface: 'description' | 'comment';
}) {
  const { content, taskId, orgId, authorId, authorName, taskPrefix, taskNumber, surface } = params;
  const mentionedIds = await resolveMentions(content, orgId, authorId);
  if (mentionedIds.length === 0) return;

  const taskRef = `${taskPrefix}-${taskNumber}`;
  const link = `/tasks?task=${taskRef}`;
  const plain = toPlainText(content);
  const snippet = plain.slice(0, 200);

  for (const userId of mentionedIds) {
    try {
      const notification = await createNotificationIfAllowed({
        org_id: orgId,
        user_id: userId,
        type: 'mention',
        title: `${authorName || 'Someone'} mentioned you ${surface === 'comment' ? 'in a comment on' : 'in'} ${taskRef}`,
        body: snippet,
        link,
        metadata: { task_id: taskId, surface },
      }, { channel: 'tasks', isMention: true });
      if (notification) {
        emitToUser(userId, 'notification:new', notification);
      }
    } catch (err) {
      console.error('Failed to create mention notification:', err);
    }
  }
}

/**
 * Task 2.7 — detect cycles in the `blocks` dependency graph.
 *
 * Edges are stored exclusively as type=`blocks` (the POST handler normalizes
 * `blocked_by` by flipping direction). To determine whether inserting a new
 * edge `fromId -> toId` would create a cycle, we BFS forward through `blocks`
 * edges starting at `toId`; if the traversal reaches `fromId`, a cycle exists.
 *
 * Scope is restricted to `blocks` edges — `relates_to` and `duplicates` are
 * semantic pointers, not orderings, and cannot form cycles. Org isolation is
 * enforced by joining source_task -> tasks and filtering on tasks.org_id.
 *
 * Safety cap: traversal aborts after visiting 1000 nodes.
 */
// Cycle detector for task dependency graphs lives in
// apps/api/src/lib/task-dependency.ts (shared with the agent add_dependency
// tool). Imported at top of file.

// GET /api/tasks/my — my tasks across all projects
taskRoutes.get('/my', async (c) => {
  try {
    const user = c.get('user');

    const result = await db.select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      created_by: tasks.created_by,
      due_date: tasks.due_date,
      start_date: tasks.start_date,
      estimation: tasks.estimation,
      sort_order: tasks.sort_order,
      project_id: tasks.project_id,
      source_message_id: tasks.source_message_id,
      parent_task_id: tasks.parent_task_id,
      metadata: tasks.metadata,
      is_deleted: tasks.is_deleted,
      created_at: tasks.created_at,
      updated_at: tasks.updated_at,
      project_name: projects.name,
      project_prefix: projects.prefix,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.assignee_id, user.id),
          eq(tasks.is_deleted, false),
          eq(tasks.is_template, false),
          eq(tasks.org_id, user.org_id),
          isNull(tasks.parent_task_id),
        )
      )
      .orderBy(desc(tasks.updated_at));

    // Fetch labels
    const taskIds = result.map((t) => t.id);
    const labelsMap = await getLabelsForTasks(taskIds);

    // Fetch subtask counts
    const subtaskCounts = taskIds.length > 0
      ? await db.select({
          parent_task_id: tasks.parent_task_id,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
        })
          .from(tasks)
          .where(
            and(
              inArray(tasks.parent_task_id, taskIds),
              eq(tasks.is_deleted, false),
            )
          )
          .groupBy(tasks.parent_task_id)
      : [];

    const subtaskCountMap = new Map(
      subtaskCounts.map((s) => [s.parent_task_id, { total: s.total, done: s.done }])
    );

    const tasksWithLabels = result.map((t) => ({
      ...t,
      labels: labelsMap.get(t.id) ?? [],
      subtask_count: subtaskCountMap.get(t.id)?.total ?? 0,
      subtask_done_count: subtaskCountMap.get(t.id)?.done ?? 0,
    }));

    return c.json(tasksWithLabels);
  } catch (err) {
    console.error('Failed to fetch my tasks:', err);
    return c.json({ error: 'Failed to fetch tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/search?q=DEFT — search tasks by ID or title
taskRoutes.get('/search', async (c) => {
  try {
    const user = c.get('user');
    const query = c.req.query('q');

    if (!query || query.trim().length === 0) {
      return c.json([]);
    }

    const q = query.trim();

    // Try to parse as project prefix + number (e.g., DEFT-5)
    const prefixMatch = q.match(/^([A-Za-z]+)-?(\d+)$/);

    let result;
    if (prefixMatch) {
      const prefix = prefixMatch[1]!.toUpperCase();
      const num = parseInt(prefixMatch[2]!);

      result = await db.select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        project_prefix: projects.prefix,
      })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(
          and(
            eq(tasks.org_id, user.org_id),
            eq(tasks.is_deleted, false),
            eq(projects.prefix, prefix),
            eq(tasks.number, num),
            visibleTaskCondition(user.id),
          )
        )
        .limit(20);
    } else {
      result = await db.select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        project_prefix: projects.prefix,
      })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(
          and(
            eq(tasks.org_id, user.org_id),
            eq(tasks.is_deleted, false),
            ilike(tasks.title, `%${q}%`),
            visibleTaskCondition(user.id),
          )
        )
        .limit(20);
    }

    return c.json(result);
  } catch (err) {
    console.error('Failed to search tasks:', err);
    return c.json({ error: 'Failed to search tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ LABEL ROUTES (must be before /:id) ═══
taskRoutes.get('/labels', async (c) => {
  try {
    const user = c.get('user');
    const result = await db.select().from(labels).where(eq(labels.org_id, user.org_id)).orderBy(labels.name);
    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch labels:', err);
    return c.json({ error: 'Failed to fetch labels', code: 'INTERNAL_ERROR' }, 500);
  }
});

taskRoutes.post('/labels', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = createLabelSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    const [label] = await db.insert(labels).values({ org_id: user.org_id, name: parsed.data.name, color: parsed.data.color }).returning();
    return c.json(label, 201);
  } catch (err) {
    console.error('Failed to create label:', err);
    return c.json({ error: 'Failed to create label', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ BULK OPERATIONS (must be before /:id to avoid route capture) ═══

// PATCH /api/tasks/bulk — update multiple tasks at once
// Task 5.5: instead of emitting N `task:updated` events + N notifications,
// we emit a single `task:bulk_updated` and collapse per-assignee notifications
// into a grouped "You were assigned N tasks" when ≥3 tasks go to the same user.
taskRoutes.patch('/bulk', async (c) => {
  try {
    const user = c.get('user');
    const parsed = bulkTaskUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk update', code: 'VALIDATION_ERROR' }, 400);
    }
    return c.json(await bulkUpdateTasks(parsed.data, { orgId: user.org_id, userId: user.id }));
  } catch (err) {
    if (err instanceof BulkTaskUpdateError) {
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    console.error('Failed to bulk update tasks:', err);
    return c.json({ error: 'Failed to bulk update tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});
// POST /api/tasks/bulk-delete — soft delete multiple tasks
taskRoutes.post('/bulk-delete', async (c) => {
  try {
    const user = c.get('user');
    const parsed = bulkTaskDeleteSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk delete', code: 'VALIDATION_ERROR' }, 400);
    }
    const taskIds = [...new Set(parsed.data.task_ids)];
    const targetTasks = await db.select({ id: tasks.id, created_by: tasks.created_by, assignee_id: tasks.assignee_id })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(and(inArray(tasks.id, taskIds), eq(tasks.org_id, user.org_id), eq(tasks.is_deleted, false), visibleTaskCondition(user.id)));
    if (targetTasks.length !== taskIds.length) {
      return c.json({ error: 'One or more tasks were not found or are not accessible', code: 'TASK_NOT_FOUND' }, 404);
    }
    const [member] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id))).limit(1);
    if (targetTasks.some((task) => !canDeleteTask(user, task, member?.role ?? null))) {
      return c.json({ error: 'You cannot delete every selected task', code: 'FORBIDDEN' }, 403);
    }

    await db.transaction(async (tx) => {
      await tx.update(tasks).set({ is_deleted: true, updated_at: new Date() }).where(inArray(tasks.id, taskIds));
      await tx.insert(taskActivity).values(taskIds.map((taskId) => ({
        org_id: user.org_id, task_id: taskId, user_id: user.id, action: 'deleted',
      })));
    });

    const io = getIO();
    if (io) {
      for (const taskId of taskIds) {
        io.to(`org:${user.org_id}`).emit('task:deleted', { id: taskId });
      }
    }

    return c.json({ success: true, deleted: taskIds.length, deleted_ids: taskIds });
  } catch (err) {
    console.error('Failed to bulk delete tasks:', err);
    return c.json({ error: 'Failed to bulk delete tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});

type TableOrderKey = Omit<TaskTableSort, 'field'> & { field: TaskTableSortField | 'id'; group?: boolean };

function tableOrderExpression(key: TableOrderKey): SQL {
  if (key.group && key.field === 'due_date') {
    return sql`case
      when ${tasks.due_date} is null then 'No due date'
      when ${tasks.due_date} < current_date then 'Overdue'
      when ${tasks.due_date} < current_date + interval '1 day' then 'Today'
      when ${tasks.due_date} < current_date + interval '8 days' then 'Next 7 days'
      else 'Later'
    end`;
  }
  switch (key.field) {
    case 'id': return sql`${tasks.id}`;
    case 'number': return sql`${tasks.number}`;
    case 'title': return sql`lower(${tasks.title})`;
    case 'status': return sql`${tasks.status}`;
    case 'priority': return sql`case ${tasks.priority} when 'p0' then 0 when 'p1' then 1 when 'p2' then 2 else 3 end`;
    case 'assignee': return sql`lower(${users.name})`;
    case 'start_date': return sql`${tasks.start_date}`;
    case 'due_date': return sql`${tasks.due_date}`;
    case 'estimation': return sql`${tasks.estimation}`;
    case 'labels': return sql`(
      select lower(${labels.name}) from ${taskLabels}
      inner join ${labels} on ${labels.id} = ${taskLabels.label_id}
      where ${taskLabels.task_id} = ${tasks.id}
      order by lower(${labels.name}), ${labels.id}
      limit 1
    )`;
    case 'updated_at': return sql`${tasks.updated_at}`;
    case 'project': return sql`lower(${projects.name})`;
  }
}

type TaskTableCursorRow = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_name: string | null;
  start_date: Date | string | null;
  due_date: Date | string | null;
  estimation: string | number | null;
  labels: Array<{ name: string }>;
  updated_at: Date | string;
  project_name: string;
  group_cursor_value: string | number | null;
};

function tableCursorValue(task: TaskTableCursorRow, key: TableOrderKey): string | number | null {
  if (key.group) return task.group_cursor_value;
  switch (key.field) {
    case 'id': return task.id;
    case 'number': return task.number;
    case 'title': return task.title.toLowerCase();
    case 'status': return task.status;
    case 'priority': return ({ p0: 0, p1: 1, p2: 2, p3: 3 } as const)[task.priority];
    case 'assignee': return task.assignee_name?.toLowerCase() ?? null;
    case 'start_date': return task.start_date ? new Date(task.start_date).toISOString() : null;
    case 'due_date': return task.due_date ? new Date(task.due_date).toISOString() : null;
    case 'estimation': return task.estimation == null ? null : Number(task.estimation);
    case 'labels': return task.labels[0]?.name.toLowerCase() ?? null;
    case 'updated_at': return new Date(task.updated_at).toISOString();
    case 'project': return task.project_name.toLowerCase();
  }
}

function cursorAfter(expression: SQL, value: string | number | null, key: TableOrderKey): SQL {
  if (value === null) {
    return key.nulls === 'first' ? sql`${expression} is not null` : sql`false`;
  }
  const comparison = key.direction === 'desc'
    ? sql`${expression} < ${value}`
    : sql`${expression} > ${value}`;
  return key.nulls === 'last'
    ? sql`(${comparison} or ${expression} is null)`
    : comparison;
}

function tableCursorCondition(keys: TableOrderKey[], values: Array<string | number | null>): SQL | null {
  if (values.length !== keys.length) return null;
  const branches = keys.map((key, index) => {
    const prior = keys.slice(0, index).map((priorKey, priorIndex) => {
      const expression = tableOrderExpression(priorKey);
      const value = values[priorIndex];
      return value === null ? sql`${expression} is null` : sql`${expression} = ${value}`;
    });
    return and(...prior, cursorAfter(tableOrderExpression(key), values[index]!, key))!;
  });
  return or(...branches)!;
}

// GET /api/tasks/table — the server-backed query used only by Table view.
taskRoutes.get('/table', async (c) => {
  try {
    const user = c.get('user');
    const parsed = parseTaskTableQuery(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'Invalid table query', code: 'VALIDATION_ERROR' }, 400);
    }
    const query = parsed.data;
    const decodedCursor = decodeTaskTableCursor(query.cursor);
    if (query.cursor && !decodedCursor) {
      return c.json({ error: 'Invalid cursor', code: 'INVALID_CURSOR' }, 400);
    }

    if (query.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(and(
        eq(projects.id, query.projectId),
        eq(projects.org_id, user.org_id),
      )).limit(1);
      if (!project) return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    const baseConditions: SQL[] = [
      eq(tasks.org_id, user.org_id),
      eq(tasks.is_deleted, false),
      eq(tasks.is_template, false),
      isNull(tasks.parent_task_id),
      visibleTaskCondition(user.id)!,
    ];
    if (query.mine) baseConditions.push(eq(tasks.assignee_id, user.id));
    if (query.projectId) baseConditions.push(eq(tasks.project_id, query.projectId));
    if (query.assigneeIds.length) baseConditions.push(inArray(tasks.assignee_id, query.assigneeIds));
    if (query.priorities.length) baseConditions.push(inArray(tasks.priority, query.priorities as Array<'p0' | 'p1' | 'p2' | 'p3'>));
    if (query.statuses.length) baseConditions.push(inArray(tasks.status, query.statuses as Array<'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled'>));
    if (query.labelIds.length) baseConditions.push(sql`exists (
      select 1 from ${taskLabels}
      where ${taskLabels.task_id} = ${tasks.id}
        and ${inArray(taskLabels.label_id, query.labelIds)}
    )`);
    if (query.due === 'overdue') baseConditions.push(sql`${tasks.due_date} < current_date`);
    if (query.due === 'today') baseConditions.push(sql`${tasks.due_date} >= current_date and ${tasks.due_date} < current_date + interval '1 day'`);
    if (query.due === 'this_week') baseConditions.push(sql`${tasks.due_date} >= current_date and ${tasks.due_date} < current_date + interval '8 days'`);
    if (query.dateFrom) baseConditions.push(sql`${tasks.due_date} >= ${query.dateFrom}::date`);
    if (query.dateTo) baseConditions.push(sql`${tasks.due_date} < (${query.dateTo}::date + interval '1 day')`);

    const configured = query.sorts.length ? query.sorts : [{ field: 'number', direction: 'desc', nulls: 'last' } satisfies TaskTableSort];
    const keys: TableOrderKey[] = [
      ...(query.group ? [{ ...query.group, group: true }] : []),
      ...configured.filter((sort) => sort.field !== query.group?.field),
      { field: 'id', direction: 'asc', nulls: 'last' },
    ];
    const cursorSignature = JSON.stringify({
      projectId: query.projectId,
      mine: query.mine,
      assigneeIds: query.assigneeIds,
      priorities: query.priorities,
      statuses: query.statuses,
      labelIds: query.labelIds,
      due: query.due,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      keys,
    });
    const cursorValues = decodedCursor?.values ?? null;
    if (decodedCursor && decodedCursor.signature !== cursorSignature) {
      return c.json({ error: 'Cursor does not match query', code: 'INVALID_CURSOR' }, 400);
    }
    const pageConditions = [...baseConditions];
    if (cursorValues) {
      const cursorCondition = tableCursorCondition(keys, cursorValues);
      if (!cursorCondition) return c.json({ error: 'Cursor does not match query', code: 'INVALID_CURSOR' }, 400);
      pageConditions.push(cursorCondition);
    }

    const baseWhere = and(...baseConditions);
    const [countRow] = await db.select({ total: sql<number>`count(*)::int` })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(baseWhere);

    const rows = await db.select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      created_by: tasks.created_by,
      due_date: tasks.due_date,
      start_date: tasks.start_date,
      estimation: tasks.estimation,
      sort_order: tasks.sort_order,
      project_id: tasks.project_id,
      source_message_id: tasks.source_message_id,
      parent_task_id: tasks.parent_task_id,
      is_deleted: tasks.is_deleted,
      created_at: tasks.created_at,
      updated_at: tasks.updated_at,
      assignee_name: users.name,
      assignee_avatar: users.avatar_url,
      project_name: projects.name,
      project_prefix: projects.prefix,
      project_color: projects.color,
      group_cursor_value: query.group
        ? sql<string | number | null>`${tableOrderExpression({ ...query.group, group: true })}`
        : sql<string | number | null>`null`,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(and(...pageConditions))
      .orderBy(...keys.map((key) => sql`${tableOrderExpression(key)} ${sql.raw(key.direction.toUpperCase())} NULLS ${sql.raw(key.nulls.toUpperCase())}`))
      .limit(query.pageSize + 1);

    const pageRows = rows.slice(0, query.pageSize);
    const taskIds = pageRows.map((task) => task.id);
    const labelsMap = await getLabelsForTasks(taskIds);
    const subtaskCounts = taskIds.length ? await db.select({
      parent_task_id: tasks.parent_task_id,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
    }).from(tasks).where(and(inArray(tasks.parent_task_id, taskIds), eq(tasks.is_deleted, false))).groupBy(tasks.parent_task_id) : [];
    const subtaskMap = new Map(subtaskCounts.map((item) => [item.parent_task_id, item]));
    const creatorIds = [...new Set(pageRows.map((task) => task.created_by))];
    const creatorRows = creatorIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, creatorIds)) : [];
    const creatorMap = new Map(creatorRows.map((creator) => [creator.id, creator.name]));
    const enriched = pageRows.map((task) => ({
      ...task,
      creator_name: creatorMap.get(task.created_by) ?? null,
      labels: labelsMap.get(task.id) ?? [],
      subtask_count: subtaskMap.get(task.id)?.total ?? 0,
      subtask_done_count: subtaskMap.get(task.id)?.done ?? 0,
    }));
    const last = enriched.at(-1);
    const data = enriched.map(({ group_cursor_value: _groupCursorValue, ...task }) => task);
    return c.json({
      data,
      total: countRow?.total ?? 0,
      next_cursor: rows.length > query.pageSize && last
        ? encodeTaskTableCursor(cursorSignature, keys.map((key) => tableCursorValue(last, key)))
        : null,
    });
  } catch (err) {
    console.error('Failed to query task table:', err);
    return c.json({ error: 'Failed to query task table', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/templates — list task templates for the org
taskRoutes.get('/templates', async (c) => {
  try {
    const user = c.get('user');
    const rows = await db.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      priority: tasks.priority,
      estimation: tasks.estimation,
    }).from(tasks)
      .where(and(eq(tasks.org_id, user.org_id), eq(tasks.is_template, true), eq(tasks.is_deleted, false)))
      .orderBy(tasks.title);
    return c.json({ templates: rows });
  } catch (err) {
    console.error('Failed to fetch templates:', err);
    return c.json({ error: 'Failed to fetch templates', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/saved-views — list saved views (must be before /:id)
const createViewSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  project_id: z.string().nullable().optional(),
  is_shared: z.boolean().optional(),
});

taskRoutes.get('/saved-views', async (c) => {
  try {
    const user = c.get('user');
    const views = await db.select()
      .from(savedViews)
      .where(and(eq(savedViews.org_id, user.org_id), or(eq(savedViews.user_id, user.id), eq(savedViews.is_shared, true))))
      .orderBy(desc(savedViews.created_at));
    return c.json(views);
  } catch (err) {
    console.error('Failed to fetch saved views:', err);
    return c.json({ error: 'Failed to fetch saved views', code: 'INTERNAL_ERROR' }, 500);
  }
});

taskRoutes.post('/saved-views', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = createViewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    const [view] = await db.insert(savedViews).values({
      org_id: user.org_id, user_id: user.id,
      name: parsed.data.name, config: parsed.data.config,
      project_id: parsed.data.project_id || null, is_shared: parsed.data.is_shared || false,
    }).returning();
    return c.json(view, 201);
  } catch (err) {
    console.error('Failed to create saved view:', err);
    return c.json({ error: 'Failed to create saved view', code: 'INTERNAL_ERROR' }, 500);
  }
});

taskRoutes.patch('/saved-views/:id', async (c) => {
  try {
    const user = c.get('user');
    const viewId = c.req.param('id');
    const parsed = createViewSchema.partial().safeParse(await c.req.json());
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }
    const [view] = await db.update(savedViews).set({
      ...parsed.data,
      updated_at: new Date(),
    }).where(and(
      eq(savedViews.id, viewId),
      eq(savedViews.org_id, user.org_id),
      eq(savedViews.user_id, user.id),
    )).returning();
    if (!view) return c.json({ error: 'View not found', code: 'NOT_FOUND' }, 404);
    return c.json(view);
  } catch (err) {
    console.error('Failed to update saved view:', err);
    return c.json({ error: 'Failed to update saved view', code: 'INTERNAL_ERROR' }, 500);
  }
});

taskRoutes.delete('/saved-views/:id', async (c) => {
  try {
    const user = c.get('user');
    const viewId = c.req.param('id');
    const [view] = await db.select().from(savedViews)
      .where(and(eq(savedViews.id, viewId), eq(savedViews.org_id, user.org_id), eq(savedViews.user_id, user.id))).limit(1);
    if (!view) return c.json({ error: 'View not found', code: 'NOT_FOUND' }, 404);
    await db.delete(savedViews).where(eq(savedViews.id, viewId));
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete saved view:', err);
    return c.json({ error: 'Failed to delete saved view', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/watchers — list watchers for a task
taskRoutes.get('/:id/watchers', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    const taskId = c.req.param('id');
    const taskRow = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!taskRow) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    const watchers = await db.select({
      id: taskWatchers.id,
      user_id: taskWatchers.user_id,
      user_name: users.name,
      user_avatar: users.avatar_url,
      created_at: taskWatchers.created_at,
    }).from(taskWatchers)
      .innerJoin(users, eq(taskWatchers.user_id, users.id))
      .where(eq(taskWatchers.task_id, taskId));
    return c.json({ watchers });
  } catch (err) {
    console.error('Failed to fetch watchers:', err);
    return c.json({ error: 'Failed to fetch watchers', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/watch — watch a task
taskRoutes.post('/:id/watch', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    await db.insert(taskWatchers).values({
      task_id: taskId,
      user_id: user.id,
    }).onConflictDoNothing();
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to watch task:', err);
    return c.json({ error: 'Failed to watch task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id/watch — unwatch a task
taskRoutes.delete('/:id/watch', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    await db.delete(taskWatchers)
      .where(and(eq(taskWatchers.task_id, taskId), eq(taskWatchers.user_id, user.id)));
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to unwatch task:', err);
    return c.json({ error: 'Failed to unwatch task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/assignees — add additional (non-primary) assignee.
// Refuses if user_id is the task's primary assignee — see Phase 0.3 plan.
taskRoutes.post('/:id/assignees', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const { user_id } = await c.req.json();
    if (!user_id) return c.json({ error: 'user_id required', code: 'VALIDATION_ERROR' }, 400);

    const assigneeId = await validateAssignableAssigneeId(user_id, user.org_id);
    if (!assigneeId) {
      return c.json({ error: 'Assignee must be an active user or healthy agent in this organization', code: 'INVALID_ASSIGNEE' }, 400);
    }

    // Look up the task's primary assignee to enforce "no duplication" invariant.
    const taskRow = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!taskRow) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    if (taskRow.assignee_id && taskRow.assignee_id === assigneeId) {
      return c.json({
        error: 'User is already the primary assignee for this task',
        code: 'ALREADY_PRIMARY_ASSIGNEE',
      }, 409);
    }

    await db.insert(taskAssignees).values({
      task_id: taskId,
      user_id: assigneeId,
    }).onConflictDoNothing();
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to add assignee:', err);
    return c.json({ error: 'Failed to add assignee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id/assignees/:userId — remove an additional assignee.
// Succeeds ONLY for users present in taskAssignees; the primary assignee lives on
// tasks.assignee_id and cannot be removed via this endpoint — see Phase 0.3 plan.
taskRoutes.delete('/:id/assignees/:userId', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const userId = c.req.param('userId');
    const taskRow = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!taskRow) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    const deleted = await db.delete(taskAssignees)
      .where(and(eq(taskAssignees.task_id, taskId), eq(taskAssignees.user_id, userId)))
      .returning({ id: taskAssignees.id });
    if (deleted.length === 0) {
      return c.json({ error: 'Assignee not found', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove assignee:', err);
    return c.json({ error: 'Failed to remove assignee', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/assignees — list all assignees
taskRoutes.get('/:id/assignees', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    const taskId = c.req.param('id');
    const taskRow = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!taskRow) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    const assignees = await db.select({
      id: taskAssignees.id,
      user_id: taskAssignees.user_id,
      user_name: users.name,
      user_avatar: users.avatar_url,
    }).from(taskAssignees)
      .innerJoin(users, eq(taskAssignees.user_id, users.id))
      .where(eq(taskAssignees.task_id, taskId));
    return c.json({ assignees });
  } catch (err) {
    console.error('Failed to fetch assignees:', err);
    return c.json({ error: 'Failed to fetch assignees', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/agent-handoff — explicitly queue the assigned agent employee.
taskRoutes.post('/:id/agent-handoff', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    if (!task.assignee_id) {
      return c.json({ error: 'Assign this task to an agent employee first', code: 'NO_ASSIGNEE' }, 400);
    }

    const [employee] = await db.select({
      id: agentEmployees.id,
      user_id: agentEmployees.user_id,
      name: agentEmployees.name,
      slug: agentEmployees.slug,
      runtime_kind: agentEmployees.runtime_kind,
      wake_mode: agentEmployees.wake_mode,
      trust_level: agentEmployees.trust_level,
      certification_status: agentEmployees.certification_status,
      is_active: agentEmployees.is_active,
      unhealthy: agentEmployees.unhealthy,
      unhealthy_reason: agentEmployees.unhealthy_reason,
      heartbeat_interval_min: agentEmployees.heartbeat_interval_min,
      last_heartbeat_at: agentEmployees.last_heartbeat_at,
      last_mcp_call_at: agentEmployees.last_mcp_call_at,
    })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, user.org_id),
        eq(agentEmployees.user_id, task.assignee_id),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);

    if (!employee) {
      return c.json({ error: 'The assignee is not an agent employee', code: 'NOT_AGENT_ASSIGNEE' }, 400);
    }
    if (!employee.is_active) {
      return c.json({ error: 'This agent employee is paused', code: 'AGENT_PAUSED' }, 409);
    }

    const dispatch = await dispatchAgentEmployeeTask({
      taskId,
      orgId: user.org_id,
      assigneeUserId: task.assignee_id,
      assignedBy: user.id,
    });

    if (!dispatch.queued) {
      return c.json({ error: 'Could not queue this task for the agent employee', code: 'HANDOFF_FAILED', reason: dispatch.reason }, 500);
    }

    const [pending] = await db.select({
      count: sql<number>`count(*)::int`,
    })
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.agent_employee_id, employee.id),
        eq(agentActions.approval_status, 'pending'),
      ));

    return c.json({
      queued: true,
      employee: {
        ...employee,
        pending_action_count: pending?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('Failed to queue task agent handoff:', err);
    return c.json({ error: 'Failed to queue agent handoff', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id — single task detail
taskRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const [task] = await db.select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      created_by: tasks.created_by,
      due_date: tasks.due_date,
      start_date: tasks.start_date,
      estimation: tasks.estimation,
      sort_order: tasks.sort_order,
      project_id: tasks.project_id,
      source_message_id: tasks.source_message_id,
      parent_task_id: tasks.parent_task_id,
      // Task 4.12 — surface recurrence on GET so the detail UI can
      // render the Repeats dropdown without a second fetch.
      recurrence: tasks.recurrence,
      recurrence_source_id: tasks.recurrence_source_id,
      is_deleted: tasks.is_deleted,
      created_at: tasks.created_at,
      updated_at: tasks.updated_at,
      project_name: projects.name,
      project_prefix: projects.prefix,
    })
      .from(tasks)
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.org_id, user.org_id),
          eq(tasks.is_deleted, false),
          visibleTaskCondition(user.id),
        )
      )
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const [latestAgentEvent] = await db.select({
      agent_employee_id: agentChannelEvents.agent_employee_id,
      status: agentChannelEvents.status,
      work_outcome: agentChannelEvents.work_outcome,
      detail: agentChannelEvents.outcome_detail,
      error: agentChannelEvents.error,
      updated_at: agentChannelEvents.updated_at,
    }).from(agentChannelEvents)
      .where(and(
        eq(agentChannelEvents.org_id, user.org_id),
        eq(agentChannelEvents.source_kind, 'task'),
        eq(agentChannelEvents.source_id, task.id),
        task.assignee_id
          ? sql`EXISTS (
              SELECT 1 FROM agent_employees ae
              WHERE ae.id = ${agentChannelEvents.agent_employee_id}
                AND ae.org_id = ${user.org_id}
                AND ae.user_id = ${task.assignee_id}
                AND ae.is_deleted = false
            )`
          : sql`FALSE`,
      ))
      .orderBy(desc(agentChannelEvents.updated_at))
      .limit(1);

    // Fetch assignee info
    let assignee = null;
    if (task.assignee_id) {
      const [a] = await db.select({
        id: users.id,
        name: users.name,
        avatar_url: users.avatar_url,
      })
        .from(users)
        .where(eq(users.id, task.assignee_id))
        .limit(1);
      assignee = a ?? null;
    }

    // Fetch creator info
    const [creator] = await db.select({
      id: users.id,
      name: users.name,
      avatar_url: users.avatar_url,
    })
      .from(users)
      .where(eq(users.id, task.created_by))
      .limit(1);

    // Fetch labels
    const labelsMap = await getLabelsForTasks([task.id]);

    // Fetch subtasks
    const subtasks = await db.select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      sort_order: tasks.sort_order,
      parent_task_id: tasks.parent_task_id,
      assignee_name: users.name,
      assignee_avatar: users.avatar_url,
    })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(and(eq(tasks.parent_task_id, taskId), eq(tasks.is_deleted, false)))
      .orderBy(asc(tasks.sort_order));

    // Fetch source message if any
    let sourceMessage = null;
    if (task.source_message_id) {
      const [msg] = await db.select({
        id: messages.id,
        content: messages.content,
        space_id: messages.space_id,
        space_name: spaces.name,
        user_id: messages.user_id,
        author_name: users.name,
        author_avatar: users.avatar_url,
        created_at: messages.created_at,
      })
        .from(messages)
        .innerJoin(spaceMembers, and(
          eq(spaceMembers.space_id, messages.space_id),
          eq(spaceMembers.user_id, user.id),
        ))
        .innerJoin(spaces, and(
          eq(spaces.id, messages.space_id),
          eq(spaces.org_id, user.org_id),
          eq(spaces.is_archived, false),
        ))
        .leftJoin(users, eq(users.id, messages.user_id))
        .where(and(
          eq(messages.id, task.source_message_id),
          eq(messages.org_id, user.org_id),
          eq(messages.is_deleted, false),
        ))
        .limit(1);
      sourceMessage = msg ?? null;
    }

    // Fetch parent task info if this is a subtask
    let parentTask = null;
    if (task.parent_task_id) {
      const [pt] = await db.select({
        id: tasks.id,
        number: tasks.number,
        title: tasks.title,
        project_prefix: projects.prefix,
      })
        .from(tasks)
        .innerJoin(projects, eq(tasks.project_id, projects.id))
        .where(eq(tasks.id, task.parent_task_id))
        .limit(1);
      parentTask = pt ?? null;
    }

    return c.json({
      ...task,
      assignee_name: assignee?.name ?? null,
      assignee_avatar: assignee?.avatar_url ?? null,
      creator_name: creator?.name ?? null,
      creator_avatar: creator?.avatar_url ?? null,
      assignee,
      creator: creator ?? null,
      labels: labelsMap.get(task.id) ?? [],
      source_message: sourceMessage,
      subtasks,
      parent_task: parentTask,
      agent_progress: latestAgentEvent ? {
        agent_employee_id: latestAgentEvent.agent_employee_id,
        step_index: 0,
        total_steps: 1,
        status: latestAgentEvent.work_outcome ?? (
          latestAgentEvent.status === 'running' ? 'started' : latestAgentEvent.status
        ),
        step_description: latestAgentEvent.detail
          ?? latestAgentEvent.error
          ?? `Agent work is ${latestAgentEvent.status.replaceAll('_', ' ')}`,
        error: latestAgentEvent.error ?? undefined,
        updated_at: latestAgentEvent.updated_at,
      } : null,
    });
  } catch (err) {
    console.error('Failed to fetch task:', err);
    return c.json({ error: 'Failed to fetch task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/comments — list comments for a task
taskRoutes.get('/:id/comments', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const result = await db.select({
      id: taskComments.id,
      task_id: taskComments.task_id,
      user_id: taskComments.user_id,
      content: taskComments.content,
      is_deleted: taskComments.is_deleted,
      created_at: taskComments.created_at,
      updated_at: taskComments.updated_at,
      user_name: users.name,
      user_avatar: users.avatar_url,
    })
      .from(taskComments)
      .innerJoin(users, eq(taskComments.user_id, users.id))
      .where(
        and(
          eq(taskComments.task_id, taskId),
          eq(taskComments.is_deleted, false),
        )
      )
      .orderBy(taskComments.created_at);

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch task comments:', err);
    return c.json({ error: 'Failed to fetch comments', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/comments — add comment
taskRoutes.post('/:id/comments', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = await c.req.json();
    const parsed = createCommentSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const [comment] = await db.insert(taskComments).values({
      org_id: user.org_id,
      task_id: taskId,
      user_id: user.id,
      content: parsed.data.content,
    }).returning();

    // Create activity log entry
    await db.insert(taskActivity).values({
      org_id: user.org_id,
      task_id: taskId,
      user_id: user.id,
      action: 'commented',
    });

    // Get user info for response
    const [userData] = await db.select({
      name: users.name,
      avatar_url: users.avatar_url,
    }).from(users).where(eq(users.id, user.id)).limit(1);

    // Notify task assignee about the comment (if not the commenter) and
    // dispatch `mention` notifications for any @-mentions in the body.
    try {
      const [commentedTask] = await db.select({ assignee_id: tasks.assignee_id, number: tasks.number, title: tasks.title, project_id: tasks.project_id })
        .from(tasks).where(eq(tasks.id, taskId)).limit(1);
      const [proj] = await db.select({ prefix: projects.prefix })
        .from(projects)
        .where(eq(projects.id, commentedTask?.project_id ?? ''))
        .limit(1);
      const prefix = proj?.prefix || '';
      const number = commentedTask?.number ?? 0;
      const taskId_str = `${prefix}-${number}`;

      if (commentedTask?.assignee_id && commentedTask.assignee_id !== user.id) {
        const notification = await createNotificationIfAllowed({
          org_id: user.org_id,
          user_id: commentedTask.assignee_id,
          type: 'task_updated',
          title: `${userData?.name || 'Someone'} commented on ${taskId_str}`,
          body: parsed.data.content.slice(0, 200),
          link: `/tasks?task=${taskId_str}`,
        }, { channel: 'tasks' });
        if (notification) {
          emitToUser(commentedTask.assignee_id, 'notification:new', notification);
        }
      }

      // Task 6.4 — mention notifications for this comment.
      if (commentedTask) {
        await dispatchMentionNotifications({
          content: parsed.data.content,
          taskId,
          orgId: user.org_id,
          authorId: user.id,
          authorName: userData?.name ?? null,
          taskPrefix: prefix,
          taskNumber: number,
          surface: 'comment',
        });
      }
    } catch (err) {
      console.error('Comment notification error:', err);
    }

    await publishTaskChannelEventForAssignee({
      orgId: user.org_id,
      task,
      actorUserId: user.id,
      kind: 'task.commented',
      idempotencyKey: `comment:${comment!.id}`,
      payload: {
        comment_id: comment!.id,
        commenter_id: user.id,
        commenter_name: userData?.name ?? null,
        content: parsed.data.content,
      },
    });

    return c.json({
      ...comment,
      user_name: userData?.name ?? null,
      user_avatar: userData?.avatar_url ?? null,
    }, 201);
  } catch (err) {
    console.error('Failed to create task comment:', err);
    return c.json({ error: 'Failed to create comment', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/activity — list activity log for a task
taskRoutes.get('/:id/activity', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const result = await db.select({
      id: taskActivity.id,
      task_id: taskActivity.task_id,
      user_id: taskActivity.user_id,
      action: taskActivity.action,
      field: taskActivity.field,
      old_value: taskActivity.old_value,
      new_value: taskActivity.new_value,
      created_at: taskActivity.created_at,
      user_name: users.name,
      user_avatar: users.avatar_url,
    })
      .from(taskActivity)
      .leftJoin(users, eq(taskActivity.user_id, users.id))
      .where(eq(taskActivity.task_id, taskId))
      .orderBy(desc(taskActivity.created_at));

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch task activity:', err);
    return c.json({ error: 'Failed to fetch activity', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/labels — add label to task
taskRoutes.post('/:id/labels', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = await c.req.json();
    const parsed = addLabelSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    // Verify label belongs to same org
    const [label] = await db.select()
      .from(labels)
      .where(
        and(
          eq(labels.id, parsed.data.label_id),
          eq(labels.org_id, user.org_id),
        )
      )
      .limit(1);

    if (!label) {
      return c.json({ error: 'Label not found', code: 'NOT_FOUND' }, 404);
    }

    await db.insert(taskLabels).values({
      task_id: taskId,
      label_id: parsed.data.label_id,
    });

    return c.json({ success: true }, 201);
  } catch (err: any) {
    if (err?.code === '23505') {
      return c.json({ error: 'Label already attached', code: 'CONFLICT' }, 409);
    }
    console.error('Failed to add label to task:', err);
    return c.json({ error: 'Failed to add label', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id/labels/:labelId — remove label from task
taskRoutes.delete('/:id/labels/:labelId', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const labelId = c.req.param('labelId');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const deleted = await db.delete(taskLabels)
      .where(
        and(
          eq(taskLabels.task_id, taskId),
          eq(taskLabels.label_id, labelId),
        )
      )
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Label not attached to task', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to remove label from task:', err);
    return c.json({ error: 'Failed to remove label', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/labels — list all labels for current org
// Note: mounted under /api/tasks, so this is /api/tasks/labels
taskRoutes.get('/labels', async (c) => {
  try {
    const user = c.get('user');

    const result = await db.select()
      .from(labels)
      .where(eq(labels.org_id, user.org_id))
      .orderBy(labels.name);

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch labels:', err);
    return c.json({ error: 'Failed to fetch labels', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/labels — create a new label
taskRoutes.post('/labels', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = createLabelSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const [label] = await db.insert(labels).values({
      org_id: user.org_id,
      name: parsed.data.name,
      color: parsed.data.color,
    }).returning();

    return c.json(label, 201);
  } catch (err) {
    console.error('Failed to create label:', err);
    return c.json({ error: 'Failed to create label', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ PROJECT-SCOPED TASK ROUTES ═══
// These are mounted at /api/projects/:projectId/tasks in index.ts
// But since Hono route() doesn't pass parent params, we handle them here
// by creating a sub-router that gets mounted with the project routes.
// Instead, we add project-scoped routes directly here with full paths.

// GET /api/projects/:projectId/tasks — list all tasks for a project
taskRoutes.get('/project/:projectId', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('projectId');

    // Verify project belongs to user's org
    const [project] = await db.select({
      id: projects.id,
      prefix: projects.prefix,
    })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.org_id, user.org_id),
        )
      )
      .limit(1);

    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    // Fetch only top-level tasks (no subtasks)
    const result = await db.select({
      id: tasks.id,
      number: tasks.number,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      assignee_id: tasks.assignee_id,
      created_by: tasks.created_by,
      due_date: tasks.due_date,
      start_date: tasks.start_date,
      estimation: tasks.estimation,
      sort_order: tasks.sort_order,
      project_id: tasks.project_id,
      source_message_id: tasks.source_message_id,
      parent_task_id: tasks.parent_task_id,
      is_deleted: tasks.is_deleted,
      created_at: tasks.created_at,
      updated_at: tasks.updated_at,
      assignee_name: users.name,
      assignee_avatar: users.avatar_url,
    })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(
        and(
          eq(tasks.project_id, projectId),
          eq(tasks.is_deleted, false),
          eq(tasks.is_template, false),
          isNull(tasks.parent_task_id),
        )
      )
      .orderBy(tasks.sort_order);

    // Fetch creator names
    const creatorIds = [...new Set(result.map((t) => t.created_by))];
    const creatorRows = creatorIds.length > 0
      ? await db.select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, creatorIds))
      : [];
    const creatorMap = new Map(creatorRows.map((u) => [u.id, u.name]));

    // Fetch labels
    const taskIds = result.map((t) => t.id);
    const labelsMap = await getLabelsForTasks(taskIds);

    // Fetch subtask counts
    const subtaskCounts = taskIds.length > 0
      ? await db.select({
          parent_task_id: tasks.parent_task_id,
          total: sql<number>`count(*)::int`,
          done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
        })
          .from(tasks)
          .where(
            and(
              inArray(tasks.parent_task_id, taskIds),
              eq(tasks.is_deleted, false),
            )
          )
          .groupBy(tasks.parent_task_id)
      : [];

    const subtaskCountMap = new Map(
      subtaskCounts.map((s) => [s.parent_task_id, { total: s.total, done: s.done }])
    );

    const tasksWithExtras = result.map((t) => ({
      ...t,
      creator_name: creatorMap.get(t.created_by) ?? null,
      labels: labelsMap.get(t.id) ?? [],
      project_prefix: project.prefix,
      subtask_count: subtaskCountMap.get(t.id)?.total ?? 0,
      subtask_done_count: subtaskCountMap.get(t.id)?.done ?? 0,
    }));

    return c.json(tasksWithExtras);
  } catch (err) {
    console.error('Failed to fetch project tasks:', err);
    return c.json({ error: 'Failed to fetch tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});

/**
 * Shared task-creation logic used by both the root POST /api/tasks and the
 * path-param POST /api/tasks/project/:projectId routes.
 */
async function createTaskForProject(
  data: z.infer<typeof createTaskSchema>,
  projectId: string,
  orgId: string,
  userId: string,
): Promise<{ task: Record<string, any>; project: { prefix: string; name: string } }> {
  // Verify project belongs to org
  const [project] = await db.select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.org_id, orgId),
      )
    )
    .limit(1);

  if (!project) {
    throw Object.assign(new Error('Project not found'), { code: 'NOT_FOUND' });
  }

  const assigneeId = await validateAssignableAssigneeId(data.assignee_id, orgId);
  if (data.assignee_id !== undefined && assigneeId === undefined) {
    throw Object.assign(new Error('Invalid assignee'), { code: 'INVALID_ASSIGNEE' });
  }

  const taskNumber = await reserveNextTaskNumber({ projectId, orgId });

  const [task] = await db.insert(tasks).values({
    org_id: orgId,
    project_id: projectId,
    number: taskNumber,
    title: data.title,
    description: data.description || undefined,
    status: (data.status || 'backlog') as any,
    priority: (data.priority || 'p2') as any,
    assignee_id: assigneeId ?? undefined,
    created_by: userId,
    due_date: data.due_date ? new Date(data.due_date) : undefined,
    sort_order: data.sort_order ?? 0,
    source_message_id: data.source_message_id || undefined,
    parent_task_id: data.parent_task_id || undefined,
    // Task 4.11 — skill-defined custom fields.
    metadata: data.metadata ?? undefined,
  }).returning();

  // Create activity log entry
  await db.insert(taskActivity).values({
    org_id: orgId,
    task_id: task!.id,
    user_id: userId,
    action: 'created',
  });

  // Broadcast task:created via socket to org
  const io = getIO();
  if (io) {
    io.to(`org:${orgId}`).emit('task:created', {
      ...task,
      project_prefix: project.prefix,
      project_name: project.name,
    });
  }

  // Notify assignee if different from creator
  if (task!.assignee_id && task!.assignee_id !== userId) {
    try {
      const [creatorUser] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
      const taskId_str = `${project.prefix}-${taskNumber}`;
      const notification = await createNotificationIfAllowed({
        org_id: orgId,
        user_id: task!.assignee_id,
        type: 'task_assigned',
        title: `${creatorUser?.name || 'Someone'} assigned you ${taskId_str}`,
        body: task!.title,
        link: `/tasks?task=${taskId_str}`,
      }, { channel: 'tasks' });
      if (notification) {
        emitToUser(task!.assignee_id, 'notification:new', notification);
      }
    } catch {}
  }

  // If assignee is an agent employee, wake them up to work the task.
  if (task!.assignee_id) {
    await dispatchAgentEmployeeTask({
      taskId: task!.id,
      orgId,
      assigneeUserId: task!.assignee_id,
      assignedBy: userId,
    });
  }

  // Enqueue duplicate detection job (skip for subtasks)
  if (!data.parent_task_id) {
    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'duplicate-detect', {
        taskId: task!.id,
        title: task!.title,
        projectId,
        orgId,
      });
    } catch (err) {
      console.error('Failed to enqueue duplicate-detect:', err);
    }
  }

  return { task: task!, project };
}

// POST /api/tasks — root endpoint for REST discoverability.
// Accepts project_id in the request body; otherwise identical to the
// path-param variant below. This is the canonical entry point for
// third-party clients (MCP, scripts, integrations).
taskRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();

    // Validate project_id presence and UUID format before running the full schema.
    if (!body?.project_id) {
      return c.json({ error: 'project_id required', code: 'VALIDATION_ERROR' }, 400);
    }

    const parsed = createTaskWithProjectSchema.safeParse(body);
    if (!parsed.success) {
      // Surface a specific message for bad project_id UUID format.
      const projectIdError = parsed.error.issues.find((i) => i.path[0] === 'project_id');
      if (projectIdError) {
        return c.json({ error: 'project_id required', code: 'VALIDATION_ERROR' }, 400);
      }
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { project_id: projectId, ...taskData } = parsed.data;

    try {
      const { task, project } = await createTaskForProject(taskData, projectId, user.org_id, user.id);
      return c.json({ ...task, project_prefix: project.prefix, project_name: project.name }, 201);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
      }
      if (err?.code === 'INVALID_ASSIGNEE') {
        return c.json({ error: 'Assignee must be an active user or healthy agent in this organization', code: 'INVALID_ASSIGNEE' }, 400);
      }
      throw err;
    }
  } catch (err) {
    console.error('Failed to create task:', err);
    return c.json({ error: 'Failed to create task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/project/:projectId — create task (path-param variant, kept
// for backwards compatibility with existing clients).
taskRoutes.post('/project/:projectId', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('projectId');
    const body = await c.req.json();
    const parsed = createTaskSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    try {
      const { task, project } = await createTaskForProject(parsed.data, projectId, user.org_id, user.id);
      return c.json({ ...task, project_prefix: project.prefix, project_name: project.name }, 201);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
      }
      throw err;
    }
  } catch (err) {
    console.error('Failed to create task:', err);
    return c.json({ error: 'Failed to create task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/tasks/:id — update task
taskRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = await c.req.json();
    const parsed = updateTaskSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const existingTask = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!existingTask) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    // Task 0.6 — reject cross-project moves.
    // Cross-references (PREFIX-N) are keyed to the project. Changing project_id
    // would silently break every chat message / comment / wiki citation that
    // references the task. Safer default: reject, and require delete+recreate.
    // Zod strips project_id above, but we re-check the raw body in case a
    // caller bypasses Zod or we later add passthrough.
    if (
      body &&
      typeof body === 'object' &&
      'project_id' in body &&
      body.project_id !== undefined &&
      body.project_id !== existingTask.project_id
    ) {
      return c.json(
        {
          error: 'Project change is not supported — delete and recreate the task in the target project',
          code: 'PROJECT_CHANGE_UNSUPPORTED',
        },
        400,
      );
    }

    let expectedUpdatedAt: Date | null = null;
    if (parsed.data.expected_updated_at !== undefined) {
      expectedUpdatedAt = new Date(parsed.data.expected_updated_at);
      if (Number.isNaN(expectedUpdatedAt.getTime())) {
        return c.json({ error: 'Invalid expected_updated_at', code: 'VALIDATION_ERROR' }, 400);
      }
      if (expectedUpdatedAt.getTime() !== existingTask.updated_at.getTime()) {
        return c.json({
          error: 'Task changed after it was loaded',
          code: 'TASK_STALE',
          current_task: existingTask,
        }, 409);
      }
    }

    const updateData: Record<string, any> = {};
    const activityEntries: { action: string; field: string; old_value: string | null; new_value: string | null }[] = [];

    if (parsed.data.title !== undefined && parsed.data.title !== existingTask.title) {
      updateData.title = parsed.data.title;
      activityEntries.push({ action: 'title_changed', field: 'title', old_value: existingTask.title, new_value: parsed.data.title });
    }

    if (parsed.data.description !== undefined && parsed.data.description !== existingTask.description) {
      updateData.description = parsed.data.description;
      activityEntries.push({ action: 'description_changed', field: 'description', old_value: existingTask.description ?? null, new_value: parsed.data.description });
    }

    if (parsed.data.status !== undefined && parsed.data.status !== existingTask.status) {
      const resolvedConfig = await getProjectResolvedConfig(existingTask.project_id);
      if (!isValidTransition(existingTask.status, parsed.data.status, resolvedConfig)) {
        return c.json({
          error: 'Invalid status transition',
          code: 'INVALID_TRANSITION',
          current_status: existingTask.status,
          requested_status: parsed.data.status,
          allowed_next_statuses: allowedNextStatuses(existingTask.status, resolvedConfig),
        }, 400);
      }
      updateData.status = parsed.data.status;
      activityEntries.push({ action: 'status_changed', field: 'status', old_value: existingTask.status, new_value: parsed.data.status });
    }

    if (parsed.data.priority !== undefined && parsed.data.priority !== existingTask.priority) {
      updateData.priority = parsed.data.priority;
      activityEntries.push({ action: 'priority_changed', field: 'priority', old_value: existingTask.priority, new_value: parsed.data.priority });
    }

    if (parsed.data.assignee_id !== undefined) {
      const newAssignee = await validateAssignableAssigneeId(parsed.data.assignee_id, user.org_id);
      if (newAssignee === undefined) {
        return c.json({ error: 'Assignee must be an active user or healthy agent in this organization', code: 'INVALID_ASSIGNEE' }, 400);
      }
      if (newAssignee !== existingTask.assignee_id) {
        updateData.assignee_id = newAssignee;
        activityEntries.push({ action: 'assigned', field: 'assignee_id', old_value: existingTask.assignee_id ?? null, new_value: newAssignee });
      }
    }

    if (parsed.data.due_date !== undefined) {
      const newDueDate = parsed.data.due_date ? new Date(parsed.data.due_date) : null;
      // Check for Invalid Date
      if (newDueDate && isNaN(newDueDate.getTime())) {
        return c.json({ error: 'Invalid due date', code: 'VALIDATION_ERROR' }, 400);
      }
      updateData.due_date = newDueDate;
      activityEntries.push({
        action: 'due_date_changed',
        field: 'due_date',
        old_value: existingTask.due_date?.toISOString() ?? null,
        new_value: newDueDate?.toISOString() ?? null,
      });
    }

    if (parsed.data.start_date !== undefined) {
      const newStartDate = parsed.data.start_date ? new Date(parsed.data.start_date) : null;
      if (newStartDate && isNaN(newStartDate.getTime())) {
        return c.json({ error: 'Invalid start date', code: 'VALIDATION_ERROR' }, 400);
      }
      updateData.start_date = newStartDate;
    }

    if (parsed.data.estimation !== undefined) {
      updateData.estimation = parsed.data.estimation;
    }

    let nextLabelIds: string[] | undefined;
    let labelsChanged = false;
    if (parsed.data.label_ids !== undefined) {
      nextLabelIds = [...new Set(parsed.data.label_ids)];
      const validLabels = nextLabelIds.length
        ? await db.select({ id: labels.id }).from(labels).where(and(eq(labels.org_id, user.org_id), inArray(labels.id, nextLabelIds)))
        : [];
      if (validLabels.length !== nextLabelIds.length) {
        return c.json({ error: 'One or more labels are invalid', code: 'INVALID_LABEL' }, 400);
      }
      const currentLabels = await db.select({ id: taskLabels.label_id }).from(taskLabels).where(eq(taskLabels.task_id, taskId));
      const currentIds = currentLabels.map((label) => label.id).sort();
      labelsChanged = currentIds.join(',') !== [...nextLabelIds].sort().join(',');
      if (labelsChanged) {
        updateData.updated_at = new Date();
        activityEntries.push({ action: 'labels_changed', field: 'labels', old_value: currentIds.join(','), new_value: nextLabelIds.join(',') });
      }
    }

    if (parsed.data.sort_order !== undefined) {
      updateData.sort_order = parsed.data.sort_order;
    }

    if (parsed.data.parent_task_id !== undefined) {
      const newParent = parsed.data.parent_task_id || null;
      if (newParent !== existingTask.parent_task_id) {
        updateData.parent_task_id = newParent;
        activityEntries.push({ action: 'parent_changed', field: 'parent_task_id', old_value: existingTask.parent_task_id ?? null, new_value: newParent });
      }
    }

    if (parsed.data.recurrence !== undefined) {
      updateData.recurrence = parsed.data.recurrence;
    }

    if (parsed.data.metadata !== undefined) {
      // Task 4.11 — shallow-merge custom field updates into existing metadata
      // so the UI can PATCH a single field without clobbering the others.
      // Pass null explicitly to clear all custom fields.
      if (parsed.data.metadata === null) {
        updateData.metadata = null;
      } else {
        const existing = (existingTask as any).metadata ?? {};
        updateData.metadata = { ...existing, ...parsed.data.metadata };
      }
    }

    // Task 0.6 — project_id moves are rejected earlier in the handler with
    // 400 PROJECT_CHANGE_UNSUPPORTED. If a same-project project_id slipped
    // through, Zod has already stripped it from parsed.data, so there's
    // nothing to handle here.

    if (Object.keys(updateData).length === 0) {
      return c.json({ error: 'No fields to update', code: 'VALIDATION_ERROR' }, 400);
    }

    let updatedTask: typeof tasks.$inferSelect | null = null;
    if (expectedUpdatedAt || labelsChanged) {
      updatedTask = await db.transaction(async (tx) => {
        const [lockedTask] = await tx.select({ updated_at: tasks.updated_at })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .for('update');
        if (!lockedTask || (expectedUpdatedAt && lockedTask.updated_at.getTime() !== expectedUpdatedAt.getTime())) {
          return null;
        }
        const [updated] = await tx.update(tasks)
          .set(updateData)
          .where(eq(tasks.id, taskId))
          .returning();
        if (labelsChanged && nextLabelIds) {
          await tx.delete(taskLabels).where(eq(taskLabels.task_id, taskId));
          if (nextLabelIds.length) {
            await tx.insert(taskLabels).values(nextLabelIds.map((labelId) => ({ task_id: taskId, label_id: labelId })));
          }
        }
        return updated ?? null;
      });
    } else {
      const [updated] = await db.update(tasks)
        .set(updateData)
        .where(eq(tasks.id, taskId))
        .returning();
      updatedTask = updated ?? null;
    }

    // The row lock makes the version check and update one atomic operation.
    // A concurrent writer cannot slip between them and be overwritten.
    if (!updatedTask) {
      const currentTask = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
      return c.json({
        error: 'Task changed after it was loaded',
        code: 'TASK_STALE',
        current_task: currentTask,
      }, 409);
    }

    if (
      (updateData.status && ['done', 'cancelled'].includes(updateData.status))
      || parsed.data.assignee_id !== undefined
      || parsed.data.due_date !== undefined
    ) {
      await resolveAttentionBySource({
        orgId: user.org_id,
        sourceType: 'task',
        sourceId: taskId,
        resolution: updateData.status === 'done'
          ? 'task_completed'
          : updateData.status === 'cancelled'
            ? 'task_cancelled'
            : parsed.data.assignee_id !== undefined
              ? 'task_reassigned'
              : 'task_due_date_changed',
        actorUserId: user.id,
      });
    }

    // Only mutate the additional-assignee table after the guarded task update
    // succeeds, so a stale write cannot leave related state half-updated.
    if (parsed.data.assignee_id !== undefined && updatedTask.assignee_id) {
      await db.delete(taskAssignees)
        .where(and(
          eq(taskAssignees.task_id, taskId),
          eq(taskAssignees.user_id, updatedTask.assignee_id),
        ));
    }

    let activityRows: { id: string; action: string; field: string | null }[] = [];

    // Create activity log entries for each changed field
    if (activityEntries.length > 0) {
      activityRows = await db.insert(taskActivity).values(
        activityEntries.map((entry) => ({
          org_id: user.org_id,
          task_id: taskId,
          user_id: user.id,
          action: entry.action,
          field: entry.field,
          old_value: entry.old_value,
          new_value: entry.new_value,
        }))
      ).returning({ id: taskActivity.id, action: taskActivity.action, field: taskActivity.field });
    }

    // Task 6.4 — dispatch mention notifications on description edits.
    if (parsed.data.description !== undefined && parsed.data.description !== existingTask.description) {
      try {
        const [author] = await db.select({ name: users.name })
          .from(users).where(eq(users.id, user.id)).limit(1);
        const [proj] = await db.select({ prefix: projects.prefix })
          .from(projects).where(eq(projects.id, existingTask.project_id)).limit(1);
        await dispatchMentionNotifications({
          content: parsed.data.description,
          taskId,
          orgId: user.org_id,
          authorId: user.id,
          authorName: author?.name ?? null,
          taskPrefix: proj?.prefix ?? '',
          taskNumber: existingTask.number,
          surface: 'description',
        });
      } catch (err) {
        console.error('Description mention dispatch error:', err);
      }
    }

    // After the task update is committed, check for recurring task
    if (updateData.status && ['done', 'cancelled'].includes(updateData.status)) {
      // Refetch the updated task to check recurrence
      const [recurringTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      if (recurringTask?.recurrence) {
        // Calculate next due date
        const baseDue = recurringTask.due_date || new Date();
        const nextDue = new Date(baseDue);
        switch (recurringTask.recurrence) {
          case 'daily': nextDue.setDate(nextDue.getDate() + 1); break;
          case 'weekly': nextDue.setDate(nextDue.getDate() + 7); break;
          case 'biweekly': nextDue.setDate(nextDue.getDate() + 14); break;
          case 'monthly': nextDue.setMonth(nextDue.getMonth() + 1); break;
        }

        const nextNumber = await reserveNextTaskNumber({
          projectId: recurringTask.project_id,
          orgId: recurringTask.org_id,
        });

        // Task 4.12 — clone-gap fix. The previous implementation only
        // cloned scalar fields; we now also propagate parent_task_id and
        // the full label set so the next occurrence inherits its full
        // classification.
        const [clone] = await db.insert(tasks).values({
          org_id: recurringTask.org_id,
          project_id: recurringTask.project_id,
          number: nextNumber,
          title: recurringTask.title,
          description: recurringTask.description,
          status: 'todo',
          priority: recurringTask.priority,
          assignee_id: recurringTask.assignee_id,
          due_date: nextDue,
          estimation: recurringTask.estimation,
          parent_task_id: recurringTask.parent_task_id,
          recurrence: recurringTask.recurrence,
          recurrence_source_id: recurringTask.recurrence_source_id || recurringTask.id,
          created_by: user.id,
        }).returning({ id: tasks.id });

        // Clone labels via the (task_id, label_id) composite PK. The
        // onConflictDoNothing is defensive — duplicates should be
        // impossible for a brand-new clone, but we'd rather no-op than
        // 500 if the surrounding flow is ever retried.
        if (clone) {
          const sourceLabels = await db.select({ label_id: taskLabels.label_id })
            .from(taskLabels)
            .where(eq(taskLabels.task_id, recurringTask.id));
          if (sourceLabels.length > 0) {
            await db.insert(taskLabels)
              .values(sourceLabels.map((l) => ({ task_id: clone.id, label_id: l.label_id })))
              .onConflictDoNothing();
          }
        }

        // reserveNextTaskNumber already advanced the project task counter.
      }
    }

    // Get project info for broadcasts
    const [project] = await db.select({
      prefix: projects.prefix,
      name: projects.name,
    })
      .from(projects)
      .where(eq(projects.id, updatedTask!.project_id))
      .limit(1);

    // Notify assignee (if changed)
    if (parsed.data.assignee_id !== undefined) {
      const newAssignee = updateData.assignee_id;
      if (newAssignee && newAssignee !== user.id) {
        try {
          const [assignerUser] = await db.select({ name: users.name }).from(users).where(eq(users.id, user.id)).limit(1);
          const taskId_str = `${project?.prefix || ''}-${updatedTask!.number}`;
          const notification = await createNotificationIfAllowed({
            org_id: user.org_id,
            user_id: newAssignee,
            type: 'task_assigned',
            title: `${assignerUser?.name || 'Someone'} assigned you ${taskId_str}`,
            body: updatedTask!.title,
            link: `/tasks?task=${taskId_str}`,
          }, { channel: 'tasks' });
          if (notification) {
            emitToUser(newAssignee, 'notification:new', notification);
          }
        } catch {}
      }

      // If the new assignee is an AI agent, enqueue the agent worker
      if (newAssignee) {
        await dispatchAgentEmployeeTask({
          taskId,
          orgId: user.org_id,
          assigneeUserId: newAssignee,
          assignedBy: user.id,
        });
      }
    }

    // Notify assignee of status change (if they didn't make the change themselves)
    if (parsed.data.status !== undefined && parsed.data.status !== existingTask.status) {
      const assignee = updatedTask!.assignee_id;
      if (assignee && assignee !== user.id) {
        try {
          const [changerUser] = await db.select({ name: users.name }).from(users).where(eq(users.id, user.id)).limit(1);
          const taskId_str = `${project?.prefix || ''}-${updatedTask!.number}`;
          const statusLabel = { backlog:'Backlog', todo:'To Do', in_progress:'In Progress', in_review:'In Review', done:'Done', cancelled:'Cancelled' }[parsed.data.status] || parsed.data.status;
          const notification = await createNotificationIfAllowed({
            org_id: user.org_id,
            user_id: assignee,
            type: 'task_updated',
            title: `${changerUser?.name || 'Someone'} moved ${taskId_str} to ${statusLabel}`,
            body: updatedTask!.title,
            link: `/tasks?task=${taskId_str}`,
          }, { channel: 'tasks' });
          if (notification) {
            emitToUser(assignee, 'notification:new', notification);
          }
        } catch {}
      }

      const statusActivity = activityRows.find((row) => row.action === 'status_changed');
      await publishTaskChannelEventForAssignee({
        orgId: user.org_id,
        task: updatedTask!,
        projectPrefix: project?.prefix ?? null,
        actorUserId: user.id,
        kind: 'task.status_changed',
        idempotencyKey: `activity:${statusActivity?.id ?? `${taskId}:${existingTask.status}:${parsed.data.status}`}`,
        payload: {
          old_status: existingTask.status,
          new_status: parsed.data.status,
        },
      });
    }

    const io = getIO();

    // If status changed: broadcast and post system message in linked spaces
    if (parsed.data.status !== undefined && parsed.data.status !== existingTask.status) {
      if (io) {
        io.to(`org:${user.org_id}`).emit('task:updated', {
          ...updatedTask,
          project_prefix: project?.prefix,
          project_name: project?.name,
        });
      }

      // Task 5.7 — enqueue workflow-execute for rules matching this
      // status change (trigger_type='task.status_changed' +
      // trigger_config.to_status === new status).
      try {
        const matchingRules = await db
          .select({ id: workflowRules.id, trigger_config: workflowRules.trigger_config })
          .from(workflowRules)
          .where(and(
            eq(workflowRules.org_id, user.org_id),
            eq(workflowRules.trigger_type, 'task.status_changed'),
            eq(workflowRules.is_active, true),
          ));

        for (const rule of matchingRules) {
          const cfg = (rule.trigger_config ?? {}) as Record<string, unknown>;
          const toStatus = (cfg as any).to_status;
          if (toStatus && toStatus !== parsed.data.status) continue;
          await enqueue(QUEUE_NAMES.AGENT_JOBS, 'workflow-execute', {
            workflow_id: rule.id,
            task_id: taskId,
            actor_user_id: user.id,
          });
        }
      } catch (err) {
        console.error('Failed to enqueue workflow-execute:', (err as Error).message);
      }

      // Post system message in linked spaces
      const linkedSpaces = await db.select({ space_id: projectSpaces.space_id })
        .from(projectSpaces)
        .where(eq(projectSpaces.project_id, updatedTask!.project_id));

      if (linkedSpaces.length > 0) {
        const [userData] = await db.select({ name: users.name })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1);

        const taskIdentifier = `${project?.prefix ?? ''}-${updatedTask!.number}`;
        const statusLabel = parsed.data.status.replace(/_/g, ' ');
        const messageContent = `${userData?.name ?? 'Someone'} changed ${taskIdentifier} status to ${statusLabel}`;

        for (const { space_id } of linkedSpaces) {
          const [sysMessage] = await db.insert(messages).values({
            org_id: user.org_id,
            space_id,
            user_id: user.id,
            content: messageContent,
          }).returning();

          if (io) {
            io.to(`space:${space_id}`).emit('message:new', {
              ...sysMessage,
              user_name: userData?.name ?? null,
              user_avatar: null,
              reactions: [],
              reply_count: 0,
              latest_reply_at: null,
            });
          }
        }
      }
    }

    return c.json({
      ...updatedTask,
      project_prefix: project?.prefix ?? null,
      project_name: project?.name ?? null,
    });
  } catch (err) {
    console.error('Failed to update task:', err);
    return c.json({ error: 'Failed to update task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id — soft delete
taskRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const existingTask = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!existingTask) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const [member] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id)))
      .limit(1);

    if (!canDeleteTask(user, existingTask, member?.role ?? null)) {
      return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
    }

    await db.update(tasks)
      .set({ is_deleted: true })
      .where(eq(tasks.id, taskId));

    // Create activity log entry
    await db.insert(taskActivity).values({
      org_id: user.org_id,
      task_id: taskId,
      user_id: user.id,
      action: 'deleted',
    });

    const io = getIO();
    if (io) {
      io.to(`org:${user.org_id}`).emit('task:deleted', { id: taskId });
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete task:', err);
    return c.json({ error: 'Failed to delete task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/duplicate — duplicate a task
taskRoutes.post('/:id/duplicate', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const original = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!original) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const taskNumber = await reserveNextTaskNumber({
      projectId: original.project_id,
      orgId: user.org_id,
    });

    const [project] = await db.select({ prefix: projects.prefix, name: projects.name })
      .from(projects).where(eq(projects.id, original.project_id)).limit(1);

    const [dup] = await db.insert(tasks).values({
      org_id: user.org_id,
      project_id: original.project_id,
      number: taskNumber,
      title: original.title + ' (copy)',
      description: original.description,
      status: 'backlog',
      priority: original.priority,
      assignee_id: original.assignee_id,
      created_by: user.id,
      sort_order: 0,
    }).returning();

    // Copy labels
    const originalLabels = await db.select().from(taskLabels).where(eq(taskLabels.task_id, taskId));
    for (const label of originalLabels) {
      await db.insert(taskLabels).values({ task_id: dup!.id, label_id: label.label_id }).catch(() => {});
    }

    await db.insert(taskActivity).values({ org_id: user.org_id, task_id: dup!.id, user_id: user.id, action: 'created' });

    return c.json({
      ...dup,
      project_prefix: project?.prefix,
      project_name: project?.name,
      labels: originalLabels.length > 0 ? [] : [],
    }, 201);
  } catch (err) {
    console.error('Failed to duplicate task:', err);
    return c.json({ error: 'Failed to duplicate task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ DEPENDENCY ROUTES ═══

// GET /api/tasks/:id/dependencies — get all dependencies for a task
taskRoutes.get('/:id/dependencies', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    // Tasks this task blocks (this task is the source, type='blocks')
    const blocksRows = await db.select({
      id: taskRelationships.id,
      type: taskRelationships.type,
      task_id: tasks.id,
      task_number: tasks.number,
      task_title: tasks.title,
      task_status: tasks.status,
      task_priority: tasks.priority,
      task_assignee_id: tasks.assignee_id,
      project_prefix: projects.prefix,
      assignee_name: users.name,
    })
      .from(taskRelationships)
      .innerJoin(tasks, eq(taskRelationships.target_task_id, tasks.id))
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(
        and(
          eq(taskRelationships.source_task_id, taskId),
          eq(tasks.is_deleted, false),
        )
      );

    // Tasks that block this task (this task is the target, type='blocks')
    const blockedByRows = await db.select({
      id: taskRelationships.id,
      type: taskRelationships.type,
      task_id: tasks.id,
      task_number: tasks.number,
      task_title: tasks.title,
      task_status: tasks.status,
      task_priority: tasks.priority,
      task_assignee_id: tasks.assignee_id,
      project_prefix: projects.prefix,
      assignee_name: users.name,
    })
      .from(taskRelationships)
      .innerJoin(tasks, eq(taskRelationships.source_task_id, tasks.id))
      .innerJoin(projects, eq(tasks.project_id, projects.id))
      .leftJoin(users, eq(tasks.assignee_id, users.id))
      .where(
        and(
          eq(taskRelationships.target_task_id, taskId),
          eq(tasks.is_deleted, false),
        )
      );

    // Separate into blocks/blocked_by/relates_to
    const blocks = blocksRows
      .filter((r) => r.type === 'blocks')
      .map((r) => ({
        relationship_id: r.id,
        task_id: r.task_id,
        number: r.task_number,
        title: r.task_title,
        status: r.task_status,
        priority: r.task_priority,
        assignee_name: r.assignee_name,
        project_prefix: r.project_prefix,
      }));

    const blocked_by = blockedByRows
      .filter((r) => r.type === 'blocks')
      .map((r) => ({
        relationship_id: r.id,
        task_id: r.task_id,
        number: r.task_number,
        title: r.task_title,
        status: r.task_status,
        priority: r.task_priority,
        assignee_name: r.assignee_name,
        project_prefix: r.project_prefix,
      }));

    const relates_to = [
      ...blocksRows.filter((r) => r.type === 'relates_to'),
      ...blockedByRows.filter((r) => r.type === 'relates_to'),
    ].map((r) => ({
      relationship_id: r.id,
      task_id: r.task_id,
      number: r.task_number,
      title: r.task_title,
      status: r.task_status,
      priority: r.task_priority,
      assignee_name: r.assignee_name,
      project_prefix: r.project_prefix,
    }));

    return c.json({ blocks, blocked_by, relates_to });
  } catch (err) {
    console.error('Failed to fetch dependencies:', err);
    return c.json({ error: 'Failed to fetch dependencies', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/dependencies — create a dependency
taskRoutes.post('/:id/dependencies', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = await c.req.json();
    const parsed = createDependencySchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const targetTask = await getVisibleTaskForOrg(parsed.data.target_task_id, user.org_id, user.id);
    if (!targetTask) {
      return c.json({ error: 'Target task not found', code: 'NOT_FOUND' }, 404);
    }

    // Prevent self-referencing
    if (taskId === parsed.data.target_task_id) {
      return c.json({ error: 'Cannot create dependency to self', code: 'VALIDATION_ERROR' }, 400);
    }

    let source_task_id = taskId;
    let target_task_id = parsed.data.target_task_id;
    let type = parsed.data.type as string;

    // Normalize: if type is 'blocked_by', flip the direction and store as 'blocks'
    if (type === 'blocked_by') {
      source_task_id = parsed.data.target_task_id;
      target_task_id = taskId;
      type = 'blocks';
    }

    // Task 2.7 — reject cycles in the blocks graph before inserting.
    // relates_to / duplicates are semantic pointers and cannot form cycles.
    if (type === 'blocks') {
      const cycle = await detectBlocksCycle(source_task_id, target_task_id, user.org_id);
      if (cycle) {
        return c.json(
          { error: 'Would create a circular dependency', code: 'DEPENDENCY_CYCLE' },
          400,
        );
      }
    }

    const [rel] = await db.insert(taskRelationships).values({
      source_task_id,
      target_task_id,
      type: type as 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates',
    }).returning();

    return c.json(rel, 201);
  } catch (err: any) {
    if (err?.code === '23505') {
      return c.json({ error: 'Dependency already exists', code: 'CONFLICT' }, 409);
    }
    console.error('Failed to create dependency:', err);
    return c.json({ error: 'Failed to create dependency', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id/dependencies/:relationId — remove a dependency
taskRoutes.delete('/:id/dependencies/:relationId', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const relationId = c.req.param('relationId');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const deleted = await db.delete(taskRelationships)
      .where(
        and(
          eq(taskRelationships.id, relationId),
          or(
            eq(taskRelationships.source_task_id, taskId),
            eq(taskRelationships.target_task_id, taskId),
          ),
        )
      )
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Dependency not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete dependency:', err);
    return c.json({ error: 'Failed to delete dependency', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/attachments — list files attached to a task
taskRoutes.get('/:id/attachments', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    const results = await db.select({
      id: files.id,
      filename: files.filename,
      mime_type: files.mime_type,
      size_bytes: files.size_bytes,
      storage_key: files.storage_key,
      created_at: files.created_at,
    }).from(files)
      .where(and(eq(files.task_id, taskId), eq(files.org_id, user.org_id)))
      .orderBy(desc(files.created_at));

    return c.json(results);
  } catch (err) {
    console.error('Failed to fetch task attachments:', err);
    return c.json({ error: 'Failed to fetch attachments', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/wiki-links — get wiki pages linked to this task
taskRoutes.get('/:id/wiki-links', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    const links = await db.select({
      citation_id: wikiCitations.id,
      page_id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      summary: wikiPages.summary,
      confidence: wikiPages.confidence,
    }).from(wikiCitations)
      .innerJoin(wikiPages, eq(wikiCitations.page_id, wikiPages.id))
      .where(and(
        eq(wikiCitations.source_type, 'task'),
        eq(wikiCitations.source_id, taskId),
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.is_deleted, false),
        visibleWikiPageCondition(user.id),
      ));
    return c.json({ wiki_links: links });
  } catch (err) {
    console.error('Failed to fetch task wiki links:', err);
    return c.json({ error: 'Failed to fetch wiki links', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/wiki-links — link task to a wiki page
taskRoutes.post('/:id/wiki-links', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const { slug } = await c.req.json();
    if (!slug) return c.json({ error: 'slug required', code: 'VALIDATION_ERROR' }, 400);

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    // Find a wiki page visible to this caller.
    const [page] = await db.select({ id: wikiPages.id }).from(wikiPages)
      .where(and(
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.slug, slug),
        eq(wikiPages.is_deleted, false),
        visibleWikiPageCondition(user.id),
      ))
      .limit(1);
    if (!page) return c.json({ error: 'Wiki page not found', code: 'NOT_FOUND' }, 404);

    // Create citation (task → wiki page)
    await db.insert(wikiCitations).values({
      page_id: page.id,
      source_type: 'task',
      source_id: taskId,
    }).onConflictDoNothing();

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to link task to wiki:', err);
    return c.json({ error: 'Failed to link', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id/wiki-links/:citationId — unlink task from wiki page
taskRoutes.delete('/:id/wiki-links/:citationId', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const citationId = c.req.param('citationId');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    await db.delete(wikiCitations).where(
      and(eq(wikiCitations.id, citationId), eq(wikiCitations.source_id, taskId))
    );
    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to unlink task from wiki:', err);
    return c.json({ error: 'Failed to unlink', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/tasks/:id/subtree — recursive subtask tree
taskRoutes.get('/:id/subtree', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    const result = await db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, title, status, priority, parent_task_id, 0 as depth
        FROM tasks WHERE parent_task_id = ${taskId} AND is_deleted = false AND is_template = false
        UNION ALL
        SELECT t.id, t.title, t.status, t.priority, t.parent_task_id, s.depth + 1
        FROM tasks t
        JOIN subtree s ON t.parent_task_id = s.id
        WHERE t.is_deleted = false AND t.is_template = false AND s.depth < 5
      )
      SELECT * FROM subtree ORDER BY depth, title
    `);
    const rows = (result as any).rows ?? result;
    return c.json({ subtasks: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error('Failed to fetch subtree:', err);
    return c.json({ error: 'Failed to fetch subtree', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ TASK REACTIONS (Task 6.3) ═══

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

// GET /api/tasks/:id/reactions — list reactions grouped by emoji, with
// counts + the caller's selection flag so the client can toggle highlighted
// buttons without a follow-up fetch.
taskRoutes.get('/:id/reactions', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    const rows = await db.select({
      emoji: taskReactions.emoji,
      user_id: taskReactions.user_id,
      user_name: users.name,
    })
      .from(taskReactions)
      .leftJoin(users, eq(taskReactions.user_id, users.id))
      .where(eq(taskReactions.task_id, taskId))
      .orderBy(asc(taskReactions.created_at));

    const byEmoji = new Map<string, { emoji: string; count: number; mine: boolean; users: { id: string; name: string | null }[] }>();
    for (const r of rows) {
      const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, users: [] };
      entry.count += 1;
      if (r.user_id === user.id) entry.mine = true;
      entry.users.push({ id: r.user_id, name: r.user_name });
      byEmoji.set(r.emoji, entry);
    }
    return c.json(Array.from(byEmoji.values()));
  } catch (err) {
    console.error('Failed to list task reactions:', err);
    return c.json({ error: 'Failed to list reactions', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/:id/reactions — upsert (task, user, emoji). The unique
// index makes duplicates a no-op; we return the current reaction summary.
taskRoutes.post('/:id/reactions', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const body = await c.req.json();
    const parsed = reactionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    await db.execute(sql`
      INSERT INTO task_reactions (id, org_id, task_id, user_id, emoji)
      VALUES (${crypto.randomUUID()}, ${user.org_id}, ${taskId}, ${user.id}, ${parsed.data.emoji})
      ON CONFLICT (task_id, user_id, emoji) DO NOTHING
    `);

    try {
      getIO()?.to(`org:${user.org_id}`).emit('task:reaction_changed', { task_id: taskId });
    } catch { /* ignore */ }

    return c.json({ ok: true }, 201);
  } catch (err) {
    console.error('Failed to add task reaction:', err);
    return c.json({ error: 'Failed to add reaction', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/tasks/:id/reactions/:emoji — remove the caller's reaction.
taskRoutes.delete('/:id/reactions/:emoji', async (c) => {
  try {
    const user = c.get('user');
    const taskId = c.req.param('id');
    const emoji = decodeURIComponent(c.req.param('emoji'));

    const task = await getVisibleTaskForOrg(taskId, user.org_id, user.id);
    if (!task) return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);

    await db.delete(taskReactions).where(and(
      eq(taskReactions.task_id, taskId),
      eq(taskReactions.user_id, user.id),
      eq(taskReactions.emoji, emoji),
    ));

    try {
      getIO()?.to(`org:${user.org_id}`).emit('task:reaction_changed', { task_id: taskId });
    } catch { /* ignore */ }

    return c.json({ ok: true });
  } catch (err) {
    console.error('Failed to remove task reaction:', err);
    return c.json({ error: 'Failed to remove reaction', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ SAVED VIEWS ═══

