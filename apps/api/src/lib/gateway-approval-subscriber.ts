/**
 * Block 1.9 — subscribe to OpenClaw Gateway approval events and mirror
 * them into Deft's `agent_actions` table so they show up in the existing
 * approval-inbox UI.
 *
 * Flow:
 *   gateway emits notification "exec.approval.request" {approvalId, command}
 *   → insert agent_actions row with action='openclaw_exec_approval' +
 *     params={approvalId, command, raw}, approval_tier=full
 *   → UI renders approval card (unchanged plumbing)
 *   → user clicks approve → approval-resolver detects openclaw kind →
 *     calls gateway.exec.approval.resolve(approvalId, true)
 *
 * The resolver half lives in agent-approval-resolver.ts. This file is
 * only the subscribe side.
 *
 * Lifecycle: one subscriber per OpenClaw agent-employee with
 * connection_status='connected'. Started at server boot by
 * startAllApprovalSubscribers() and when a new gateway is provisioned.
 */
import { eq, and, isNotNull } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentEmployees, agentActions } from '@deft/db';
import { decrypt } from './encryption.js';
import { OpenClawGateway, getGatewayForDeployment, type GatewayOptions } from './openclaw-gateway.js';

type EmployeeRow = {
  id: string;
  org_id: string;
  created_by: string;
  connection_url: string;
  gateway_token_encrypted: string | null;
};

export type ApprovalEventKind = 'exec.approval.request' | 'plugin.approval.request';

// Map gateway event → the Deft action kind we stamp onto the row.
const EVENT_TO_ACTION: Record<ApprovalEventKind, string> = {
  'exec.approval.request': 'openclaw_exec_approval',
  'plugin.approval.request': 'openclaw_plugin_approval',
};

// In-memory registry: employeeId → unsubscribe functions
const activeSubs = new Map<string, Array<() => void>>();

/**
 * Start subscribing for one employee. Idempotent: if already subscribed,
 * existing subs are replaced (unsubscribed first).
 */
export async function startApprovalSubscriberFor(
  employee: EmployeeRow,
  gatewayOptsOverride?: GatewayOptions,
): Promise<void> {
  stopApprovalSubscriberFor(employee.id);

  if (!employee.gateway_token_encrypted) return;
  let token: string;
  try {
    token = decrypt(employee.gateway_token_encrypted);
  } catch {
    return; // can't decrypt → skip; an operator-visible error is logged by ping worker
  }

  const gateway = getGatewayForDeployment(
    employee.id,
    employee.connection_url,
    token,
    gatewayOptsOverride,
  );

  const unsubs: Array<() => void> = [];
  for (const event of Object.keys(EVENT_TO_ACTION) as ApprovalEventKind[]) {
    const u = gateway.subscribe(event, (params) => {
      void handleApprovalEvent(employee, event, params).catch((err) => {
        console.warn(`[gateway-approval-subscriber ${employee.id}] ${event}: ${(err as Error).message}`);
      });
    });
    unsubs.push(u);
  }
  activeSubs.set(employee.id, unsubs);
}

export function stopApprovalSubscriberFor(employeeId: string): void {
  const unsubs = activeSubs.get(employeeId);
  if (!unsubs) return;
  for (const u of unsubs) {
    try { u(); } catch { /* ignore */ }
  }
  activeSubs.delete(employeeId);
}

/** Insert an agent_actions row mirroring a gateway approval request. */
export async function handleApprovalEvent(
  employee: EmployeeRow,
  event: ApprovalEventKind,
  rawPayload: unknown,
): Promise<void> {
  const action = EVENT_TO_ACTION[event];
  const payload = (rawPayload && typeof rawPayload === 'object') ? (rawPayload as Record<string, unknown>) : {};

  const approvalId = typeof payload.approvalId === 'string'
    ? payload.approvalId
    : typeof payload.approval_id === 'string'
      ? payload.approval_id
      : typeof payload.id === 'string'
        ? payload.id
        : null;

  if (!approvalId) {
    // Malformed event — skip. Gateway is expected to always send an id.
    console.warn(`[gateway-approval-subscriber] missing approvalId in ${event} payload`);
    return;
  }

  await db.insert(agentActions).values({
    id: crypto.randomUUID(),
    org_id: employee.org_id,
    user_id: employee.created_by,
    agent_employee_id: employee.id,
    action,
    params: { approvalId, ...payload } as any,
    approval_tier: 'full',
    approval_status: 'pending',
  });
}

/**
 * Scan all connected OpenClaw employees and start subscribers. Safe to
 * call multiple times — each call refreshes the set and replaces any
 * stale subs.
 */
export async function startAllApprovalSubscribers(): Promise<number> {
  const rows = await db
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      created_by: agentEmployees.created_by,
      connection_url: agentEmployees.connection_url,
      gateway_token_encrypted: agentEmployees.gateway_token_encrypted,
      kind: agentEmployees.kind,
      connection_status: agentEmployees.connection_status,
    })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.kind, 'openclaw'),
      eq(agentEmployees.connection_status, 'connected'),
      isNotNull(agentEmployees.connection_url),
    ));

  let started = 0;
  for (const r of rows) {
    if (!r.connection_url) continue;
    await startApprovalSubscriberFor({
      id: r.id,
      org_id: r.org_id,
      created_by: r.created_by,
      connection_url: r.connection_url,
      gateway_token_encrypted: r.gateway_token_encrypted,
    }).catch((err) => {
      console.warn(`[gateway-approval-subscriber] failed to start for ${r.id}: ${(err as Error).message}`);
    });
    started++;
  }
  return started;
}

/** Test hook: clear in-memory subscriber registry without touching gateways. */
export function _clearApprovalSubs(): void {
  for (const employeeId of activeSubs.keys()) {
    stopApprovalSubscriberFor(employeeId);
  }
}

/** Exposed for tests — bypasses employee row + gateway cache. */
export async function _handleApprovalEventForTest(
  employee: EmployeeRow,
  event: ApprovalEventKind,
  rawPayload: unknown,
): Promise<void> {
  return handleApprovalEvent(employee, event, rawPayload);
}

// re-export so callers can type against it
export type { OpenClawGateway };
