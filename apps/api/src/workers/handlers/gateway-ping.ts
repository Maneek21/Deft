/**
 * Phase 11 — Gateway connectivity ping.
 *
 * Runs every 60s as its own cron distinct from the proactive
 * agent-employee-heartbeat handler. Groups active OpenClaw employees by
 * connection_url and fires a single GET {connection_url}/v1/models per
 * Gateway with a 5s timeout.
 *
 * On success: every employee in the group flips to connection_status='connected',
 *   connection_error=null, gateway_ping_fail_count=0, last_gateway_ping_at=NOW().
 *   A linked provider_instances row (if any) also has last_status_check_at updated.
 *
 * On failure: gateway_ping_fail_count increments atomically. When the counter
 *   hits 3 consecutive failures the row flips to connection_status='error' and
 *   records connection_error. Transient blips (<3 fails) stay 'connected'.
 *
 * This handler NEVER throws — a bad Gateway cannot crash the worker loop.
 * Errors are logged with a [gateway-ping] prefix for grep-ability.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { agentEmployees, providerInstances } from '@deft/db/schema';
import { decrypt } from '../../lib/encryption.js';

const PING_TIMEOUT_MS = 5000;
const FAIL_THRESHOLD = 3;

type EmployeeRow = {
  id: string;
  connection_url: string | null;
  gateway_token_encrypted: string | null;
};

type GatewayGroup = {
  connectionUrl: string;
  employees: EmployeeRow[];
  token: string | null;
};

type PingOutcome =
  | { ok: true }
  | { ok: false; message: string };

export async function handleGatewayPing(_job: JobData): Promise<void> {
  let pinged = 0;
  let connectedCount = 0;
  let erroredCount = 0;

  try {
    const rows = (await db
      .select({
        id: agentEmployees.id,
        connection_url: agentEmployees.connection_url,
        gateway_token_encrypted: agentEmployees.gateway_token_encrypted,
      })
      .from(agentEmployees)
      .where(
        and(
          eq(agentEmployees.kind, 'openclaw'),
          eq(agentEmployees.is_active, true),
        ),
      )) as EmployeeRow[];

    // Drop rows with no connection_url (can't ping them yet) and group by URL.
    const groups = new Map<string, GatewayGroup>();
    for (const row of rows) {
      if (!row.connection_url) continue;
      let group = groups.get(row.connection_url);
      if (!group) {
        let token: string | null = null;
        if (row.gateway_token_encrypted) {
          try {
            token = decrypt(row.gateway_token_encrypted);
          } catch (err) {
            console.warn(
              `[gateway-ping] failed to decrypt gateway token for ${row.connection_url}: ${(err as Error).message}`,
            );
            token = null;
          }
        }
        group = { connectionUrl: row.connection_url, employees: [], token };
        groups.set(row.connection_url, group);
      }
      group.employees.push(row);
    }

    pinged = groups.size;

    for (const group of groups.values()) {
      const outcome = await pingGateway(group.connectionUrl, group.token);
      if (outcome.ok) {
        connectedCount += 1;
        await markGroupConnected(group);
      } else {
        erroredCount += 1;
        await markGroupFailure(group, outcome.message);
      }
    }
  } catch (err) {
    console.error(
      `[gateway-ping] unexpected error: ${(err as Error).message}`,
    );
    return;
  }

  console.log(
    `[gateway-ping] pinged ${pinged} gateways, ${connectedCount} connected, ${erroredCount} errored`,
  );
}

async function pingGateway(
  connectionUrl: string,
  token: string | null,
): Promise<PingOutcome> {
  const url = `${connectionUrl.replace(/\/$/, '')}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true };
    }
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (err) {
    const msg = (err as Error).message || 'unknown error';
    return { ok: false, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function markGroupConnected(group: GatewayGroup): Promise<void> {
  try {
    await db
      .update(agentEmployees)
      .set({
        connection_status: 'connected',
        connection_error: null,
        gateway_ping_fail_count: 0,
        last_gateway_ping_at: new Date(),
      })
      .where(
        and(
          eq(agentEmployees.kind, 'openclaw'),
          eq(agentEmployees.is_active, true),
          eq(agentEmployees.connection_url, group.connectionUrl),
        ),
      );

    const ids = group.employees.map((e) => e.id);
    if (ids.length > 0) {
      await db
        .update(providerInstances)
        .set({ last_status_check_at: new Date() })
        .where(inArray(providerInstances.employee_id, ids));
    }
  } catch (err) {
    console.error(
      `[gateway-ping] failed to mark group ${group.connectionUrl} connected: ${(err as Error).message}`,
    );
  }
}

async function markGroupFailure(
  group: GatewayGroup,
  message: string,
): Promise<void> {
  const errMsg = `gateway unreachable: ${message}`.slice(0, 4000);
  try {
    // Atomic: increment the counter and conditionally flip status + error
    // in a single UPDATE so races can't leave the row half-updated.
    await db.execute(sql`
      UPDATE agent_employees SET
        gateway_ping_fail_count = gateway_ping_fail_count + 1,
        last_gateway_ping_at = NOW(),
        connection_status = CASE
          WHEN gateway_ping_fail_count + 1 >= ${FAIL_THRESHOLD}
            THEN 'error'
          ELSE connection_status
        END,
        connection_error = CASE
          WHEN gateway_ping_fail_count + 1 >= ${FAIL_THRESHOLD}
            THEN ${errMsg}
          ELSE connection_error
        END
      WHERE connection_url = ${group.connectionUrl}
        AND kind = 'openclaw'
        AND is_active = true
    `);
  } catch (err) {
    console.error(
      `[gateway-ping] failed to mark group ${group.connectionUrl} failure: ${(err as Error).message}`,
    );
  }
}
