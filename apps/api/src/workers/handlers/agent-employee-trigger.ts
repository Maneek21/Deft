// Handler: agent-employee-trigger — fires when events occur and evaluates
// per-employee trigger conditions, then queues a pending `agent_actions`
// row so the BYOA client picks the work up via `poll_pending_work`.
//
// Phase 9: every employee is BYOA. We never push into a runtime — we
// record the invitation. The legacy `triggers` row (with structured
// `condition` + `actions`) drives gating; on a match we queue ONE
// agent_actions row carrying the event payload + the trigger's prompt
// (if any) so the agent has full context.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { triggers, agentEmployees, agentActions } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';

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

  // 4. Evaluate structured condition
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

  // 5. Queue one pending agent_actions row per matching `run_agent`
  // action so the BYOA client picks them up. Non-`run_agent` action
  // types are ignored here — they belong on workflow-execute.
  const actions = trigger.actions as { type: string; prompt?: string }[];
  let queued = 0;
  for (const action of actions) {
    if (action.type !== 'run_agent' || !action.prompt) continue;

    const prompt = action.prompt.replace('{{event}}', JSON.stringify(eventData));

    try {
      await db.insert(agentActions).values({
        org_id: orgId,
        user_id: employee.user_id,
        agent_employee_id: employee.id,
        source: 'trigger',
        action: 'trigger_dispatch',
        params: {
          trigger_id: triggerId,
          trigger_name: trigger.name,
          event_type: eventType,
          event_data: eventData,
          prompt,
        },
        approval_tier: 'auto',
        approval_status: 'pending',
      });
      queued += 1;
    } catch (err) {
      console.error(
        `[agent-employee-trigger] failed to queue trigger ${triggerId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 6. Update trigger fire stats only when we actually queued something
  // — keeps fire_count meaningful when the actions list is empty or
  // only contains non-run_agent kinds.
  if (queued > 0) {
    await db.update(triggers).set({
      last_fired_at: new Date(),
      fire_count: sql`coalesce(${triggers.fire_count}, 0) + 1`,
    }).where(eq(triggers.id, triggerId));
  }

  console.log(`[agent-employee-trigger] Trigger ${triggerId} (${trigger.name}) queued ${queued} action(s) for event ${eventType}`);
}
