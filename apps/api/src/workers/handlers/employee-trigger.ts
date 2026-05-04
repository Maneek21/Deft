/**
 * Handler: employee-trigger — trigger dispatcher.
 *
 * Receives a synthetic `TriggerInvocation` (cron-fired or webhook-fired)
 * and queues an `agent_actions` row so the BYOA agent picks the work
 * up via `poll_pending_work`. `trigger_subscriptions` routing is the
 * job of the upstream `trigger-dispatch` handler — by the time we land
 * here, the employee has already been chosen.
 *
 * Phase 9: every employee is BYOA. We never push into a runtime; we
 * record the invitation and let the agent decide when to wake.
 */
import { eq, and } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentActions, agentEmployees } from '@deft/db/schema';

/**
 * Shape sent to `enqueue('agent-jobs', 'employee-trigger', invocation)`.
 *
 * `trigger_kind` is free-form per the plan doc — common values include
 * `cron:standup`, `cron:weekly-digest`, `cron:meeting-prep`,
 * `event:task-stalled`, `event:task-overdue`, `webhook:pr-merged`,
 * `webhook:calendar-event-upcoming`.
 */
export type TriggerInvocation = {
  employee_id: string;
  trigger_kind: string;
  /** Machine-readable context for the agent to reason over. */
  context: Record<string, unknown>;
  /** High-level goal string the agent should pursue this turn. */
  goal: string;
  /** Optional target space to post the result into. */
  target_space_id?: string;
};

export async function handleEmployeeTrigger(job: JobData): Promise<void> {
  const invocation = job.data as TriggerInvocation;
  const { employee_id, trigger_kind, context, goal, target_space_id } = invocation;

  console.log(
    `[employee-trigger] Queueing ${trigger_kind} for employee ${employee_id}`,
  );

  // 1. Load the employee and verify it is active.
  const [employee] = await db
    .select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employee_id), eq(agentEmployees.is_active, true)))
    .limit(1);

  if (!employee) {
    console.warn(
      `[employee-trigger] Employee ${employee_id} not found or inactive, skipping`,
    );
    return;
  }

  // 2. Action budget gate — matches the existing chat-mention behavior.
  if (employee.daily_action_count >= employee.max_daily_actions) {
    console.warn(
      `[employee-trigger] Employee ${employee.slug} has exhausted daily action budget`,
    );
    return;
  }

  // 3. Queue an agent_actions row so the BYOA client finds the trigger
  // via `poll_pending_work`. Triggers don't need approval — they're
  // invitations to do work, so tier='auto'.
  try {
    await db.insert(agentActions).values({
      org_id: employee.org_id,
      // Triggers fire without a human in the loop; attribute to the
      // employee's shadow user so the action shows up under the agent
      // in the audit log.
      user_id: employee.user_id,
      agent_employee_id: employee.id,
      source: 'trigger',
      action: 'trigger_dispatch',
      params: {
        trigger_kind,
        trigger_payload: context ?? {},
        goal,
        target_space_id: target_space_id ?? null,
      },
      approval_tier: 'auto',
      approval_status: 'pending',
    });
  } catch (err) {
    console.error(
      `[employee-trigger] failed to queue ${trigger_kind} for ${employee.slug}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
