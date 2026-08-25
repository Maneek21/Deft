/**
 * Agent Channel API transport path v1, protocol contract v2.
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
  agentChannelConnections,
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
  AGENT_CHANNEL_CAPABILITIES,
  AGENT_CHANNEL_AUTONOMOUS_REQUIRED_RUNTIME_CAPABILITIES,
  AGENT_CHANNEL_REQUIRED_RUNTIME_CAPABILITIES,
  AGENT_CHANNEL_DEFAULT_LEASE_MS,
  DEFT_BUILD_COMMIT,
  DEFT_RELEASE_VERSION,
  DEFT_SCHEMA_HEAD,
  getAgentChannelPrincipal,
  hasActiveAgentChannelClaim,
  listPendingChannelEvents,
  renewAgentChannelEventLease,
  resolveAgentChannelBearer,
  touchAgentChannelConnection,
  updateAgentChannelCursor,
  type AgentChannelPrincipal,
  type AgentChannelAdapterMode,
} from '../lib/agent-channel.js';
import { getIO } from '../socket.js';
import { executeSendMessage, executeTaskUpdate } from '../lib/mcp-tools/writes.js';
import { buildAgentChannelLifecyclePatch } from '../lib/agent-channel-lifecycle.js';
import { reconcileAgentChannelRuntimeAttempt } from '../lib/agent-channel-reconciliation.js';

export const agentChannelRoutes = new Hono();

function channelContract() {
  return {
    protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
    server_release: DEFT_RELEASE_VERSION,
    server_commit: DEFT_BUILD_COMMIT,
    schema_head: DEFT_SCHEMA_HEAD,
    capabilities: [...AGENT_CHANNEL_CAPABILITIES],
    required_runtime_capabilities: [...AGENT_CHANNEL_REQUIRED_RUNTIME_CAPABILITIES],
    adapter_modes: {
      supervised_runtime: {
        required_runtime_capabilities: [...AGENT_CHANNEL_REQUIRED_RUNTIME_CAPABILITIES],
        delivery_acknowledgement: 'lease_bound',
      },
      autonomous_platform: {
        required_runtime_capabilities: [...AGENT_CHANNEL_AUTONOMOUS_REQUIRED_RUNTIME_CAPABILITIES],
        delivery_acknowledgement: 'transport_acceptance',
      },
    },
  };
}

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
  state: z.enum([
    'received',
    'completed',
    'needs_human',
    'blocked',
    'failed',
    'cancelled',
    'work_completed_handoff_uncertain',
  ]).default('received'),
  claim_token: z.string().min(1),
  lease_ms: z.number().int().positive().optional(),
  runtime_session_key: z.string().min(1).optional(),
  runtime_request_key: z.string().min(1).max(300).optional(),
  runtime_response_id: z.string().min(1).max(300).optional(),
  detail: z.string().max(2000).optional(),
  error: z.string().max(4000).optional(),
  caller_employee_slug: z.string().optional(),
});

const acceptSchema = z.object({
  event_id: z.string().min(1),
  claim_token: z.string().min(1),
  caller_employee_slug: z.string().optional(),
}).strict();

const replySchema = z.object({
  event_id: z.string().min(1),
  content: z.string().min(1).max(16000),
  thread_id: z.string().nullable().optional(),
  idempotency_key: z.string().min(1).max(300).optional(),
  claim_token: z.string().min(1).optional(),
  adapter_mode: z.literal('autonomous_platform').optional(),
  outcome: z.enum(['completed', 'needs_human', 'blocked', 'failed', 'cancelled']).default('completed'),
  summary: z.string().max(2000).optional(),
  runtime_session_key: z.string().min(1).optional(),
  runtime_request_key: z.string().min(1).max(300).optional(),
  runtime_response_id: z.string().min(1).max(300).optional(),
  caller_employee_slug: z.string().optional(),
});

const reconcileSchema = z.object({
  event_id: z.string().min(1),
  claim_token: z.string().min(1),
  runtime_request_key: z.string().min(1).max(300),
  caller_employee_slug: z.string().optional(),
});

const statusSchema = z.object({
  state: z.enum(['idle', 'typing', 'working', 'approval_pending', 'degraded', 'incompatible', 'error', 'offline']),
  event_id: z.string().optional(),
  claim_token: z.string().min(1).optional(),
  lease_ms: z.number().int().positive().optional(),
  detail: z.string().max(2000).optional(),
  worker_id: z.string().min(1).max(200).optional(),
  attestation: z.object({
    schema: z.literal('deft.hermes.runtime_attestation.v1'),
    ready: z.boolean(),
    checked_at: z.string().datetime(),
    hermes_version: z.string().max(64).nullable().optional(),
    configured_model: z.string().max(200).nullable().optional(),
    available_models: z.array(z.string().max(200)).max(20).optional(),
    responses_api: z.boolean().optional(),
    skills_api: z.boolean().optional(),
    enabled_toolsets: z.array(z.string().max(64)).max(50).optional(),
    error_code: z.string().max(100).optional(),
  }).strict().optional(),
  caller_employee_slug: z.string().optional(),
}).strict();

function errorResponse(c: Context, status: 400 | 401 | 403 | 404 | 409 | 426 | 500, code: string, message: string) {
  return c.json({ error: message, code }, status);
}

function channelCompatibility(c: Context): {
  adapterVersion: string;
  capabilities: string[];
  adapterMode: AgentChannelAdapterMode;
} | Response {
  const protocolVersion = c.req.query('protocol_version')?.trim() ?? '';
  const adapterVersion = c.req.query('adapter_version')?.trim() ?? '';
  const capabilities = (c.req.query('capabilities') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const adapterMode: AgentChannelAdapterMode = capabilities.includes('autonomous_platform_adapter_v1')
    ? 'autonomous_platform'
    : 'supervised_runtime';
  const requiredCapabilities = adapterMode === 'autonomous_platform'
    ? AGENT_CHANNEL_AUTONOMOUS_REQUIRED_RUNTIME_CAPABILITIES
    : AGENT_CHANNEL_REQUIRED_RUNTIME_CAPABILITIES;
  const missingCapabilities = requiredCapabilities
    .filter((capability) => !capabilities.includes(capability));

  if (protocolVersion !== AGENT_CHANNEL_PROTOCOL_VERSION || !adapterVersion || missingCapabilities.length > 0) {
    return c.json({
      error: [
        `Agent Channel runtime is incompatible with ${AGENT_CHANNEL_PROTOCOL_VERSION}.`,
        protocolVersion ? `Runtime requested ${protocolVersion}.` : 'Runtime did not declare a protocol version.',
        adapterVersion ? null : 'Runtime did not declare an adapter version.',
        missingCapabilities.length > 0 ? `Missing capabilities: ${missingCapabilities.join(', ')}.` : null,
        `Install the Hermes integration bundle for Deft ${DEFT_RELEASE_VERSION}.`,
      ].filter(Boolean).join(' '),
      code: 'INCOMPATIBLE_CHANNEL',
      protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
      server_release: DEFT_RELEASE_VERSION,
      server_commit: DEFT_BUILD_COMMIT,
      schema_head: DEFT_SCHEMA_HEAD,
      capabilities: [...AGENT_CHANNEL_CAPABILITIES],
      required_runtime_capabilities: [...AGENT_CHANNEL_REQUIRED_RUNTIME_CAPABILITIES],
      adapter_modes: channelContract().adapter_modes,
    }, 426);
  }

  return { adapterVersion, capabilities, adapterMode };
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

function isResponse<T>(value: T | Response): value is Response {
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

async function hasAutonomousPlatformConnection(principal: AgentChannelPrincipal) {
  const [connection] = await db
    .select({ status: agentChannelConnections.status, metadata: agentChannelConnections.metadata })
    .from(agentChannelConnections)
    .where(and(
      eq(agentChannelConnections.org_id, principal.org_id),
      eq(agentChannelConnections.agent_employee_id, principal.employee_id),
    ))
    .limit(1);
  const metadata = (connection?.metadata ?? {}) as Record<string, unknown>;
  const capabilities = Array.isArray(metadata.runtime_capabilities)
    ? metadata.runtime_capabilities.filter((value): value is string => typeof value === 'string')
    : [];
  return connection?.status === 'connected'
    && metadata.adapter_mode === 'autonomous_platform'
    && capabilities.includes('autonomous_platform_adapter_v1');
}

async function startRuntimeAttempt(params: {
  event: typeof agentChannelEvents.$inferSelect;
  principal: AgentChannelPrincipal;
  runtimeRequestKey: string;
  runtimeSessionKey?: string | null;
}) {
  return db.transaction(async (tx) => {
    await tx.update(agentChannelDeliveryAttempts)
      .set({
        status: 'abandoned',
        error: 'Owning Agent Channel lease is no longer active',
        updated_at: new Date(),
      })
      .where(and(
        eq(agentChannelDeliveryAttempts.org_id, params.principal.org_id),
        eq(agentChannelDeliveryAttempts.agent_employee_id, params.principal.employee_id),
        eq(agentChannelDeliveryAttempts.direction, 'outbound_runtime'),
        eq(agentChannelDeliveryAttempts.status, 'started'),
        sql`(
          (
            ${agentChannelDeliveryAttempts.event_id} = ${params.event.id}
            AND ${agentChannelDeliveryAttempts.idempotency_key} IS DISTINCT FROM ${params.runtimeRequestKey}
          )
          OR NOT EXISTS (
            SELECT 1 FROM agent_channel_events active_event
            WHERE active_event.id = ${agentChannelDeliveryAttempts.event_id}
              AND active_event.org_id = ${params.principal.org_id}
              AND active_event.agent_employee_id = ${params.principal.employee_id}
              AND active_event.lease_expires_at > now()
          )
        )`,
      ));

    await tx.insert(agentChannelDeliveryAttempts)
      .values({
        org_id: params.principal.org_id,
        agent_employee_id: params.principal.employee_id,
        event_id: params.event.id,
        direction: 'outbound_runtime',
        idempotency_key: params.runtimeRequestKey,
        status: 'started',
        request_json: {
          event_id: params.event.id,
          delivery_count: params.event.delivery_count,
          runtime_session_key: params.runtimeSessionKey ?? null,
        },
      })
      .onConflictDoNothing();

    const [attempt] = await tx.select({ event_id: agentChannelDeliveryAttempts.event_id })
      .from(agentChannelDeliveryAttempts)
      .where(and(
        eq(agentChannelDeliveryAttempts.org_id, params.principal.org_id),
        eq(agentChannelDeliveryAttempts.agent_employee_id, params.principal.employee_id),
        eq(agentChannelDeliveryAttempts.idempotency_key, params.runtimeRequestKey),
      ))
      .limit(1);
    return attempt?.event_id === params.event.id;
  });
}

async function settleRuntimeAttempt(params: {
  event: typeof agentChannelEvents.$inferSelect;
  principal: AgentChannelPrincipal;
  runtimeRequestKey?: string | null;
  status: string;
  runtimeResponseId?: string | null;
  reconciliation?: unknown;
  error?: string | null;
}) {
  if (!params.runtimeRequestKey) return;
  await db.update(agentChannelDeliveryAttempts)
    .set({
      status: params.status,
      response_json: {
        runtime_response_id: params.runtimeResponseId ?? null,
        reconciliation: params.reconciliation ?? null,
      },
      error: params.error ?? null,
      updated_at: new Date(),
    })
    .where(and(
      eq(agentChannelDeliveryAttempts.org_id, params.principal.org_id),
      eq(agentChannelDeliveryAttempts.agent_employee_id, params.principal.employee_id),
      eq(agentChannelDeliveryAttempts.event_id, params.event.id),
      eq(agentChannelDeliveryAttempts.direction, 'outbound_runtime'),
      eq(agentChannelDeliveryAttempts.idempotency_key, params.runtimeRequestKey),
    ));
}

async function closeFallbackWorkForEvent(params: {
  event: typeof agentChannelEvents.$inferSelect;
  principal: AgentChannelPrincipal;
  runtimeSessionKey?: string | null;
  detail?: string | null;
  outcome?: 'completed' | 'needs_human' | 'blocked' | 'failed' | 'cancelled' | 'work_completed_handoff_uncertain';
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

agentChannelRoutes.get('/contract', (c) => c.json(channelContract()));

agentChannelRoutes.get('/connect', async (c) => {
  const principal = await resolveChannelPrincipal(c, c.req.query('caller_employee_slug'));
  if (isResponse(principal)) return principal;
  const workerId = c.req.query('worker_id')?.trim() ?? '';
  if (!workerId || workerId.length > 200) {
    return errorResponse(c, 400, 'VALIDATION_ERROR', 'worker_id is required and must be at most 200 characters');
  }
  const compatibility = channelCompatibility(c);
  if (isResponse(compatibility)) {
    await touchAgentChannelConnection(principal, {
      status: 'incompatible',
      workerId,
      lastError: 'Runtime protocol or capabilities are incompatible with this Deft release.',
      metadata: {
        adapter_version: c.req.query('adapter_version')?.trim() ?? null,
        runtime_capabilities: (c.req.query('capabilities') ?? '').split(',').filter(Boolean),
        compatibility_error: 'INCOMPATIBLE_CHANNEL',
      },
    });
    return compatibility;
  }

  const connection = await touchAgentChannelConnection(principal, {
    workerId,
    metadata: {
      adapter_version: compatibility.adapterVersion,
      runtime_capabilities: compatibility.capabilities,
      adapter_mode: compatibility.adapterMode,
      server_release: DEFT_RELEASE_VERSION,
      server_commit: DEFT_BUILD_COMMIT,
      schema_head: DEFT_SCHEMA_HEAD,
    },
  });
  await updateAgentChannelCursor({ principal, connectionId: connection?.id ?? null });

  return c.json({
    ok: true,
    protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
    server_release: DEFT_RELEASE_VERSION,
    server_commit: DEFT_BUILD_COMMIT,
    schema_head: DEFT_SCHEMA_HEAD,
    capabilities: [...AGENT_CHANNEL_CAPABILITIES],
    adapter_mode: compatibility.adapterMode,
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
  const compatibility = channelCompatibility(c);
  if (isResponse(compatibility)) return compatibility;

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
    adapterMode: compatibility.adapterMode,
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
    capabilities: [...AGENT_CHANNEL_CAPABILITIES],
    adapter_mode: compatibility.adapterMode,
    cursor: lastEventId,
    events,
  });
});

/**
 * Settle transport delivery for an autonomous platform adapter without
 * claiming that the employee's business work is complete. Accepted events are
 * not redelivered to autonomous adapters, and no reasoning lease remains.
 */
agentChannelRoutes.post('/accept', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = acceptSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const principal = await resolveChannelPrincipal(c, parsed.data.caller_employee_slug);
  if (isResponse(principal)) return principal;
  if (!(await hasAutonomousPlatformConnection(principal))) {
    return errorResponse(c, 409, 'AUTONOMOUS_CHANNEL_REQUIRED', 'Connect with autonomous_platform_adapter_v1 before accepting autonomous deliveries');
  }

  const event = await getEventForPrincipal(parsed.data.event_id, principal);
  if (!event) return errorResponse(c, 404, 'NOT_FOUND', 'Channel event not found');
  if (event.status === 'acknowledged' && event.acked_at && !event.claim_token) {
    await updateAgentChannelCursor({ principal, lastAckedEventId: event.id });
    return c.json({
      ok: true,
      idempotent: true,
      adapter_mode: 'autonomous_platform',
      transport_state: 'accepted',
      business_outcome: event.work_outcome ?? null,
      event,
    });
  }
  if (!hasActiveAgentChannelClaim(event, parsed.data.claim_token)) {
    return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim is missing, expired, or owned by another worker');
  }

  const now = new Date();
  const lifecyclePatch = buildAgentChannelLifecyclePatch(event, 'acknowledged', now);
  const [accepted] = await db
    .update(agentChannelEvents)
    .set({
      ...lifecyclePatch,
      claim_owner: null,
      claim_token: null,
      claimed_at: null,
      lease_expires_at: null,
    })
    .where(and(
      eq(agentChannelEvents.id, event.id),
      eq(agentChannelEvents.org_id, principal.org_id),
      eq(agentChannelEvents.agent_employee_id, principal.employee_id),
      eq(agentChannelEvents.claim_token, parsed.data.claim_token),
      sql`${agentChannelEvents.lease_expires_at} > now()`,
    ))
    .returning();
  if (!accepted) {
    return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim expired before transport acceptance committed');
  }

  await touchAgentChannelConnection(principal, {
    status: 'connected',
    lastEventId: event.id,
  });
  await updateAgentChannelCursor({ principal, lastAckedEventId: event.id });

  return c.json({
    ok: true,
    adapter_mode: 'autonomous_platform',
    transport_state: 'accepted',
    business_outcome: accepted.work_outcome ?? null,
    event: accepted,
  });
});

agentChannelRoutes.post('/reconcile', async (c) => {
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = reconcileSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
  }

  const principal = await resolveChannelPrincipal(c, parsed.data.caller_employee_slug);
  if (isResponse(principal)) return principal;
  const event = await getEventForPrincipal(parsed.data.event_id, principal);
  if (!event) return errorResponse(c, 404, 'NOT_FOUND', 'Channel event not found');
  if (!hasActiveAgentChannelClaim(event, parsed.data.claim_token)) {
    return errorResponse(c, 409, 'STALE_CLAIM', 'The Agent Channel claim is missing, expired, or owned by another worker');
  }

  const reconciliation = await reconcileAgentChannelRuntimeAttempt({
    event,
    orgId: principal.org_id,
    employeeId: principal.employee_id,
    runtimeRequestKey: parsed.data.runtime_request_key,
  });
  if (!reconciliation) {
    return errorResponse(c, 409, 'RUNTIME_ATTEMPT_NOT_FOUND', 'No matching runtime attempt exists for this event and request identity');
  }
  return c.json({ ok: true, ...reconciliation });
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

  if (parsed.data.state === 'received' && parsed.data.runtime_request_key) {
    const started = await startRuntimeAttempt({
      event,
      principal,
      runtimeRequestKey: parsed.data.runtime_request_key,
      runtimeSessionKey: parsed.data.runtime_session_key,
    });
    if (!started) {
      return errorResponse(c, 409, 'RUNTIME_REQUEST_KEY_CONFLICT', 'The runtime request identity belongs to another event');
    }
  }

  let reconciliation: Awaited<ReturnType<typeof reconcileAgentChannelRuntimeAttempt>> = null;
  if (parsed.data.state === 'work_completed_handoff_uncertain') {
    if (!parsed.data.runtime_request_key) {
      return errorResponse(c, 409, 'RUNTIME_REQUEST_KEY_REQUIRED', 'A runtime request identity is required for uncertain handoff reconciliation');
    }
    reconciliation = await reconcileAgentChannelRuntimeAttempt({
      event,
      orgId: principal.org_id,
      employeeId: principal.employee_id,
      runtimeRequestKey: parsed.data.runtime_request_key,
    });
    if (!reconciliation) {
      return errorResponse(c, 409, 'RUNTIME_ATTEMPT_NOT_FOUND', 'No matching runtime attempt exists for this event and request identity');
    }
    if (!reconciliation.has_durable_effects) {
      return errorResponse(c, 409, 'NO_DURABLE_EFFECTS', 'No durable Deft effects support an uncertain-completed outcome');
    }
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
    await settleRuntimeAttempt({
      event,
      principal,
      runtimeRequestKey: parsed.data.runtime_request_key,
      status: reportedOutcome,
      runtimeResponseId: parsed.data.runtime_response_id,
      reconciliation,
      error: parsed.data.error ?? null,
    });
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
  const autonomousReply = parsed.data.adapter_mode === 'autonomous_platform';
  if (autonomousReply) {
    if (!(await hasAutonomousPlatformConnection(principal))) {
      return errorResponse(c, 409, 'AUTONOMOUS_CHANNEL_REQUIRED', 'Connect with autonomous_platform_adapter_v1 before posting autonomous replies');
    }
    if (!event.acked_at || event.status !== 'acknowledged') {
      return errorResponse(c, 409, 'DELIVERY_NOT_ACCEPTED', 'Autonomous replies require an accepted transport delivery');
    }
  }
  const autonomousTaskReply = autonomousReply
    && event.source_kind === 'task'
    && Boolean(event.source_id);
  const autonomousNotificationReply = autonomousReply
    && event.kind === 'approval.resolved'
    && !event.space_id
    && !autonomousTaskReply;
  if (!event.space_id && !autonomousTaskReply && !autonomousNotificationReply) {
    return errorResponse(c, 409, 'NO_REPLY_TARGET', 'Channel event has no Deft reply target');
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
    outcome: autonomousReply ? null : parsed.data.outcome,
    adapter_mode: autonomousReply ? 'autonomous_platform' : 'supervised_runtime',
    reply_target: autonomousTaskReply
      ? 'task_comment'
      : autonomousNotificationReply
        ? 'notification_ack'
        : 'chat_message',
    summary: parsed.data.summary ?? null,
    runtime_session_key: parsed.data.runtime_session_key ?? null,
    runtime_request_key: parsed.data.runtime_request_key ?? null,
    runtime_response_id: parsed.data.runtime_response_id ?? null,
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
  if (!autonomousReply && (!parsed.data.claim_token || !hasActiveAgentChannelClaim(event, parsed.data.claim_token))) {
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

  const toolContext = {
    org_id: principal.org_id,
    employee_id: principal.employee_id,
    employee_slug: principal.employee_slug,
    trust_level: principal.trust_level,
  };
  const result = autonomousNotificationReply
    ? {
        content: [{ type: 'text' as const, text: JSON.stringify({ acknowledged: true, event_id: event.id }) }],
        isError: false,
      }
    : autonomousTaskReply
      ? await executeTaskUpdate({
      caller_employee_slug: principal.employee_slug,
      task_id: event.source_id!,
      patch: { comment: parsed.data.content },
      }, toolContext)
      : await executeSendMessage({
        orgId: principal.org_id,
        spaceId: event.space_id!,
        content: parsed.data.content,
        parentId,
        ctx: toolContext,
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

  if (autonomousReply) {
    await touchAgentChannelConnection(principal, {
      status: result.isError ? 'degraded' : 'connected',
      lastEventId: event.id,
      lastError: result.isError ? text : null,
    });
    return c.json({
      ok: !result.isError,
      idempotent: false,
      adapter_mode: 'autonomous_platform',
      transport_reply: result.isError ? 'failed' : 'sent',
      transport_target: autonomousTaskReply
        ? 'task_comment'
        : autonomousNotificationReply
          ? 'notification_ack'
          : 'chat_message',
      business_outcome: event.work_outcome ?? null,
      result: responseJson,
    }, result.isError ? 500 : 200);
  }

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
        eq(agentChannelEvents.claim_token, parsed.data.claim_token!),
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

  await settleRuntimeAttempt({
    event,
    principal,
    runtimeRequestKey: parsed.data.runtime_request_key,
    status: reportedOutcome,
    runtimeResponseId: parsed.data.runtime_response_id,
    error: result.isError ? text : null,
  });

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

  const connectionStatus = parsed.data.state === 'offline'
    ? 'disconnected'
    : parsed.data.state === 'incompatible'
    ? 'incompatible'
    : parsed.data.state === 'error' || parsed.data.state === 'degraded'
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
      if (parsed.data.detail) {
        emitTaskProgress(event, principal.employee_id, signal, parsed.data.detail);
      }
    }
  }

  const connection = await touchAgentChannelConnection(principal, {
    status: connectionStatus,
    workerId: parsed.data.worker_id,
    lastEventId: parsed.data.event_id ?? null,
    lastError: ['error', 'degraded', 'incompatible'].includes(parsed.data.state)
      ? parsed.data.detail ?? 'Runtime reported a degraded state'
      : null,
    metadata: parsed.data.attestation ? { runtime_attestation: parsed.data.attestation } : undefined,
  });

  return c.json({
    ok: true,
    state: parsed.data.state,
    detail: parsed.data.detail ?? null,
    connection,
  });
});
