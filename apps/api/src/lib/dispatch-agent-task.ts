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
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { users } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from './queues.js';

export async function dispatchAgentEmployeeTask(params: {
  taskId: string;
  orgId: string;
  assigneeUserId: string;
  assignedBy: string;
}): Promise<void> {
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
    }
  } catch (err) {
    console.error('[dispatch-agent-task] enqueue failed:', err);
  }
}
