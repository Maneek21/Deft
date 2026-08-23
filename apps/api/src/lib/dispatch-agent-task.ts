/**
 * dispatchAgentEmployeeTask — wake an agent employee on task assignment.
 *
 * Looks up the assignee user; if it's a shadow user backing an agent
 * employee, enqueues an `agent-employee-task` job. The handler at
 * `workers/handlers/agent-employee-task.ts` runs the agent in background
 * mode against the task's title/description and posts results as a task
 * comment + status → in_review.
 *
 * Use from every site that sets `tasks.assignee_id`:
 *   - POST /api/tasks (creation)
 *   - PATCH /api/tasks/:id (re-assign)
 *   - agent tools that mutate assignment (create_task, assign_task)
 *
 * Best-effort: errors are logged, never thrown — a failed enqueue must
 * not roll back the task write.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import { agentEmployees, projects, users } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { publishAgentChannelEvent, type AgentChannelEventKind } from './agent-channel.js';

export type AgentTaskDispatchResult =
  | { queued: true; employeeId: string }
  | { queued: false; reason: 'not_agent' | 'enqueue_failed' };

export async function dispatchAgentEmployeeTask(params: {
  taskId: string;
  orgId: string;
  assigneeUserId: string;
  assignedBy: string;
}): Promise<AgentTaskDispatchResult> {
  const { taskId, orgId, assigneeUserId, assignedBy } = params;
  try {
    const [assigneeUser] = await db
      .select({
        is_agent: users.is_agent,
        agent_employee_id: users.agent_employee_id,
      })
      .from(users)
      .where(eq(users.id, assigneeUserId))
      .limit(1);

    if (assigneeUser?.is_agent && assigneeUser?.agent_employee_id) {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-task', {
        taskId,
        orgId,
        employeeId: assigneeUser.agent_employee_id,
        assignedBy,
      });
      return { queued: true, employeeId: assigneeUser.agent_employee_id };
    }
    return { queued: false, reason: 'not_agent' };
  } catch (err) {
    console.error('[dispatch-agent-task] enqueue failed:', err);
    return { queued: false, reason: 'enqueue_failed' };
  }
}

export type AgentChannelTaskSnapshot = {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_id: string | null;
};

/** Publish follow-up task activity through the same durable channel as REST writes. */
export async function publishTaskChannelEventForAssignee(params: {
  orgId: string;
  task: AgentChannelTaskSnapshot;
  actorUserId: string;
  kind: AgentChannelEventKind;
  idempotencyKey: string;
  projectPrefix?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!params.task.assignee_id || params.task.assignee_id === params.actorUserId) return;

  try {
    const [employee] = await db
      .select({ id: agentEmployees.id, user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, params.orgId),
        eq(agentEmployees.user_id, params.task.assignee_id),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (!employee || employee.user_id === params.actorUserId) return;

    let prefix = params.projectPrefix;
    if (prefix === undefined) {
      const [project] = await db
        .select({ prefix: projects.prefix })
        .from(projects)
        .where(and(eq(projects.id, params.task.project_id), eq(projects.org_id, params.orgId)))
        .limit(1);
      prefix = project?.prefix ?? null;
    }

    await publishAgentChannelEvent({
      orgId: params.orgId,
      employeeId: employee.id,
      kind: params.kind,
      sourceKind: 'task',
      sourceId: params.task.id,
      actorUserId: params.actorUserId,
      idempotencyKey: `${params.kind}:${params.idempotencyKey}:employee:${employee.id}`,
      payload: {
        task_id: params.task.id,
        task_key: prefix ? `${prefix}-${params.task.number}` : null,
        project_id: params.task.project_id,
        title: params.task.title,
        description: params.task.description ?? null,
        status: params.task.status,
        priority: params.task.priority,
        assignee_user_id: params.task.assignee_id,
        ...params.payload,
      },
    });
  } catch (err) {
    console.error(`[dispatch-agent-task] failed to publish ${params.kind} for ${params.task.id}:`, err);
  }
}
