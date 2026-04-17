// Handler: agent-employee-heartbeat — runs periodic checks for proactive agent employees.
//
// Task 8.1 extended the handler to route by `employee.kind`:
//   - native / claude_sdk → `runAgentQuery` in background mode (legacy path)
//   - openclaw / custom_mcp → `dispatchHeartbeat` over the Gateway SSE channel
//
// Task 8.4 adds per-tick logging into `agent_heartbeat_turns` (the session
// inspector's Heartbeats feed), and a `agent:heartbeat:turn` socket event
// so the UI refreshes live. Task 8.5 layers the cost + action caps +
// unhealthy circuit breaker. Task 8.6 layers idempotency + loop detection.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentActions,
  agentEmployees,
  agentHeartbeatTurns,
  orgs,
} from '@deft/db/schema';
import { eq, and, or, desc, inArray, sql } from 'drizzle-orm';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { dispatchHeartbeat } from '../../lib/openclaw-dispatch.js';
import { getIO } from '../../socket.js';

type HeartbeatScope = 'native' | 'openclaw' | 'all';

export type HeartbeatOutcome =
  | 'dispatched'
  | 'no_op'
  | 'skipped_budget'
  | 'skipped_idempotent'
  | 'skipped_unhealthy'
  | 'skipped_disconnected'
  | 'error';

function scopeFromJob(job: JobData): HeartbeatScope {
  if (job.name === 'heartbeat-native') return 'native';
  if (job.name === 'heartbeat-openclaw') return 'openclaw';
  return 'all';
}

/**
 * Task 8.4 — persist the turn row + broadcast `agent:heartbeat:turn` for
 * the UI feed. Swallows errors so a bad insert never cancels the dispatch
 * loop (the dispatch itself has already run by the time we get here).
 */
async function logHeartbeatTurn(params: {
  orgId: string;
  employeeId: string;
  cadenceMinutes: number;
  promptSha: string;
  outcome: HeartbeatOutcome;
  outcomeReason?: string;
  actionCount?: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costCents?: number | null;
  summary?: string | null;
  rawResponse?: unknown;
}): Promise<void> {
  try {
    const [row] = await db
      .insert(agentHeartbeatTurns)
      .values({
        org_id: params.orgId,
        agent_employee_id: params.employeeId,
        cadence_minutes: params.cadenceMinutes,
        prompt_sha: params.promptSha,
        action_count: params.actionCount ?? 0,
        tokens_in: params.tokensIn ?? null,
        tokens_out: params.tokensOut ?? null,
        cost_cents: params.costCents ?? null,
        outcome: params.outcome,
        outcome_reason: params.outcomeReason ?? null,
        summary: params.summary ?? null,
        raw_response: params.rawResponse ?? null,
      })
      .returning();
    const io = getIO();
    if (io && row) {
      io.to(`org:${params.orgId}`).emit('agent:heartbeat:turn', {
        id: row.id,
        agent_employee_id: row.agent_employee_id,
        fired_at: row.fired_at,
        outcome: row.outcome,
        summary: row.summary,
        cadence_minutes: row.cadence_minutes,
      });
    }
  } catch (err) {
    console.error('[heartbeat] logHeartbeatTurn failed:', err);
  }
}

/**
 * Task 8.6 — check the previous turn for idempotency. If the last turn's
 * `prompt_sha` matches AND its outcome was `no_op`, the agent hasn't seen
 * anything new since then, so a re-dispatch would just burn budget.
 */
async function lastTurnFor(employeeId: string): Promise<
  typeof agentHeartbeatTurns.$inferSelect | null
> {
  const [row] = await db
    .select()
    .from(agentHeartbeatTurns)
    .where(eq(agentHeartbeatTurns.agent_employee_id, employeeId))
    .orderBy(desc(agentHeartbeatTurns.fired_at))
    .limit(1);
  return row ?? null;
}

/**
 * Task 8.6 — loop detector. Looks at the most recent N `agent_actions`
 * attributed to the employee (where `action` is a create/post shape) and
 * compares the canonical payload. If five in a row produce the same
 * task title OR the same message text, the employee is trapped in a
 * feedback loop (e.g. a heartbeat that always fires the same nudge
 * because the state it checks never changes). Trip the breaker in that
 * case so a human has to unwedge it.
 *
 * Returns `{ loop: true, reason }` when a loop is detected; `{ loop:
 * false }` otherwise. Swallow DB errors — a loop detector that crashes
 * the handler would be worse than one that occasionally misses.
 */
async function detectActionLoop(
  employeeId: string,
): Promise<{ loop: true; reason: string } | { loop: false }> {
  try {
    const rows = await db
      .select({
        action: agentActions.action,
        params: agentActions.params,
      })
      .from(agentActions)
      .where(eq(agentActions.agent_employee_id, employeeId))
      .orderBy(desc(agentActions.created_at))
      .limit(5);

    if (rows.length < 5) return { loop: false };

    // Bucket by the loop signal: tasks share title; messages share
    // normalized content prefix. Anything else (status changes, reads) is
    // ignored — a loop of reads isn't costing real actions.
    const signals: string[] = [];
    for (const row of rows) {
      const params = (row.params ?? {}) as Record<string, unknown>;
      if (row.action === 'create_task' || row.action === 'task_create') {
        const title = typeof params.title === 'string' ? params.title : '';
        if (!title) return { loop: false };
        signals.push(`task::${title.trim().toLowerCase()}`);
      } else if (
        row.action === 'post_message' ||
        row.action === 'message_post'
      ) {
        const content = typeof params.content === 'string' ? params.content : '';
        if (!content) return { loop: false };
        signals.push(`msg::${content.trim().slice(0, 120).toLowerCase()}`);
      } else {
        return { loop: false };
      }
    }

    const unique = new Set(signals);
    if (unique.size === 1) {
      return {
        loop: true,
        reason: `loop detected: 5 consecutive identical actions (${[...unique][0]})`,
      };
    }
    return { loop: false };
  } catch (err) {
    console.warn('[heartbeat] detectActionLoop failed:', err);
    return { loop: false };
  }
}

/**
 * Task 8.5 / 8.6 — bump the consecutive-error counter or trip the
 * breaker. The counter is inferred from the last N rows (no dedicated
 * column) so we stay additive.
 */
async function trackConsecutiveOutcome(params: {
  employeeId: string;
  orgId: string;
  outcome: HeartbeatOutcome;
  lookback: number;
}): Promise<{ consecutive: number }> {
  const rows = await db
    .select({ outcome: agentHeartbeatTurns.outcome })
    .from(agentHeartbeatTurns)
    .where(eq(agentHeartbeatTurns.agent_employee_id, params.employeeId))
    .orderBy(desc(agentHeartbeatTurns.fired_at))
    .limit(params.lookback);

  let consecutive = 0;
  for (const r of rows) {
    if (r.outcome === params.outcome) consecutive += 1;
    else break;
  }
  return { consecutive };
}

export async function handleAgentEmployeeHeartbeat(job: JobData): Promise<void> {
  const scope = scopeFromJob(job);

  const kindFilter =
    scope === 'native'
      ? or(
          eq(agentEmployees.kind, 'native'),
          eq(agentEmployees.kind, 'claude_sdk'),
        )
      : scope === 'openclaw'
        ? or(
            eq(agentEmployees.kind, 'openclaw'),
            eq(agentEmployees.kind, 'custom_mcp'),
          )
        : sql`TRUE`;

  const dueEmployees = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.heartbeat_enabled, true),
        sql`(${agentEmployees.last_heartbeat_at} IS NULL OR ${agentEmployees.last_heartbeat_at} + (${agentEmployees.heartbeat_interval_min} || ' minutes')::interval < NOW())`,
        kindFilter,
      ),
    );

  console.log(
    `[heartbeat] scope=${scope} found ${dueEmployees.length} employee(s) due`,
  );

  for (const employee of dueEmployees) {
    const cadenceMinutes = employee.heartbeat_interval_min;
    const isOpenClawShaped =
      employee.kind === 'openclaw' || employee.kind === 'custom_mcp';

    // ─── Guard: unhealthy circuit breaker (Task 8.5) ────────────────────
    if (employee.unhealthy) {
      await logHeartbeatTurn({
        orgId: employee.org_id,
        employeeId: employee.id,
        cadenceMinutes,
        promptSha: 'n/a',
        outcome: 'skipped_unhealthy',
        outcomeReason: employee.unhealthy_reason ?? 'unhealthy flag set',
      });
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
      continue;
    }

    // ─── Guard: daily action cap (all kinds) ────────────────────────────
    if (employee.daily_action_count >= employee.max_daily_actions) {
      await logHeartbeatTurn({
        orgId: employee.org_id,
        employeeId: employee.id,
        cadenceMinutes,
        promptSha: 'n/a',
        outcome: 'skipped_budget',
        outcomeReason: `daily_action_count ${employee.daily_action_count}/${employee.max_daily_actions}`,
      });
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
      continue;
    }

    // ─── Guard: daily cost cap (Task 8.5) ───────────────────────────────
    if (
      typeof employee.daily_budget_cents === 'number' &&
      employee.daily_cost_cents >= employee.daily_budget_cents
    ) {
      await logHeartbeatTurn({
        orgId: employee.org_id,
        employeeId: employee.id,
        cadenceMinutes,
        promptSha: 'n/a',
        outcome: 'skipped_budget',
        outcomeReason: `daily_cost_cents ${employee.daily_cost_cents}/${employee.daily_budget_cents}`,
      });
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
      continue;
    }

    // ─── Guard: Gateway connection (openclaw only) ──────────────────────
    if (isOpenClawShaped && employee.connection_status !== 'connected') {
      await logHeartbeatTurn({
        orgId: employee.org_id,
        employeeId: employee.id,
        cadenceMinutes,
        promptSha: 'n/a',
        outcome: 'skipped_disconnected',
        outcomeReason: `connection_status=${employee.connection_status}`,
      });
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
      continue;
    }

    const [org] = await db
      .select({ name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, employee.org_id))
      .limit(1);
    const orgName = org?.name ?? 'Unknown';

    try {
      if (isOpenClawShaped) {
        const { buildHeartbeatPrompt } = await import(
          '../../lib/heartbeat-prompt.js'
        );
        const { prompt, context, prompt_sha } = await buildHeartbeatPrompt(
          employee.id,
        );

        // ─── Task 8.6 — idempotency skip ───────────────────────────────
        const last = await lastTurnFor(employee.id);
        if (
          last &&
          last.prompt_sha === prompt_sha &&
          last.outcome === 'no_op'
        ) {
          await logHeartbeatTurn({
            orgId: employee.org_id,
            employeeId: employee.id,
            cadenceMinutes,
            promptSha: prompt_sha,
            outcome: 'skipped_idempotent',
            outcomeReason: 'prompt unchanged since last no_op',
          });
          await db
            .update(agentEmployees)
            .set({ last_heartbeat_at: new Date() })
            .where(eq(agentEmployees.id, employee.id));
          continue;
        }

        await dispatchHeartbeat({ employee, prompt, context });

        await logHeartbeatTurn({
          orgId: employee.org_id,
          employeeId: employee.id,
          cadenceMinutes,
          promptSha: prompt_sha,
          outcome: 'dispatched',
          actionCount: 1,
          summary: prompt.slice(0, 200),
        });

        // Task 8.6 — loop detector. Check whether the last five actions
        // point at the same task title or message text; if so, trip the
        // breaker so a human can unwedge the agent.
        const loop = await detectActionLoop(employee.id);
        if (loop.loop) {
          await db
            .update(agentEmployees)
            .set({
              unhealthy: true,
              unhealthy_reason: loop.reason,
            })
            .where(eq(agentEmployees.id, employee.id));
          console.warn(
            `[heartbeat] ${employee.slug}: ${loop.reason}`,
          );
        }
      } else {
        const heartbeatConfig =
          typeof employee.heartbeat_config === 'string'
            ? employee.heartbeat_config
            : (employee.heartbeat_config as { checklist?: string } | null)
                ?.checklist ?? 'Check if anything needs attention in your domain.';

        const heartbeatPrompt = `HEARTBEAT CHECK — You are waking up for a scheduled check.

## Your Heartbeat Checklist:
${heartbeatConfig}

## Instructions:
1. Go through each item in your checklist
2. Use your tools to check the current state
3. If something needs attention: take action (post in channels, create tasks, DM people)
4. If nothing needs attention: respond with exactly HEARTBEAT_OK

Be concise. Only act on things that genuinely need attention right now.`;

        const augmentedPrompt = `${employee.system_prompt}

## Your Identity
You are ${employee.name}, a ${employee.role.replace(/_/g, ' ')} at ${orgName}.
${employee.expertise_description ? `Your expertise: ${employee.expertise_description}` : ''}`;

        const result = await runAgentQuery({
          content: heartbeatPrompt,
          orgId: employee.org_id,
          userId: employee.user_id,
          orgName,
          mode: 'background',
          systemPromptOverride: augmentedPrompt,
          trustLevelOverride: employee.trust_level,
          agentEmployeeId: employee.id,
        });

        const text = (result.text ?? '').trim();
        const noOp = text === 'HEARTBEAT_OK' || text === '';
        await logHeartbeatTurn({
          orgId: employee.org_id,
          employeeId: employee.id,
          cadenceMinutes,
          promptSha: 'native:' + employee.id,
          outcome: noOp ? 'no_op' : 'dispatched',
          actionCount: noOp ? 0 : 1,
          summary: text.slice(0, 200),
        });
      }

      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[heartbeat] Error for ${employee.slug}:`, msg);
      await logHeartbeatTurn({
        orgId: employee.org_id,
        employeeId: employee.id,
        cadenceMinutes,
        promptSha: 'n/a',
        outcome: 'error',
        outcomeReason: msg.slice(0, 500),
      });

      // ─── Task 8.5 — 3 consecutive errors → trip the breaker ────────
      const { consecutive } = await trackConsecutiveOutcome({
        employeeId: employee.id,
        orgId: employee.org_id,
        outcome: 'error',
        lookback: 5,
      });
      if (consecutive >= 3) {
        await db
          .update(agentEmployees)
          .set({
            unhealthy: true,
            unhealthy_reason: `3 consecutive heartbeat errors; last: ${msg.slice(0, 200)}`,
          })
          .where(eq(agentEmployees.id, employee.id));
        console.warn(
          `[heartbeat] ${employee.slug}: tripped unhealthy flag after ${consecutive} consecutive errors`,
        );
      }

      // Still stamp last_heartbeat_at to prevent retry storms.
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
    }
  }
}

// Exported for test-suite convenience — lets Phase 8 tests assert which
// kinds the handler routes to which runtime without re-deriving the filter.
export const HEARTBEAT_OPENCLAW_KINDS = ['openclaw', 'custom_mcp'] as const;
export const HEARTBEAT_NATIVE_KINDS = ['native', 'claude_sdk'] as const;

// Re-export so tests + future callers can import a stable symbol.
export { dispatchHeartbeat };

// Kept for task 8.7's batch scan.
void inArray;
