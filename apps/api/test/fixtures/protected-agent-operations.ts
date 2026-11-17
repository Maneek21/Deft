/**
 * Every operation that manages an agent employee (lib/agent-management.ts),
 * for the owner-only table in test/protected-agent-db.test.ts. The static
 * test (test/protected-agent-writers.test.ts) fails if a write route on
 * /api/agent-employees, /api/api-keys or /api/agent-webhooks, or an
 * agent-management MCP tool, is in neither list.
 */
export type AgentTarget = {
  employeeId: string;
  userId: string;
  /** An existing webhook, API key, failed and pending channel event, and skill with a trigger. */
  webhookId: string;
  apiKeyId: string;
  failedEventId: string;
  pendingEventId: string;
  skillId: string;
};
export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
export type McpCall = (tool: string, args: Record<string, unknown>) => Promise<{ status: number; json: any }>;
export type Operation = {
  route: string;
  run: (t: AgentTarget, call: Call, mcp: McpCall) => Promise<{ status: number; json: any }>;
};

const A = '/api/agent-employees';

export const PROTECTED_AGENT_ROUTES: Operation[] = [
  { route: `PUT ${A}/:id`, run: (t, call) => call('PUT', `${A}/${t.employeeId}`, { name: 'Renamed agent' }) },
  { route: `PATCH ${A}/:id`, run: (t, call) => call('PATCH', `${A}/${t.employeeId}`, { max_daily_actions: 20 }) },
  { route: `POST ${A}/:id/action-budget/reset`, run: (t, call) => call('POST', `${A}/${t.employeeId}/action-budget/reset`, {}) },
  { route: `POST ${A}/:id/reassign-trigger`, run: (t, call) => call('POST', `${A}/${t.employeeId}/reassign-trigger`, { trigger_kind: 'member.joined', skill_id: t.skillId }) },
  { route: `POST ${A}/:id/pause`, run: (t, call) => call('POST', `${A}/${t.employeeId}/pause`, {}) },
  { route: `POST ${A}/:id/resume`, run: (t, call) => call('POST', `${A}/${t.employeeId}/resume`, {}) },
  { route: `POST ${A}/:id/channel-events/:eventId/retry`, run: (t, call) => call('POST', `${A}/${t.employeeId}/channel-events/${t.failedEventId}/retry`, {}) },
  { route: `POST ${A}/:id/channel-events/:eventId/cancel`, run: (t, call) => call('POST', `${A}/${t.employeeId}/channel-events/${t.pendingEventId}/cancel`, {}) },
  { route: `POST ${A}/:id/channel-test/start`, run: (t, call) => call('POST', `${A}/${t.employeeId}/channel-test/start`, {}) },
  { route: `POST ${A}/:id/certification/start`, run: (t, call) => call('POST', `${A}/${t.employeeId}/certification/start`, {}) },
  { route: `POST ${A}/:id/certification/check`, run: (t, call) => call('POST', `${A}/${t.employeeId}/certification/check`, {}) },
  { route: `POST ${A}/:id/certification/reset`, run: (t, call) => call('POST', `${A}/${t.employeeId}/certification/reset`, {}) },
  { route: `POST ${A}/:id/regenerate-token`, run: (t, call) => call('POST', `${A}/${t.employeeId}/regenerate-token`, { mcp_app_scopes: [], mcp_resource_scopes: [] }) },
  { route: `POST ${A}/:id/regenerate-channel-token`, run: (t, call) => call('POST', `${A}/${t.employeeId}/regenerate-channel-token`, {}) },
  { route: `POST ${A}/:id/clone`, run: (t, call) => call('POST', `${A}/${t.employeeId}/clone`, {}) },
  { route: `DELETE ${A}/:id`, run: (t, call) => call('DELETE', `${A}/${t.employeeId}`) },
  { route: 'POST /api/api-keys', run: (t, call) => call('POST', '/api/api-keys', { name: 'Agent key', agent_employee_id: t.employeeId, permissions: ['mcp:full'] }) },
  { route: 'PUT /api/api-keys/:id', run: (t, call) => call('PUT', `/api/api-keys/${t.apiKeyId}`, { is_active: false }) },
  { route: 'DELETE /api/api-keys/:id', run: (t, call) => call('DELETE', `/api/api-keys/${t.apiKeyId}`) },
  { route: 'POST /api/agent-webhooks', run: (t, call) => call('POST', '/api/agent-webhooks', { agent_employee_id: t.employeeId, label: 'Table hook' }) },
  { route: 'DELETE /api/agent-webhooks/:id', run: (t, call) => call('DELETE', `/api/agent-webhooks/${t.webhookId}`) },
  { route: 'MCP agent_employee_update_state', run: (t, _call, mcp) => mcp('agent_employee_update_state', { employee_id: t.employeeId, state: 'paused' }) },
  // The agent's membership itself (lib/membership-guard.ts, the same rule).
  { route: 'PATCH /api/members/:id (agent)', run: (t, call) => call('PATCH', `/api/members/${t.userId}`, { role: 'member' }) },
  { route: 'DELETE /api/members/:id (agent)', run: (t, call) => call('DELETE', `/api/members/${t.userId}`, {}) },
];

/** Write routes on those routers that do not manage an existing agent, and why. */
export const ROUTES_NOT_MANAGING_AN_AGENT: Record<string, string> = {
  [`POST ${A}`]: 'creates a new agent, which is member-level',
  [`POST ${A}/:id/onboarding-preflight`]: 'evaluates readiness and writes nothing',
  [`POST ${A}/:id/save-as-template`]: 'copies settings into an org template; no credential, no role, and agents made from it are new member-level agents',
};
