// Handler: agent-employee-task — processes task assignments to agent employees.
//
// Phase 9: every employee is BYOA. Task assignments to an agent are
// queued as a pending `agent_actions` row so the BYOA client picks
// the work up via `poll_pending_work`. The task itself stays in its
// current status; the BYOA agent decides when to move it.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentActions,
  agentEmployees,
  taskActivity,
  tasks,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { getIO } from '../../socket.js';

interface AgentEmployeeTaskData {
  taskId: string;
  orgId: string;
  employeeId: string;
  assignedBy: string;
}

export async function handleAgentEmployeeTask(job: JobData): Promise<void> {
  const { taskId, orgId, employeeId, assignedBy } = job.data as AgentEmployeeTaskData;

  console.log(`[agent-employee-task] Queueing task ${taskId} for employee ${employeeId}`);

  // 1. Load employee and verify it's active
  const [employee] = await db.select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId), eq(agentEmployees.is_active, true)))
    .limit(1);

  if (!employee) {
    console.warn(`[agent-employee-task] Employee ${employeeId} not found or inactive, skipping`);
    return;
  }

  // 2. Load task
  const [task] = await db.select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
    .limit(1);

  if (!task) {
    console.warn(`[agent-employee-task] Task ${taskId} not found, skipping`);
    return;
  }

  // 3. Queue an agent_actions row so the BYOA client picks up the
  // assignment via `poll_pending_work`. The assigning user is recorded
  // so the audit log shows who handed the work off.
  try {
    const [actionRow] = await db.insert(agentActions).values({
      org_id: orgId,
      user_id: assignedBy,
      agent_employee_id: employeeId,
      source: 'task_assignment',
      action: 'task_assigned',
      params: {
        task_id: task.id,
        title: task.title,
        description: task.description ?? null,
        priority: task.priority,
        status: task.status,
      },
      approval_tier: 'auto',
      approval_status: 'pending',
    }).returning({ id: agentActions.id });

    await db.insert(taskActivity).values({
      org_id: orgId,
      task_id: task.id,
      user_id: assignedBy,
      action: 'agent_handoff_queued',
      field: 'assignee_id',
      old_value: null,
      new_value: employee.user_id,
      agent_action_id: actionRow?.id ?? null,
      acting_agent_employee_id: employeeId,
    });
  } catch (err) {
    console.error(
      `[agent-employee-task] failed to queue task ${taskId} for ${employeeId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 4. Best-effort progress signal so the task-detail strip shows the
  // hand-off; the BYOA agent will emit its own progress events when it
  // wakes up and acts on the queued row.
  const io = getIO();
  if (io) {
    io.to(`org:${orgId}`).emit('task:agent_progress', {
      task_id: taskId,
      agent_employee_id: employeeId,
      step_index: 0,
      step_description: `Task queued for ${employee.name}`,
      status: 'queued',
      total_steps: 1,
    });
  }
}
