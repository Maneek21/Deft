import { z } from 'zod';
import { taskPriorityEnum } from '@deft/db/schema';

// A task's priority, p0 (urgent) to p3 (low), as the database enum holds it.
// Every path that writes a priority (REST create and update, bulk update, MCP
// task_create / task_update / task_bulk_update, Defty's task tools) checks it
// with this one schema, so an unknown value such as 'urgent' is refused as a
// validation error rather than reaching the enum and failing as a 500.

export const TASK_PRIORITIES = taskPriorityEnum.enumValues;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_MESSAGE = `priority must be one of ${TASK_PRIORITIES.join(', ')}`;

export const taskPrioritySchema = z.enum(TASK_PRIORITIES, { message: TASK_PRIORITY_MESSAGE });

export function isTaskPriority(value: unknown): value is TaskPriority {
  return taskPrioritySchema.safeParse(value).success;
}

/**
 * For a tool argument: null when the priority is absent (undefined or null)
 * or valid, otherwise the message to refuse it with.
 */
export function taskPriorityError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return isTaskPriority(value) ? null : TASK_PRIORITY_MESSAGE;
}
