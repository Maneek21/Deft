import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAgentWriters } from './fixtures/agent-writer-scan.js';
import { PROTECTED_AGENT_ROUTES, ROUTES_NOT_MANAGING_AN_AGENT } from './fixtures/protected-agent-operations.js';

/**
 * Every statement in apps/api/src that writes an agent's credentials or
 * state (agent_employees, agent_webhooks, agent_channel_tokens, mcp_tokens,
 * api_keys, or a credential issuer) is either inside the choke point
 * (`manageAgent` / `manageAgentIfBound` in lib/agent-management.ts, without
 * touching the global `db` inside it) or listed below with the reason it is
 * not an operator managing someone else's agent. A new writer that is
 * neither fails this test: route it through the choke point, or add it here
 * with its reason for review.
 */
const NOT_MANAGEMENT: Record<string, string> = {
  // The credential issuers themselves; their callers are checked.
  'lib/agent-channel.ts|function issueAgentChannelToken|update agent_channel_tokens': 'issuer; callers are checked',
  'lib/agent-channel.ts|function issueAgentChannelToken|insert agent_channel_tokens': 'issuer; callers are checked',
  'lib/mcp-token.ts|function issueScopedEmployeeMcpToken|update mcp_tokens': 'issuer; callers are checked',
  'lib/mcp-token.ts|function issueScopedEmployeeMcpToken|insert mcp_tokens': 'issuer; callers are checked',
  'lib/mcp-token.ts|function issueScopedEmployeeMcpToken|update agent_employees': 'issuer; callers are checked',
  'routes/agent-employees.ts|function issueMcpToken|issue mcp_tokens': 'issuer; callers are checked',
  'routes/agent-employees.ts|function issueMcpToken|update api_keys': 'issuer; callers are checked',
  'routes/agent-employees.ts|function issueMcpToken|insert api_keys': 'issuer; callers are checked',
  'lib/mcp-token.ts|function issueEmployeeToken|issue mcp_tokens': 'only called by the operator script scripts/issue-token.ts (server shell access)',
  // A person's own personal tokens, never an agent's.
  'lib/mcp-token.ts|function issuePersonalMcpToken|insert mcp_tokens': "a person's own personal MCP token (principal_kind human)",
  'routes/mcp-access.ts|DELETE /tokens/:id|update mcp_tokens': "revokes the caller's own personal token only (user_id = caller, principal_kind human)",
  // A credential being used: last-used stamps and counters.
  'lib/agent-channel.ts|function resolveAgentChannelBearer|update agent_channel_tokens': 'last_used_at when the agent itself authenticates',
  'lib/mcp-token.ts|function resolveMcpPrincipal|update mcp_tokens': 'last_used_at when a token authenticates',
  'routes/mcp-server.ts|POST /call|update api_keys': 'usage counter when a key is used',
  'routes/mcp-server-v1.ts|function auditMcpCall|update agent_employees': "last_mcp_call_at from the agent's own call",
  'routes/mcp-server-v1.ts|function auditMcpDiscovery|update agent_employees': "last_mcp_call_at from the agent's own discovery",
  'routes/agent-webhooks.ts|POST /:slug|update agent_webhooks': 'fire_count when an external system calls the HMAC-signed webhook',
  // The agent acting itself, or charged for its own actions.
  'lib/agent-tool-policy.ts|function consumeAgentDailyActionBudget|update agent_employees': "charges the agent's own action against its budget",
  'lib/app-run-live-authorization.ts|module app-run-live-authorization.ts|update agent_employees': "reserves budget for the agent's own app run",
  'lib/employee-chat-post-guard.ts|function chargeEmployeeChatPostOncePerAttempt|update agent_employees': "charges the agent's own chat post",
  'lib/mcp-tools/cooperative.ts|function pingAlive|update agent_employees': 'the agent reporting itself alive',
  'routes/agent-channel.ts|POST /ack|update agent_employees': 'the agent acknowledging over its own channel key',
  'routes/agent-channel.ts|POST /reply|update agent_employees': 'the agent replying over its own channel key',
  // Background workers (no operator).
  'workers/handlers/agent-daily-reset.ts|function handleAgentDailyReset|update agent_employees': 'scheduled daily counter reset',
  'workers/handlers/agent-employee-heartbeat.ts|function claimHeartbeatWindow|update agent_employees': 'heartbeat scheduler',
  'workers/handlers/agent-employee-heartbeat.ts|function handleAgentEmployeeHeartbeat|update agent_employees': 'heartbeat scheduler and its loop detector',
  // The built-in assistant's own row.
  'lib/ensure-defty-membership.ts|function ensureDeftyEmployee|update agent_employees': "Defty's own system row",
  'lib/ensure-defty-membership.ts|function ensureDeftyEmployee|insert agent_employees': "Defty's own system row",
  // Creating a new agent: a new agent is never owner or admin.
  'routes/agent-employees.ts|POST /|insert agent_employees': 'creates a new member-level agent',
  'routes/agent-employees.ts|POST /|issue mcp_tokens': "the new agent's first key",
  'routes/agent-employees.ts|POST /|issue agent_channel_tokens': "the new agent's first channel key",
  // Removing a member through Members: the membership locked path decides first.
  'routes/members.ts|function endWorkspaceAccess|update mcp_tokens': 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)',
  'routes/members.ts|function endWorkspaceAccess|update api_keys': 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)',
  'routes/members.ts|function endWorkspaceAccess|update agent_channel_tokens': 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)',
  'routes/members.ts|function endWorkspaceAccess|update agent_employees': 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)',
};

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('every writer of an agent’s credentials or state goes through the choke point or has a listed reason', () => {
  const writers = scanAgentWriters(src);
  assert.ok(writers.length > 40, `the scan found the writers (${writers.length})`);
  const outside: string[] = [];
  const secondConnection: string[] = [];
  const used = new Set<string>();
  for (const w of writers) {
    const key = `${w.file}|${w.site}|${w.op} ${w.table}`;
    if (w.inChokePoint) {
      if (w.dbInsideWork) secondConnection.push(`${w.file}:${w.line} ${w.site}`);
      continue;
    }
    if (NOT_MANAGEMENT[key]) { used.add(key); continue; }
    outside.push(`${w.file}:${w.line}  ${key}`);
  }
  assert.deepEqual(outside, [], 'writers outside the choke point with no listed reason');
  assert.deepEqual(secondConnection, [], 'choke-point work that uses the global db (a second pooled connection)');
  const stale = Object.keys(NOT_MANAGEMENT).filter((key) => !used.has(key));
  assert.deepEqual(stale, [], 'listed reasons whose writer no longer exists (remove them)');
});

const HTTP = /(agentEmployeeRoutes|apiKeyRoutes|agentWebhookRoutes)\.(post|put|patch|delete)\('([^']+)'/g;

test('every write route on agents, agent keys and agent webhooks is in the owner-only table or listed as not managing an agent', () => {
  const registered: string[] = [];
  for (const [file, mount] of [['routes/agent-employees.ts', '/api/agent-employees'], ['routes/api-keys.ts', '/api/api-keys'], ['routes/agent-webhooks.ts', '/api/agent-webhooks']] as const) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    for (const match of text.matchAll(HTTP)) registered.push(`${match[2]!.toUpperCase()} ${mount}${match[3] === '/' ? '' : match[3]}`);
  }
  // The table also holds the members routes and the MCP tool; compare the three routers here.
  const covered = new Set([...PROTECTED_AGENT_ROUTES.map((r) => r.route), ...Object.keys(ROUTES_NOT_MANAGING_AN_AGENT)]
    .filter((r) => /^(POST|PUT|PATCH|DELETE) \/api\/(agent-employees|api-keys|agent-webhooks)(\/|$)/.test(r)));
  assert.deepEqual(registered.filter((r) => !covered.has(r)), [], 'write routes missing from the table');
  assert.deepEqual([...covered].filter((r) => !registered.includes(r)), [], 'table entries for routes that no longer exist');
});

test('every agent-management MCP tool is in the owner-only table', () => {
  const text = fs.readFileSync(path.join(src, 'lib/mcp-tools/human.ts'), 'utf8');
  const tools = [...new Set([...text.matchAll(/^\s+(agent_employee_[a-z_]+): human[A-Za-z]+,/gm)].map((m) => m[1]!))]
    .filter((name) => !/_(get|list)$/.test(name));
  assert.ok(tools.length > 0, 'found the MCP tool registry');
  const covered = PROTECTED_AGENT_ROUTES.map((r) => r.route);
  assert.deepEqual(tools.filter((t) => !covered.includes(`MCP ${t}`)), [], 'agent-management MCP tools missing from the table');
});
