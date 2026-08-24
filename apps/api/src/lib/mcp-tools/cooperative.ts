/**
 * Self-hosted v1 — cooperative-knowledge + control MCP tools.
 *
 * Nine tools live here:
 *
 *   ── Cooperative knowledge (aspirational, no trust gating) ──
 *   record_conversation_turn  — inbound message the agent handled
 *   record_decision           — a choice the agent made with rationale
 *   record_outcome            — success/failure of an action taken
 *   record_reasoning_step     — an internal reasoning beat
 *   record_action_attempt     — an action the agent tried (approved or not)
 *   record_progress           — a bounded, task-linked employee milestone
 *
 *   ── Control surface (maps onto existing primitives) ──
 *   request_human_approval    — queue an agent_actions row for a human
 *   poll_pending_work         — what's pending for this employee
 *   ping_alive                — bump last_heartbeat_at
 *
 * The five general `record_*` tools append to `agent_cooperative_log` with the
 * same shape: summary + metadata + optional session_turn_id. They don't
 * gate on trust level — the point is to receive the agent's voice
 * verbatim. `record_progress` uses the same log with a stricter, correlated,
 * secret-safe contract and mirrors the milestone into task activity.
 *
 * The three control tools reuse primitives that already exist: agent
 * heartbeat timestamps (`ping_alive`), the agent_actions approval queue
 * (`request_human_approval` and `poll_pending_work`). That keeps the
 * self-hosted surface consistent with the native agent's action log.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  agentActions,
  agentChannelEvents,
  agentCooperativeLog,
  agentEmployees,
  messages,
  spaceMembers,
  taskActivity,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { normalizeMcpApprovalAction } from '../mcp-approval-actions.js';
import { getIO } from '../../socket.js';

// ─── Cooperative knowledge ────────────────────────────────────────────────

type RecordArgs = {
  summary?: string;
  metadata?: Record<string, unknown> | null;
  session_turn_id?: string | null;
};

type ProgressArgs = {
  summary?: string;
  status?: 'working' | 'retrying' | 'waiting_human' | 'needs_human' | 'blocked' | 'approval_pending';
  idempotency_key?: string;
  artifact_refs?: Array<{
    kind?: string;
    label?: string;
    reference?: string;
  }>;
};

const PROGRESS_STATUSES = new Set([
  'working',
  'retrying',
  'waiting_human',
  'needs_human',
  'blocked',
  'approval_pending',
]);
const CREDENTIAL_LIKE_TEXT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]/i;
const SAFE_ARTIFACT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,499}$/;

function progressDigest(ctx: ToolContext, eventId: string, idempotencyKey: string): string {
  return `sha256:${createHash('sha256')
    .update(`${ctx.org_id}\u0000${ctx.employee_id}\u0000${eventId}\u0000${idempotencyKey}`)
    .digest('hex')}`;
}

function safeArtifactReference(value: string): string | null {
  const trimmed = value.trim().slice(0, 500);
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.username || url.password || CREDENTIAL_LIKE_TEXT.test(url.pathname)) return null;
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 500);
    } catch {
      return null;
    }
  }
  if (CREDENTIAL_LIKE_TEXT.test(trimmed)) return null;
  return SAFE_ARTIFACT_REFERENCE.test(trimmed) ? trimmed : null;
}

function boundedArtifacts(value: ProgressArgs['artifact_refs']) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const kind = typeof candidate.kind === 'string' ? candidate.kind.trim().slice(0, 64) : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim().slice(0, 200) : '';
    const reference = typeof candidate.reference === 'string'
      ? safeArtifactReference(candidate.reference)
      : null;
    if (!kind || !label || !reference || CREDENTIAL_LIKE_TEXT.test(kind) || CREDENTIAL_LIKE_TEXT.test(label)) return [];
    return [{ kind, label, reference }];
  });
}

/**
 * Persist one meaningful, task-linked milestone for the currently executing
 * Agent Channel event. The active lease is the source of task correlation;
 * model-authored arguments never choose another task or employee.
 */
export async function recordProgress(args: ProgressArgs, ctx: ToolContext): Promise<ToolResult> {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
  const status = args.status ?? 'working';
  if (!summary || summary.length > 600) {
    return errorResult('summary is required and must be at most 600 characters');
  }
  if (CREDENTIAL_LIKE_TEXT.test(summary)) {
    return errorResult('summary must not contain credentials or secrets');
  }
  if (typeof status !== 'string' || !PROGRESS_STATUSES.has(status)) {
    return errorResult('status must be one of working, retrying, waiting_human, needs_human, blocked, or approval_pending');
  }
  if (!idempotencyKey || idempotencyKey.length > 300) {
    return errorResult('idempotency_key is required and must be at most 300 characters');
  }
  if (!ctx.channel_event_id || !ctx.runtime_request_key) {
    return errorResult('record_progress requires an active Agent Channel assignment');
  }

  const eventId = ctx.channel_event_id;
  const digest = progressDigest(ctx, eventId, idempotencyKey);
  const artifacts = boundedArtifacts(args.artifact_refs);
  const recorded = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-progress:${digest}`}, 0))`);
    const [event] = await tx.select({
      id: agentChannelEvents.id,
      org_id: agentChannelEvents.org_id,
      employee_id: agentChannelEvents.agent_employee_id,
      source_kind: agentChannelEvents.source_kind,
      source_id: agentChannelEvents.source_id,
      status: agentChannelEvents.status,
    }).from(agentChannelEvents).where(and(
      eq(agentChannelEvents.id, eventId),
      eq(agentChannelEvents.org_id, ctx.org_id),
      eq(agentChannelEvents.agent_employee_id, ctx.employee_id),
    )).limit(1);
    if (!event || event.source_kind !== 'task' || !event.source_id) {
      return { error: 'record_progress is only available for an active task assignment' } as const;
    }
    if (['completed', 'failed', 'cancelled'].includes(event.status)) {
      return { error: 'record_progress cannot append to a terminal assignment' } as const;
    }

    const [existing] = await tx.select({
      id: agentCooperativeLog.id,
      created_at: agentCooperativeLog.created_at,
    }).from(agentCooperativeLog).where(and(
      eq(agentCooperativeLog.org_id, ctx.org_id),
      eq(agentCooperativeLog.employee_id, ctx.employee_id),
      eq(agentCooperativeLog.kind, 'milestone'),
      sql`${agentCooperativeLog.metadata}->>'idempotency_digest' = ${digest}`,
      sql`${agentCooperativeLog.metadata}->>'channel_event_id' = ${eventId}`,
    )).limit(1);
    if (existing) {
      return {
        replayed: true,
        log_id: existing.id,
        task_id: event.source_id,
        recorded_at: existing.created_at,
      } as const;
    }

    const [log] = await tx.insert(agentCooperativeLog).values({
      org_id: ctx.org_id,
      employee_id: ctx.employee_id,
      kind: 'milestone',
      summary,
      metadata: {
        status,
        task_id: event.source_id,
        channel_event_id: eventId,
        runtime_request_key: ctx.runtime_request_key,
        idempotency_digest: digest,
        artifacts,
      },
      session_turn_id: ctx.runtime_request_key,
    }).returning({ id: agentCooperativeLog.id, created_at: agentCooperativeLog.created_at });
    const [activity] = await tx.insert(taskActivity).values({
      org_id: ctx.org_id,
      task_id: event.source_id,
      user_id: null,
      action: 'agent_progress',
      field: 'progress',
      old_value: status,
      new_value: summary,
      acting_agent_employee_id: ctx.employee_id,
    }).returning({ id: taskActivity.id });
    return {
      replayed: false,
      log_id: log!.id,
      activity_id: activity!.id,
      task_id: event.source_id,
      recorded_at: log!.created_at,
    } as const;
  });

  if ('error' in recorded && typeof recorded.error === 'string') return errorResult(recorded.error);
  if (!recorded.replayed) {
    getIO()?.to(`org:${ctx.org_id}`).emit('task:agent_progress', {
      task_id: recorded.task_id,
      agent_employee_id: ctx.employee_id,
      step_index: 0,
      total_steps: 1,
      step_description: summary,
      status: status === 'working' || status === 'retrying'
        ? 'started'
        : status === 'waiting_human'
          ? 'needs_human'
          : status,
    });
  }

  return textResult({ ok: true, kind: 'milestone', status, ...recorded });
}

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
