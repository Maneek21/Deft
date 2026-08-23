import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db.js';
import {
  agentChannelConnections,
  agentChannelCursors,
  agentChannelEvents,
  agentChannelTokens,
  agentEmployees,
} from '@deft/db/schema';
import { McpAuthError } from './mcp-token.js';
import { getIO } from '../socket.js';

export const AGENT_CHANNEL_PROTOCOL_VERSION = 'deft.agent_channel.v1';
export const AGENT_CHANNEL_DEFAULT_LEASE_MS = 120_000;
export const AGENT_CHANNEL_MIN_LEASE_MS = 30_000;
export const AGENT_CHANNEL_MAX_LEASE_MS = 600_000;

function boundedLeaseMs(value?: number) {
  if (!Number.isFinite(value)) return AGENT_CHANNEL_DEFAULT_LEASE_MS;
  return Math.min(Math.max(Math.trunc(value!), AGENT_CHANNEL_MIN_LEASE_MS), AGENT_CHANNEL_MAX_LEASE_MS);
}

function resultRows(result: unknown): Array<Record<string, any>> {
  if (Array.isArray(result)) return result as Array<Record<string, any>>;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows as Array<Record<string, any>> : [];
  }
  return [];
}

export type AgentChannelEventKind =
  | 'message.created'
  | 'task.assigned'
  | 'task.commented'
  | 'task.status_changed'
  | 'certification.challenge'
  | 'heartbeat.tick'
  | 'webhook.triggered'
  | 'runtime.status';

export type PublishAgentChannelEventInput = {
  orgId: string;
  employeeId: string;
  kind: AgentChannelEventKind | string;
  sourceKind?: string | null;
  sourceId?: string | null;
  spaceId?: string | null;
  threadId?: string | null;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
};

export type AgentChannelPrincipal = {
  org_id: string;
  employee_id: string;
  employee_slug: string;
  trust_level: 'conservative' | 'standard' | 'autonomous';
  runtime_kind: string;
};

const CHANNEL_TOKEN_ROUNDS = 10;

export async function issueAgentChannelToken(params: {
  orgId: string;
  employeeId: string;
  employeeName: string;
  createdBy: string;
  deactivateExisting?: boolean;
}): Promise<{ raw: string; prefix: string; tokenId: string }> {
  const raw = `deft_ch_${randomBytes(32).toString('base64url')}`;
  const prefix = raw.slice(0, 18);
  const hash = await bcrypt.hash(raw, CHANNEL_TOKEN_ROUNDS);

  if (params.deactivateExisting ?? true) {
    await db
      .update(agentChannelTokens)
      .set({ is_active: false, revoked_at: new Date() })
      .where(
        and(
          eq(agentChannelTokens.org_id, params.orgId),
          eq(agentChannelTokens.agent_employee_id, params.employeeId),
          eq(agentChannelTokens.is_active, true),
        ),
      );
  }

  const [row] = await db
    .insert(agentChannelTokens)
    .values({
      org_id: params.orgId,
      agent_employee_id: params.employeeId,
      name: `${params.employeeName} Channel Token`,
      token_hash: hash,
      token_prefix: prefix,
      created_by: params.createdBy,
    })
    .returning({ id: agentChannelTokens.id });
  if (!row?.id) throw new Error('issueAgentChannelToken: insert returned no row');

  return { raw, prefix, tokenId: row.id };
}

export async function resolveAgentChannelBearer(bearer: string): Promise<AgentChannelPrincipal> {
  if (!bearer || bearer.length < 16) {
    throw new McpAuthError(401, 'unauthorized', 'Missing or malformed channel bearer token');
  }

  const candidates = await db
    .select({
      token_id: agentChannelTokens.id,
      token_hash: agentChannelTokens.token_hash,
      employee_id: agentEmployees.id,
      employee_slug: agentEmployees.slug,
      org_id: agentEmployees.org_id,
      trust_level: agentEmployees.trust_level,
      runtime_kind: agentEmployees.runtime_kind,
      is_active: agentEmployees.is_active,
      is_deleted: agentEmployees.is_deleted,
    })
    .from(agentChannelTokens)
    .innerJoin(agentEmployees, eq(agentChannelTokens.agent_employee_id, agentEmployees.id))
    .where(
      and(
        eq(agentChannelTokens.is_active, true),
        isNull(agentChannelTokens.revoked_at),
      ),
    );

  for (const row of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(bearer, row.token_hash);
    if (!ok) continue;
    if (!row.is_active || row.is_deleted) {
      throw new McpAuthError(403, 'forbidden', 'Agent employee is inactive, deleted, or missing');
    }
    await db
      .update(agentChannelTokens)
      .set({ last_used_at: new Date() })
      .where(eq(agentChannelTokens.id, row.token_id));
    return {
      org_id: row.org_id,
      employee_id: row.employee_id,
      employee_slug: row.employee_slug,
      trust_level: row.trust_level as AgentChannelPrincipal['trust_level'],
      runtime_kind: row.runtime_kind,
    };
  }

  throw new McpAuthError(401, 'unauthorized', 'Invalid channel bearer token');
}

export async function publishAgentChannelEvent(input: PublishAgentChannelEventInput) {
  const id = crypto.randomUUID();
  const insertRows = await db
    .insert(agentChannelEvents)
    .values({
      id,
      org_id: input.orgId,
      agent_employee_id: input.employeeId,
      kind: input.kind,
      source_kind: input.sourceKind ?? null,
      source_id: input.sourceId ?? null,
      space_id: input.spaceId ?? null,
      thread_id: input.threadId ?? null,
      actor_user_id: input.actorUserId ?? null,
      payload: input.payload ?? {},
      idempotency_key: input.idempotencyKey,
      status: 'pending',
    })
    .onConflictDoNothing({
      target: [
        agentChannelEvents.org_id,
        agentChannelEvents.agent_employee_id,
        agentChannelEvents.idempotency_key,
      ],
    })
    .returning();

  if (insertRows[0]) {
    return { event: insertRows[0], created: true };
  }

  const [existing] = await db
    .select()
    .from(agentChannelEvents)
    .where(
      and(
        eq(agentChannelEvents.org_id, input.orgId),
        eq(agentChannelEvents.agent_employee_id, input.employeeId),
        eq(agentChannelEvents.idempotency_key, input.idempotencyKey),
      ),
    )
    .limit(1);

  return { event: existing ?? null, created: false };
}

export async function touchAgentChannelConnection(
  principal: AgentChannelPrincipal,
  opts?: { status?: 'connected' | 'degraded' | 'disconnected'; lastEventId?: string | null; lastError?: string | null },
) {
  const now = new Date();
  const id = crypto.randomUUID();
  const [connection] = await db
    .insert(agentChannelConnections)
    .values({
      id,
      org_id: principal.org_id,
      agent_employee_id: principal.employee_id,
      runtime_kind: principal.runtime_kind,
      status: opts?.status ?? 'connected',
      protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
      last_seen_at: now,
      last_event_id: opts?.lastEventId ?? null,
      last_error: opts?.lastError ?? null,
    })
    .onConflictDoUpdate({
      target: [
        agentChannelConnections.org_id,
        agentChannelConnections.agent_employee_id,
      ],
      set: {
        runtime_kind: principal.runtime_kind,
        status: opts?.status ?? 'connected',
        protocol_version: AGENT_CHANNEL_PROTOCOL_VERSION,
        last_seen_at: now,
        last_event_id: opts?.lastEventId ?? sql`${agentChannelConnections.last_event_id}`,
        last_error: opts?.lastError ?? null,
        updated_at: now,
      },
    })
    .returning();

  if (connection) {
    getIO()?.to(`org:${principal.org_id}`).emit('agent:presence', {
      employee_id: principal.employee_id,
      status: connection.status,
      runtime_kind: connection.runtime_kind,
      last_seen_at: connection.last_seen_at?.toISOString() ?? now.toISOString(),
      last_error: connection.last_error ?? null,
    });
  }
  return connection ?? null;
}

export async function updateAgentChannelCursor(params: {
  principal: AgentChannelPrincipal;
  connectionId?: string | null;
  lastDeliveredEventId?: string | null;
  lastAckedEventId?: string | null;
}) {
  const now = new Date();
  const [cursor] = await db
    .insert(agentChannelCursors)
    .values({
      id: crypto.randomUUID(),
      org_id: params.principal.org_id,
      agent_employee_id: params.principal.employee_id,
      connection_id: params.connectionId ?? null,
      last_delivered_event_id: params.lastDeliveredEventId ?? null,
      last_acked_event_id: params.lastAckedEventId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        agentChannelCursors.org_id,
        agentChannelCursors.agent_employee_id,
      ],
      set: {
        connection_id: params.connectionId ?? sql`${agentChannelCursors.connection_id}`,
        last_delivered_event_id: params.lastDeliveredEventId ?? sql`${agentChannelCursors.last_delivered_event_id}`,
        last_acked_event_id: params.lastAckedEventId ?? sql`${agentChannelCursors.last_acked_event_id}`,
        updated_at: now,
      },
    })
    .returning();
  return cursor ?? null;
}

export async function listPendingChannelEvents(params: {
  principal: AgentChannelPrincipal;
  limit?: number;
  afterEventId?: string | null;
  workerId: string;
  leaseMs?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const workerId = params.workerId.trim().slice(0, 200);
  if (!workerId) throw new Error('Agent Channel workerId is required');
  const leaseMs = boundedLeaseMs(params.leaseMs);
  let afterCreatedAt: Date | null = null;

  if (params.afterEventId) {
    const [cursorEvent] = await db
      .select({ created_at: agentChannelEvents.created_at })
      .from(agentChannelEvents)
      .where(
        and(
          eq(agentChannelEvents.id, params.afterEventId),
          eq(agentChannelEvents.org_id, params.principal.org_id),
          eq(agentChannelEvents.agent_employee_id, params.principal.employee_id),
        ),
      )
      .limit(1);
    afterCreatedAt = cursorEvent?.created_at ?? null;
  }

  const claimToken = crypto.randomUUID();
  const cursorFilter = afterCreatedAt
    ? sql`AND created_at > ${afterCreatedAt}`
    : sql``;
  const result = await db.execute(sql`
    WITH claimable AS (
      SELECT id
      FROM agent_channel_events
      WHERE org_id = ${params.principal.org_id}
        AND agent_employee_id = ${params.principal.employee_id}
        AND status IN ('pending', 'delivered', 'acknowledged', 'running', 'approval_pending')
        AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now())
        ${cursorFilter}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE agent_channel_events AS event
    SET status = CASE WHEN event.status = 'pending' THEN 'delivered' ELSE event.status END,
        delivered_at = COALESCE(event.delivered_at, now()),
        delivery_count = event.delivery_count + 1,
        claim_owner = ${workerId},
        claim_token = ${claimToken},
        claimed_at = now(),
        lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
        updated_at = now()
    FROM claimable
    WHERE event.id = claimable.id
    RETURNING event.*
  `);

  return resultRows(result)
    .sort((left, right) => {
      const createdDelta = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
      return createdDelta || String(left.id).localeCompare(String(right.id));
    }) as Array<typeof agentChannelEvents.$inferSelect>;
}

export function hasActiveAgentChannelClaim(
  event: Pick<typeof agentChannelEvents.$inferSelect, 'claim_token' | 'lease_expires_at'>,
  claimToken: string | null | undefined,
  now = new Date(),
) {
  return Boolean(
    claimToken
    && event.claim_token === claimToken
    && event.lease_expires_at
    && event.lease_expires_at.getTime() > now.getTime(),
  );
}

export async function renewAgentChannelEventLease(params: {
  principal: AgentChannelPrincipal;
  eventId: string;
  claimToken: string;
  leaseMs?: number;
}) {
  const leaseMs = boundedLeaseMs(params.leaseMs);
  const result = await db.execute(sql`
    UPDATE agent_channel_events
    SET lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
        updated_at = now()
    WHERE id = ${params.eventId}
      AND org_id = ${params.principal.org_id}
      AND agent_employee_id = ${params.principal.employee_id}
      AND status IN ('delivered', 'acknowledged', 'running', 'approval_pending')
      AND claim_token = ${params.claimToken}
      AND lease_expires_at > now()
    RETURNING *
  `);
  return (resultRows(result)[0] ?? null) as typeof agentChannelEvents.$inferSelect | null;
}

export async function getAgentChannelPrincipal(employeeId: string, orgId: string): Promise<AgentChannelPrincipal | null> {
  const [employee] = await db
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      slug: agentEmployees.slug,
      trust_level: agentEmployees.trust_level,
      runtime_kind: agentEmployees.runtime_kind,
      is_active: agentEmployees.is_active,
      is_deleted: agentEmployees.is_deleted,
    })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.id, employeeId), eq(agentEmployees.org_id, orgId)))
    .limit(1);

  if (!employee || !employee.is_active || employee.is_deleted) return null;
  return {
    org_id: employee.org_id,
    employee_id: employee.id,
    employee_slug: employee.slug,
    trust_level: employee.trust_level as AgentChannelPrincipal['trust_level'],
    runtime_kind: employee.runtime_kind,
  };
}
