// Handler: agent-employee-heartbeat — runs periodic checks for proactive
// agent employees.
//
// Phase 9: every employee is BYOA. The heartbeat handler no longer
// pushes work into a runtime. When an employee is due for a tick, after
// the existing guard gates pass (budget, circuit breaker, idempotency,
// loop detector), we insert an `agent_actions` row with
// `action='heartbeat_tick'` so the BYOA client picks it up via
// `poll_pending_work`. Persistence to `agent_heartbeat_turns` and the
// `agent:heartbeat:turn` socket fanout are preserved for the inspector
// UI.
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentActions,
  agentEmployees,
  agentHeartbeatTurns,
} from '@deft/db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getIO } from '../../socket.js';

export type HeartbeatOutcome =
  | 'queued'
  | 'no_op'
  | 'skipped_budget'
  | 'skipped_idempotent'
  | 'skipped_unhealthy'
  | 'error';

/**
 * Persist the turn row + broadcast `agent:heartbeat:turn` for the UI
 * feed. Swallows errors so a bad insert never cancels the dispatch
 * loop.
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
 * Idempotency check — if the last turn's `prompt_sha` matches AND its
 * outcome was `no_op`, the agent hasn't seen anything new since then,
 * so a re-queue would just clutter the BYOA inbox.
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
 * Loop detector. Looks at the most recent N `agent_actions` attributed
 * to the employee (where `action` is a create/post shape) and compares
 * the canonical payload. If five in a row produce the same task title
 * OR the same message text, the employee is trapped in a feedback loop;
 * trip the breaker so a human has to unwedge it.
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

/** Atomically claim a due window so concurrent workers cannot queue duplicates. */
async function claimHeartbeatWindow(employeeId: string): Promise<boolean> {
  const [claimed] = await db
    .update(agentEmployees)
    .set({ last_heartbeat_at: new Date() })
    .where(
      and(
        eq(agentEmployees.id, employeeId),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.heartbeat_enabled, true),
        sql`(${agentEmployees.last_heartbeat_at} IS NULL OR ${agentEmployees.last_heartbeat_at} + (${agentEmployees.heartbeat_interval_min} || ' minutes')::interval < NOW())`,
      ),
    )
    .returning({ id: agentEmployees.id });
  return Boolean(claimed);
}

export async function handleAgentEmployeeHeartbeat(_job: JobData): Promise<void> {
  // Phase 9: no kind filter — every active employee with heartbeat
  // enabled and a due window is a candidate. The handler re-derives the
  // per-employee due set from `last_heartbeat_at + heartbeat_interval_min`.
  const dueEmployees = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.heartbeat_enabled, true),
        sql`(${agentEmployees.last_heartbeat_at} IS NULL OR ${agentEmployees.last_heartbeat_at} + (${agentEmployees.heartbeat_interval_min} || ' minutes')::interval < NOW())`,
      ),
    );

  console.log(
    `[heartbeat] found ${dueEmployees.length} employee(s) due`,
  );

  for (const employee of dueEmployees) {
    const cadenceMinutes = employee.heartbeat_interval_min;

    // The due scan is advisory; this update is the overlap lock.
    if (!(await claimHeartbeatWindow(employee.id))) continue;

    // ─── Guard: unhealthy circuit breaker ───────────────────────────────
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

    // ─── Guard: daily action cap ────────────────────────────────────────
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

    // ─── Guard: daily cost cap ──────────────────────────────────────────
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

    try {
      const { buildHeartbeatPrompt } = await import(
        '../../lib/heartbeat-prompt.js'
      );
      const { prompt, prompt_sha } = await buildHeartbeatPrompt(employee.id);

      // ─── Idempotency skip ─────────────────────────────────────────────
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

      // ─── Queue the heartbeat tick for BYOA pickup ─────────────────────
      const dueAt = new Date().toISOString();
      try {
        await db.insert(agentActions).values({
          org_id: employee.org_id,
          // Self-triggered: heartbeats originate from the agent's own
          // schedule, not a human. Attribute to the employee's shadow
          // user so the action shows up under the agent in audit.
          user_id: employee.user_id,
          agent_employee_id: employee.id,
          source: 'heartbeat',
          action: 'heartbeat_tick',
          params: {
            heartbeat_prompt: prompt,
            due_at: dueAt,
          },
          approval_tier: 'auto',
          approval_status: 'pending',
        });
      } catch (err) {
        console.error(
          `[heartbeat] failed to queue heartbeat_tick for ${employee.slug}:`,
          err instanceof Error ? err.message : err,
        );
      }

      await logHeartbeatTurn({
        orgId: employee.org_id,
        employeeId: employee.id,
        cadenceMinutes,
        promptSha: prompt_sha,
        outcome: 'queued',
        actionCount: 1,
        summary: prompt.slice(0, 200),
      });

      // Loop detector — check whether the last five actions point at the
      // same task title or message text; if so, trip the breaker so a
      // human can unwedge the agent.
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

      // Still stamp last_heartbeat_at to prevent retry storms.
      await db
        .update(agentEmployees)
        .set({ last_heartbeat_at: new Date() })
        .where(eq(agentEmployees.id, employee.id));
    }
  }
}
