/**
 * Task 4.11 — Task template bulk-apply endpoint.
 *
 * POST /api/projects/:id/apply-template
 * Body: { template_id: string }
 *
 * Resolves the project's merged skill config, finds the named template,
 * then creates every task in a single transaction. Relative due-dates of
 * the form "+Nd" are parsed against the apply date. The project's
 * task_counter is incremented atomically inside the txn so concurrent
 * applies never collide on (project_id, number).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { projects, tasks, taskActivity } from '@deft/db/schema';
import { getProjectResolvedConfig } from '../lib/project-resolved-config.js';
import { getIO } from '../socket.js';

export const taskTemplateRoutes = new Hono();

const applyTemplateSchema = z.object({
  template_id: z.string().min(1),
});

/**
 * Parse a template task's due_date field. Accepts:
 *   - `"+Nd"` → apply-date + N days
 *   - ISO date string → that date
 *   - undefined / null / empty → no due date
 */
export function resolveTemplateDueDate(
  raw: string | undefined | null,
  applyDate: Date,
): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const relative = trimmed.match(/^\+(\d+)d$/i);
  if (relative) {
    const days = parseInt(relative[1]!, 10);
    if (Number.isNaN(days)) return null;
    const d = new Date(applyDate);
    d.setDate(d.getDate() + days);
    return d;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

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

    // Verify org ownership.
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.org_id, user.org_id)))
      .limit(1);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    // Resolve the template from the merged skill config.
    const resolved = await getProjectResolvedConfig(projectId);
    const template = (resolved.task_templates ?? []).find(
      (t) => t.id === parsed.data.template_id,
    );
    if (!template) {
      return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }
    if (!Array.isArray(template.tasks) || template.tasks.length === 0) {
      return c.json({ error: 'Template has no tasks', code: 'VALIDATION_ERROR' }, 400);
    }

    const applyDate = new Date();
    const createdTasks = await db.transaction(async (tx) => {
      // Atomically bump the project's task_counter by the full template size
      // so every row lands on a distinct, monotonically-increasing number.
      const [updated] = await tx
        .update(projects)
        .set({
          task_counter: (project.task_counter as number) + template.tasks.length,
        })
        .where(eq(projects.id, projectId))
        .returning({ task_counter: projects.task_counter });

      const finalCounter = updated!.task_counter as number;
      const firstNumber = finalCounter - template.tasks.length + 1;

      const rowsToInsert = template.tasks.map((t, idx) => ({
        org_id: user.org_id,
        project_id: projectId,
        number: firstNumber + idx,
        title: t.title,
        status: (t.status || 'backlog') as any,
        priority: 'p2' as any,
        created_by: user.id,
        due_date: resolveTemplateDueDate(t.due_date, applyDate) ?? undefined,
        sort_order: (idx + 1) * 1000,
      }));

      const inserted = await tx.insert(tasks).values(rowsToInsert).returning();

      // One activity row per created task so the UI's activity feed shows
      // which template spawned the task.
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

      return inserted;
    });

    // Broadcast each created task so board/list views refresh live.
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
