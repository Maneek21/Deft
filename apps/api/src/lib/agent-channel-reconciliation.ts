import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  actionReceipts,
  agentActions,
  agentChannelDeliveryAttempts,
  agentChannelEvents,
  agentEmployees,
  messages,
  moduleMutationReceipts,
  taskActivity,
  taskComments,
  tasks,
} from '@deft/db/schema';
import { db } from './db.js';

type ChannelEvent = typeof agentChannelEvents.$inferSelect;

export type RuntimeReconciliation = {
  runtime_request_key: string;
  attempt_started_at: string;
  has_durable_effects: boolean;
  effects: {
    task_state: null | {
      task_id: string;
      status: string;
      updated_at: string;
      employee_activity_count: number;
    };
    task_comments: { count: number; ids: string[] };
    task_activity: { count: number; ids: string[] };
    messages: { count: number; ids: string[] };
    agent_actions: { count: number; ids: string[] };
    module_mutations: { count: number; ids: string[] };
    action_receipts: { count: number; ids: string[] };
  };
};

export async function reconcileAgentChannelRuntimeAttempt(params: {
  event: ChannelEvent;
  orgId: string;
  employeeId: string;
  runtimeRequestKey: string;
}): Promise<RuntimeReconciliation | null> {
  const [attempt] = await db.select()
    .from(agentChannelDeliveryAttempts)
    .where(and(
      eq(agentChannelDeliveryAttempts.org_id, params.orgId),
      eq(agentChannelDeliveryAttempts.agent_employee_id, params.employeeId),
      eq(agentChannelDeliveryAttempts.event_id, params.event.id),
      eq(agentChannelDeliveryAttempts.direction, 'outbound_runtime'),
      eq(agentChannelDeliveryAttempts.idempotency_key, params.runtimeRequestKey),
    ))
    .limit(1);
  if (!attempt) return null;

  const [employee] = await db.select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.id, params.employeeId),
      eq(agentEmployees.org_id, params.orgId),
    ))
    .limit(1);
  if (!employee) return null;

  const since = attempt.created_at;
  const taskId = params.event.source_kind === 'task' ? params.event.source_id : null;
  const [taskState] = taskId
    ? await db.select({ id: tasks.id, status: tasks.status, updated_at: tasks.updated_at })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.org_id, params.orgId)))
      .limit(1)
    : [];
  const taskActivityRows = taskId
    ? await db.select({ id: taskActivity.id })
      .from(taskActivity)
      .where(and(
        eq(taskActivity.org_id, params.orgId),
        eq(taskActivity.task_id, taskId),
        eq(taskActivity.acting_agent_employee_id, params.employeeId),
        gte(taskActivity.created_at, since),
      ))
      .orderBy(desc(taskActivity.created_at))
      .limit(50)
    : [];
  const taskCommentRows = taskId
    ? await db.select({ id: taskComments.id })
      .from(taskComments)
      .where(and(
        eq(taskComments.org_id, params.orgId),
        eq(taskComments.task_id, taskId),
        eq(taskComments.user_id, employee.user_id),
        eq(taskComments.is_deleted, false),
        gte(taskComments.created_at, since),
      ))
      .orderBy(desc(taskComments.created_at))
      .limit(50)
    : [];
  const messageRows = params.event.space_id
    ? await db.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.org_id, params.orgId),
        eq(messages.space_id, params.event.space_id),
        eq(messages.user_id, employee.user_id),
        gte(messages.created_at, since),
      ))
      .orderBy(desc(messages.created_at))
      .limit(50)
    : [];
  const actionRows = await db.select({ id: agentActions.id })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, params.orgId),
      eq(agentActions.agent_employee_id, params.employeeId),
      eq(agentActions.channel_event_id, params.event.id),
      eq(agentActions.runtime_request_key, params.runtimeRequestKey),
      gte(agentActions.created_at, since),
    ))
    .orderBy(desc(agentActions.created_at))
    .limit(50);
  const actionIds = actionRows.map((row) => row.id);
  const moduleMutationRows = actionIds.length > 0
    ? await db.select({ id: moduleMutationReceipts.id })
      .from(moduleMutationReceipts)
      .where(and(
        eq(moduleMutationReceipts.org_id, params.orgId),
        eq(moduleMutationReceipts.actor_type, 'agent_employee'),
        eq(moduleMutationReceipts.actor_id, params.employeeId),
        inArray(moduleMutationReceipts.agent_action_id, actionIds),
        gte(moduleMutationReceipts.created_at, since),
      ))
      .orderBy(desc(moduleMutationReceipts.created_at))
      .limit(50)
    : [];
  const receiptRows = actionIds.length > 0
    ? await db.select({ id: actionReceipts.id })
      .from(actionReceipts)
      .where(and(
        eq(actionReceipts.org_id, params.orgId),
        eq(actionReceipts.employee_id, params.employeeId),
        inArray(actionReceipts.action_id, actionIds),
        gte(actionReceipts.created_at, since),
      ))
      .orderBy(desc(actionReceipts.created_at))
      .limit(50)
    : [];

  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
  const durableCount = taskActivityRows.length
    + taskCommentRows.length
    + actionRows.length
    + moduleMutationRows.length
    + receiptRows.length;
  return {
    runtime_request_key: params.runtimeRequestKey,
    attempt_started_at: since.toISOString(),
    has_durable_effects: durableCount > 0,
    effects: {
      task_state: taskState
        ? {
            task_id: taskState.id,
            status: taskState.status,
            updated_at: taskState.updated_at.toISOString(),
            employee_activity_count: taskActivityRows.length,
          }
        : null,
      task_comments: { count: taskCommentRows.length, ids: ids(taskCommentRows) },
      task_activity: { count: taskActivityRows.length, ids: ids(taskActivityRows) },
      messages: { count: messageRows.length, ids: ids(messageRows) },
      agent_actions: { count: actionRows.length, ids: ids(actionRows) },
      module_mutations: { count: moduleMutationRows.length, ids: ids(moduleMutationRows) },
      action_receipts: { count: receiptRows.length, ids: ids(receiptRows) },
    },
  };
}
