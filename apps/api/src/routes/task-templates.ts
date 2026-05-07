/**
 * Task 4.11 — Task template bulk-apply endpoint.
 *
 * POST /api/projects/:id/apply-template
 * Body: { template_id: string }
 *
 * Reads the template directly from the task_templates table (org-scoped),
 * then creates every task in a single transaction. Template tasks use
 * due_offset_days (plain number) to compute due dates from apply time.
 * The project's task_counter is incremented atomically inside the txn so
 * concurrent applies never collide on (project_id, number).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, or, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { projects, tasks, taskActivity, taskTemplates } from '@deft/db/schema';
import { getIO } from '../socket.js';

export const taskTemplateRoutes = new Hono();

const applyTemplateSchema = z.object({
  template_id: z.string().min(1),
});

// GET /api/task-templates — list bundled + org templates for this tenant.
taskTemplateRoutes.get('/', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const rows = await db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.is_deleted, false),
          or(
            isNull(taskTemplates.org_id),                  // bundled + marketplace
            eq(taskTemplates.org_id, user.org_id),         // tenant-scoped
          ),
        ),
      );
    return c.json({ templates: rows });
  } catch (err) {
    console.error('Failed to list task templates:', err);
    return c.json({ error: 'Failed to list templates', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/task-templates/:id — fetch one, org-scoped.
taskTemplateRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const id = c.req.param('id');
    const [row] = await db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.id, id),
          eq(taskTemplates.is_deleted, false),
          or(
            isNull(taskTemplates.org_id),
            eq(taskTemplates.org_id, user.org_id),
          ),
        ),
      )
      .limit(1);
    if (!row) {
      return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ template: row });
  } catch (err) {
    console.error('Failed to get task template:', err);
    return c.json({ error: 'Failed to get template', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/projects/:id/apply-template
taskTemplateRoutes.post('/:id/apply-template', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = applyTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.org_id, user.org_id)))
      .limit(1);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    // Fetch template from task_templates table (org-scoped).
    const [template] = await db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.id, parsed.data.template_id),
          eq(taskTemplates.is_deleted, false),
          or(
            isNull(taskTemplates.org_id),
            eq(taskTemplates.org_id, user.org_id),
          ),
        ),
      )
      .limit(1);
    if (!template) {
      return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }
    const tasksPayload = template.tasks as Array<{
      title: string;
      status?: string;
      priority?: string;
      due_offset_days?: number;
      description?: string;
      labels?: string[];
    }>;
    if (!Array.isArray(tasksPayload) || tasksPayload.length === 0) {
      return c.json({ error: 'Template has no tasks', code: 'VALIDATION_ERROR' }, 400);
    }

    const applyDate = new Date();
    const createdTasks = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(projects)
        .set({ task_counter: (project.task_counter as number) + tasksPayload.length })
        .where(eq(projects.id, projectId))
        .returning({ task_counter: projects.task_counter });

      const finalCounter = updated!.task_counter as number;
      const firstNumber = finalCounter - tasksPayload.length + 1;

      const rowsToInsert = tasksPayload.map((t, idx) => {
        let dueDate: Date | undefined = undefined;
        if (typeof t.due_offset_days === 'number') {
          const d = new Date(applyDate);
          d.setDate(d.getDate() + t.due_offset_days);
          dueDate = d;
        }
        return {
          org_id: user.org_id,
          project_id: projectId,
          number: firstNumber + idx,
          title: t.title,
          description: t.description,
          status: (t.status || 'backlog') as any,
          priority: (t.priority || 'p2') as any,
          created_by: user.id,
          due_date: dueDate,
          sort_order: (idx + 1) * 1000,
        };
      });

      const inserted = await tx.insert(tasks).values(rowsToInsert).returning();

      if (inserted.length > 0) {
        await tx.insert(taskActivity).values(
          inserted.map((row) => ({
            org_id: user.org_id,
            task_id: row.id,
            user_id: user.id,
            action: 'created',
            field: 'template',
            old_value: null,
            new_value: template.id,
          })),
        );
      }

      await tx
        .update(taskTemplates)
        .set({ usage_count: (template.usage_count as number) + 1 })
        .where(eq(taskTemplates.id, template.id));

      return inserted;
    });

    const io = getIO();
    if (io) {
      for (const task of createdTasks) {
        io.to(`org:${user.org_id}`).emit('task:created', {
          ...task,
          project_prefix: project.prefix,
          project_name: project.name,
        });
      }
    }

    return c.json(
      {
        template_id: template.id,
        count: createdTasks.length,
        tasks: createdTasks.map((t) => ({
          id: t.id,
          number: t.number,
          title: t.title,
          status: t.status,
          due_date: t.due_date,
        })),
      },
      201,
    );
  } catch (err) {
    console.error('Failed to apply template:', err);
    return c.json({ error: 'Failed to apply template', code: 'INTERNAL_ERROR' }, 500);
  }
});
