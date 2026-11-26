import { z } from 'zod';
import { taskPriorityEnum, taskStatusEnum } from '@deft/db/schema';

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

// A task's status, backlog to cancelled, as the database enum holds it. A
// task create route and Defty's update_task_status check it with this schema,
// so an unknown value such as 'open' is refused rather than failing as a 500.
// (PATCH answers an unknown status through its transition check, and bulk
// update and the MCP tools check it with this schema too.)

export const TASK_STATUSES = taskStatusEnum.enumValues;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_MESSAGE = `status must be one of ${TASK_STATUSES.join(', ')}`;

export const taskStatusSchema = z.enum(TASK_STATUSES, { message: TASK_STATUS_MESSAGE });

export function isTaskStatus(value: unknown): value is TaskStatus {
  return taskStatusSchema.safeParse(value).success;
}
