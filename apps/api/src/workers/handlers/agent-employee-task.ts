// Handler: agent-employee-task — processes task assignments to agent employees
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentEmployees, tasks, taskActivity, orgs, users } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { runAgentQuery } from '../../lib/agent-runner.js';

interface AgentEmployeeTaskData {
  taskId: string;
  orgId: string;
  employeeId: string;
  assignedBy: string;
}

export async function handleAgentEmployeeTask(job: JobData): Promise<void> {
  const { taskId, orgId, employeeId, assignedBy } = job.data as AgentEmployeeTaskData;

  console.log(`[agent-employee-task] Processing task ${taskId} for employee ${employeeId}`);

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

  // 3. Load org name
  const [org] = await db.select({ name: orgs.name })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  const orgName = org?.name ?? 'Unknown';

  // 4. Build task-focused augmented prompt
  const systemPrompt = `${employee.system_prompt}

---
# Identity & Context
You are ${employee.name}, a ${employee.role} at ${orgName}.
${employee.expertise_description ? `\nExpertise: ${employee.expertise_description}` : ''}

## Task Assignment
You have been assigned the following task:
- **Task ID:** ${task.id}
- **Title:** ${task.title}
- **Description:** ${task.description || 'No description provided'}
- **Priority:** ${task.priority}
- **Status:** ${task.status}

## Instructions
1. Read the task details carefully.
2. If the task is ambiguous or missing critical information, ask for clarification.
3. Use available tools to complete the task.
4. Post your results and findings clearly.
5. When done, your work will be set to "in_review" status.
`;

  const taskPrompt = `I've been assigned task "${task.title}". ${task.description || ''}\n\nLet me work on this now.`;

  // 5. Call agent runner
  const result = await runAgentQuery({
    content: taskPrompt,
    orgId,
    userId: employee.user_id,
    orgName,
    mode: 'background',
    systemPromptOverride: systemPrompt,
    trustLevelOverride: employee.trust_level,
  });

  // 6. Post result as task activity comment
  if (result.text) {
    await db.insert(taskActivity).values({
      task_id: taskId,
      user_id: employee.user_id,
      action: 'commented',
      new_value: result.text,
    });
  }

  // 7. Update task status to 'in_review'
  const previousStatus = task.status;
  await db.update(tasks).set({
    status: 'in_review',
  }).where(eq(tasks.id, taskId));

  // 8. Log status change in taskActivity
  await db.insert(taskActivity).values({
    task_id: taskId,
    user_id: employee.user_id,
    action: 'status_changed',
    field: 'status',
    old_value: previousStatus,
    new_value: 'in_review',
  });

  // Increment daily action count (atomic to prevent race conditions)
  await db.execute(
    sql`UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = ${employeeId} AND daily_action_count < max_daily_actions`
  );

  console.log(`[agent-employee-task] Completed task ${taskId}, status set to in_review`);
}
