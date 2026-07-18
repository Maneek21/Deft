/**
 * Task 8.7 — trigger dispatcher.
 *
 * Cron / webhook / event-driven trigger fan-out. Distinct from the Phase 6
 * `employee-trigger` handler: that one dispatches ONE already-targeted
 * invocation; this one walks the `agent_employees` table and finds every
 * employee subscribed to the trigger (via the column + any installed
 * skill's `agent_config.triggers`) and enqueues one `employee-trigger`
 * job per match. The split keeps the fan-out SQL out of the per-employee
 * critical path so a slow fan-out scan doesn't block the Gateway dispatch.
 *
 * Trigger kinds supported in v1:
 *   cron:standup               — 9am org-tz (approximated as 9am UTC for v1)
 *   cron:nightly-review        — 9pm org-tz
 *   webhook:github-pr-merged   — fan-out from the GitHub webhook route
 *   event:task-extracted       — fan-out from the task-extract worker
 *   event:task-overdue         — fan-out from the overdue sweep
 *   event:task-stalled-48h     — fan-out from the stalled sweep
 *
 * Cron-flavored trigger_kinds fire on the 60s `trigger-dispatch` poll and
 * the handler gates on "is this the right hour-of-day?" so we don't need
 * a separate cron per kind. Webhook/event kinds are enqueued with a
 * payload and the handler dispatches immediately.
 */
import { and, eq } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentEmployees,
  agentEmployeeSkills,
  skills,
} from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { SkillAgentConfig } from '../../lib/skill-config.js';
import type { TriggerInvocation } from './employee-trigger.js';

type DispatchJobData =
  | { trigger_kind?: string; context?: Record<string, unknown>; goal?: string }
  | undefined;

/**
 * Cron kinds fire on every 60s poll; we only want them at the correct
 * hour-of-day. Keep the map tiny — Phase 8.7 v1 has two cron kinds.
 */
const CRON_HOUR_UTC: Record<string, number> = {
  'cron:nightly-review': 21,
};

/**
 * Dedup cron firings inside the same hour — store a memo keyed by
 * `${triggerKind}:${YYYY-MM-DDTHH}` in memory. Workers restart wipes
 * the memo, but the `CRON_HOUR_UTC` gate combined with the 60s poll
 * means we only need in-process dedup for one hour; a restart during
 * that hour worst-case fires the trigger twice, which is fine.
 */
const recentCronFirings = new Set<string>();
function hourKey(kind: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${kind}:${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}`;
}

export async function handleTriggerDispatch(job: JobData): Promise<void> {
  const data = (job.data ?? {}) as DispatchJobData;
  // Two invocation paths share this handler:
  //   (a) cron: invoked with empty `data` — we scan CRON_HOUR_UTC and fire
  //       every cron kind whose hour matches.
  //   (b) webhook / event: invoked with `{ trigger_kind, context, goal }`
  //       and we fan out directly to subscribed employees.
  if (data && typeof data === 'object' && data.trigger_kind) {
    await fanOutTrigger({
      triggerKind: data.trigger_kind,
      context: data.context ?? {},
      goal: data.goal ?? `Handle trigger ${data.trigger_kind}`,
    });
    return;
  }

  // Cron path — hour gate + dedup + fan-out.
  const now = new Date();
  const currentHourUtc = now.getUTCHours();
  for (const [kind, hour] of Object.entries(CRON_HOUR_UTC)) {
    if (hour !== currentHourUtc) continue;
    const key = hourKey(kind);
    if (recentCronFirings.has(key)) continue;
    recentCronFirings.add(key);
    // Expire old entries to bound memory — keep only this hour's.
    if (recentCronFirings.size > 20) {
      const keep = [...recentCronFirings].filter((k) =>
        k.startsWith(key.split(':')[0] ?? ''),
      );
      recentCronFirings.clear();
      for (const k of keep) recentCronFirings.add(k);
    }
    await fanOutTrigger({
      triggerKind: kind,
      context: { fired_at: now.toISOString() },
      goal: 'Compose a nightly review of today\'s activity and post it in your default space.',
    });
  }
}

/**
 * Look up every active employee whose active trigger set (inline +
 * skill-derived) includes `triggerKind` and enqueue an `employee-trigger`
 * job per match. The `employee-trigger` handler queues a pending
 * `agent_actions` row that the BYOA agent picks up via
 * `poll_pending_work`, and enforces the per-employee budget gate.
 */
async function fanOutTrigger(params: {
  triggerKind: string;
  context: Record<string, unknown>;
  goal: string;
}): Promise<void> {
  const { triggerKind, context, goal } = params;

  // Pull every active employee + their installed skills. Two queries so
  // the joins stay readable; the employee count per org is small.
  const employees = await db
    .select({
      id: agentEmployees.id,
      name: agentEmployees.name,
      slug: agentEmployees.slug,
      org_id: agentEmployees.org_id,
      unhealthy: agentEmployees.unhealthy,
      daily_action_count: agentEmployees.daily_action_count,
      max_daily_actions: agentEmployees.max_daily_actions,
      daily_cost_cents: agentEmployees.daily_cost_cents,
      daily_budget_cents: agentEmployees.daily_budget_cents,
      trigger_subscriptions: agentEmployees.trigger_subscriptions,
    })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.is_active, true)));

  if (employees.length === 0) return;

  const employeeIds = employees.map((e) => e.id);
  const skillRows = await db
    .select({
      agent_employee_id: agentEmployeeSkills.agent_employee_id,
      agent_config: skills.agent_config,
    })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(skills.id, agentEmployeeSkills.skill_id));

  const skillTriggersByEmp = new Map<string, Set<string>>();
  for (const row of skillRows) {
    if (!employeeIds.includes(row.agent_employee_id)) continue;
    const cfg = (row.agent_config ?? {}) as SkillAgentConfig;
    let set = skillTriggersByEmp.get(row.agent_employee_id);
    if (!set) {
      set = new Set();
      skillTriggersByEmp.set(row.agent_employee_id, set);
    }
    for (const t of cfg.triggers ?? []) set.add(t);
  }

  let enqueued = 0;
  let skipped = 0;

  for (const emp of employees) {
    const inline = new Set(emp.trigger_subscriptions ?? []);
    const fromSkills = skillTriggersByEmp.get(emp.id) ?? new Set<string>();
    if (!inline.has(triggerKind) && !fromSkills.has(triggerKind)) continue;

    // Task 8.5 guards — the employee-trigger handler re-checks these,
    // but gating here too keeps us from enqueuing doomed jobs.
    if (emp.unhealthy) {
      skipped += 1;
      continue;
    }
    if (emp.daily_action_count >= emp.max_daily_actions) {
      skipped += 1;
      continue;
    }
    if (
      typeof emp.daily_budget_cents === 'number' &&
      emp.daily_cost_cents >= emp.daily_budget_cents
    ) {
      skipped += 1;
      continue;
    }

    const invocation: TriggerInvocation = {
      employee_id: emp.id,
      trigger_kind: triggerKind,
      context,
      goal,
    };
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'employee-trigger', invocation);
    enqueued += 1;
  }

  console.log(
    `[trigger-dispatch] kind=${triggerKind} enqueued=${enqueued} skipped=${skipped}`,
  );
}
