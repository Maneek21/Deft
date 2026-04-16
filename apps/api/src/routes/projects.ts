import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, asc, sql, inArray, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { projects, tasks, taskLabels, labels, users, taskActivity, notifications, projectSkills, skills } from '@deft/db/schema';
import { getIO, emitToUser } from '../socket.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import {
  getProjectResolvedConfig,
  invalidateProjectResolvedConfig,
} from '../lib/project-resolved-config.js';

export const projectRoutes = new Hono();

// GET /api/projects — list all projects for current org
projectRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');

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
      .where(
        and(
          eq(projects.org_id, user.org_id),
          eq(projects.is_archived, false),
        )
      );

    return c.json(result);
  } catch (err) {
    console.error('Failed to fetch projects:', err);
    return c.json({ error: 'Failed to fetch projects', code: 'INTERNAL_ERROR' }, 500);
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

// ═══ PROJECT SKILL ATTACHMENT ROUTES (Task 4.5) ═══

// Helper: verify a project belongs to the caller's org. Returns project row
// or null. Keeps each handler short.
async function verifyProjectForOrg(projectId: string, orgId: string) {
  const [row] = await db.select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId)))
    .limit(1);
  return row ?? null;
}

// GET /api/projects/:id/skills — list attached skills in attachment_order
projectRoutes.get('/:id/skills', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const project = await verifyProjectForOrg(projectId, user.org_id);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    const rows = await db.select({
      skill_id: projectSkills.skill_id,
      attachment_order: projectSkills.attachment_order,
      attached_at: projectSkills.attached_at,
      skill_name: skills.name,
      skill_slug: skills.slug,
      skill_description: skills.description,
      skill_icon: skills.icon,
      skill_source: skills.source,
      skill_version: skills.version,
      skill_project_config: skills.project_config,
    })
      .from(projectSkills)
      .innerJoin(skills, eq(projectSkills.skill_id, skills.id))
      .where(eq(projectSkills.project_id, projectId))
      .orderBy(asc(projectSkills.attachment_order));

    const resolved = await getProjectResolvedConfig(projectId);

    const attached_skills = rows.map((r) => ({
      skill_id: r.skill_id,
      attachment_order: r.attachment_order,
      attached_at: r.attached_at,
      name: r.skill_name,
      slug: r.skill_slug,
      description: r.skill_description,
      icon: r.skill_icon,
      source: r.skill_source,
      version: r.skill_version,
      project_config: r.skill_project_config,
    }));

    return c.json({ attached_skills, resolved_config: resolved });
  } catch (err) {
    console.error('Failed to list project skills:', err);
    return c.json({ error: 'Failed to list skills', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/projects/:id/skills — attach a skill (appends to end of order)
const attachSkillSchema = z.object({
  skill_id: z.string().min(1),
});

projectRoutes.post('/:id/skills', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = attachSkillSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const project = await verifyProjectForOrg(projectId, user.org_id);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    // Resolve skill: must be bundled/marketplace (org_id NULL) OR belong to
    // this org. Prevents cross-tenant attachment.
    const [skill] = await db.select({
      id: skills.id,
      org_id: skills.org_id,
      source: skills.source,
    })
      .from(skills)
      .where(eq(skills.id, parsed.data.skill_id))
      .limit(1);

    if (!skill) {
      return c.json({ error: 'Skill not found', code: 'SKILL_NOT_FOUND' }, 404);
    }
    if (skill.org_id !== null && skill.org_id !== user.org_id) {
      return c.json({ error: 'Skill not accessible', code: 'FORBIDDEN' }, 403);
    }

    // Already attached? Return 409.
    const existing = await db.select({ skill_id: projectSkills.skill_id })
      .from(projectSkills)
      .where(and(
        eq(projectSkills.project_id, projectId),
        eq(projectSkills.skill_id, skill.id),
      ))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: 'Skill already attached', code: 'ALREADY_ATTACHED' }, 409);
    }

    // Compute next attachment_order = max + 1 (or 0 if empty).
    const [maxRow] = await db.select({
      max_order: sql<number | null>`max(${projectSkills.attachment_order})`,
    })
      .from(projectSkills)
      .where(eq(projectSkills.project_id, projectId));

    const nextOrder = maxRow?.max_order == null ? 0 : Number(maxRow.max_order) + 1;

    await db.insert(projectSkills).values({
      project_id: projectId,
      skill_id: skill.id,
      attachment_order: nextOrder,
    });

    invalidateProjectResolvedConfig(projectId);

    return c.json({
      project_id: projectId,
      skill_id: skill.id,
      attachment_order: nextOrder,
    }, 201);
  } catch (err) {
    console.error('Failed to attach skill:', err);
    return c.json({ error: 'Failed to attach skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/projects/:id/skills/:skill_id — detach + renumber remainder
projectRoutes.delete('/:id/skills/:skill_id', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const skillId = c.req.param('skill_id');

    const project = await verifyProjectForOrg(projectId, user.org_id);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    const deleted = await db.delete(projectSkills)
      .where(and(
        eq(projectSkills.project_id, projectId),
        eq(projectSkills.skill_id, skillId),
      ))
      .returning({ skill_id: projectSkills.skill_id });

    if (deleted.length === 0) {
      return c.json({ error: 'Skill not attached', code: 'NOT_FOUND' }, 404);
    }

    // Renumber remaining rows to be contiguous 0..n-1, preserving order.
    const remaining = await db.select({ skill_id: projectSkills.skill_id })
      .from(projectSkills)
      .where(eq(projectSkills.project_id, projectId))
      .orderBy(asc(projectSkills.attachment_order));

    for (let i = 0; i < remaining.length; i++) {
      await db.update(projectSkills)
        .set({ attachment_order: i })
        .where(and(
          eq(projectSkills.project_id, projectId),
          eq(projectSkills.skill_id, remaining[i]!.skill_id),
        ));
    }

    invalidateProjectResolvedConfig(projectId);

    return c.json({ ok: true });
  } catch (err) {
    console.error('Failed to detach skill:', err);
    return c.json({ error: 'Failed to detach skill', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/projects/:id/skills/reorder — replace the full ordering
const reorderSkillsSchema = z.object({
  // Ordered list of skill_ids. Must equal the current attached set.
  attachment_order: z.array(z.string().min(1)),
});

projectRoutes.patch('/:id/skills/reorder', async (c) => {
  try {
    const user = c.get('user');
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = reorderSkillsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const project = await verifyProjectForOrg(projectId, user.org_id);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    const current = await db.select({ skill_id: projectSkills.skill_id })
      .from(projectSkills)
      .where(eq(projectSkills.project_id, projectId));

    const currentSet = new Set(current.map((r) => r.skill_id));
    const desired = parsed.data.attachment_order;
    const desiredSet = new Set(desired);

    if (
      desired.length !== current.length ||
      desiredSet.size !== desired.length ||
      [...currentSet].some((s) => !desiredSet.has(s))
    ) {
      return c.json({
        error: 'attachment_order must match currently attached skill set exactly (no duplicates, no missing, no extras)',
        code: 'INVALID_REORDER',
      }, 400);
    }

    for (let i = 0; i < desired.length; i++) {
      await db.update(projectSkills)
        .set({ attachment_order: i })
        .where(and(
          eq(projectSkills.project_id, projectId),
          eq(projectSkills.skill_id, desired[i]!),
        ));
    }

    invalidateProjectResolvedConfig(projectId);

    return c.json({ ok: true });
  } catch (err) {
    console.error('Failed to reorder skills:', err);
    return c.json({ error: 'Failed to reorder skills', code: 'INTERNAL_ERROR' }, 500);
  }
});

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
