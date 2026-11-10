/**
 * Lane S2-b — a connected (MCP) tool classed as destructive never
 * auto-executes, whatever tier its connection gives it, on the real direct
 * action and plan-dependency handlers. Provider discovery and execution are
 * stubbed; no external service is called. Run only against a disposable DB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, type TestContext } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { agentRoutes } from '../src/routes/agent.js';
import { inboxRoutes } from '../src/routes/inbox.js';
import {
  mcpClientManager,
  type MCPConnectionConfig,
  type MCPToolDiscovery,
} from '@deft/mcp';
import { closeDb } from '../src/lib/db.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { createPlanRow } from '../src/lib/agent-plans.js';
import { APP_RUN_LEGACY_MCP_CUTOVER_ENABLED } from '../src/lib/env.js';
import { shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { handlePlanExecutor } from '../src/workers/handlers/plan-executor.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const legacyTest = !databaseUrl || APP_RUN_LEGACY_MCP_CUTOVER_ENABLED ? test.skip : test;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `s2-mcp-org-${suffix}`;
const USER_ID = `s2-mcp-user-${suffix}`;
const EMPLOYEE_ID = `s2-mcp-employee-${suffix}`;
const CONNECTION_ID = `s2-mcp-connection-${suffix}`;
const CONNECTION_SLUG = `s2crm${suffix}`;
const DELETE_TOOL = 'delete_contact';
const PREFIXED_DELETE = `mcp__${CONNECTION_SLUG}__${DELETE_TOOL}`;
const HINTED_TOOL = 'purge_contacts';
const PREFIXED_HINTED = `mcp__${CONNECTION_SLUG}__${HINTED_TOOL}`;
const planIds: string[] = [];

let client: pg.Client;

before(async () => {
  if (!databaseUrl) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [ORG_ID, 'S2 MCP org', `s2-mcp-${suffix}`]);
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
     VALUES ($1, $2, 'S2 MCP user', 'human', false, true)`,
    [USER_ID, `${USER_ID}@test.local`],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)`,
    [randomUUID(), ORG_ID, USER_ID],
  );
  // The connection hands every tool the most permissive tier ('auto').
  await client.query(
    `INSERT INTO mcp_connections
      (id, org_id, name, slug, server_url, transport, auth_type, is_active,
       default_trust_tier, enabled_tools, created_by)
     VALUES ($1, $2, 'S2 CRM', $3, 'https://api.example.com/mcp',
       'streamable-http', 'none', true, 'auto', $4::text[], $5)`,
    [CONNECTION_ID, ORG_ID, CONNECTION_SLUG, [DELETE_TOOL, HINTED_TOOL], USER_ID],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt,
       mcp_connection_ids, disabled_tools, trust_level, max_daily_actions,
       daily_action_count, created_by, is_active, is_deleted, is_byoa, runtime_kind)
     VALUES ($1, $2, $3, 'S2 MCP employee', $4, 'custom', 'test',
       $5::text[], '{}'::text[], 'standard', 50, 0, $3, true, false, false, 'defty_system')`,
    [EMPLOYEE_ID, ORG_ID, USER_ID, `s2-mcp-employee-${suffix}`, [CONNECTION_ID]],
  );
});

after(async () => {
  if (client) {
    if (planIds.length) await client.query('DELETE FROM agent_plans WHERE id = ANY($1::text[])', [planIds]);
    for (const table of ['action_receipts', 'agent_action_approvers', 'agent_actions', 'attention_items', 'notifications', 'job_queue']) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [ORG_ID]);
    }
    await client.query('DELETE FROM mcp_tool_overrides WHERE mcp_connection_id = $1', [CONNECTION_ID]);
    await client.query('DELETE FROM agent_employees WHERE id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM mcp_connections WHERE id = $1', [CONNECTION_ID]);
    await client.query('DELETE FROM org_members WHERE org_id = $1', [ORG_ID]);
    await client.query('DELETE FROM users WHERE id = $1', [USER_ID]);
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.end();
  }
  await shutdownAppRunRuntime();
  await closeDb();
});

function stubProvider(t: TestContext) {
  const originalDiscovery = mcpClientManager.getCachedToolDiscovery;
  const originalExecute = mcpClientManager.executeTool;
  const discovered: MCPToolDiscovery = {
    tools: [{
      name: PREFIXED_DELETE,
      originalName: DELETE_TOOL,
      description: 'Delete a contact',
      inputSchema: { type: 'object', properties: {} },
      connectionId: CONNECTION_ID,
      connectionSlug: CONNECTION_SLUG,
      isWrite: true,
      approvalTier: 'auto-execute',
      annotations: null,
      rawTool: { name: DELETE_TOOL, description: 'Delete a contact', inputSchema: { type: 'object', properties: {} } },
    }],
    providerTools: [{ name: DELETE_TOOL, description: 'Delete a contact', inputSchema: { type: 'object', properties: {} } }],
  };
  const calls: Array<{ config: MCPConnectionConfig; toolName: string }> = [];
  mcpClientManager.getCachedToolDiscovery = async () => discovered;
  mcpClientManager.executeTool = async (config, toolName) => {
    calls.push({ config, toolName });
    return { success: true, content: [{ type: 'text', text: 'deleted' }], rawResult: {}, durationMs: 1 };
  };
  t.after(() => {
    mcpClientManager.getCachedToolDiscovery = originalDiscovery;
    mcpClientManager.executeTool = originalExecute;
  });
  return calls;
}

legacyTest('S2-b: a Standard employee direct call of an auto-tier connected delete_* tool waits for approval', async (t) => {
  const calls = stubProvider(t);
  const outcome = await executeActionDirect(
    PREFIXED_DELETE,
    { contact_id: 'c-1' },
    ORG_ID,
    USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMPLOYEE_ID, source: 'runner' },
  );
  assert.equal(outcome.success, false);
  assert.equal(outcome.requiresApproval, true);
  assert.equal(calls.length, 0, 'the provider must not be called before approval');
  const row = await client.query(
    'SELECT approval_status, executed_at FROM agent_actions WHERE id = $1',
    [outcome.actionId],
  );
  assert.equal(row.rows[0].approval_status, 'pending');
  assert.equal(row.rows[0].executed_at, null);
});

legacyTest('S2-b: an auto-tier connected delete_* plan step that a later step depends on waits for approval', async (t) => {
  const calls = stubProvider(t);
  const plan = await createPlanRow({
    org_id: ORG_ID,
    user_id: USER_ID,
    agent_employee_id: EMPLOYEE_ID,
    title: `S2 MCP plan ${suffix}`,
    steps: [
      { id: 'delete', description: 'Delete the contact', tool: PREFIXED_DELETE, params: { contact_id: 'c-2' } },
      { id: 'after', description: 'Continue', tool: 'list_projects', params: {}, depends_on: ['delete'] },
    ],
    fail_fast: true,
  });
  planIds.push(plan.plan_id);
  await client.query("UPDATE agent_plans SET status = 'approved' WHERE id = $1", [plan.plan_id]);
  await handlePlanExecutor({
    id: randomUUID(),
    name: 'plan-executor',
    data: { planId: plan.plan_id, orgId: ORG_ID, userId: USER_ID },
    attempts: 1,
  } as any);
  const planRow = await client.query<{ status: string; steps: Array<{ status: string }> }>(
    'SELECT status, steps FROM agent_plans WHERE id = $1',
    [plan.plan_id],
  );
  assert.equal(planRow.rows[0]?.status, 'paused', JSON.stringify(planRow.rows[0]));
  assert.equal(planRow.rows[0]?.steps[0]?.status, 'waiting_approval');
  assert.equal(calls.length, 0, 'the provider must not be called before approval');
  const actions = await client.query(
    `SELECT approval_status, executed_at FROM agent_actions
      WHERE org_id = $1 AND plan_id = $2 AND plan_step_id = 'delete'`,
    [ORG_ID, plan.plan_id],
  );
  assert.equal(actions.rows.length, 1);
  assert.equal(actions.rows[0].approval_status, 'pending');
});

function stubHintedProvider(t: TestContext) {
  const originalDiscovery = mcpClientManager.getCachedToolDiscovery;
  const originalExecute = mcpClientManager.executeTool;
  const rawTool = {
    name: HINTED_TOOL,
    description: 'Purge contacts',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  };
  const discovered: MCPToolDiscovery = {
    tools: [{
      name: PREFIXED_HINTED,
      originalName: HINTED_TOOL,
      description: 'Purge contacts',
      inputSchema: { type: 'object', properties: {} },
      connectionId: CONNECTION_ID,
      connectionSlug: CONNECTION_SLUG,
      isWrite: true,
      // The connection's tier would let it run; only the hint says destructive.
      approvalTier: 'auto-execute',
      annotations: { destructiveHint: true },
      rawTool,
    }],
    providerTools: [rawTool],
  };
  const calls: string[] = [];
  mcpClientManager.getCachedToolDiscovery = async () => discovered;
  mcpClientManager.executeTool = async (_config, toolName) => {
    calls.push(toolName);
    return { success: true, content: [{ type: 'text', text: 'purged' }], rawResult: {}, durationMs: 1 };
  };
  t.after(() => {
    mcpClientManager.getCachedToolDiscovery = originalDiscovery;
    mcpClientManager.executeTool = originalExecute;
  });
  return calls;
}

legacyTest('W2a1-b: a direct call of a connected tool that declares destructiveHint waits for approval', async (t) => {
  const calls = stubHintedProvider(t);
  const outcome = await executeActionDirect(
    PREFIXED_HINTED,
    { segment: 'all' },
    ORG_ID,
    USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMPLOYEE_ID, source: 'runner' },
  );
  assert.equal(outcome.success, false);
  assert.equal(outcome.requiresApproval, true);
  assert.equal(calls.length, 0, 'the provider must not be called before approval');
  const row = await client.query('SELECT approval_status, approval_tier, executed_at FROM agent_actions WHERE id = $1', [outcome.actionId]);
  assert.equal(row.rows[0].approval_status, 'pending');
  assert.equal(row.rows[0].executed_at, null);

  // R2-3: stored and returned at tier full, visible to the requester, and
  // approving it calls the provider exactly once.
  assert.equal(row.rows[0].approval_tier, 'full');
  assert.equal(outcome.approvalTier, 'full');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, org_id: ORG_ID, email: `${USER_ID}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes);
  app.route('/api/inbox', inboxRoutes);
  const pending = await (await app.request('/api/agent/actions/pending')).json() as any;
  assert.ok(pending.actions.some((a: any) => a.id === outcome.actionId), 'pending approvals list the hinted call');
  const inbox = await (await app.request('/api/inbox?kind=pending_approval')).text();
  assert.ok(inbox.includes(outcome.actionId), 'the inbox lists the hinted call');
  const approve = await app.request(`/api/agent/actions/${outcome.actionId}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(approve.status, 200, await approve.text());
  await app.request(`/api/agent/actions/${outcome.actionId}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(calls.length, 1, 'approval runs the provider call once');
});

legacyTest('W2a1-b: a leaf plan step calling a destructiveHint tool waits for its own approval', async (t) => {
  const calls = stubHintedProvider(t);
  const plan = await createPlanRow({
    org_id: ORG_ID,
    user_id: USER_ID,
    agent_employee_id: EMPLOYEE_ID,
    title: `W2a1 hinted plan ${suffix}`,
    steps: [{ id: 'purge', description: 'Purge', tool: PREFIXED_HINTED, params: { segment: 'all' } }],
    fail_fast: true,
  });
  planIds.push(plan.plan_id);
  await client.query("UPDATE agent_plans SET status = 'approved' WHERE id = $1", [plan.plan_id]);
  await handlePlanExecutor({
    id: randomUUID(),
    name: 'plan-executor',
    data: { planId: plan.plan_id, orgId: ORG_ID, userId: USER_ID },
    attempts: 1,
  } as any);
  const planRow = await client.query<{ status: string; steps: Array<{ status: string }> }>(
    'SELECT status, steps FROM agent_plans WHERE id = $1',
    [plan.plan_id],
  );
  assert.equal(planRow.rows[0]?.status, 'paused', JSON.stringify(planRow.rows[0]));
  assert.equal(planRow.rows[0]?.steps[0]?.status, 'waiting_approval');
  assert.equal(calls.length, 0, 'the provider must not be called before approval');
});

legacyTest('R2-5: the plan payload marks a destructiveHint step destructive', async (t) => {
  stubHintedProvider(t);
  const { agentPlanRoutes } = await import('../src/routes/agent-plans.js');
  const plan = await createPlanRow({
    org_id: ORG_ID,
    user_id: USER_ID,
    agent_employee_id: EMPLOYEE_ID,
    title: `R2-5 hinted plan ${suffix}`,
    steps: [
      { id: 'purge', description: 'Purge', tool: PREFIXED_HINTED, params: { segment: 'all' } },
      { id: 'gone', description: 'Unknown tool', tool: `mcp__${CONNECTION_SLUG}__not_listed`, params: {} },
    ],
  });
  planIds.push(plan.plan_id);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, org_id: ORG_ID, email: `${USER_ID}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/api/agent-plans', agentPlanRoutes);
  const detail = await (await app.request(`/api/agent-plans/${plan.plan_id}`)).json() as any;
  assert.equal(detail.steps.find((s: any) => s.id === 'purge').destructive, true);
  // A step whose live tool cannot be resolved falls back to name and params.
  assert.equal(detail.steps.find((s: any) => s.id === 'gone').destructive, false);
  const list = await (await app.request('/api/agent-plans')).json() as any[];
  assert.equal(list.find((p) => p.id === plan.plan_id).steps.find((s: any) => s.id === 'purge').destructive, true);
});
