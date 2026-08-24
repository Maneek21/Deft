/**
 * Self-hosted v1 — cooperative-knowledge + control MCP tools.
 *
 * Eight tools live here:
 *
 *   ── Cooperative knowledge (aspirational, no trust gating) ──
 *   record_conversation_turn  — inbound message the agent handled
 *   record_decision           — a choice the agent made with rationale
 *   record_outcome            — success/failure of an action taken
 *   record_reasoning_step     — an internal reasoning beat
 *   record_action_attempt     — an action the agent tried (approved or not)
 *
 *   ── Control surface (maps onto existing primitives) ──
 *   request_human_approval    — queue an agent_actions row for a human
 *   poll_pending_work         — what's pending for this employee
 *   ping_alive                — bump last_heartbeat_at
 *
 * The five `record_*` tools all append to `agent_cooperative_log` with the
 * same shape: summary + metadata + optional session_turn_id. They don't
 * gate on trust level — the point is to receive the agent's voice
 * verbatim. A future session inspector renders the rollup.
 *
 * The three control tools reuse primitives that already exist: agent
 * heartbeat timestamps (`ping_alive`), the agent_actions approval queue
 * (`request_human_approval` and `poll_pending_work`). That keeps the
 * self-hosted surface consistent with the native agent's action log.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db.js';
import {
  agentActions,
  agentCooperativeLog,
  agentEmployees,
  messages,
  spaceMembers,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { normalizeMcpApprovalAction } from '../mcp-approval-actions.js';

// ─── Cooperative knowledge ────────────────────────────────────────────────

type RecordArgs = {
  summary?: string;
  metadata?: Record<string, unknown> | null;
  session_turn_id?: string | null;
};

async function appendLog(
  ctx: ToolContext,
  kind:
    | 'conversation_turn'
    | 'decision'
    | 'outcome'
    | 'reasoning_step'
    | 'action_attempt',
  args: RecordArgs,
): Promise<ToolResult> {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return errorResult('summary is required');
  }
  const [row] = await db
    .insert(agentCooperativeLog)
    .values({
      org_id: ctx.org_id,
      employee_id: ctx.employee_id,
      kind,
      summary,
      metadata: args.metadata ?? null,
      session_turn_id: args.session_turn_id ?? null,
    })
    .returning({ id: agentCooperativeLog.id, created_at: agentCooperativeLog.created_at });
  return textResult({
    ok: true,
    id: row!.id,
    kind,
    recorded_at: row!.created_at,
  });
}

export const recordConversationTurn = (args: RecordArgs, ctx: ToolContext) =>
  appendLog(ctx, 'conversation_turn', args);

export const recordDecision = (args: RecordArgs, ctx: ToolContext) =>
  appendLog(ctx, 'decision', args);

export const recordOutcome = (args: RecordArgs, ctx: ToolContext) =>
  appendLog(ctx, 'outcome', args);

export const recordReasoningStep = (args: RecordArgs, ctx: ToolContext) =>
  appendLog(ctx, 'reasoning_step', args);

export const recordActionAttempt = (args: RecordArgs, ctx: ToolContext) =>
  appendLog(ctx, 'action_attempt', args);

// ─── Control ──────────────────────────────────────────────────────────────

export async function requestHumanApproval(
  args: {
    action?: string;
    summary?: string;
    params?: Record<string, unknown> | null;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!action || !summary) {
    return errorResult('action and summary are required');
  }

  const normalized = normalizeMcpApprovalAction(
    action,
    args.params ?? {},
    ctx.employee_slug,
  );
  if (!normalized.ok) {
    return errorResult(normalized.error);
  }

  const [emp] = await db
    .select({
      created_by: agentEmployees.created_by,
      user_id: agentEmployees.user_id,
    })
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.id, ctx.employee_id),
        eq(agentEmployees.org_id, ctx.org_id),
      ),
    )
    .limit(1);
  if (!emp) {
    return errorResult('employee lookup failed');
  }

  const requestedSourceMessageId = typeof normalized.params.source_message_id === 'string'
    ? normalized.params.source_message_id.trim()
    : '';
  let sourceMessageId: string | null = null;
  if (requestedSourceMessageId) {
    const [visibleSource] = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(
        spaceMembers,
        and(
          eq(spaceMembers.space_id, messages.space_id),
          eq(spaceMembers.user_id, emp.user_id),
        ),
      )
      .where(
        and(
          eq(messages.id, requestedSourceMessageId),
          eq(messages.org_id, ctx.org_id),
          eq(messages.is_deleted, false),
        ),
      )
      .limit(1);
    sourceMessageId = visibleSource?.id ?? null;
  }

  const [row] = await db
    .insert(agentActions)
    .values({
      org_id: ctx.org_id,
      user_id: emp.created_by,
      agent_employee_id: ctx.employee_id,
      channel_event_id: ctx.channel_event_id,
      runtime_request_key: ctx.runtime_request_key,
      message_id: sourceMessageId,
      source: 'mcp',
      action: normalized.action,
      params: {
        ...normalized.params,
        summary,
        requested_by_agent: ctx.employee_slug,
      },
      approval_tier: 'full',
      approval_status: 'pending',
    })
    .returning({ id: agentActions.id });

  return textResult({
    ok: true,
    action_id: row!.id,
    status: 'pending',
    message:
      'Queued for human review. Poll `poll_pending_work` to check for a ' +
      'resolution.',
  });
}

export async function pollPendingWork(
  _args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  console.warn('[mcp] poll_pending_work is deprecated; use fetch_unread (returns both unread messages + pending actions)');
  const pending = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      status: agentActions.approval_status,
      created_at: agentActions.created_at,
    })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.agent_employee_id, ctx.employee_id),
        eq(agentActions.approval_status, 'pending'),
      ),
    )
    .orderBy(desc(agentActions.created_at))
    .limit(25);

  return textResult({
    pending_actions: pending,
  });
}

export async function pingAlive(
  _args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const now = new Date();
  await db
    .update(agentEmployees)
    .set({
      last_heartbeat_at: now,
    })
    .where(
      and(
        eq(agentEmployees.id, ctx.employee_id),
        eq(agentEmployees.org_id, ctx.org_id),
      ),
    );

  return textResult({
    ok: true,
    ts: now.toISOString(),
    employee_slug: ctx.employee_slug,
  });
}
