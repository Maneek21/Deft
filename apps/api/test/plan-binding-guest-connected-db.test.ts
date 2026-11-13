/**
 * Plans bind only to an active employee of the caller's workspace; a plan is
 * approved, started, resumed or cancelled by its creator or a workspace
 * owner/admin; connected (MCP) tools are available to workspace members, not
 * guests. Provider discovery and execution are stubbed; no external service
 * is called. Run only against a disposable DB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, type TestContext } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { mcpClientManager, type MCPToolDiscovery } from '@deft/mcp';
import { closeDb } from '../src/lib/db.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { createPlanRow } from '../src/lib/agent-plans.js';
import { CapabilityService } from '../src/lib/capability-service.js';
import { APP_RUN_LEGACY_MCP_CUTOVER_ENABLED } from '../src/lib/env.js';
import { shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { agentPlanRoutes } from '../src/routes/agent-plans.js';
import { agentRoutes } from '../src/routes/agent.js';
import { handlePlanExecutor } from '../src/workers/handlers/plan-executor.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const dbTest = !databaseUrl ? test.skip : test;
const legacyTest = !databaseUrl || APP_RUN_LEGACY_MCP_CUTOVER_ENABLED ? test.skip : test;

const s = randomUUID().replaceAll('-', '').slice(0, 10);
const ORG = `d0-org-${s}`;
const OTHER_ORG = `d0-other-${s}`;
const OWNER = `d0-owner-${s}`;
const ADMIN = `d0-admin-${s}`;
const CREATOR = `d0-creator-${s}`;
const MEMBER = `d0-member-${s}`;
const GUEST = `d0-guest-${s}`;
const OTHER_OWNER = `d0-other-owner-${s}`;
const USERS = [OWNER, ADMIN, CREATOR, MEMBER, GUEST, OTHER_OWNER];
const ROLES: Record<string, string> = {
  [OWNER]: 'owner', [ADMIN]: 'admin', [CREATOR]: 'member', [MEMBER]: 'member', [GUEST]: 'guest',
};
const EMPLOYEE = `d0-emp-${s}`;
const DELETED_EMPLOYEE = `d0-emp-del-${s}`;
const DISABLED_EMPLOYEE = `d0-emp-off-${s}`;
const FOREIGN_EMPLOYEE = `d0-emp-foreign-${s}`;
const CONNECTION = `d0-conn-${s}`;
const SLUG = `d0crm${s}`;
const READ_TOOL = 'lookup_contact';
const WRITE_TOOL = 'update_contact';
const MCP_READ = `mcp__${SLUG}__${READ_TOOL}`;
const MCP_WRITE = `mcp__${SLUG}__${WRITE_TOOL}`;

let client: pg.Client;

before(async () => {
  if (!databaseUrl) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  for (const [id, slug] of [[ORG, `d0-${s}`], [OTHER_ORG, `d0-other-${s}`]]) {
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $2)', [id, slug]);
  }
  for (const id of USERS) {
    await client.query(`INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, $1, 'human', false, true)`, [id, `${id}@test.local`]);
  }
  // The guest of ORG is an ordinary member of OTHER_ORG.
  const memberships = [
    ...Object.entries(ROLES).map(([user, role]) => [ORG, user, role]),
    [OTHER_ORG, OTHER_OWNER, 'owner'], [OTHER_ORG, GUEST, 'member'],
  ];
  for (const [org, user, role] of memberships) {
    await client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
      [randomUUID(), org, user, role]);
  }
  await client.query(
    `INSERT INTO mcp_connections
      (id, org_id, name, slug, server_url, transport, auth_type, is_active,
       default_trust_tier, enabled_tools, created_by)
     VALUES ($1, $2, 'D0 CRM', $3, 'https://api.example.com/mcp',
       'streamable-http', 'none', true, 'auto', $4::text[], $5)`,
    [CONNECTION, ORG, SLUG, [READ_TOOL, WRITE_TOOL], OWNER],
  );
  const employees: Array<[string, string, boolean, boolean]> = [
    [EMPLOYEE, ORG, true, false],
    [DELETED_EMPLOYEE, ORG, true, true],
    [DISABLED_EMPLOYEE, ORG, false, false],
    [FOREIGN_EMPLOYEE, OTHER_ORG, true, false],
  ];
  for (const [id, org, active, deleted] of employees) {
    await client.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, mcp_connection_ids,
         disabled_tools, trust_level, max_daily_actions, daily_action_count, created_by,
         is_active, is_deleted, is_byoa)
       VALUES ($1, $2, $3, $1, $1, 'custom', 'test', $4::text[], '{}'::text[], 'standard',
         500, 0, $3, $5, $6, true)`,
      [id, org, org === ORG ? OWNER : OTHER_OWNER, org === ORG ? [CONNECTION] : [], active, deleted],
    );
  }
});

after(async () => {
  if (client) {
    for (const table of ['agent_plans', 'action_receipts', 'agent_action_approvers', 'agent_actions',
      'attention_items', 'notifications', 'job_queue', 'agent_employees', 'mcp_connections', 'org_members']) {
      await client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [[ORG, OTHER_ORG]]);
    }
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [USERS]);
    await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [[ORG, OTHER_ORG]]);
    await client.end();
  }
  await shutdownAppRunRuntime();
  await closeDb();
});

function stubProvider(t: TestContext) {
  const originalDiscovery = mcpClientManager.getCachedToolDiscovery;
  const originalExecute = mcpClientManager.executeTool;
  const tool = (name: string, isWrite: boolean, annotations: Record<string, boolean>) => {
    const rawTool = { name, description: name, inputSchema: { type: 'object', properties: {} }, annotations };
    return { rawTool, tool: {
      name: `mcp__${SLUG}__${name}`, originalName: name, description: name, inputSchema: rawTool.inputSchema,
      connectionId: CONNECTION, connectionSlug: SLUG, isWrite, approvalTier: 'auto-execute' as const, annotations, rawTool,
    } };
  };
  const read = tool(READ_TOOL, false, { readOnlyHint: true });
  const write = tool(WRITE_TOOL, true, { destructiveHint: false });
  const discovered = { tools: [read.tool, write.tool], providerTools: [read.rawTool, write.rawTool] } as unknown as MCPToolDiscovery;
  const calls: string[] = [];
  mcpClientManager.getCachedToolDiscovery = async () => discovered;
  mcpClientManager.executeTool = async (_config, toolName) => {
    calls.push(toolName);
    return { success: true, content: [{ type: 'text', text: 'ok' }], rawResult: {}, durationMs: 1 };
  };
  t.after(() => {
    mcpClientManager.getCachedToolDiscovery = originalDiscovery;
    mcpClientManager.executeTool = originalExecute;
  });
  return calls;
}

function appAs(userId: string, orgId = ORG) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId, email: `${userId}@test.local`, role: ROLES[userId] } as any);
    await next();
  });
  app.route('/api/agent-plans', agentPlanRoutes);
  app.route('/api/agent', agentRoutes);
  return app;
}

function post(app: Hono, path: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

const NATIVE_STEP = { id: 'list', description: 'List projects', tool: 'list_projects', params: {} };
const READ_STEP = { id: 'read', description: 'Look up', tool: MCP_READ, params: { id: 'c-1' } };

async function insertPlanRow(userId: string, steps: unknown[], status = 'draft'): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO agent_plans (id, org_id, user_id, agent_employee_id, title, steps, status, current_step, context)
     VALUES ($1, $2, $3, $4, 'D0 plan', $5::jsonb, $6, 0, '{}'::jsonb)`,
    [id, ORG, userId, EMPLOYEE, JSON.stringify(steps.map((step) => ({ ...(step as object), status: 'pending' }))), status],
  );
  return id;
}

async function executorJobUserIds(planId: string): Promise<string[]> {
  const rows = await client.query(`SELECT data->>'userId' AS user_id FROM job_queue
      WHERE name = 'plan-executor' AND data->>'planId' = $1 ORDER BY created_at`, [planId]);
  return rows.rows.map((row) => row.user_id);
}

// ─── Plan binding ────────────────────────────────────────────────────────────

dbTest('a plan can be bound only to an active employee of the same workspace', async () => {
  const app = appAs(CREATOR);
  const refusals: string[] = [];
  for (const employeeId of [FOREIGN_EMPLOYEE, `d0-missing-${s}`, DELETED_EMPLOYEE, DISABLED_EMPLOYEE]) {
    const res = await post(app, '/api/agent-plans', { title: 'Bind', steps: [NATIVE_STEP], agent_employee_id: employeeId });
    assert.equal(res.status, 400, employeeId);
    refusals.push(await res.text());
  }
  assert.equal(new Set(refusals).size, 1, `refusals must be identical: ${refusals.join(' | ')}`);
  const stored = await client.query('SELECT count(*)::int AS n FROM agent_plans WHERE org_id = $1 AND user_id = $2', [ORG, CREATOR]);
  assert.equal(stored.rows[0].n, 0, 'no plan is stored for a refused binding');

  const ok = await post(app, '/api/agent-plans', { title: 'Bind', steps: [NATIVE_STEP], agent_employee_id: EMPLOYEE });
  assert.equal(ok.status, 201, await ok.text());
  const unbound = await post(app, '/api/agent-plans', { title: 'No employee', steps: [NATIVE_STEP] });
  assert.equal(unbound.status, 201);
});

// ─── Plan verbs ──────────────────────────────────────────────────────────────

dbTest('another member cannot approve, start, resume or cancel a plan; its creator and owners/admins can', async () => {
  const planId = await insertPlanRow(CREATOR, [NATIVE_STEP]);
  const member = appAs(MEMBER);
  for (const verb of ['approve', 'execute', 'resume', 'abort']) {
    assert.equal((await post(member, `/api/agent-plans/${planId}/${verb}`)).status, 404, verb);
  }
  assert.equal((await client.query('SELECT status FROM agent_plans WHERE id = $1', [planId])).rows[0].status, 'draft');
  assert.deepEqual(await executorJobUserIds(planId), []);

  // Admin approves; owner starts. The run belongs to the plan's creator.
  assert.equal((await post(appAs(ADMIN), `/api/agent-plans/${planId}/approve`)).status, 200);
  const started = await post(appAs(OWNER), `/api/agent-plans/${planId}/execute`);
  assert.equal(started.status, 200, await started.text());
  assert.deepEqual(await executorJobUserIds(planId), [CREATOR]);

  await client.query("UPDATE agent_plans SET status = 'paused' WHERE id = $1", [planId]);
  assert.equal((await post(member, `/api/agent-plans/${planId}/resume`)).status, 404);
  assert.equal((await post(appAs(ADMIN), `/api/agent-plans/${planId}/resume`)).status, 200);
  assert.deepEqual(await executorJobUserIds(planId), [CREATOR, CREATOR]);

  assert.equal((await post(appAs(OWNER), `/api/agent-plans/${planId}/abort`)).status, 200);
  assert.equal((await client.query('SELECT status FROM agent_plans WHERE id = $1', [planId])).rows[0].status, 'failed');

  // The creator keeps every verb on their own plan.
  const own = await insertPlanRow(CREATOR, [NATIVE_STEP]);
  const creator = appAs(CREATOR);
  assert.equal((await post(creator, `/api/agent-plans/${own}/approve`)).status, 200);
  assert.equal((await post(creator, `/api/agent-plans/${own}/execute`)).status, 200);
  assert.equal((await post(creator, `/api/agent-plans/${own}/abort`)).status, 200);

  // An owner of another workspace reaches nothing.
  const foreign = await insertPlanRow(CREATOR, [NATIVE_STEP]);
  assert.equal((await post(appAs(OTHER_OWNER, OTHER_ORG), `/api/agent-plans/${foreign}/approve`)).status, 404);
});

dbTest('a plan run executes only for its own creator', async () => {
  const planId = await insertPlanRow(CREATOR, [NATIVE_STEP], 'approved');
  await assert.rejects(
    handlePlanExecutor({ id: randomUUID(), name: 'plan-executor', data: { planId, orgId: ORG, userId: OWNER }, attempts: 1 } as any),
  );
  assert.equal((await client.query('SELECT status FROM agent_plans WHERE id = $1', [planId])).rows[0].status, 'approved');
});

// ─── Guests and connected tools ──────────────────────────────────────────────

legacyTest('a guest cannot create or approve a plan with a connected step', async (t) => {
  const calls = stubProvider(t);
  const guest = appAs(GUEST);
  const refused = await post(guest, '/api/agent-plans', { title: 'Guest', steps: [READ_STEP], agent_employee_id: EMPLOYEE });
  assert.equal(refused.status, 403, await refused.text());
  await assert.rejects(createPlanRow({ org_id: ORG, user_id: GUEST, title: 'Guest', steps: [READ_STEP] }));
  const stored = await client.query('SELECT count(*)::int AS n FROM agent_plans WHERE org_id = $1 AND user_id = $2', [ORG, GUEST]);
  assert.equal(stored.rows[0].n, 0);

  // Guests keep native plans.
  assert.equal((await post(guest, '/api/agent-plans', { title: 'Guest native', steps: [NATIVE_STEP] })).status, 201);

  const existing = await insertPlanRow(GUEST, [READ_STEP]);
  assert.equal((await post(guest, `/api/agent-plans/${existing}/approve`)).status, 403);
  assert.equal((await client.query('SELECT status FROM agent_plans WHERE id = $1', [existing])).rows[0].status, 'draft');
  assert.equal(calls.length, 0);

  // A member's connected plan is created and approved as before.
  const member = appAs(MEMBER);
  const created = await post(member, '/api/agent-plans', { title: 'Member', steps: [READ_STEP], agent_employee_id: EMPLOYEE });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const memberPlan = JSON.parse(createdText).id;
  assert.equal((await post(member, `/api/agent-plans/${memberPlan}/approve`)).status, 200);
});

legacyTest('a guest-owned plan step calling a connected tool fails without calling the provider', async (t) => {
  const calls = stubProvider(t);
  const planId = await insertPlanRow(GUEST, [READ_STEP], 'approved');
  await handlePlanExecutor({ id: randomUUID(), name: 'plan-executor', data: { planId, orgId: ORG, userId: GUEST }, attempts: 1 } as any);
  const plan = await client.query('SELECT status, steps FROM agent_plans WHERE id = $1', [planId]);
  assert.equal(calls.length, 0);
  assert.equal(plan.rows[0].steps[0].status, 'failed', JSON.stringify(plan.rows[0]));
  assert.notEqual(plan.rows[0].status, 'completed');
  const actions = await client.query('SELECT count(*)::int AS n FROM agent_actions WHERE plan_id = $1', [planId]);
  assert.equal(actions.rows[0].n, 0);

  // The same plan owned by a member reads through the provider.
  const memberPlan = await insertPlanRow(MEMBER, [READ_STEP], 'approved');
  await handlePlanExecutor({ id: randomUUID(), name: 'plan-executor', data: { planId: memberPlan, orgId: ORG, userId: MEMBER }, attempts: 1 } as any);
  assert.deepEqual(calls, [READ_TOOL]);
  assert.equal((await client.query('SELECT status FROM agent_plans WHERE id = $1', [memberPlan])).rows[0].status, 'completed');
});

legacyTest('a guest-requested connected read or write is refused before the provider and settles failed', async (t) => {
  const calls = stubProvider(t);
  const read = await executeToolCall(MCP_READ, { id: 'c-1' }, ORG, GUEST, undefined, EMPLOYEE);
  assert.ok(read.result && typeof read.result === 'object' && 'error' in read.result, JSON.stringify(read.result));

  const write = await executeActionDirect(MCP_WRITE, { id: 'c-1' }, ORG, GUEST, null, 'auto', { agentEmployeeId: EMPLOYEE, source: 'runner' });
  assert.equal(write.success, false);
  assert.equal(calls.length, 0, 'nothing is sent to the provider');
  const row = await client.query('SELECT approval_status, executed_at, error FROM agent_actions WHERE id = $1', [write.actionId]);
  assert.equal(row.rows[0].approval_status, 'approved');
  assert.ok(row.rows[0].executed_at, 'the refused action is settled');
  assert.ok(row.rows[0].error, 'the refused action carries its error');

  // A member's read and write behave as before.
  const memberRead = await executeToolCall(MCP_READ, { id: 'c-1' }, ORG, MEMBER, undefined, EMPLOYEE);
  assert.ok(!(memberRead.result && typeof memberRead.result === 'object' && 'error' in memberRead.result), JSON.stringify(memberRead.result));
  const memberWrite = await executeActionDirect(MCP_WRITE, { id: 'c-1' }, ORG, MEMBER, null, 'auto', { agentEmployeeId: EMPLOYEE, source: 'runner' });
  assert.equal(memberWrite.success, true, JSON.stringify(memberWrite));
  assert.deepEqual(calls, [READ_TOOL, WRITE_TOOL]);
});

legacyTest('approving a pending guest-requested connected action settles it failed without calling the provider', async (t) => {
  const calls = stubProvider(t);
  const insertPending = async (userId: string) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, action, params, approval_tier, approval_status, mcp_connection_id)
       VALUES ($1, $2, $3, $4, $5, '{"id":"c-9"}'::jsonb, 'quick', 'pending', $6)`,
      [id, ORG, userId, EMPLOYEE, MCP_WRITE, CONNECTION],
    );
    return id;
  };
  const guestAction = await insertPending(GUEST);
  await post(appAs(GUEST), `/api/agent/actions/${guestAction}/approve`);
  const row = await client.query('SELECT approval_status, executed_at, error FROM agent_actions WHERE id = $1', [guestAction]);
  assert.equal(calls.length, 0);
  assert.equal(row.rows[0].approval_status, 'approved', JSON.stringify(row.rows[0]));
  assert.ok(row.rows[0].executed_at, 'settled, not reopened');
  assert.ok(row.rows[0].error);

  const memberAction = await insertPending(MEMBER);
  const approved = await post(appAs(MEMBER), `/api/agent/actions/${memberAction}/approve`);
  assert.equal(approved.status, 200, await approved.text());
  assert.deepEqual(calls, [WRITE_TOOL]);
});

dbTest('connected tools are available to workspace members in either execution mode', async () => {
  for (const cutover of [false, true]) {
    let providerCalls = 0;
    let governedCalls = 0;
    const result = { provider: { provider_kind: 'mcp', requested_provider_key: SLUG }, operation_name: READ_TOOL, provider_call_attempted: true, provider_succeeded: true, legacy_output: {}, duration_ms: 1 };
    const service = new CapabilityService(
      { discover: async () => { throw new Error('unused'); }, invoke: async () => { providerCalls += 1; return result as any; } },
      { invoke: async () => { governedCalls += 1; return result as any; } },
      () => cutover,
    );
    const request = (orgId: string, userId: string) => ({
      org_id: orgId,
      actor: { user_id: userId },
      provider: { provider_kind: 'mcp', connection_slug: SLUG, operation_name: READ_TOOL },
      input: {},
    });
    const refused = await service.invoke(request(ORG, GUEST));
    assert.equal(refused.provider_call_attempted, false);
    assert.equal(providerCalls + governedCalls, 0, `guest refused (cutover=${cutover})`);
    // The same person is a member of another workspace, where the call proceeds.
    await service.invoke(request(OTHER_ORG, GUEST));
    await service.invoke(request(ORG, MEMBER));
    assert.equal(providerCalls + governedCalls, 2, `members proceed (cutover=${cutover})`);
  }
});

legacyTest('a connected plan step refused at execution fails the step instead of completing it', async (t) => {
  const calls = stubProvider(t);
  const discover = mcpClientManager.getCachedToolDiscovery;
  // The plan's creator becomes a guest after the run starts.
  mcpClientManager.getCachedToolDiscovery = async (...args) => {
    await client.query("UPDATE org_members SET role = 'guest' WHERE org_id = $1 AND user_id = $2", [ORG, CREATOR]);
    return discover(...args);
  };
  t.after(() => client.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [ORG, CREATOR]));
  const planId = await insertPlanRow(CREATOR, [READ_STEP], 'approved');
  await handlePlanExecutor({ id: randomUUID(), name: 'plan-executor', data: { planId, orgId: ORG, userId: CREATOR }, attempts: 1 } as any);
  const plan = await client.query('SELECT status, steps FROM agent_plans WHERE id = $1', [planId]);
  assert.equal(calls.length, 0);
  assert.equal(plan.rows[0].steps[0].status, 'failed', JSON.stringify(plan.rows[0]));
  assert.equal(plan.rows[0].status, 'paused');
});
