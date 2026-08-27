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
import { agentEmployees, projects, tasks, users } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { publishAgentChannelEvent, type AgentChannelEventKind } from './agent-channel.js';
import { employeeCanAccessProject } from './mcp-tools/employee-project-access.js';

export type AgentTaskDispatchResult =
  | { queued: true; employeeId: string }
  | { queued: false; reason: 'not_agent' | 'project_not_allowed' | 'enqueue_failed' };

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
      const [task] = await db
        .select({ project_id: tasks.project_id })
        .from(tasks)
        .innerJoin(projects, and(
          eq(projects.id, tasks.project_id),
          eq(projects.org_id, tasks.org_id),
        ))
        .where(and(
          eq(tasks.id, taskId),
          eq(tasks.org_id, orgId),
          eq(tasks.is_deleted, false),
          eq(projects.is_deleted, false),
        ))
        .limit(1);
      if (!task || !(await employeeCanAccessProject({
        org_id: orgId,
        employee_id: assigneeUser.agent_employee_id,
      }, task.project_id))) {
        return { queued: false, reason: 'project_not_allowed' };
      }
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
    const [activeTask] = await db
      .select({ project_prefix: projects.prefix })
      .from(tasks)
      .innerJoin(projects, and(
        eq(projects.id, tasks.project_id),
        eq(projects.org_id, tasks.org_id),
      ))
      .where(and(
        eq(tasks.id, params.task.id),
        eq(tasks.org_id, params.orgId),
        eq(tasks.project_id, params.task.project_id),
        eq(tasks.is_deleted, false),
        eq(projects.is_deleted, false),
      ))
      .limit(1);
    if (!activeTask) return;

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

    const prefix = params.projectPrefix === undefined
      ? activeTask.project_prefix
      : params.projectPrefix;
    const [actor] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, params.actorUserId))
      .limit(1);

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
        actor_user_id: params.actorUserId,
        actor_name: actor?.name ?? null,
        ...params.payload,
      },
    });
  } catch (err) {
    console.error(`[dispatch-agent-task] failed to publish ${params.kind} for ${params.task.id}:`, err);
  }
}
