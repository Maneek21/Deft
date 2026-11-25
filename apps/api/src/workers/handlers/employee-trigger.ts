import { logId } from '../../lib/log-metadata.js';
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
import { eq, and, sql } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { jobOrgId } from '../job-org.js';
import { db } from '../../lib/db.js';
import { agentActions, agentEmployees, messages, spaces, tasks } from '@deft/db/schema';
import { unrestrictedTaskCondition, visibleTaskSql } from '../../lib/task-visibility.js';
import { currentEmployeeMessageAuthoritySql } from '../../lib/agent-channel-authority.js';
import { toPlainText } from '../../lib/plain-text.js';

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
  /** Org the trigger belongs to; the employee and target space must be in it. */
  org_id: string;
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
  const orgId = jobOrgId(job);
  if (!orgId || !employee_id) {
    console.warn("[employee-trigger] <redacted> job without a workspace; not delivered");
    return;
  }

  console.log(`[employee-trigger] Queueing <redacted> for employee ${logId(employee_id)}`
  );

  // 1. Load the employee from the job's org and verify it is active.
  const [employee] = await db
    .select()
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.id, employee_id),
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.is_active, true),
    ))
    .limit(1);

  if (!employee) {
    console.warn(`[employee-trigger] Employee ${logId(employee_id)} not found or inactive, skipping`
    );
    return;
  }

  if (target_space_id) {
    const [space] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.id, target_space_id), eq(spaces.org_id, orgId)))
      .limit(1);
    if (!space) {
      console.warn("[employee-trigger] target space for <redacted> not found; skipping");
      return;
    }
  }

  // 2. Action budget gate — matches the existing chat-mention behavior.
  if (employee.daily_action_count >= employee.max_daily_actions) {
    console.warn("[employee-trigger] Employee <redacted> has exhausted daily action budget"
    );
    return;
  }

  // A stalled or overdue task's trigger names the task. It is stored on an
  // agent action that the workspace's agent activity lists, so it is queued
  // only while the task is unrestricted and the employee may see it, checked
  // now and not only when the nudge was enqueued (lib/task-visibility.ts).
  if ((trigger_kind === 'event:task-stalled' || trigger_kind === 'event:task-overdue') && typeof context?.task_id === 'string') {
    const [current] = await db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.id, context.task_id), eq(tasks.org_id, orgId), eq(tasks.is_deleted, false),
      unrestrictedTaskCondition(), visibleTaskSql(employee.user_id),
    )).limit(1);
    if (!current) return;
  }

  let messageId: string | null = null;
  let payload = context ?? {};
  if (trigger_kind === 'event:task-extract') {
    // The observation and this dispatch are separate jobs. Preserve the source
    // for later reads, and never publish the earlier job's captured preview.
    if (typeof context?.message_id !== 'string' || typeof context.space_id !== 'string'
      || typeof context.author_user_id !== 'string' || context.space_id !== target_space_id) return;
    const [source] = await db.select({ id: messages.id, content: messages.content }).from(messages).where(and(
      eq(messages.id, context.message_id), eq(messages.org_id, orgId), eq(messages.space_id, context.space_id),
      eq(messages.user_id, context.author_user_id), eq(messages.is_deleted, false),
      currentEmployeeMessageAuthoritySql(sql`${orgId}`, sql`${employee.id}`, messages.id),
    )).limit(1);
    if (!source) return;
    messageId = source.id;
    payload = { ...context, message_preview: toPlainText(source.content).slice(0, 500) };
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
      message_id: messageId,
      source: 'trigger',
      action: 'trigger_dispatch',
      params: {
        trigger_kind,
        trigger_payload: payload,
        goal,
        target_space_id: target_space_id ?? null,
      },
      approval_tier: 'auto',
      approval_status: 'pending',
    });
  } catch (err) {
    console.error("[employee-trigger] failed to queue <redacted> for <redacted>:"
    );
  }
}
