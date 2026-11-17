import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
const NOT_MANAGEMENT: Record<string, { n: number; why: string }> = {
  // The credential issuers themselves; their callers are checked.
  'lib/agent-channel.ts|function issueAgentChannelToken|update agent_channel_tokens': { n: 1, why: 'issuer; callers are checked' },
  'lib/agent-channel.ts|function issueAgentChannelToken|insert agent_channel_tokens': { n: 1, why: 'issuer; callers are checked' },
  'lib/mcp-token.ts|function issueScopedEmployeeMcpToken|update mcp_tokens': { n: 1, why: 'issuer; callers are checked' },
  'lib/mcp-token.ts|function issueScopedEmployeeMcpToken|insert mcp_tokens': { n: 1, why: 'issuer; callers are checked' },
  'lib/mcp-token.ts|function issueScopedEmployeeMcpToken|update agent_employees': { n: 1, why: 'issuer; callers are checked' },
  'routes/agent-employees.ts|function issueMcpToken|issue mcp_tokens': { n: 1, why: 'issuer; callers are checked' },
  'routes/agent-employees.ts|function issueMcpToken|update api_keys': { n: 1, why: 'issuer; callers are checked' },
  'routes/agent-employees.ts|function issueMcpToken|insert api_keys': { n: 1, why: 'issuer; callers are checked' },
  'lib/mcp-token.ts|function issueEmployeeToken|issue mcp_tokens': { n: 1, why: 'only called by the operator script scripts/issue-token.ts (server shell access)' },
  // A person's own personal tokens, never an agent's.
  'lib/mcp-token.ts|function issuePersonalMcpToken|insert mcp_tokens': { n: 1, why: "a person's own personal MCP token (principal_kind human)" },
  'routes/mcp-access.ts|DELETE /tokens/:id|update mcp_tokens': { n: 1, why: "revokes the caller's own personal token only (user_id = caller, principal_kind human)" },
  // A credential being used: last-used stamps and counters.
  'lib/agent-channel.ts|function resolveAgentChannelBearer|update agent_channel_tokens': { n: 1, why: 'last_used_at when the agent itself authenticates' },
  'lib/mcp-token.ts|function resolveMcpPrincipal|update mcp_tokens': { n: 2, why: 'last_used_at when a token authenticates' },
  'routes/mcp-server.ts|POST /call|update api_keys': { n: 1, why: 'usage counter when a key is used' },
  'routes/mcp-server-v1.ts|function auditMcpCall|update agent_employees': { n: 1, why: "last_mcp_call_at from the agent's own call" },
  'routes/mcp-server-v1.ts|function auditMcpDiscovery|update agent_employees': { n: 1, why: "last_mcp_call_at from the agent's own discovery" },
  'routes/agent-webhooks.ts|POST /:slug|update agent_webhooks': { n: 1, why: 'fire_count when an external system calls the HMAC-signed webhook' },
  // The agent acting itself, or charged for its own actions.
  'lib/agent-tool-policy.ts|function consumeAgentDailyActionBudget|update agent_employees': { n: 1, why: "charges the agent's own action against its budget" },
  'lib/app-run-live-authorization.ts|module app-run-live-authorization.ts|update agent_employees': { n: 1, why: "reserves budget for the agent's own app run" },
  'lib/employee-chat-post-guard.ts|function chargeEmployeeChatPostOncePerAttempt|update agent_employees': { n: 1, why: "charges the agent's own chat post" },
  'lib/mcp-tools/cooperative.ts|function pingAlive|update agent_employees': { n: 1, why: 'the agent reporting itself alive' },
  'routes/agent-channel.ts|POST /ack|update agent_employees': { n: 1, why: 'the agent acknowledging over its own channel key' },
  'routes/agent-channel.ts|POST /reply|update agent_employees': { n: 2, why: 'the agent replying over its own channel key' },
  // Background workers (no operator).
  'workers/handlers/agent-daily-reset.ts|function handleAgentDailyReset|update agent_employees': { n: 1, why: 'scheduled daily counter reset' },
  'workers/handlers/agent-employee-heartbeat.ts|function claimHeartbeatWindow|update agent_employees': { n: 1, why: 'heartbeat scheduler' },
  'workers/handlers/agent-employee-heartbeat.ts|function handleAgentEmployeeHeartbeat|update agent_employees': { n: 7, why: 'heartbeat scheduler and its loop detector' },
  // The built-in assistant's own row.
  'lib/ensure-defty-membership.ts|function ensureDeftyEmployee|update agent_employees': { n: 1, why: "Defty's own system row" },
  'lib/ensure-defty-membership.ts|function ensureDeftyEmployee|insert agent_employees': { n: 1, why: "Defty's own system row" },
  // Creating a new agent: a new agent is never owner or admin.
  'routes/agent-employees.ts|POST /|insert agent_employees': { n: 1, why: 'creates a new member-level agent' },
  // Removing a member through Members: the membership locked path decides first.
  'routes/members.ts|function endWorkspaceAccess|update mcp_tokens': { n: 2, why: 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)' },
  'routes/members.ts|function endWorkspaceAccess|update api_keys': { n: 2, why: 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)' },
  'routes/members.ts|function endWorkspaceAccess|update agent_channel_tokens': { n: 1, why: 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)' },
  'routes/members.ts|function endWorkspaceAccess|update agent_employees': { n: 1, why: 'removal, after authorizeMembershipOperation under lockMembership (lib/membership-guard.ts)' },
  // Waking and authority tables (agent_channel_events, agent_certification_challenges, agent_employee_skills).
  'lib/agent-channel.ts|function publishAgentChannelEvent|insert agent_channel_events': { n: 1, why: 'the event publisher; its operator-facing callers (channel-test, certification) are inside the choke point, the rest are workspace activity (mentions, assignments, triggers)' },
  'lib/agent-channel.ts|function listPendingChannelEvents|update agent_channel_events': { n: 1, why: 'the agent claiming its own events over its channel key' },
  'lib/agent-channel.ts|function renewAgentChannelEventLease|update agent_channel_events': { n: 1, why: 'the agent renewing the lease on its own event' },
  'routes/agent-channel.ts|function completeAutonomousReplyTransport|update agent_channel_events': { n: 1, why: 'the agent completing its own reply' },
  'routes/agent-channel.ts|POST /accept|update agent_channel_events': { n: 1, why: 'the agent accepting its own event over its channel key' },
  'routes/agent-channel.ts|POST /ack|update agent_channel_events': { n: 1, why: 'the agent acknowledging over its own channel key' },
  'routes/agent-channel.ts|POST /reply|update agent_channel_events': { n: 2, why: 'the agent replying over its own channel key' },
  'routes/agent-channel.ts|POST /status|update agent_channel_events': { n: 1, why: 'the agent reporting its own runtime status' },
  'routes/agent-employees.ts|function cancelPendingCertification|update agent_certification_challenges': { n: 1, why: 'helper; both callers (certification start and reset) run it inside the choke point on its transaction' },
  'routes/agent-employees.ts|function cancelPendingCertification|update agent_channel_events': { n: 1, why: 'helper; both callers (certification start and reset) run it inside the choke point on its transaction' },
  'routes/agent-employees.ts|function installRequiredWorkspaceSkill|insert agent_employee_skills': { n: 1, why: 'only called by POST / for the new, member-level agent' },
};

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('every writer of an agent’s credentials or state goes through the choke point or has a listed reason', () => {
  const writers = scanAgentWriters(src);
  assert.ok(writers.length > 40, `the scan found the writers (${writers.length})`);
  const outside: string[] = [];
  const secondConnection: string[] = [];
  const seen = new Map<string, number>();
  for (const w of writers) {
    const key = `${w.file}|${w.site}|${w.op} ${w.table}`;
    if (w.inChokePoint) {
      if (w.dbInsideWork) secondConnection.push(`${w.file}:${w.line} ${w.site}`);
      continue;
    }
    if (NOT_MANAGEMENT[key]) { seen.set(key, (seen.get(key) ?? 0) + 1); continue; }
    outside.push(`${w.file}:${w.line}  ${key}`);
  }
  // Each listed site has exactly the writers counted: a new one there is a
  // new writer and needs its own review.
  const recount = Object.entries(NOT_MANAGEMENT).filter(([key, { n }]) => (seen.get(key) ?? 0) > n).map(([key, { n }]) => `${key}: ${seen.get(key)} writers, ${n} listed`);
  assert.deepEqual(recount, [], 'listed sites with more writers than listed');
  assert.deepEqual(outside, [], 'writers outside the choke point with no listed reason');
  assert.deepEqual(secondConnection, [], 'choke-point work that uses the global db (a second pooled connection)');
  const stale = Object.entries(NOT_MANAGEMENT).filter(([key, { n }]) => (seen.get(key) ?? 0) < n).map(([key]) => key);
  assert.deepEqual(stale, [], 'listed sites with fewer writers than listed (lower the count or remove them)');
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

test('the scan sees the writers reviewers slipped past it (round 1 of #544)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-writer-scan-'));
  try {
    const probe = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);
    probe('aliased.ts', "import { agentEmployees as ae } from '@deft/db/schema';\nexport const a = (db: any) => db.update(ae).set({ is_active: true });\n");
    probe('namespace.ts', "import * as schema from '@deft/db/schema';\nexport const b = (db: any) => db.delete(schema.agentWebhooks);\n");
    probe('issuer-only.ts', "import { issueAgentChannelToken as mint } from '../lib/agent-channel.js';\nexport const c = () => mint({ orgId: 'o', employeeId: 'e', employeeName: 'n' } as any);\n");
    probe('interpolated.ts', "import { sql } from 'drizzle-orm';\nimport { agentEmployees } from '@deft/db/schema';\nexport const d = (db: any, id: string) => db.execute(sql`UPDATE ${agentEmployees} SET is_active = false WHERE id = ${id}`);\n");
    probe('no-executor.ts', "import { manageAgent } from '../lib/agent-management.js';\nimport { issueAgentChannelToken } from '../lib/agent-channel.js';\nexport const e = () => manageAgent({} as any, 'x', (tx) => issueAgentChannelToken({ orgId: 'o', employeeId: 'x', employeeName: 'n' } as any));\n");
    probe('with-executor.ts', "import { manageAgent } from '../lib/agent-management.js';\nimport { issueAgentChannelToken } from '../lib/agent-channel.js';\nexport const f = () => manageAgent({} as any, 'x', (tx) => issueAgentChannelToken({ executor: tx, orgId: 'o', employeeId: 'x', employeeName: 'n' } as any));\n");
    // Round 2: an executor that is not the callback's transaction, and an issuer through a namespace import.
    probe('undefined-executor.ts', "import { manageAgent } from '../lib/agent-management.js';\nimport { issueAgentChannelToken } from '../lib/agent-channel.js';\nexport const g = () => manageAgent({} as any, 'x', (tx) => issueAgentChannelToken({ executor: undefined, orgId: 'o', employeeId: 'x', employeeName: 'n' } as any));\n");
    probe('other-executor.ts', "import { db } from '../lib/db.js';\nimport { manageAgent } from '../lib/agent-management.js';\nimport { issueAgentChannelToken } from '../lib/agent-channel.js';\nexport const h = () => manageAgent({} as any, 'x', (tx) => issueAgentChannelToken({ executor: db, orgId: 'o', employeeId: 'x', employeeName: 'n' } as any));\n");
    probe('namespace-issuer.ts', "import * as channel from '../lib/agent-channel.js';\nexport const i = () => channel.issueAgentChannelToken({ orgId: 'o', employeeId: 'e', employeeName: 'n' } as any);\n");
    // Confirm pass: a spread that can override the executor, and a shadowing `tx`.
    probe('spread-executor.ts', "import { manageAgent } from '../lib/agent-management.js';\nimport { issueAgentChannelToken } from '../lib/agent-channel.js';\nexport const j = (extra: any) => manageAgent({} as any, 'x', (tx) => issueAgentChannelToken({ executor: tx, ...extra, orgId: 'o', employeeId: 'x', employeeName: 'n' } as any));\n");
    probe('shadowed-executor.ts', "import { manageAgent } from '../lib/agent-management.js';\nimport { issueAgentChannelToken } from '../lib/agent-channel.js';\nexport const k = () => manageAgent({} as any, 'x', (tx) => [undefined].map((tx) => issueAgentChannelToken({ executor: tx, orgId: 'o', employeeId: 'x', employeeName: 'n' } as any)));\n");
    const found = scanAgentWriters(dir).map((w) => `${w.file} ${w.op} ${w.table} ${w.inChokePoint ? 'managed' : 'outside'}${w.dbInsideWork ? ' second-connection' : ''}`);
    assert.deepEqual(found, [
      'aliased.ts update agent_employees outside',
      'interpolated.ts update agent_employees outside',
      'issuer-only.ts issue agent_channel_tokens outside',
      'namespace-issuer.ts issue agent_channel_tokens outside',
      'namespace.ts delete agent_webhooks outside',
      'no-executor.ts issue agent_channel_tokens managed second-connection',
      'other-executor.ts issue agent_channel_tokens managed second-connection',
      'shadowed-executor.ts issue agent_channel_tokens managed second-connection',
      'spread-executor.ts issue agent_channel_tokens managed second-connection',
      'undefined-executor.ts issue agent_channel_tokens managed second-connection',
      'with-executor.ts issue agent_channel_tokens managed',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
