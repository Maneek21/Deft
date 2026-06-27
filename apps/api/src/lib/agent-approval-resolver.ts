/**
 * Phase 6.5 — approval resolver.
 *
 * When Phase 4 write tools queue an action (trust-gated), the row lives in
 * `agent_actions` with `approval_status='pending'`. This module is the
 * consumer: it loads a pending row, verifies the approver, re-builds a
 * ToolContext from the row's employee, dispatches to the matching
 * `execute*` inner function from `mcp-tools/writes.ts` or
 * `mcp-tools/memory-update.ts`, and stamps the row with the outcome.
 *
 * Idempotency: if the row is already approved/rejected, the call is a
 * no-op that returns the current status. This protects against double-clicks
 * from the UI and race conditions between the approve button and an
 * eventual expiry cron.
 *
 * Permission model (MVP): any member of the action's org can approve or
 * reject. We deliberately DO NOT require role='admin' for v1 — the SaaS
 * story is "one org = one small team, everybody trusts everybody" and
 * stricter ACLs can layer on later.
 *
 * Phase 7 hook point: the `generateReceipt({...})` call slots in right
 * after the inner executor returns (both on success and error paths).
 * Today we only mutate the `agent_actions` row; Phase 7 will also insert
 * into `action_receipts` with an HMAC signature.
 *
 * Trust elevation: the rebuilt ToolContext uses the employee's CURRENT
 * `trust_level`, NOT the user's permissions. This matters because the
 * inner `execute*` functions deliberately don't gate — the gating already
 * happened when the row was queued, and re-gating here would bounce
 * every conservative-trust employee's approved writes.
 */
import { eq, and, sql } from 'drizzle-orm';
import { db } from './db.js';
import {
  agentActions,
  agentEmployees,
  orgMembers,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './mcp-tools/types.js';
import type { TrustLevel } from './agent-approval.js';
import {
  executeTaskCreate,
  executeTaskUpdate,
  executeMessagePost,
  executeSendMessage,
  type TaskCreateArgs,
  type TaskUpdateArgs,
  type MessagePostArgs,
  type SendMessageArgs,
} from './mcp-tools/writes.js';
import {
  executeMemoryUpdate,
  type MemoryUpdateArgs,
} from './mcp-tools/memory-update.js';
import { generateReceipt } from './receipts.js';
import {
  markWorkIntentConvertedForAction,
  markWorkIntentDismissedForAction,
  markWorkIntentFailedForAction,
} from './work-intents.js';
export const MCP_ACTION_KINDS = new Set([
  'task_create',
  'task_update',
  'message_post',
  'send_message',
  'memory_update',
]);

export type ApprovalResolverError =
  | { status: 'error'; code: 'NOT_FOUND'; message: string }
  | { status: 'error'; code: 'FORBIDDEN'; message: string }
  | { status: 'error'; code: 'UNSUPPORTED_ACTION'; message: string }
  | { status: 'error'; code: 'EMPLOYEE_MISSING'; message: string }
  | { status: 'error'; code: 'EXECUTE_FAILED'; message: string };

export type ApprovalResolverSuccess =
  | { status: 'approved'; message?: string; result?: unknown }
  | { status: 'rejected'; message?: string };

export type ApprovalResolverResult =
  | ApprovalResolverSuccess
  | ApprovalResolverError;

/**
 * Throws if the user is not a member of the given org. Returns quietly
 * on success.
 */
async function assertUserInOrg(
  userId: string,
  orgId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(
      and(eq(orgMembers.user_id, userId), eq(orgMembers.org_id, orgId)),
    )
    .limit(1);
  return !!row;
}

/** Look up the employee row for a queued action so we can rebuild ctx. */
async function loadEmployeeForAction(employeeId: string) {
  const [row] = await db
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      slug: agentEmployees.slug,
      trust_level: agentEmployees.trust_level,
    })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  return row ?? null;
}

function buildCtxFromEmployee(emp: {
  id: string;
  org_id: string;
  slug: string;
  trust_level: string;
}): ToolContext {
  return {
    org_id: emp.org_id,
    employee_id: emp.id,
    employee_slug: emp.slug,
    trust_level: emp.trust_level as TrustLevel,
  };
}

async function dispatchAction(
  actionName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  actionId?: string,
): Promise<ToolResult> {
  // Phase 7 — skipReceipt=true: the approval resolver owns receipt
  // generation for approved actions (it knows the approver_id). The inner
  // executors only emit receipts in the auto-exec path.
  const opts = { skipReceipt: true, actionId } as const;
  switch (actionName) {
    case 'task_create':
      return executeTaskCreate(params as unknown as TaskCreateArgs, ctx, opts);
    case 'task_update':
      return executeTaskUpdate(params as unknown as TaskUpdateArgs, ctx, opts);
    case 'message_post':
      return executeMessagePost(params as unknown as MessagePostArgs, ctx, opts);
    case 'send_message': {
      const p = params as unknown as SendMessageArgs & {
        resolved_space_id?: string;
        parent_id?: string | null;
      };
      const target = (p.target ?? {}) as Partial<{ space_id: string }>;
      const spaceId =
        p.resolved_space_id ??
        target.space_id;
      if (!spaceId) {
        return {
          content: [{
            type: 'text',
            text: 'send_message approval is missing resolved_space_id',
          }],
          isError: true,
        };
      }
      return executeSendMessage(
        {
          orgId: ctx.org_id,
          spaceId,
          content: p.content,
          parentId: p.parent_id ?? null,
          ctx,
        },
        opts,
      );
    }
    case 'memory_update':
      return executeMemoryUpdate(params as unknown as MemoryUpdateArgs, ctx, opts);
    default:
      throw new Error(`Unsupported action: ${actionName}`);
  }
}

/**
 * Approve a pending action. Idempotent: already-approved actions return
 * the stored result; already-rejected actions return the current status.
 *
 * Permission: approver must be a member of the action's org. 403 otherwise.
 */
export async function approveAction(
  actionId: string,
  approverUserId: string,
): Promise<ApprovalResolverResult> {
  // Pre-checks read immutable fields so they are safe to run before the
  // atomic claim. If any pre-check fails we return without ever flipping
  // the row.
  const [row] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, actionId))
    .limit(1);

  if (!row) {
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `agent_actions row ${actionId} not found`,
    };
  }

  // Idempotency: already in a terminal state.
  if (row.approval_status === 'approved') {
    return {
      status: 'approved',
      message: 'already approved',
      result: row.result ?? undefined,
    };
  }
  if (row.approval_status === 'rejected') {
    return {
      status: 'rejected',
      message: 'already rejected',
    };
  }
  if (row.approval_status === 'expired') {
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `action ${actionId} has expired`,
    };
  }

  // Permission check.
  const isMember = await assertUserInOrg(approverUserId, row.org_id);
  if (!isMember) {
    return {
      status: 'error',
      code: 'FORBIDDEN',
      message: 'approver is not a member of the action org',
    };
  }

  if (!MCP_ACTION_KINDS.has(row.action)) {
    return {
      status: 'error',
      code: 'UNSUPPORTED_ACTION',
      message: `approval resolver does not handle action kind "${row.action}"`,
    };
  }

  if (!row.agent_employee_id) {
    return {
      status: 'error',
      code: 'EMPLOYEE_MISSING',
      message: 'queued MCP action has no agent_employee_id',
    };
  }

  const emp = await loadEmployeeForAction(row.agent_employee_id);
  if (!emp) {
    return {
      status: 'error',
      code: 'EMPLOYEE_MISSING',
      message: `agent_employee ${row.agent_employee_id} not found`,
    };
  }

  const ctx = buildCtxFromEmployee(emp);

  // Phase 12 review fix — atomic claim. Two concurrent callers could both
  // pass the `status === 'pending'` read above; the UPDATE … WHERE … AND
  // approval_status = 'pending' only succeeds for one of them. If this
  // returns zero rows, we lost the race and return the idempotent result.
  const claimed = await db.execute(
    sql`UPDATE agent_actions
           SET approval_status = 'approved', approved_at = NOW()
         WHERE id = ${actionId} AND approval_status = 'pending'
         RETURNING id`,
  );
  const claimedRows =
    (claimed as { rows?: any[] }).rows ?? (claimed as unknown as any[]);
  if (claimedRows.length === 0) {
    const [winner] = await db
      .select()
      .from(agentActions)
      .where(eq(agentActions.id, actionId))
      .limit(1);
    return {
      status: 'approved',
      message: 'already approved (lost race)',
      result: winner?.result ?? undefined,
    };
  }

  let toolResult: ToolResult;
  let caughtError: Error | null = null;
  try {
    toolResult = await dispatchAction(
      row.action,
      (row.params ?? {}) as Record<string, unknown>,
      ctx,
      row.id,
    );
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
    toolResult = {
      content: [{ type: 'text', text: caughtError.message }],
      isError: true,
    };
  }

  const isError = toolResult.isError === true;
  const resultText = toolResult.content?.[0]?.text ?? '';
  let parsedResult: unknown = resultText;
  try {
    parsedResult = JSON.parse(resultText);
  } catch {
    // leave as string
  }

  // Stamp exec outcome on the row. approval_status is already 'approved'
  // from the atomic claim; we only touch executed_at + result/error here.
  const now = new Date();
  await db
    .update(agentActions)
    .set({
      executed_at: now,
      result: (isError ? null : parsedResult) as any,
      error: isError ? String(resultText).slice(0, 2000) : null,
    })
    .where(eq(agentActions.id, actionId));

  // Invalidate platform_context cache for the employee so the next turn
  // sees the new state. executeTaskCreate etc. already do this, but we
  // call it again in case the exec failed before that point.
  try {
    const { invalidatePlatformContextCacheFor } = await import(
      './mcp-tools/context.js'
    );
    invalidatePlatformContextCacheFor(ctx.employee_id);
  } catch {
    // best-effort
  }

  // ── Phase 7 — signed approval receipt ────────────────────────────────
  // The approval decision itself is audit-recorded regardless of whether
  // the inner executor succeeded. decision_reason captures the failure
  // message so a compliance officer can read "approved but execution
  // failed: X" instead of silently losing the decision.
  const isDeftyCapture = row.source === 'defty_capture';
  await generateReceipt({
    actionId: row.id,
    orgId: row.org_id,
    employeeId: ctx.employee_id,
    proposer: isDeftyCapture ? 'defty' : 'employee',
    proposerId: isDeftyCapture ? row.user_id : ctx.employee_id,
    approverId: approverUserId,
    decision: 'approved',
    decisionReason: isError
      ? `execution failed: ${resultText || caughtError?.message || 'unknown'}`.slice(0, 2000)
      : null,
    actionName: row.action,
    actionParams: (row.params ?? {}) as Record<string, unknown>,
    resultJson: isError ? null : parsedResult,
  });

  if (isError) {
    await markWorkIntentFailedForAction({
      actionId: row.id,
      orgId: row.org_id,
      actionParams: row.params,
      reason: resultText || caughtError?.message || 'execution failed',
    });
  } else {
    await markWorkIntentConvertedForAction({
      actionId: row.id,
      orgId: row.org_id,
      actionParams: row.params,
      result: parsedResult,
      convertedBy: approverUserId,
    });
  }

  if (isError) {
    return {
      status: 'error',
      code: 'EXECUTE_FAILED',
      message: resultText || caughtError?.message || 'execution failed',
    };
  }

  return {
    status: 'approved',
    result: parsedResult,
  };
}

/**
 * Reject a pending action. Idempotent.
 *
 * Permission: rejecter must be a member of the action's org.
 * Schema has no `rejected_at` column — we use `updated_at` (auto-managed)
 * plus stash the reason in the `error` column so the UI can surface it.
 */
export async function rejectAction(
  actionId: string,
  rejecterUserId: string,
  reason?: string,
): Promise<ApprovalResolverResult> {
  const [row] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, actionId))
    .limit(1);

  if (!row) {
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `agent_actions row ${actionId} not found`,
    };
  }

  if (row.approval_status === 'rejected') {
    return { status: 'rejected', message: 'already rejected' };
  }
  if (row.approval_status === 'approved') {
    return {
      status: 'approved',
      message: 'already approved — cannot reject after approval',
      result: row.result ?? undefined,
    };
  }
  if (row.approval_status === 'expired') {
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `action ${actionId} has expired`,
    };
  }

  // Permission check.
  const isMember = await assertUserInOrg(rejecterUserId, row.org_id);
  if (!isMember) {
    return {
      status: 'error',
      code: 'FORBIDDEN',
      message: 'rejecter is not a member of the action org',
    };
  }

  await db
    .update(agentActions)
    .set({
      approval_status: 'rejected',
      error: reason ? reason.slice(0, 2000) : null,
    })
    .where(eq(agentActions.id, actionId));

  // ── Phase 7 — signed rejection receipt ───────────────────────────────
  const isDeftyCapture = row.source === 'defty_capture';
  await generateReceipt({
    actionId: row.id,
    orgId: row.org_id,
    employeeId: row.agent_employee_id ?? null,
    proposer: isDeftyCapture ? 'defty' : 'employee',
    proposerId: isDeftyCapture ? row.user_id : row.agent_employee_id ?? null,
    approverId: rejecterUserId,
    decision: 'rejected',
    decisionReason: reason ?? null,
    actionName: row.action,
    actionParams: (row.params ?? {}) as Record<string, unknown>,
    resultJson: null,
  });

  await markWorkIntentDismissedForAction({
    actionId: row.id,
    orgId: row.org_id,
    actionParams: row.params,
    dismissedBy: rejecterUserId,
    reason: reason ?? null,
  });

  return { status: 'rejected', message: reason };
}
