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
  agentChannelDeliveryAttempts,
  agentChannelEvents,
} from '@deft/db/schema';
import {
  extractBearer,
  McpAuthError,
} from '../lib/mcp-token.js';
import {
  AGENT_CHANNEL_PROTOCOL_VERSION,
  getAgentChannelPrincipal,
  listPendingChannelEvents,
  resolveAgentChannelBearer,
  touchAgentChannelConnection,
  updateAgentChannelCursor,
  type AgentChannelPrincipal,
} from '../lib/agent-channel.js';
import { executeSendMessage } from '../lib/mcp-tools/writes.js';

export const agentChannelRoutes = new Hono();

const ackSchema = z.object({
  event_id: z.string().min(1),
  state: z.enum(['received', 'completed', 'failed']).default('received'),
  runtime_session_key: z.string().min(1).optional(),
  detail: z.string().max(2000).optional(),
  error: z.string().max(4000).optional(),
  caller_employee_slug: z.string().optional(),
});

const replySchema = z.object({
  event_id: z.string().min(1),
  content: z.string().min(1).max(16000),
  thread_id: z.string().optional(),
  idempotency_key: z.string().min(1).max(300).optional(),
  caller_employee_slug: z.string().optional(),
});

const statusSchema = z.object({
  state: z.enum(['idle', 'typing', 'working', 'degraded', 'error']),
  event_id: z.string().optional(),
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
  const afterEventId = c.req.query('cursor') ?? c.req.query('after_event_id') ?? null;
  const events = await listPendingChannelEvents({
    principal,
    limit: Number.isFinite(limit) ? limit : 25,
    afterEventId,
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

  const now = new Date();
  const patch =
    parsed.data.state === 'completed'
      ? { status: 'completed', acked_at: event.acked_at ?? now, completed_at: now, error: null, updated_at: now }
      : parsed.data.state === 'failed'
        ? { status: 'failed', acked_at: event.acked_at ?? now, failed_at: now, error: parsed.data.error ?? parsed.data.detail ?? 'Runtime reported failure', updated_at: now }
        : { status: 'delivered', acked_at: now, updated_at: now };

  const [updated] = await db
    .update(agentChannelEvents)
    .set(patch)
    .where(eq(agentChannelEvents.id, event.id))
    .returning();

  await touchAgentChannelConnection(principal, {
    status: parsed.data.state === 'failed' ? 'degraded' : 'connected',
    lastEventId: event.id,
    lastError: parsed.data.state === 'failed' ? patch.error ?? 'Runtime reported failure' : null,
  });
  await updateAgentChannelCursor({ principal, lastAckedEventId: event.id });

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
  const parentId = parsed.data.thread_id ?? event.thread_id ?? event.source_id ?? null;
  const requestJson = {
    event_id: event.id,
    content: parsed.data.content,
    thread_id: parentId,
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

  await db
    .update(agentChannelEvents)
    .set({
      status: result.isError ? 'failed' : 'completed',
      completed_at: result.isError ? null : new Date(),
      failed_at: result.isError ? new Date() : null,
      error: result.isError ? text : null,
      updated_at: new Date(),
    })
    .where(eq(agentChannelEvents.id, event.id));

  await touchAgentChannelConnection(principal, {
    status: result.isError ? 'degraded' : 'connected',
    lastEventId: event.id,
    lastError: result.isError ? text : null,
  });
  await updateAgentChannelCursor({ principal, lastAckedEventId: event.id });

  return c.json({ ok: !result.isError, idempotent: false, result: responseJson }, result.isError ? 500 : 200);
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
  const connection = await touchAgentChannelConnection(principal, {
    status: connectionStatus,
    lastEventId: parsed.data.event_id ?? null,
    lastError: parsed.data.state === 'error' ? parsed.data.detail ?? 'Runtime reported error' : null,
  });

  if (parsed.data.event_id) {
    await db.execute(sql`
      UPDATE agent_channel_events
      SET updated_at = now()
      WHERE id = ${parsed.data.event_id}
        AND org_id = ${principal.org_id}
        AND agent_employee_id = ${principal.employee_id}
    `);
  }

  return c.json({
    ok: true,
    state: parsed.data.state,
    detail: parsed.data.detail ?? null,
    connection,
  });
});
