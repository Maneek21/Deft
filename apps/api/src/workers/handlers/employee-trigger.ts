/**
 * Handler: employee-trigger — Phase 6 trigger dispatcher.
 *
 * Receives a synthetic `TriggerInvocation` (cron-fired or webhook-fired),
 * loads the target employee, and routes the invocation to the right runtime:
 *
 *   - `kind='openclaw'` employees get a chat-envelope call via the shared
 *     `dispatchViaOpenClaw` helper, with a synthetic override trigger so we
 *     don't pollute the `messages` table with a fake trigger row.
 *   - native/legacy employees get a direct `runAgentQuery` call in background
 *     mode, bypassing the self-verification pass.
 *
 * All invocations are wrapped in a 60s Promise.race timeout so a wedged
 * Gateway or hung MCP call can't stall the worker poller.
 *
 * On success for native employees, we post the agent's text reply into the
 * target space as a message authored by the employee's shadow user, and
 * write an `agent_session_turns` row tagged with the invocation's
 * `trigger_kind` so the Phase 10 session inspector can surface it.
 * (OpenClaw employees already get their session turn written by
 * `dispatchViaOpenClaw`.)
 *
 * `invalidatePlatformContextCacheFor` is called after a successful
 * invocation so the next `platform_context` call reflects whatever wiki
 * or task state the trigger may have written.
 */
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  agentEmployees,
  agentSessionTurns,
  messages,
  orgs,
  spaces,
  users,
} from '@deft/db/schema';
import { runAgentQuery } from '../../lib/agent-runner.js';
import { dispatchViaOpenClaw } from '../../lib/openclaw-dispatch.js';
import { invalidatePlatformContextCacheFor } from '../../lib/mcp-tools/context.js';
import { getIO } from '../../socket.js';

/**
 * Shape sent to `enqueue('agent-jobs', 'employee-trigger', invocation)`.
 *
 * `trigger_kind` is free-form per the plan doc §4.3 — common values include
 * `cron:standup`, `cron:weekly-digest`, `cron:meeting-prep`,
 * `event:task-stalled`, `event:task-overdue`, `webhook:pr-merged`,
 * `webhook:calendar-event-upcoming`. The dispatcher logs whatever it
 * receives verbatim so new kinds don't need code changes.
 */
export type TriggerInvocation = {
  employee_id: string;
  trigger_kind: string;
  /** Machine-readable context for the agent to reason over. */
  context: Record<string, unknown>;
  /** High-level goal string the agent should pursue this turn. */
  goal: string;
  /** Optional target space to post the result into. Defaults to the org
   *  default space when omitted. */
  target_space_id?: string;
};

const TRIGGER_TIMEOUT_MS = 60_000;

export async function handleEmployeeTrigger(job: JobData): Promise<void> {
  const invocation = job.data as TriggerInvocation;
  const { employee_id, trigger_kind, context, goal, target_space_id } = invocation;

  console.log(
    `[employee-trigger] Dispatching ${trigger_kind} to employee ${employee_id}`,
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

  // 3. Resolve a target space. Prefer the caller-supplied one; otherwise
  // fall back to the org's default (#general) space. If neither exists
  // we can still run a native agent query but have nowhere to post, so
  // we bail.
  let spaceId: string | null = target_space_id ?? null;
  if (!spaceId) {
    const [defaultSpace] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(eq(spaces.org_id, employee.org_id), eq(spaces.is_default, true)),
      )
      .limit(1);
    spaceId = defaultSpace?.id ?? null;
  }

  // ─── OpenClaw branch ──────────────────────────────────────────────────
  if (employee.kind === 'openclaw') {
    if (!spaceId) {
      console.warn(
        `[employee-trigger] No target space resolved for openclaw employee ${employee.slug}; skipping`,
      );
      return;
    }
    try {
      await Promise.race([
        dispatchViaOpenClaw({
          employee,
          orgId: employee.org_id,
          spaceId,
          // Correlation id for audit-only logging. Prefixed with the
          // trigger kind so inspector rows are greppable.
          messageId: `trigger:${trigger_kind}:${Date.now()}`,
          isDM: false,
          overrideTrigger: {
            kind: trigger_kind,
            content: goal,
            author_name: 'Deft Triggers',
            goal,
            context,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `employee-trigger: dispatchViaOpenClaw timeout after ${TRIGGER_TIMEOUT_MS}ms`,
                ),
              ),
            TRIGGER_TIMEOUT_MS,
          ),
        ),
      ]);
      invalidatePlatformContextCacheFor(employee.id);
    } catch (err) {
      console.error(
        `[employee-trigger] openclaw dispatch failed for ${employee.slug}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return;
  }

  // ─── Native / legacy branch ───────────────────────────────────────────
  //
  // Build the content the native runner should see. We inline the goal
  // and the machine-readable context as a single prompt body so the
  // runner doesn't need a bespoke trigger-shaped code path.
  const [org] = await db
    .select({ name: orgs.name })
    .from(orgs)
    .where(eq(orgs.id, employee.org_id))
    .limit(1);

  const contextJson = JSON.stringify(context ?? {});
  const promptBody = `[trigger:${trigger_kind}]\ngoal: ${goal}\ncontext: ${contextJson}`;

  const startTime = Date.now();
  let resultText = '';
  let turnResult: 'success' | 'timeout' | 'error' = 'success';
  let turnError: string | null = null;

  try {
    const result = await Promise.race([
      runAgentQuery({
        content: promptBody,
        orgId: employee.org_id,
        userId: employee.user_id,
        orgName: org?.name ?? 'Unknown',
        mode: 'background',
        systemPromptOverride: employee.system_prompt,
        trustLevelOverride: employee.trust_level,
        agentEmployeeId: employee.id,
        // Triggers run without a human in the loop; matching the chat-mention
        // path we skip the self-verification pass.
        skipVerification: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `employee-trigger: runAgentQuery timeout after ${TRIGGER_TIMEOUT_MS}ms`,
              ),
            ),
          TRIGGER_TIMEOUT_MS,
        ),
      ),
    ]);
    resultText = result.text ?? '';
  } catch (err) {
    turnResult = err instanceof Error && /timeout/i.test(err.message) ? 'timeout' : 'error';
    turnError = err instanceof Error ? err.message : String(err);
    console.error(
      `[employee-trigger] native dispatch failed for ${employee.slug}:`,
      turnError,
    );
  }

  const latencyMs = Date.now() - startTime;

  // Persist the inspector turn row.
  await db.insert(agentSessionTurns).values({
    org_id: employee.org_id,
    employee_id: employee.id,
    trigger_kind,
    triggering_message_id: null,
    space_id: spaceId ?? null,
    input_messages_json: [{ role: 'user', content: promptBody }],
    raw_reply_text: resultText || null,
    latency_ms: latencyMs,
    model_name: null,
    tokens_in: null,
    tokens_out: null,
    result: turnResult,
    error: turnError,
  });

  if (!resultText || turnResult !== 'success') {
    return;
  }

  // Post the reply as a message authored by the employee's shadow user.
  if (spaceId) {
    const [agentMessage] = await db
      .insert(messages)
      .values({
        org_id: employee.org_id,
        space_id: spaceId,
        user_id: employee.user_id,
        content: resultText,
        metadata: {
          is_agent_reply: true,
          trigger_kind,
          agent_employee_id: employee.id,
        },
      })
      .returning();

    // Increment the daily budget.
    await db.execute(
      sql`UPDATE agent_employees SET daily_action_count = daily_action_count + 1 WHERE id = ${employee.id} AND daily_action_count < max_daily_actions`,
    );

    // Broadcast — best-effort, never throws.
    if (agentMessage) {
      try {
        const [userData] = await db
          .select({ name: users.name, avatar_url: users.avatar_url })
          .from(users)
          .where(eq(users.id, employee.user_id))
          .limit(1);
        const io = getIO();
        if (io) {
          io.to(`space:${spaceId}`).emit('message:new', {
            ...agentMessage,
            user_name: userData?.name ?? employee.name,
            user_avatar: userData?.avatar_url ?? null,
            reactions: [],
            reply_count: 0,
            latest_reply_at: null,
          });
        }
      } catch {
        // Socket errors are non-fatal; the row is already persisted.
      }
    }
  }

  invalidatePlatformContextCacheFor(employee.id);
}
