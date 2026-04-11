import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, asc, sql, inArray, ilike, or, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { projects, tasks, taskComments, taskActivity, taskLabels, labels, users, projectSpaces, messages, notifications, taskRelationships, files } from '@deft/db/schema';
import { getIO, emitToUser } from '../socket.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';

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
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']).optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  assignee_id: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  sort_order: z.number().optional(),
  project_id: z.string().optional(),
  parent_task_id: z.string().nullable().optional(),
});

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

// Helper: verify task exists and belongs to user's org, returns task or null
async function getTaskForOrg(taskId: string, orgId: string) {
  const [task] = await db.select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.org_id, orgId),
      )
    )
    .limit(1);
  return task ?? null;
}

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
      sort_order: tasks.sort_order,
      project_id: tasks.project_id,
      source_message_id: tasks.source_message_id,
      parent_task_id: tasks.parent_task_id,
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
taskRoutes.patch('/bulk', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const { task_ids, updates } = body;

    if (!task_ids || !Array.isArray(task_ids) || task_ids.length === 0) {
      return c.json({ error: 'task_ids required', code: 'VALIDATION_ERROR' }, 400);
    }
    if (task_ids.length > 50) {
      return c.json({ error: 'Max 50 tasks per bulk operation', code: 'VALIDATION_ERROR' }, 400);
    }
    if (!updates || typeof updates !== 'object') {
      return c.json({ error: 'updates required', code: 'VALIDATION_ERROR' }, 400);
    }

    const updateData: Record<string, any> = { updated_at: new Date() };
    if (updates.status) updateData.status = updates.status;
    if (updates.assignee_id !== undefined) updateData.assignee_id = updates.assignee_id || null;
    if (updates.priority) updateData.priority = updates.priority;

    await db.update(tasks)
      .set(updateData)
      .where(
        and(
          inArray(tasks.id, task_ids),
          eq(tasks.org_id, user.org_id),
        ),
      );

    for (const taskId of task_ids) {
      if (updates.status) {
        await db.insert(taskActivity).values({
          task_id: taskId,
          user_id: user.id,
          action: 'status_changed',
          field: 'status',
          new_value: updates.status,
        });
      }
      if (updates.assignee_id !== undefined) {
        await db.insert(taskActivity).values({
          task_id: taskId,
          user_id: user.id,
          action: 'assigned',
          field: 'assignee_id',
          new_value: updates.assignee_id || null,
        });
      }
      if (updates.priority) {
        await db.insert(taskActivity).values({
          task_id: taskId,
          user_id: user.id,
          action: 'priority_changed',
          field: 'priority',
          new_value: updates.priority,
        });
      }
    }

    const io = getIO();
    if (io) {
      for (const taskId of task_ids) {
        io.to(`org:${user.org_id}`).emit('task:updated', { id: taskId, ...updateData });
      }
    }

    return c.json({ success: true, updated: task_ids.length });
  } catch (err) {
    console.error('Failed to bulk update tasks:', err);
    return c.json({ error: 'Failed to bulk update tasks', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/tasks/bulk-delete — soft delete multiple tasks
taskRoutes.post('/bulk-delete', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const { task_ids } = body;

    if (!task_ids || !Array.isArray(task_ids) || task_ids.length === 0) {
      return c.json({ error: 'task_ids required', code: 'VALIDATION_ERROR' }, 400);
    }
    if (task_ids.length > 50) {
      return c.json({ error: 'Max 50 tasks per bulk operation', code: 'VALIDATION_ERROR' }, 400);
    }

    await db.update(tasks)
      .set({ is_deleted: true, updated_at: new Date() })
      .where(
        and(
          inArray(tasks.id, task_ids),
          eq(tasks.org_id, user.org_id),
        ),
      );

    for (const taskId of task_ids) {
      await db.insert(taskActivity).values({
        task_id: taskId,
        user_id: user.id,
        action: 'deleted',
      });
    }

    const io = getIO();
    if (io) {
      for (const taskId of task_ids) {
        io.to(`org:${user.org_id}`).emit('task:deleted', { id: taskId });
      }
    }

    return c.json({ success: true, deleted: task_ids.length });
  } catch (err) {
    console.error('Failed to bulk delete tasks:', err);
    return c.json({ error: 'Failed to bulk delete tasks', code: 'INTERNAL_ERROR' }, 500);
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
      sort_order: tasks.sort_order,
      project_id: tasks.project_id,
      source_message_id: tasks.source_message_id,
      parent_task_id: tasks.parent_task_id,
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
        )
      )
      .limit(1);

    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

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
        user_id: messages.user_id,
        created_at: messages.created_at,
      })
        .from(messages)
        .where(eq(messages.id, task.source_message_id))
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
      assignee,
      creator: creator ?? null,
      labels: labelsMap.get(task.id) ?? [],
      source_message: sourceMessage,
      subtasks,
      parent_task: parentTask,
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

    const task = await getTaskForOrg(taskId, user.org_id);
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

    const task = await getTaskForOrg(taskId, user.org_id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const [comment] = await db.insert(taskComments).values({
      task_id: taskId,
      user_id: user.id,
      content: parsed.data.content,
    }).returning();

    // Create activity log entry
    await db.insert(taskActivity).values({
      task_id: taskId,
      user_id: user.id,
      action: 'commented',
    });

    // Get user info for response
    const [userData] = await db.select({
      name: users.name,
      avatar_url: users.avatar_url,
    }).from(users).where(eq(users.id, user.id)).limit(1);

    // Notify task assignee about the comment (if not the commenter)
    try {
      const [commentedTask] = await db.select({ assignee_id: tasks.assignee_id, number: tasks.number, title: tasks.title, project_id: tasks.project_id })
        .from(tasks).where(eq(tasks.id, taskId)).limit(1);

      if (commentedTask?.assignee_id && commentedTask.assignee_id !== user.id) {
        const [proj] = await db.select({ prefix: projects.prefix }).from(projects).where(eq(projects.id, commentedTask.project_id)).limit(1);
        const taskId_str = `${proj?.prefix || ''}-${commentedTask.number}`;

        await db.insert(notifications).values({
          org_id: user.org_id,
          user_id: commentedTask.assignee_id,
          type: 'task_updated',
          title: `${userData?.name || 'Someone'} commented on ${taskId_str}`,
          body: parsed.data.content.slice(0, 200),
          link: `/tasks?task=${taskId_str}`,
        });
        emitToUser(commentedTask.assignee_id, 'notification:new', { type: 'task_updated', title: `Comment on ${taskId_str}` });
      }
    } catch (err) {
      console.error('Comment notification error:', err);
    }

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

    const task = await getTaskForOrg(taskId, user.org_id);
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

    const task = await getTaskForOrg(taskId, user.org_id);
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

    const task = await getTaskForOrg(taskId, user.org_id);
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

// POST /api/projects/:projectId/tasks — create task
taskRoutes.post('/project/:projectId', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('projectId');
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

    // Enqueue duplicate detection job (skip for subtasks)
    if (!parsed.data.parent_task_id) {
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

    const existingTask = await getTaskForOrg(taskId, user.org_id);
    if (!existingTask) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
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
      updateData.status = parsed.data.status;
      activityEntries.push({ action: 'status_changed', field: 'status', old_value: existingTask.status, new_value: parsed.data.status });
    }

    if (parsed.data.priority !== undefined && parsed.data.priority !== existingTask.priority) {
      updateData.priority = parsed.data.priority;
      activityEntries.push({ action: 'priority_changed', field: 'priority', old_value: existingTask.priority, new_value: parsed.data.priority });
    }

    if (parsed.data.assignee_id !== undefined) {
      const newAssignee = parsed.data.assignee_id || null; // Convert empty string to null
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

    if (parsed.data.project_id !== undefined && parsed.data.project_id !== existingTask.project_id) {
      // Verify new project belongs to same org
      const [newProject] = await db.select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, parsed.data.project_id),
            eq(projects.org_id, user.org_id),
          )
        )
        .limit(1);

      if (!newProject) {
        return c.json({ error: 'Target project not found', code: 'NOT_FOUND' }, 404);
      }

      updateData.project_id = parsed.data.project_id;
      activityEntries.push({ action: 'moved', field: 'project_id', old_value: existingTask.project_id, new_value: parsed.data.project_id });
    }

    if (Object.keys(updateData).length === 0) {
      return c.json({ error: 'No fields to update', code: 'VALIDATION_ERROR' }, 400);
    }

    const [updatedTask] = await db.update(tasks)
      .set(updateData)
      .where(eq(tasks.id, taskId))
      .returning();

    // Create activity log entries for each changed field
    if (activityEntries.length > 0) {
      await db.insert(taskActivity).values(
        activityEntries.map((entry) => ({
          task_id: taskId,
          user_id: user.id,
          action: entry.action,
          field: entry.field,
          old_value: entry.old_value,
          new_value: entry.new_value,
        }))
      );
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
          await db.insert(notifications).values({
            org_id: user.org_id,
            user_id: newAssignee,
            type: 'task_assigned',
            title: `${assignerUser?.name || 'Someone'} assigned you ${taskId_str}`,
            body: updatedTask!.title,
            link: `/tasks?task=${taskId_str}`,
          });
          emitToUser(newAssignee, 'notification:new', { type: 'task_assigned', title: `Assigned ${taskId_str}` });
        } catch {}
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
          await db.insert(notifications).values({
            org_id: user.org_id,
            user_id: assignee,
            type: 'task_updated',
            title: `${changerUser?.name || 'Someone'} moved ${taskId_str} to ${statusLabel}`,
            body: updatedTask!.title,
            link: `/tasks?task=${taskId_str}`,
          });
          emitToUser(assignee, 'notification:new', { type: 'task_updated', title: `${taskId_str} → ${statusLabel}` });
        } catch {}
      }
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

    const existingTask = await getTaskForOrg(taskId, user.org_id);
    if (!existingTask) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(tasks)
      .set({ is_deleted: true })
      .where(eq(tasks.id, taskId));

    // Create activity log entry
    await db.insert(taskActivity).values({
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

    const original = await getTaskForOrg(taskId, user.org_id);
    if (!original) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    // Increment task counter
    const [updated] = await db.update(projects)
      .set({ task_counter: sql`${projects.task_counter} + 1` })
      .where(eq(projects.id, original.project_id))
      .returning({ task_counter: projects.task_counter });

    const [project] = await db.select({ prefix: projects.prefix, name: projects.name })
      .from(projects).where(eq(projects.id, original.project_id)).limit(1);

    const [dup] = await db.insert(tasks).values({
      org_id: user.org_id,
      project_id: original.project_id,
      number: updated!.task_counter,
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

    await db.insert(taskActivity).values({ task_id: dup!.id, user_id: user.id, action: 'created' });

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

    const task = await getTaskForOrg(taskId, user.org_id);
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

    const task = await getTaskForOrg(taskId, user.org_id);
    if (!task) {
      return c.json({ error: 'Task not found', code: 'NOT_FOUND' }, 404);
    }

    const targetTask = await getTaskForOrg(parsed.data.target_task_id, user.org_id);
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

    const [rel] = await db.insert(taskRelationships).values({
      source_task_id,
      target_task_id,
      type,
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

    const task = await getTaskForOrg(taskId, user.org_id);
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
