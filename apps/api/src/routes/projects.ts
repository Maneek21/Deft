import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, gt, sql, inArray, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { projects, tasks, taskLabels, labels, users, taskActivity, notifications } from '@deft/db/schema';
import { getIO, emitToUser } from '../socket.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import {
  getProjectResolvedConfig,
} from '../lib/project-resolved-config.js';

export const projectRoutes = new Hono();

// GET /api/projects — list all projects for current org
// Query flags:
//   ?include_archived=true  — include is_archived=true rows (default: exclude)
// Soft-deleted rows (is_deleted=true) are always excluded from this endpoint.
// See GET /api/projects/recently-deleted for the 7-day recovery window.
projectRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const includeArchived = c.req.query('include_archived') === 'true';

    const conditions = [
      eq(projects.org_id, user.org_id),
      eq(projects.is_deleted, false),
    ];
    if (!includeArchived) {
      conditions.push(eq(projects.is_archived, false));
    }

    const result = await db.select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      prefix: projects.prefix,
      icon: projects.icon,
      color: projects.color,
      lead_id: projects.lead_id,
      task_counter: projects.task_counter,
      total_tasks: sql<number>`(
        select count(*)::int from "tasks"
        where "tasks"."project_id" = "projects"."id"
          and "tasks"."is_deleted" = false
      )`.as('total_tasks'),
      done_tasks: sql<number>`(
        select count(*)::int from "tasks"
        where "tasks"."project_id" = "projects"."id"
          and "tasks"."is_deleted" = false
          and "tasks"."status" = 'done'
      )`.as('done_tasks'),
      is_archived: projects.is_archived,
      created_at: projects.created_at,
    })
      .from(projects)
      .where(and(...conditions));

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch projects:', err);
    return c.json({ error: 'Failed to fetch projects', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/projects/recently-deleted — soft-deleted projects within the 7-day
// recovery window. Surfaced in Settings to let users restore before the row
// is hard-purged (purge is a separate cron, out of scope for task 5.8).
projectRoutes.get('/recently-deleted', async (c) => {
  try {
    const user = c.get('user');

    const result = await db.select({
      id: projects.id,
      name: projects.name,
      prefix: projects.prefix,
      color: projects.color,
      deleted_at: projects.deleted_at,
    })
      .from(projects)
      .where(
        and(
          eq(projects.org_id, user.org_id),
          eq(projects.is_deleted, true),
          // Postgres: deleted_at > NOW() - interval '7 days'
          gt(projects.deleted_at, sql`NOW() - INTERVAL '7 days'`),
        )
      )
      .orderBy(desc(projects.deleted_at));

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch recently-deleted projects:', err);
    return c.json({ error: 'Failed to fetch recently-deleted', code: 'INTERNAL_ERROR' }, 500);
  }
});

const createProjectSchema = z.object({
  name: z.string().min(1),
  prefix: z.string().min(2).max(6),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  lead_id: z.string().optional(),
});

// POST /api/projects — create project
projectRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { name, prefix, description, icon, color, lead_id } = parsed.data;

    // Ensure prefix is uppercase
    const uppercasePrefix = prefix.toUpperCase();

    // Check prefix uniqueness
    const existing = await db.select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.org_id, user.org_id), eq(projects.prefix, uppercasePrefix)))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: 'Prefix already in use', code: 'PREFIX_EXISTS' }, 409);
    }

    const [project] = await db.insert(projects).values({
      org_id: user.org_id,
      name,
      prefix: uppercasePrefix,
      description: description || null,
      icon: icon || null,
      color: color || null,
      lead_id: lead_id || null,
    }).returning();

    return c.json(project, 201);
  } catch (err) {
    console.error('Failed to create project:', err);
    return c.json({ error: 'Failed to create project', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/projects/:id — get single project with task counts per status
projectRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');

    const [project] = await db.select()
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

    // Get task counts per status
    const statusCounts = await db.select({
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
      .from(tasks)
      .where(
        and(
          eq(tasks.project_id, projectId),
          eq(tasks.is_deleted, false),
        )
      )
      .groupBy(tasks.status);

    const task_counts: Record<string, number> = {
      backlog: 0,
      todo: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
      cancelled: 0,
    };

    for (const row of statusCounts) {
      task_counts[row.status] = row.count;
    }

    return c.json({ ...project, task_counts });
  } catch (err) {
    console.error('Failed to fetch project:', err);
    return c.json({ error: 'Failed to fetch project', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/projects/:id/velocity — rolling weekly completion velocity
projectRoutes.get('/:id/velocity', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const weeks = parseInt(c.req.query('weeks') || '8');

    const result = await db.execute(sql`
      SELECT
        date_trunc('week', ta.created_at)::text as week_start,
        count(DISTINCT ta.task_id)::int as completed
      FROM task_activity ta
      JOIN tasks t ON ta.task_id = t.id
      WHERE t.project_id = ${projectId}
        AND t.org_id = ${user.org_id}
        AND ta.action = 'status_changed'
        AND ta.new_value = 'done'
        AND ta.created_at > NOW() - make_interval(weeks => ${weeks})
      GROUP BY date_trunc('week', ta.created_at)
      ORDER BY week_start
    `);

    const rows = (result as any).rows ?? result;
    const velocity = Array.isArray(rows) ? rows.map((r: any) => ({
      week: r.week_start,
      completed: Number(r.completed),
    })) : [];

    const avg = velocity.length > 0
      ? Math.round(velocity.reduce((s: number, v: any) => s + v.completed, 0) / velocity.length * 10) / 10
      : 0;

    return c.json({ velocity, average: avg, weeks });
  } catch (err) {
    console.error('Failed to fetch velocity:', err);
    return c.json({ error: 'Failed to fetch velocity', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ UPDATE / ARCHIVE / SOFT-DELETE / RESTORE (Task 5.8) ═══

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  lead_id: z.string().nullable().optional(),
  is_archived: z.boolean().optional(),
}).strict();

// PATCH /api/projects/:id — partial update of name/color/description/lead/
// icon/is_archived. `prefix` is immutable after creation (task IDs depend on
// it). Soft-delete state (is_deleted) is changed only via DELETE + restore.
projectRoutes.patch('/:id', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    // Empty patch is a no-op but we still return the current row so clients
    // have a consistent shape to work with.
    const updates = parsed.data;
    const hasChanges = Object.keys(updates).length > 0;

    // Verify project belongs to user's org (and isn't already soft-deleted).
    const [existing] = await db.select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.org_id, user.org_id),
          eq(projects.is_deleted, false),
        )
      )
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    if (!hasChanges) {
      return c.json(existing);
    }

    const [updated] = await db.update(projects)
      .set(updates)
      .where(eq(projects.id, projectId))
      .returning();

    return c.json(updated);
  } catch (err) {
    console.error('Failed to update project:', err);
    return c.json({ error: 'Failed to update project', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/projects/:id — soft-delete. Sets is_deleted=true + deleted_at=NOW().
// Tasks remain in the DB for audit but stop appearing in list queries (they
// already filter by project, which is excluded once deleted). Recoverable
// within 7 days via POST /api/projects/:id/restore.
projectRoutes.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');

    const [existing] = await db.select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.org_id, user.org_id),
          eq(projects.is_deleted, false),
        )
      )
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(projects)
      .set({ is_deleted: true, deleted_at: new Date() })
      .where(eq(projects.id, projectId));

    return c.body(null, 204);
  } catch (err) {
    console.error('Failed to delete project:', err);
    return c.json({ error: 'Failed to delete project', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/projects/:id/restore — reverse soft-delete within the 7-day
// recovery window. After 7 days the row is still restorable here if a purge
// hasn't run, but the UI only surfaces rows where deleted_at > NOW()-7d.
projectRoutes.post('/:id/restore', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');

    const [existing] = await db.select({ id: projects.id, is_deleted: projects.is_deleted })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.org_id, user.org_id),
        )
      )
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }
    if (!existing.is_deleted) {
      return c.json({ error: 'Project is not deleted', code: 'NOT_DELETED' }, 400);
    }

    const [restored] = await db.update(projects)
      .set({ is_deleted: false, deleted_at: null })
      .where(eq(projects.id, projectId))
      .returning();

    return c.json(restored);
  } catch (err) {
    console.error('Failed to restore project:', err);
    return c.json({ error: 'Failed to restore project', code: 'INTERNAL_ERROR' }, 500);
  }
});

// ═══ PROJECT-SCOPED TASK ROUTES ═══
// These match the frontend's expected URLs: /api/projects/:id/tasks

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
    .where(inArray(taskLabels.task_id, taskIds));

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
});

// GET /api/projects/:id/tasks — list all tasks for a project
projectRoutes.get('/:id/tasks', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');

    // Verify project belongs to user's org
    const [project] = await db.select({
      id: projects.id,
      prefix: projects.prefix,
      name: projects.name,
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

    // Fetch subtask counts for each task
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
      project_name: project.name,
      subtask_count: subtaskCountMap.get(t.id)?.total ?? 0,
      subtask_done_count: subtaskCountMap.get(t.id)?.done ?? 0,
    }));

    return c.json(tasksWithExtras);
  } catch (err) {
    console.error('Failed to fetch project tasks:', err);
    return c.json({ error: 'Failed to fetch tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/projects/:id/tasks — create task in project
projectRoutes.post('/:id/tasks', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const body = await c.req.json();
    const parsed = createTaskSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    // Verify project belongs to user's org
    const [project] = await db.select()
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

    // Atomically increment task_counter
    const [updated] = await db.update(projects)
      .set({ task_counter: sql`${projects.task_counter} + 1` })
      .where(eq(projects.id, projectId))
      .returning({ task_counter: projects.task_counter });

    const taskNumber = updated!.task_counter;

    const [task] = await db.insert(tasks).values({
      org_id: user.org_id,
      project_id: projectId,
      number: taskNumber,
      title: parsed.data.title,
      description: parsed.data.description || undefined,
      status: (parsed.data.status || 'backlog') as any,
      priority: (parsed.data.priority || 'p2') as any,
      assignee_id: parsed.data.assignee_id || undefined,
      created_by: user.id,
      due_date: parsed.data.due_date ? new Date(parsed.data.due_date) : undefined,
      sort_order: parsed.data.sort_order ?? 0,
      source_message_id: parsed.data.source_message_id || undefined,
      parent_task_id: parsed.data.parent_task_id || undefined,
    }).returning();

    // Create activity log entry
    await db.insert(taskActivity).values({
      org_id: user.org_id,
      task_id: task!.id,
      user_id: user.id,
      action: 'created',
    });

    // Broadcast task:created via socket to org
    const io = getIO();
    if (io) {
      io.to(`org:${user.org_id}`).emit('task:created', {
        ...task,
        project_prefix: project.prefix,
        project_name: project.name,
      });
    }

    // Notify assignee if different from creator
    if (task!.assignee_id && task!.assignee_id !== user.id) {
      try {
        const [creatorUser] = await db.select({ name: users.name }).from(users).where(eq(users.id, user.id)).limit(1);
        const taskId_str = `${project!.prefix}-${taskNumber}`;
        await db.insert(notifications).values({
          org_id: user.org_id,
          user_id: task!.assignee_id,
          type: 'task_assigned',
          title: `${creatorUser?.name || 'Someone'} assigned you ${taskId_str}`,
          body: task!.title,
          link: `/tasks?task=${taskId_str}`,
        });
        emitToUser(task!.assignee_id, 'notification:new', { type: 'task_assigned', title: `New task: ${taskId_str}` });
      } catch {}
    }

    // Enqueue duplicate detection job
    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'duplicate-detect', {
        taskId: task!.id,
        title: task!.title,
        projectId,
        orgId: user.org_id,
      });
    } catch (err) {
      console.error('Failed to enqueue duplicate-detect:', err);
    }

    return c.json({
      ...task,
      project_prefix: project.prefix,
      project_name: project.name,
    }, 201);
  } catch (err) {
    console.error('Failed to create task:', err);
    return c.json({ error: 'Failed to create task', code: 'INTERNAL_ERROR' }, 500);
  }
});

// Helper: verify a project belongs to the caller's org. Returns project row
// or null. Keeps each handler short.
async function verifyProjectForOrg(projectId: string, orgId: string) {
  const [row] = await db.select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId)))
    .limit(1);
  return row ?? null;
}

// GET /api/projects/:id/resolved-config — the merged config used by UI
projectRoutes.get('/:id/resolved-config', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const project = await verifyProjectForOrg(projectId, user.org_id);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    const resolved = await getProjectResolvedConfig(projectId);
    return c.json(resolved);
  } catch (err) {
    console.error('Failed to fetch resolved config:', err);
    return c.json({ error: 'Failed to fetch resolved config', code: 'INTERNAL_ERROR' }, 500);
  }
});
