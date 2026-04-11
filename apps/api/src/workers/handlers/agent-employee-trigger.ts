// Handler: agent-employee-trigger — fires when events occur and evaluates trigger conditions for agent employees
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { triggers, agentEmployees, orgs } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { runAgentQuery } from '../../lib/agent-runner.js';

interface AgentEmployeeTriggerData {
  triggerId: string;
  orgId: string;
  eventType: string;
  eventData: Record<string, any>;
}

export async function handleAgentEmployeeTrigger(job: JobData): Promise<void> {
  const { triggerId, orgId, eventType, eventData } = job.data as AgentEmployeeTriggerData;

  console.log(`[agent-employee-trigger] Processing trigger ${triggerId} for event ${eventType}`);

  // 1. Load trigger and verify it's active
  const [trigger] = await db.select()
    .from(triggers)
    .where(and(eq(triggers.id, triggerId), eq(triggers.is_active, true)))
    .limit(1);

  if (!trigger || !trigger.agent_employee_id) {
    console.warn(`[agent-employee-trigger] Trigger ${triggerId} not found, inactive, or has no agent employee`);
    return;
  }

  // 2. Load agent employee and verify it's active
  const [employee] = await db.select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, trigger.agent_employee_id), eq(agentEmployees.is_active, true)))
    .limit(1);

  if (!employee) {
    console.warn(`[agent-employee-trigger] Agent employee ${trigger.agent_employee_id} not found or inactive`);
    return;
  }

  // 3. Check daily action budget
  if (employee.daily_action_count >= employee.max_daily_actions) {
    console.warn(`[agent-employee-trigger] Agent employee ${employee.name} has exhausted daily action budget`);
    return;
  }

  // 4. Load org name
  const [org] = await db.select({ name: orgs.name })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  // 5. Evaluate structured condition
  const condition = trigger.condition as Record<string, any> | null;
  if (condition) {
    for (const [field, expected] of Object.entries(condition)) {
      const actual = eventData[field];
      if (Array.isArray(expected)) {
        if (!expected.includes(actual)) {
          console.log(`[agent-employee-trigger] Condition not met: ${field}=${actual} not in ${JSON.stringify(expected)}`);
          return;
        }
      } else if (actual !== expected) {
        console.log(`[agent-employee-trigger] Condition not met: ${field}=${actual} !== ${expected}`);
        return;
      }
    }
  }

  // 6. Execute actions
  const actions = trigger.actions as { type: string; prompt?: string }[];
  for (const action of actions) {
    if (action.type === 'run_agent' && action.prompt) {
      const prompt = action.prompt.replace('{{event}}', JSON.stringify(eventData));

      await runAgentQuery({
        content: prompt,
        orgId,
        userId: employee.user_id,
        orgName: org?.name ?? '',
        mode: 'background',
        systemPromptOverride: employee.system_prompt,
      });

      // Increment daily action count
      await db.update(agentEmployees).set({
        daily_action_count: employee.daily_action_count + 1,
      }).where(eq(agentEmployees.id, employee.id));
    }
  }

  // 7. Update trigger fire stats
  await db.update(triggers).set({
    last_fired_at: new Date(),
    fire_count: sql`coalesce(${triggers.fire_count}, 0) + 1`,
  }).where(eq(triggers.id, triggerId));

  console.log(`[agent-employee-trigger] Trigger ${triggerId} (${trigger.name}) executed for event ${eventType}`);
}
