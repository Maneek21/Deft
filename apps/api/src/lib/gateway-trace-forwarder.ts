/**
 * Block 1.10 — reasoning trace forwarder.
 *
 * For each active OpenClaw session, subscribe to `session.tool` and
 * `session.message` events on the Gateway and fan them out via Socket.io
 * to the org room so connected clients can render a "Show trace" tree.
 *
 * Design notes:
 *   - Subscriptions are per-session not per-employee. A single employee
 *     can have many concurrent sessions; each gets its own
 *     unsubscribe function.
 *   - Events are filtered by sessionId so two sessions on the same
 *     gateway don't leak into each other.
 *   - Fanout happens on the server-side `org:<orgId>` room. The client
 *     listens for `agent:trace` events and filters by sessionId at the
 *     render layer (matches the pattern used by
 *     `agent:heartbeat:turn`).
 *
 * Persistence:
 *   Events are forwarded but NOT persisted separately — the tool_calls
 *   JSONB column on `agent_messages` already stores the authoritative
 *   trace for audit. This forwarder is strictly for live UI fanout.
 */
import { getIO } from '../socket.js';
import { decrypt } from './encryption.js';
import { getGatewayForDeployment, type OpenClawGateway } from './openclaw-gateway.js';

export type TraceEventKind = 'session.tool' | 'session.message';

const TRACE_EVENTS: TraceEventKind[] = ['session.tool', 'session.message'];

export type TraceSubscriberEmployee = {
  id: string;
  org_id: string;
  connection_url: string | null;
  gateway_token_encrypted: string | null;
};

// Test seam — emitToRoom + gateway resolution are overridable.
type Emitter = (room: string, event: string, payload: unknown) => void;
let _emitter: Emitter = (room, event, payload) => {
  const io = getIO();
  if (io) io.to(room).emit(event, payload);
};
export function _setTraceEmitter(fn: Emitter): void { _emitter = fn; }
export function _resetTraceEmitter(): void {
  _emitter = (room, event, payload) => {
    const io = getIO();
    if (io) io.to(room).emit(event, payload);
  };
}

let _gatewayResolver: (
  employeeId: string,
  connectionUrl: string,
  token: string,
) => OpenClawGateway | null = (id, url, tok) => getGatewayForDeployment(id, url, tok);
export function _setTraceGatewayResolver(
  fn: (employeeId: string, connectionUrl: string, token: string) => OpenClawGateway | null,
): void { _gatewayResolver = fn; }
export function _resetTraceGatewayResolver(): void {
  _gatewayResolver = (id, url, tok) => getGatewayForDeployment(id, url, tok);
}

// Per-session active subscribers: sessionId → unsubscribe fns
const activeTraceSubs = new Map<string, Array<() => void>>();

/**
 * Start forwarding trace events for a specific session on a specific
 * employee. Idempotent per sessionId (re-calls replace the set).
 */
export async function startTraceForwarderForSession(
  employee: TraceSubscriberEmployee,
  sessionId: string,
): Promise<void> {
  stopTraceForwarderForSession(sessionId);

  if (!employee.connection_url || !employee.gateway_token_encrypted) return;
  let token: string;
  try { token = decrypt(employee.gateway_token_encrypted); }
  catch { return; }

  const gateway = _gatewayResolver(employee.id, employee.connection_url, token);
  if (!gateway) return;

  const unsubs: Array<() => void> = [];
  for (const event of TRACE_EVENTS) {
    const u = gateway.subscribe(event, (params) => {
      const p = (params && typeof params === 'object') ? (params as Record<string, unknown>) : {};
      // Filter by sessionId — gateway may broadcast across sessions.
      if (p.sessionId && p.sessionId !== sessionId) return;
      try {
        _emitter(`org:${employee.org_id}`, 'agent:trace', {
          sessionId,
          employee_id: employee.id,
          kind: event,
          payload: p,
          at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[trace-forwarder ${sessionId}] emit failed: ${(err as Error).message}`);
      }
    });
    unsubs.push(u);
  }
  activeTraceSubs.set(sessionId, unsubs);
}

export function stopTraceForwarderForSession(sessionId: string): void {
  const unsubs = activeTraceSubs.get(sessionId);
  if (!unsubs) return;
  for (const u of unsubs) {
    try { u(); } catch { /* ignore */ }
  }
  activeTraceSubs.delete(sessionId);
}

/** Test hook — clear registry without touching gateways. */
export function _clearTraceSubs(): void {
  for (const id of activeTraceSubs.keys()) stopTraceForwarderForSession(id);
}

export function _activeTraceSessionCount(): number { return activeTraceSubs.size; }
