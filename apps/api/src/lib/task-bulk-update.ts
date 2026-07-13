import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  labels,
  projects,
  taskActivity,
  taskAssignees,
  taskLabels,
  tasks,
} from '@deft/db/schema';
import { db } from './db.js';
import { createNotificationIfAllowed } from './notification-policy.js';
import { getProjectResolvedConfig } from './project-resolved-config.js';
import { resolveAssignableAssigneeId } from './resolve-assignee.js';
import { isValidTransition } from './task-status-machine.js';
import { visibleTaskCondition } from './task-visibility.js';
import { emitToUser, getIO } from '../socket.js';

export const bulkTaskUpdateSchema = z.object({
  task_ids: z.array(z.string().min(1)).min(1).max(50),
  updates: z.object({
    status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']).optional(),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
    assignee_id: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    estimation: z.string().max(100).nullable().optional(),
    add_label_ids: z.array(z.string().uuid()).max(50).optional(),
    remove_label_ids: z.array(z.string().uuid()).max(50).optional(),
  }).refine((updates) => Object.values(updates).some((value) => value !== undefined), {
    message: 'At least one update is required',
  }),
});

export type BulkTaskUpdateInput = z.infer<typeof bulkTaskUpdateSchema>;

export class BulkTaskUpdateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

type BulkTaskActor = {
  orgId: string;
  userId: string;
  agentActionId?: string | null;
  agentEmployeeId?: string | null;
};

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null || value === '') return value === undefined ? undefined : null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function bulkUpdateTasks(input: BulkTaskUpdateInput, actor: BulkTaskActor) {
  const parsed = bulkTaskUpdateSchema.safeParse(input);
  if (!parsed.success) {
    throw new BulkTaskUpdateError(parsed.error.issues[0]?.message ?? 'Invalid bulk update', 'VALIDATION_ERROR');
  }
  const taskIds = [...new Set(parsed.data.task_ids)];
  const updates = parsed.data.updates;
  const targetTasks = await db.select({
    id: tasks.id,
    project_id: tasks.project_id,
    status: tasks.status,
    priority: tasks.priority,
    assignee_id: tasks.assignee_id,
    due_date: tasks.due_date,
    start_date: tasks.start_date,
    estimation: tasks.estimation,
  })
    .from(tasks)
    .innerJoin(projects, eq(tasks.project_id, projects.id))
    .where(and(
      inArray(tasks.id, taskIds),
      eq(tasks.org_id, actor.orgId),
      eq(tasks.is_deleted, false),
      visibleTaskCondition(actor.userId),
    ));
  if (targetTasks.length !== taskIds.length) {
    throw new BulkTaskUpdateError('One or more tasks were not found or are not accessible', 'TASK_NOT_FOUND', 404);
  }

  let nextAssigneeId: string | null | undefined;
  if (updates.assignee_id !== undefined) {
    if (updates.assignee_id === null || updates.assignee_id === '') nextAssigneeId = null;
    else nextAssigneeId = (await resolveAssignableAssigneeId(updates.assignee_id, actor.orgId))?.id;
    if (nextAssigneeId === undefined) {
      throw new BulkTaskUpdateError(
        'Assignee must be an active user or healthy agent in this organization',
        'INVALID_ASSIGNEE',
      );
    }
  }

  const nextDueDate = parseDate(updates.due_date);
  const nextStartDate = parseDate(updates.start_date);
  if ((updates.due_date && nextDueDate === undefined) || (updates.start_date && nextStartDate === undefined)) {
    throw new BulkTaskUpdateError('Dates must be valid ISO dates', 'VALIDATION_ERROR');
  }

  if (updates.status) {
    const configs = new Map<string, Awaited<ReturnType<typeof getProjectResolvedConfig>>>();
    for (const task of targetTasks) {
      if (!configs.has(task.project_id)) configs.set(task.project_id, await getProjectResolvedConfig(task.project_id));
      if (!isValidTransition(task.status, updates.status, configs.get(task.project_id)!)) {
        throw new BulkTaskUpdateError(
          `Cannot move every selected task to ${updates.status}`,
          'INVALID_STATUS_TRANSITION',
        );
      }
    }
  }

  const addLabelIds = [...new Set(updates.add_label_ids ?? [])];
  const removeLabelIds = [...new Set(updates.remove_label_ids ?? [])];
  if (addLabelIds.some((id) => removeLabelIds.includes(id))) {
    throw new BulkTaskUpdateError('A label cannot be added and removed in the same operation', 'VALIDATION_ERROR');
  }
  const requestedLabelIds = [...new Set([...addLabelIds, ...removeLabelIds])];
  if (requestedLabelIds.length) {
    const validLabels = await db.select({ id: labels.id }).from(labels)
      .where(and(eq(labels.org_id, actor.orgId), inArray(labels.id, requestedLabelIds)));
    if (validLabels.length !== requestedLabelIds.length) {
      throw new BulkTaskUpdateError('One or more labels are invalid', 'INVALID_LABEL');
    }
  }
  const currentLabelRows = requestedLabelIds.length
    ? await db.select({ task_id: taskLabels.task_id, label_id: taskLabels.label_id }).from(taskLabels)
      .where(and(inArray(taskLabels.task_id, taskIds), inArray(taskLabels.label_id, requestedLabelIds)))
    : [];
  const currentLabelKeys = new Set(currentLabelRows.map((row) => `${row.task_id}:${row.label_id}`));
  const sameDate = (left: Date | null, right: Date | null | undefined) => right === undefined || left?.getTime() === right?.getTime();
  const activityRows: Array<typeof taskActivity.$inferInsert> = [];
  const changedIds = new Set<string>();
  const canonicalChangedIds = new Set<string>();
  const labelAdds: Array<{ task_id: string; label_id: string }> = [];
  const labelRemoves: Array<{ task_id: string; label_id: string }> = [];

  for (const task of targetTasks) {
    const record = (action: string, field: string, oldValue: string | null, newValue: string | null) => {
      changedIds.add(task.id);
      canonicalChangedIds.add(task.id);
      activityRows.push({
        org_id: actor.orgId,
        task_id: task.id,
        user_id: actor.userId,
        action,
        field,
        old_value: oldValue,
        new_value: newValue,
        agent_action_id: actor.agentActionId ?? null,
        acting_agent_employee_id: actor.agentEmployeeId ?? null,
      });
    };
    if (updates.status !== undefined && updates.status !== task.status) record('status_changed', 'status', task.status, updates.status);
    if (updates.priority !== undefined && updates.priority !== task.priority) record('priority_changed', 'priority', task.priority, updates.priority);
    if (updates.assignee_id !== undefined && nextAssigneeId !== task.assignee_id) record('assigned', 'assignee_id', task.assignee_id, nextAssigneeId ?? null);
    if (updates.due_date !== undefined && !sameDate(task.due_date, nextDueDate)) record('due_date_changed', 'due_date', task.due_date?.toISOString() ?? null, nextDueDate?.toISOString() ?? null);
    if (updates.start_date !== undefined && !sameDate(task.start_date, nextStartDate)) record('start_date_changed', 'start_date', task.start_date?.toISOString() ?? null, nextStartDate?.toISOString() ?? null);
    if (updates.estimation !== undefined && updates.estimation !== task.estimation) record('estimation_changed', 'estimation', task.estimation, updates.estimation);
    for (const labelId of addLabelIds) {
      if (!currentLabelKeys.has(`${task.id}:${labelId}`)) {
        labelAdds.push({ task_id: task.id, label_id: labelId });
        changedIds.add(task.id);
        activityRows.push({ org_id: actor.orgId, task_id: task.id, user_id: actor.userId, action: 'label_added', field: 'labels', new_value: labelId, agent_action_id: actor.agentActionId ?? null, acting_agent_employee_id: actor.agentEmployeeId ?? null });
      }
    }
    for (const labelId of removeLabelIds) {
      if (currentLabelKeys.has(`${task.id}:${labelId}`)) {
        labelRemoves.push({ task_id: task.id, label_id: labelId });
        changedIds.add(task.id);
        activityRows.push({ org_id: actor.orgId, task_id: task.id, user_id: actor.userId, action: 'label_removed', field: 'labels', old_value: labelId, agent_action_id: actor.agentActionId ?? null, acting_agent_employee_id: actor.agentEmployeeId ?? null });
      }
    }
  }

  const updatedIds = [...changedIds];
  if (!updatedIds.length) return { success: true, requested: taskIds.length, updated: 0, updated_ids: [], fields: [] };

  const updateData: Partial<typeof tasks.$inferInsert> = { updated_at: new Date() };
  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.priority !== undefined) updateData.priority = updates.priority;
  if (updates.assignee_id !== undefined) updateData.assignee_id = nextAssigneeId ?? null;
  if (updates.due_date !== undefined) updateData.due_date = nextDueDate ?? null;
  if (updates.start_date !== undefined) updateData.start_date = nextStartDate ?? null;
  if (updates.estimation !== undefined) updateData.estimation = updates.estimation;

  await db.transaction(async (tx) => {
    if (canonicalChangedIds.size) await tx.update(tasks).set(updateData).where(inArray(tasks.id, [...canonicalChangedIds]));
    else await tx.update(tasks).set({ updated_at: new Date() }).where(inArray(tasks.id, updatedIds));
    if (labelAdds.length) await tx.insert(taskLabels).values(labelAdds).onConflictDoNothing();
    for (const row of labelRemoves) {
      await tx.delete(taskLabels).where(and(eq(taskLabels.task_id, row.task_id), eq(taskLabels.label_id, row.label_id)));
    }
    if (updates.assignee_id !== undefined && nextAssigneeId) {
      await tx.delete(taskAssignees).where(and(inArray(taskAssignees.task_id, updatedIds), eq(taskAssignees.user_id, nextAssigneeId)));
    }
    if (activityRows.length) await tx.insert(taskActivity).values(activityRows);
  });

  const assignedIds = targetTasks
    .filter((task) => updates.assignee_id !== undefined && task.assignee_id !== nextAssigneeId)
    .map((task) => task.id);
  if (nextAssigneeId && nextAssigneeId !== actor.userId && assignedIds.length >= 3) {
    try {
      const notification = await createNotificationIfAllowed({
        org_id: actor.orgId,
        user_id: nextAssigneeId,
        type: 'task_assigned',
        title: `You were assigned ${assignedIds.length} tasks`,
        body: null,
        link: '/tasks?mine=1',
        metadata: { task_ids: assignedIds, grouped: true, kind: 'bulk_assign' },
      }, { channel: 'tasks' });
      if (notification) emitToUser(nextAssigneeId, 'notification:new', notification);
    } catch (err) {
      console.error('Failed to write grouped bulk-assign notification:', err);
    }
  }

  getIO()?.to(`org:${actor.orgId}`).emit('task:bulk_updated', { task_ids: updatedIds, changes: updateData });
  return {
    success: true,
    requested: taskIds.length,
    updated: updatedIds.length,
    updated_ids: updatedIds,
    fields: [...new Set(activityRows.map((row) => row.field).filter(Boolean))],
  };
}
