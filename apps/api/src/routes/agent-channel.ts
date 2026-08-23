/**
 * Agent Channel API v1.
 *
 * This is the live delivery plane for always-on BYOA runtimes. MCP remains the
 * tool plane; this route lets a runtime receive Deft workplace events, ack
 * them, post replies, and report status. Auth uses a channel-specific bearer
 * token so live delivery can be revoked independently of MCP tool access.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentActions,
  agentChannelDeliveryAttempts,
  agentChannelEvents,
  agentEmployees,
} from '@deft/db/schema';
import {
  extractBearer,
  McpAuthError,
} from '../lib/mcp-token.js';
import {
  AGENT_CHANNEL_PROTOCOL_VERSION,
  AGENT_CHANNEL_DEFAULT_LEASE_MS,
  getAgentChannelPrincipal,
  hasActiveAgentChannelClaim,
  listPendingChannelEvents,
  renewAgentChannelEventLease,
  resolveAgentChannelBearer,
  touchAgentChannelConnection,
  updateAgentChannelCursor,
  type AgentChannelPrincipal,
} from '../lib/agent-channel.js';
import { getIO } from '../socket.js';
import { executeSendMessage } from '../lib/mcp-tools/writes.js';
import { buildAgentChannelLifecyclePatch } from '../lib/agent-channel-lifecycle.js';

export const agentChannelRoutes = new Hono();

function emitTaskProgress(event: typeof agentChannelEvents.$inferSelect, employeeId: string, status: string, detail?: string | null) {
  if (event.source_kind !== 'task' || !event.source_id) return;
  const normalized = status === 'running' || status === 'working' || status === 'typing'
    ? 'started'
    : status;
  getIO()?.to(`org:${event.org_id}`).emit('task:agent_progress', {
    task_id: event.source_id,
    agent_employee_id: employeeId,
    step_index: 0,
    total_steps: 1,
    step_description: detail || 'Agent employee activity updated',
    status: normalized,
    error: normalized === 'failed' ? detail ?? undefined : undefined,
  });
}

const ackSchema = z.object({
  event_id: z.string().min(1),
  state: z.enum(['received', 'completed', 'needs_human', 'blocked', 'failed', 'cancelled']).default('received'),
  claim_token: z.string().min(1),
  lease_ms: z.number().int().positive().optional(),
  runtime_session_key: z.string().min(1).optional(),
  detail: z.string().max(2000).optional(),
  error: z.string().max(4000).optional(),
  caller_employee_slug: z.string().optional(),
});

const replySchema = z.object({
  event_id: z.string().min(1),
  content: z.string().min(1).max(16000),
  thread_id: z.string().nullable().optional(),
  idempotency_key: z.string().min(1).max(300).optional(),
  claim_token: z.string().min(1),
  outcome: z.enum(['completed', 'needs_human', 'blocked', 'failed', 'cancelled']).default('completed'),
  summary: z.string().max(2000).optional(),
  runtime_session_key: z.string().min(1).optional(),
  caller_employee_slug: z.string().optional(),
});

const statusSchema = z.object({
  state: z.enum(['idle', 'typing', 'working', 'approval_pending', 'degraded', 'error']),
  event_id: z.string().optional(),
  claim_token: z.string().min(1).optional(),
  lease_ms: z.number().int().positive().optional(),
  detail: z.string().max(2000).optional(),
  caller_employee_slug: z.string().optional(),
});

function errorResponse(c: Context, status: 400 | 401 | 403 | 404 | 409 | 500, code: string, message: string) {
  return c.json({ error: message, code }, status);
}

async function resolveChannelPrincipal(c: Context, callerSlug?: string | null): Promise<AgentChannelPrincipal | Response> {
  const bearer = extractBearer(c.req.header('Authorization'));
  if (!bearer) {
    return errorResponse(c, 401, 'UNAUTHORIZED', 'Missing bearer token');
  }

  try {
    const resolved = await resolveAgentChannelBearer(bearer);
    if (callerSlug && resolved.employee_slug !== callerSlug) {
      return errorResponse(c, 403, 'FORBIDDEN', `Declared caller_employee_slug "${callerSlug}" is not registered for this channel token`);
    }
    const principal = await getAgentChannelPrincipal(resolved.employee_id, resolved.org_id);
    if (!principal) {
      return errorResponse(c, 403, 'FORBIDDEN', 'Agent employee is inactive, deleted, or missing');
    }
    return principal;
  } catch (err) {
    if (err instanceof McpAuthError) {
      return errorResponse(c, err.status as 401 | 403 | 400, err.code.toUpperCase(), err.message);
    }
    console.error('[agent-channel] auth error:', err);
    return errorResponse(c, 500, 'INTERNAL_ERROR', 'Agent channel auth failed');
  }
}

function isResponse(value: AgentChannelPrincipal | Response): value is Response {
  return value instanceof Response;
}

async function getEventForPrincipal(eventId: string, principal: AgentChannelPrincipal) {
  const [event] = await db
    .select()
    .from(agentChannelEvents)
    .where(
      and(
        eq(agentChannelEvents.id, eventId),
        eq(agentChannelEvents.org_id, principal.org_id),
        eq(agentChannelEvents.agent_employee_id, principal.employee_id),
      ),
    )
    .limit(1);
  return event ?? null;
}

async function closeFallbackWorkForEvent(params: {
  event: typeof agentChannelEvents.$inferSelect;
  principal: AgentChannelPrincipal;
  runtimeSessionKey?: string | null;
  detail?: string | null;
  outcome?: 'completed' | 'needs_human' | 'blocked' | 'failed' | 'cancelled';
}) {
  const payload = (params.event.payload ?? {}) as Record<string, unknown>;
  const actionId = typeof payload.pending_action_id === 'string' ? payload.pending_action_id : null;
  if (!actionId) return;
  const now = new Date();
  await db
    .update(agentActions)
    .set({
      approval_status: 'approved',
      approved_at: now,
      executed_at: now,
      result: {
        channel_event_id: params.event.id,
        channel_state: 'completed',
        work_outcome: params.outcome ?? 'completed',
        runtime_session_key: params.runtimeSessionKey ?? null,
        detail: params.detail ?? null,
      },
      error: null,
      updated_at: now,
    })
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, params.principal.org_id),
      eq(agentActions.agent_employee_id, params.principal.employee_id),
      eq(agentActions.approval_status, 'pending'),
    ));
}

agentChannelRoutes.get('/connect', async (c) => {
  const principal = await resolveChannelPrincipal(c, c.req.query('caller_employee_slug'));
  if (isResponse(principal)) return principal;

  const connection = await touchAgentChannelConnection(principal);
  await updateAgentChannelCursor({ principal, connectionId: connection?.id ?? null });

  return c.json({
    ok: true,
    protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
    employee: {
      id: principal.employee_id,
      slug: principal.employee_slug,
      runtime_kind: principal.runtime_kind,
      trust_level: principal.trust_level,
    },
    connection,
  });
});

agentChannelRoutes.get('/events', async (c) => {
  const principal = await resolveChannelPrincipal(c, c.req.query('caller_employee_slug'));
  if (isResponse(principal)) return principal;

  const limit = Number.parseInt(c.req.query('limit') ?? '25', 10);
  const workerId = c.req.query('worker_id')?.trim();
  if (!workerId) {
    return errorResponse(c, 400, 'VALIDATION_ERROR', 'worker_id is required');
  }
  const leaseMs = Number.parseInt(c.req.query('lease_ms') ?? String(AGENT_CHANNEL_DEFAULT_LEASE_MS), 10);
  const afterEventId = c.req.query('cursor') ?? c.req.query('after_event_id') ?? null;
  const events = await listPendingChannelEvents({
    principal,
    limit: Number.isFinite(limit) ? limit : 25,
    afterEventId,
    workerId,
    leaseMs: Number.isFinite(leaseMs) ? leaseMs : AGENT_CHANNEL_DEFAULT_LEASE_MS,
  });
  const lastEventId = events.at(-1)?.id ?? null;
  const connection = await touchAgentChannelConnection(principal, { lastEventId });
  if (lastEventId) {
    await updateAgentChannelCursor({
      principal,
      connectionId: connection?.id ?? null,
      lastDeliveredEventId: lastEventId,
    });
  }

  return c.json({
    ok: true,
    protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
    cursor: lastEventId,
    events,
  });
});

agentChannelRoutes.post('/ack', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = ackSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const principal = await resolveChannelPrincipal(c, parsed.data.caller_employee_slug);
  if (isResponse(principal)) return principal;

  const event = await getEventForPrincipal(parsed.data.event_id, principal);
  if (!event) {
    return errorResponse(c, 404, 'NOT_FOUND', 'Channel event not found');
  }
  if (!hasActiveAgentChannelClaim(event, parsed.data.claim_token)) {
    return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim is missing, expired, or owned by another worker');
  }

  const reportedOutcome = parsed.data.state === 'received' ? null : parsed.data.state;
  const lifecycleSignal = parsed.data.state === 'received'
    ? 'acknowledged'
    : parsed.data.state === 'failed'
      ? 'failed'
      : parsed.data.state === 'cancelled'
        ? 'cancelled'
        : 'completed';

  const patch = buildAgentChannelLifecyclePatch(
    event,
    lifecycleSignal,
    new Date(),
    parsed.data.error ?? parsed.data.detail,
  );
  const now = new Date();
  const requestedLeaseMs = parsed.data.lease_ms ?? AGENT_CHANNEL_DEFAULT_LEASE_MS;
  const leaseMs = Math.min(Math.max(requestedLeaseMs, 30_000), 600_000);
  const claimPatch = parsed.data.state === 'received'
    ? {
        lease_expires_at: new Date(now.getTime() + leaseMs),
        runtime_session_key: parsed.data.runtime_session_key ?? event.runtime_session_key,
      }
    : {
        lease_expires_at: null,
        work_outcome: reportedOutcome,
        outcome_detail: parsed.data.detail ?? parsed.data.error ?? null,
        outcome_at: now,
        runtime_session_key: parsed.data.runtime_session_key ?? event.runtime_session_key,
      };

  let updated = event;
  if (Object.keys(patch).length > 0 || Object.keys(claimPatch).length > 0) {
    const [updatedRow] = await db
      .update(agentChannelEvents)
      .set({ ...patch, ...claimPatch })
      .where(and(
        eq(agentChannelEvents.id, event.id),
        eq(agentChannelEvents.org_id, principal.org_id),
        eq(agentChannelEvents.agent_employee_id, principal.employee_id),
        eq(agentChannelEvents.claim_token, parsed.data.claim_token),
        sql`${agentChannelEvents.lease_expires_at} > now()`,
      ))
      .returning();
    if (!updatedRow) {
      return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim expired before the acknowledgement committed');
    }
    updated = updatedRow;
  }

  await touchAgentChannelConnection(principal, {
    status: parsed.data.state === 'failed' ? 'degraded' : 'connected',
    lastEventId: event.id,
    lastError: parsed.data.state === 'failed' ? patch.error ?? 'Runtime reported failure' : null,
  });
  await updateAgentChannelCursor({ principal, lastAckedEventId: event.id });
  if (reportedOutcome) {
    await db.update(agentEmployees)
      .set({ last_work_outcome_at: now, updated_at: now })
      .where(and(
        eq(agentEmployees.id, principal.employee_id),
        eq(agentEmployees.org_id, principal.org_id),
      ));
    await closeFallbackWorkForEvent({
      event,
      principal,
      runtimeSessionKey: parsed.data.runtime_session_key ?? null,
      detail: parsed.data.detail ?? null,
      outcome: reportedOutcome,
    });
    emitTaskProgress(event, principal.employee_id, reportedOutcome, parsed.data.detail ?? parsed.data.error);
  }

  return c.json({ ok: true, event: updated });
});

agentChannelRoutes.post('/reply', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = replySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const principal = await resolveChannelPrincipal(c, parsed.data.caller_employee_slug);
  if (isResponse(principal)) return principal;

  const event = await getEventForPrincipal(parsed.data.event_id, principal);
  if (!event) {
    return errorResponse(c, 404, 'NOT_FOUND', 'Channel event not found');
  }
  if (!event.space_id) {
    return errorResponse(c, 409, 'NO_REPLY_TARGET', 'Channel event has no Deft space to reply into');
  }

  const idempotencyKey = parsed.data.idempotency_key
    ?? `reply:${event.id}:${Buffer.from(parsed.data.content).toString('base64url').slice(0, 64)}`;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const isTopLevelDm = payload.is_dm === true && !payload.parent_id;
  const hasExplicitThreadId = Object.prototype.hasOwnProperty.call(parsed.data, 'thread_id');
  const parentId = hasExplicitThreadId
    ? (parsed.data.thread_id ?? null)
    : (isTopLevelDm ? null : (event.thread_id ?? event.source_id ?? null));
  const requestJson = {
    event_id: event.id,
    content: parsed.data.content,
    thread_id: parentId,
    outcome: parsed.data.outcome,
    summary: parsed.data.summary ?? null,
    runtime_session_key: parsed.data.runtime_session_key ?? null,
  };

  const [existingAttempt] = await db
    .select()
    .from(agentChannelDeliveryAttempts)
    .where(
      and(
        eq(agentChannelDeliveryAttempts.org_id, principal.org_id),
        eq(agentChannelDeliveryAttempts.agent_employee_id, principal.employee_id),
        eq(agentChannelDeliveryAttempts.idempotency_key, idempotencyKey),
      ),
    )
    .limit(1);
  if (existingAttempt?.response_json) {
    return c.json({ ok: true, idempotent: true, result: existingAttempt.response_json });
  }
  if (existingAttempt) {
    return errorResponse(c, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A reply with this idempotency key is already in progress');
  }
  if (!hasActiveAgentChannelClaim(event, parsed.data.claim_token)) {
    return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim is missing, expired, or owned by another worker');
  }

  const [claim] = await db
    .insert(agentChannelDeliveryAttempts)
    .values({
      org_id: principal.org_id,
      agent_employee_id: principal.employee_id,
      event_id: event.id,
      direction: 'inbound_reply',
      idempotency_key: idempotencyKey,
      status: 'started',
      request_json: requestJson,
    })
    .onConflictDoNothing({
      target: [
        agentChannelDeliveryAttempts.org_id,
        agentChannelDeliveryAttempts.agent_employee_id,
        agentChannelDeliveryAttempts.idempotency_key,
      ],
    })
    .returning({ id: agentChannelDeliveryAttempts.id });

  if (!claim) {
    const [latestAttempt] = await db
      .select()
      .from(agentChannelDeliveryAttempts)
      .where(
        and(
          eq(agentChannelDeliveryAttempts.org_id, principal.org_id),
          eq(agentChannelDeliveryAttempts.agent_employee_id, principal.employee_id),
          eq(agentChannelDeliveryAttempts.idempotency_key, idempotencyKey),
        ),
      )
      .limit(1);
    if (latestAttempt?.response_json) {
      return c.json({ ok: true, idempotent: true, result: latestAttempt.response_json });
    }
    return errorResponse(c, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A reply with this idempotency key is already in progress');
  }

  const result = await executeSendMessage({
    orgId: principal.org_id,
    spaceId: event.space_id,
    content: parsed.data.content,
    parentId,
    ctx: {
      org_id: principal.org_id,
      employee_id: principal.employee_id,
      employee_slug: principal.employee_slug,
      trust_level: principal.trust_level,
    },
  });

  const text = result.content?.[0]?.text ?? '{}';
  let responseJson: Record<string, unknown>;
  try {
    responseJson = JSON.parse(text);
  } catch {
    responseJson = { raw: text };
  }

  await db
    .update(agentChannelDeliveryAttempts)
    .set({
      status: result.isError ? 'failed' : 'completed',
      response_json: responseJson,
      error: result.isError ? text : null,
      updated_at: new Date(),
    })
    .where(eq(agentChannelDeliveryAttempts.id, claim.id));

  const reportedOutcome = result.isError ? 'failed' : parsed.data.outcome;
  const lifecyclePatch = buildAgentChannelLifecyclePatch(
    event,
    reportedOutcome === 'failed'
      ? 'failed'
      : reportedOutcome === 'cancelled'
        ? 'cancelled'
        : 'completed',
    new Date(),
    result.isError ? text : null,
  );
  const outcomeAt = new Date();
  if (Object.keys(lifecyclePatch).length > 0) {
    const [settled] = await db
      .update(agentChannelEvents)
      .set({
        ...lifecyclePatch,
        lease_expires_at: null,
        work_outcome: reportedOutcome,
        outcome_detail: parsed.data.summary ?? (result.isError ? text : null),
        outcome_at: outcomeAt,
        runtime_session_key: parsed.data.runtime_session_key ?? event.runtime_session_key,
      })
      .where(and(
        eq(agentChannelEvents.id, event.id),
        eq(agentChannelEvents.claim_token, parsed.data.claim_token),
      ))
      .returning({ id: agentChannelEvents.id });
    if (!settled) {
      return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim changed before the reply could settle');
    }
  }

  await db.update(agentEmployees)
    .set({ last_work_outcome_at: outcomeAt, updated_at: outcomeAt })
    .where(and(
      eq(agentEmployees.id, principal.employee_id),
      eq(agentEmployees.org_id, principal.org_id),
    ));

  emitTaskProgress(event, principal.employee_id, reportedOutcome, parsed.data.summary ?? (result.isError ? text : null));

  await touchAgentChannelConnection(principal, {
    status: result.isError ? 'degraded' : 'connected',
    lastEventId: event.id,
    lastError: result.isError ? text : null,
  });
  await updateAgentChannelCursor({ principal, lastAckedEventId: event.id });
  if (!result.isError) {
    await closeFallbackWorkForEvent({
      event,
      principal,
      runtimeSessionKey: parsed.data.runtime_session_key ?? null,
      detail: parsed.data.summary ?? 'Runtime replied through the Agent Channel.',
      outcome: reportedOutcome,
    });
  }

  return c.json({ ok: !result.isError, idempotent: false, outcome: reportedOutcome, result: responseJson }, result.isError ? 500 : 200);
});

agentChannelRoutes.post('/status', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = statusSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const principal = await resolveChannelPrincipal(c, parsed.data.caller_employee_slug);
  if (isResponse(principal)) return principal;

  const connectionStatus = parsed.data.state === 'error' || parsed.data.state === 'degraded'
    ? 'degraded'
    : 'connected';

  if (parsed.data.event_id) {
    const event = await getEventForPrincipal(parsed.data.event_id, principal);
    const signal = parsed.data.state === 'approval_pending'
      ? 'approval_pending'
      : parsed.data.state === 'working' || parsed.data.state === 'typing'
        ? 'running'
        : null;
    if (event && signal) {
      if (!parsed.data.claim_token) {
        return errorResponse(c, 409, 'STALE_CLAIM', 'claim_token is required for event progress updates');
      }
      const renewed = await renewAgentChannelEventLease({
        principal,
        eventId: event.id,
        claimToken: parsed.data.claim_token,
        leaseMs: parsed.data.lease_ms,
      });
      if (!renewed) {
        return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim is missing, expired, or owned by another worker');
      }
      const lifecyclePatch = buildAgentChannelLifecyclePatch(event, signal);
      if (Object.keys(lifecyclePatch).length > 0) {
        await db
          .update(agentChannelEvents)
          .set(lifecyclePatch)
          .where(and(
            eq(agentChannelEvents.id, event.id),
            eq(agentChannelEvents.claim_token, parsed.data.claim_token),
          ));
      }
      emitTaskProgress(event, principal.employee_id, signal, parsed.data.detail);
    }
  }

  const connection = await touchAgentChannelConnection(principal, {
    status: connectionStatus,
    lastEventId: parsed.data.event_id ?? null,
    lastError: parsed.data.state === 'error' ? parsed.data.detail ?? 'Runtime reported error' : null,
  });

  return c.json({
    ok: true,
    state: parsed.data.state,
    detail: parsed.data.detail ?? null,
    connection,
  });
});
