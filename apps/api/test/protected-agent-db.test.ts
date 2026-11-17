/**
 * Owner-only management of agents that are or were owner or admin, against a
 * real database (lib/agent-management.ts). The table runs every operation in
 * test/fixtures/protected-agent-operations.ts as the owner and as an admin
 * on a member-level agent, an admin agent and a once-admin agent; the static
 * test (protected-agent-writers.test.ts) keeps that list complete. Then the
 * reviewers' reproductions from rounds 7 to 9 of #535.
 *
 * Run: DEFT_TEST_DATABASE_URL=<disposable test db> pnpm --filter @deft/api test test/protected-agent-db.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import pg from 'pg';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { isSafeTestDatabaseTarget } from './fixtures/safe-test-database-target.js';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';
import { PROTECTED_AGENT_ROUTES, type AgentTarget } from './fixtures/protected-agent-operations.js';

const databaseUrl = isSafeTestDatabaseTarget(process.env.DEFT_TEST_DATABASE_URL, process.env.DATABASE_URL);
const PASSWORD = 'Protected-agents-2026!';
type Json = Record<string, any>;

test('agents that are or were owner or admin are managed only by the owner', { skip: !databaseUrl && 'needs DEFT_TEST_DATABASE_URL on a disposable test database', timeout: 600_000 }, async (t) => {
  const hostedBefore = process.env.DEFT_HOSTED;
  delete process.env.DEFT_HOSTED;
  await ensureTwoStepTables(databaseUrl!);

  const { db, closeDb } = await import('../src/lib/db.js');
  const {
    users, orgs, orgMembers, agentEmployees, apiKeys, mcpTokens, agentChannelTokens, agentWebhooks, agentChannelEvents,
    agentCertificationChallenges, skills,
  } = await import('@deft/db/schema');
  const { authRoutes } = await import('../src/routes/auth.js');
  const { memberRoutes } = await import('../src/routes/members.js');
  const { agentEmployeeRoutes } = await import('../src/routes/agent-employees.js');
  const { apiKeyRoutes } = await import('../src/routes/api-keys.js');
  const { agentWebhookRoutes } = await import('../src/routes/agent-webhooks.js');
  const { authMiddleware } = await import('../src/middleware/auth.js');
  const { humanAgentEmployeeUpdateState } = await import('../src/lib/mcp-tools/human.js');

  t.after(async () => {
    if (hostedBefore === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = hostedBefore;
    await closeDb();
  });

  // Mounted the way index.ts mounts them.
  const app = new Hono();
  app.route('/api/auth', authRoutes);
  app.use('/api/*', authMiddleware);
  app.route('/api/members', memberRoutes);
  app.route('/api/agent-employees', agentEmployeeRoutes);
  app.route('/api/api-keys', apiKeyRoutes);
  app.route('/api/agent-webhooks', agentWebhookRoutes);

  const request = async (method: string, path: string, body: unknown, bearer: string) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Json = {};
    try { json = JSON.parse(text) as Json; } catch { /* not JSON */ }
    return { status: res.status, json };
  };

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const orgId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Protected agents', slug: `protected-agents-${orgId}` });
  async function person(role: 'owner' | 'admin' | 'member') {
    const id = randomUUID();
    const email = `protected-agents-${id}@test.local`;
    await db.insert(users).values({ id, name: `Protected ${role}`, email, email_verified: true, password_hash: passwordHash });
    await db.insert(orgMembers).values({ org_id: orgId, user_id: id, role });
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    const session = (await login.json() as Json).accessToken as string;
    assert.ok(session, 'signed in');
    return { id, role, session };
  }
  const owner = await person('owner');
  const admin = await person('admin');
  type Actor = typeof owner;
  const call = (as: Actor) => (method: string, path: string, body?: unknown) => request(method, path, body, as.session);
  const mcp = (as: Actor) => async (tool: string, args: Record<string, unknown>) => {
    assert.equal(tool, 'agent_employee_update_state');
    const result = await humanAgentEmployeeUpdateState(args, { org_id: orgId, user_id: as.id, role: as.role as 'owner' | 'admin', scopes: ['write:workspace'] });
    return { status: result.isError ? 403 : 200, json: result as Json };
  };

  const skillId = randomUUID();
  await db.insert(skills).values({ id: skillId, name: 'Table trigger skill', slug: `table-trigger-${skillId.slice(0, 8)}`, source: 'org', org_id: orgId, agent_config: { triggers: ['member.joined'] } } as any);

  type State = 'member' | 'admin' | 'demoted_admin';
  /** An agent employee with a webhook, a bound API key, two channel events and a certification challenge. */
  async function agent(state: State): Promise<AgentTarget> {
    const userId = randomUUID();
    const employeeId = randomUUID();
    await db.insert(users).values({ id: userId, name: 'Table agent', email: `${userId}@agents.test`, kind: 'agent', is_agent: true, email_verified: true });
    await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'member' });
    await db.insert(agentEmployees).values({
      id: employeeId, org_id: orgId, user_id: userId, name: 'Table agent', slug: `table-agent-${employeeId.slice(0, 8)}`,
      role: 'project_manager', system_prompt: 'Fixture', trust_level: 'conservative', is_byoa: true, is_active: true, created_by: owner.id,
      daily_action_count: 7, trigger_subscriptions: [],
    });
    // The owner grants admin (recording it), and for the once-admin agent takes it back.
    if (state !== 'member') assert.equal((await call(owner)('PATCH', `/api/members/${userId}`, { role: 'admin' })).status, 200, `${state} setup`);
    if (state === 'demoted_admin') assert.equal((await call(owner)('PATCH', `/api/members/${userId}`, { role: 'member' })).status, 200, `${state} setup`);
    const webhookId = randomUUID();
    await db.insert(agentWebhooks).values({ id: webhookId, org_id: orgId, agent_employee_id: employeeId, slug: `hook-${webhookId}`, secret_hash: 'x', enabled: true, created_by: owner.id } as any);
    const [key] = await db.insert(apiKeys).values({ org_id: orgId, agent_employee_id: employeeId, name: 'Owner key', key_hash: 'x', key_prefix: 'deft_fixture', permissions: ['mcp:full'], created_by: owner.id }).returning({ id: apiKeys.id });
    const failedEventId = randomUUID();
    const pendingEventId = randomUUID();
    await db.insert(agentChannelEvents).values([
      { id: failedEventId, org_id: orgId, agent_employee_id: employeeId, kind: 'mention', idempotency_key: `failed-${failedEventId}`, status: 'failed' },
      { id: pendingEventId, org_id: orgId, agent_employee_id: employeeId, kind: 'mention', idempotency_key: `pending-${pendingEventId}`, status: 'pending' },
    ] as any);
    await db.insert(agentCertificationChallenges).values({ org_id: orgId, employee_id: employeeId, nonce: `nonce-${employeeId}`, required_tools: [], status: 'pending' } as any);
    return { employeeId, userId, webhookId, apiKeyId: key!.id, failedEventId, pendingEventId, skillId };
  }

  /** What a refused operation must leave exactly as it was. */
  async function snapshot(target: AgentTarget) {
    const [employee] = await db.select({
      name: agentEmployees.name, is_active: agentEmployees.is_active, is_deleted: agentEmployees.is_deleted,
      max_daily_actions: agentEmployees.max_daily_actions, daily_action_count: agentEmployees.daily_action_count,
      certification_status: agentEmployees.certification_status, trigger_subscriptions: agentEmployees.trigger_subscriptions,
      unhealthy: agentEmployees.unhealthy,
    }).from(agentEmployees).where(eq(agentEmployees.id, target.employeeId));
    const [membership] = await db.select({ role: orgMembers.role, is_active: orgMembers.is_active }).from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, target.userId)));
    const keys = await db.select({ id: apiKeys.id, is_active: apiKeys.is_active }).from(apiKeys).where(eq(apiKeys.agent_employee_id, target.employeeId));
    const tokens = await db.select({ id: mcpTokens.id }).from(mcpTokens).where(and(eq(mcpTokens.agent_employee_id, target.employeeId), isNull(mcpTokens.revoked_at)));
    const channel = await db.select({ id: agentChannelTokens.id }).from(agentChannelTokens).where(and(eq(agentChannelTokens.agent_employee_id, target.employeeId), eq(agentChannelTokens.is_active, true)));
    const hooks = await db.select({ id: agentWebhooks.id }).from(agentWebhooks).where(eq(agentWebhooks.agent_employee_id, target.employeeId));
    const events = await db.select({ id: agentChannelEvents.id, status: agentChannelEvents.status }).from(agentChannelEvents).where(eq(agentChannelEvents.agent_employee_id, target.employeeId));
    const clones = await db.select({ id: agentEmployees.id }).from(agentEmployees).where(eq(agentEmployees.user_id, target.userId));
    const sort = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
    return { employee, membership, keys: sort(keys), tokens: sort(tokens), channel: sort(channel), hooks: sort(hooks), events: sort(events), clones: clones.length };
  }

  await t.test('owner-only table: actor x the agent’s past and present role x every operation', async () => {
    const isProtected: Record<State, boolean> = { member: false, admin: true, demoted_admin: true };
    let cases = 0;
    for (const actor of [owner, admin]) {
      for (const op of PROTECTED_AGENT_ROUTES) {
        for (const state of ['member', 'admin', 'demoted_admin'] as const) {
          // Reassigning takes the trigger from every other agent: start each case with no holder.
          if (op.route.includes('reassign-trigger')) await db.update(agentEmployees).set({ trigger_subscriptions: [] }).where(eq(agentEmployees.org_id, orgId));
          const target = await agent(state);
          const before = await snapshot(target);
          const res = await op.run(target, call(actor), mcp(actor));
          const label = `${actor.role} / ${state} agent / ${op.route}: ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`;
          if (actor.role === 'owner' || !isProtected[state]) {
            assert.ok(res.status === 200 || res.status === 201, label);
          } else {
            assert.equal(res.status, 403, label);
            assert.deepEqual(await snapshot(target), before, `${label}: nothing changed`);
          }
          cases += 1;
        }
      }
    }
    assert.equal(cases, 2 * 3 * PROTECTED_AGENT_ROUTES.length);
  });

  await t.test('round 7 to 9 reproductions are refused', async () => {
    // r7 Opus P1: a peer admin resets an admin agent's key. Refused; the old key still stands.
    const p1 = await agent('admin');
    assert.equal((await call(owner)('POST', `/api/agent-employees/${p1.employeeId}/regenerate-token`, { mcp_app_scopes: [], mcp_resource_scopes: [] })).status, 200);
    const tokensBefore = (await snapshot(p1)).tokens;
    assert.equal((await call(admin)('POST', `/api/agent-employees/${p1.employeeId}/regenerate-token`, { mcp_app_scopes: [], mcp_resource_scopes: [] })).status, 403);
    assert.deepEqual((await snapshot(p1)).tokens, tokensBefore, 'the owner’s token is untouched');

    // r8 (Opus, sol, astra): more concurrent key resets than the pool has
    // connections (4) all finish, and an unrelated query still answers.
    const many = await Promise.all(Array.from({ length: 10 }, () => agent('member')));
    const resets = Promise.all(many.flatMap((a) => [
      call(admin)('POST', `/api/agent-employees/${a.employeeId}/regenerate-channel-token`, {}),
      call(admin)('POST', `/api/agent-employees/${a.employeeId}/regenerate-token`, { mcp_app_scopes: [], mcp_resource_scopes: [] }),
      call(admin)('POST', `/api/agent-employees/${a.employeeId}/pause`, {}),
    ]));
    const finished = await Promise.race([resets, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000))]);
    assert.ok(finished, 'thirty concurrent managed writes finish');
    assert.deepEqual(finished.map((r) => r.status), finished.map(() => 200));
    const answered = await Promise.race([db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)), new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))]);
    assert.ok(answered, 'an unrelated query answers');

    // r8 (all three): the owner pauses an admin agent; a peer admin cannot resume it.
    const paused = await agent('admin');
    assert.equal((await call(owner)('POST', `/api/agent-employees/${paused.employeeId}/pause`, {})).status, 200);
    assert.equal((await call(admin)('POST', `/api/agent-employees/${paused.employeeId}/resume`, {})).status, 403);
    // r9 (sol blocker, Opus, astra): nor through the MCP tool.
    const viaMcp = await mcp(admin)('agent_employee_update_state', { employee_id: paused.employeeId, state: 'active' });
    assert.equal(viaMcp.status, 403, JSON.stringify(viaMcp.json));
    assert.equal((await snapshot(paused)).employee!.is_active, false, 'still paused');
    // ...nor clear its unhealthy flag.
    await db.update(agentEmployees).set({ unhealthy: true, unhealthy_reason: 'loop' }).where(eq(agentEmployees.id, paused.employeeId));
    assert.equal((await mcp(admin)('agent_employee_update_state', { employee_id: paused.employeeId, state: 'healthy' })).status, 403);
    assert.equal((await call(admin)('PATCH', `/api/agent-employees/${paused.employeeId}`, { mark_healthy: true })).status, 403);
    assert.equal((await snapshot(paused)).employee!.unhealthy, true);

    // r9 Opus blocker: a peer admin mints an API key bound to an admin agent. Refused, no raw key.
    const keyed = await agent('admin');
    const minted = await call(admin)('POST', '/api/api-keys', { name: 'Side door', agent_employee_id: keyed.employeeId, permissions: ['mcp:full'] });
    assert.equal(minted.status, 403);
    assert.equal(minted.json.raw_key, undefined);
    // ...or one bound to an agent in another workspace (the agent must be in this org).
    const elsewhereOrg = randomUUID();
    await db.insert(orgs).values({ id: elsewhereOrg, name: 'Elsewhere', slug: `elsewhere-${elsewhereOrg}` });
    const elsewhereUser = randomUUID();
    const elsewhereEmployee = randomUUID();
    await db.insert(users).values({ id: elsewhereUser, name: 'Elsewhere agent', email: `${elsewhereUser}@agents.test`, kind: 'agent', is_agent: true, email_verified: true });
    await db.insert(orgMembers).values({ org_id: elsewhereOrg, user_id: elsewhereUser, role: 'member' });
    await db.insert(agentEmployees).values({ id: elsewhereEmployee, org_id: elsewhereOrg, user_id: elsewhereUser, name: 'Elsewhere', slug: `elsewhere-${elsewhereEmployee.slice(0, 8)}`, role: 'project_manager', system_prompt: 'Fixture', trust_level: 'conservative', is_byoa: true, is_active: true, created_by: owner.id });
    assert.equal((await call(owner)('POST', '/api/api-keys', { name: 'Cross', agent_employee_id: elsewhereEmployee, permissions: ['mcp:full'] })).status, 404);
    // ...or changes or revokes the owner's key for it.
    assert.equal((await call(admin)('PUT', `/api/api-keys/${keyed.apiKeyId}`, { is_active: false })).status, 403);
    assert.equal((await call(admin)('DELETE', `/api/api-keys/${keyed.apiKeyId}`)).status, 403);

    // r9 Opus: a peer admin creates a webhook (and gets its HMAC key) or deletes the owner's.
    const hooked = await agent('admin');
    const hook = await call(admin)('POST', '/api/agent-webhooks', { agent_employee_id: hooked.employeeId });
    assert.equal(hook.status, 403);
    assert.equal(hook.json.hmac_key, undefined);
    assert.equal((await call(admin)('DELETE', `/api/agent-webhooks/${hooked.webhookId}`)).status, 403);

    // r8 Opus: taking a trigger away from an admin agent.
    const holder = await agent('admin');
    await db.update(agentEmployees).set({ trigger_subscriptions: ['member.joined'] }).where(eq(agentEmployees.id, holder.employeeId));
    const taker = await agent('member');
    assert.equal((await call(admin)('POST', `/api/agent-employees/${taker.employeeId}/reassign-trigger`, { trigger_kind: 'member.joined', skill_id: skillId })).status, 403);
    assert.deepEqual((await snapshot(holder)).employee!.trigger_subscriptions, ['member.joined']);
    assert.deepEqual((await snapshot(taker)).employee!.trigger_subscriptions, [], 'the taker got nothing either');
    assert.equal((await call(owner)('POST', `/api/agent-employees/${taker.employeeId}/reassign-trigger`, { trigger_kind: 'member.joined', skill_id: skillId })).status, 200);

    // Cloning an admin agent copies its user, so its role: owner-only.
    const source = await agent('admin');
    assert.equal((await call(admin)('POST', `/api/agent-employees/${source.employeeId}/clone`, {})).status, 403);
    assert.equal((await snapshot(source)).clones, 1);
  });

  await t.test('r9 (sol, astra): a budget reset cannot outlive a promotion that lands while it waits', async () => {
    const target = await agent('member');
    await db.update(agentEmployees).set({ daily_action_count: 100 }).where(eq(agentEmployees.id, target.employeeId));
    const holder = new pg.Client({ connectionString: databaseUrl! });
    await holder.connect();
    const order: string[] = [];
    try {
      // Hold the agent's row so the reset waits after it has decided.
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM agent_employees WHERE id = $1 FOR UPDATE', [target.employeeId]);
      const reset = call(admin)('POST', `/api/agent-employees/${target.employeeId}/action-budget/reset`, {}).then((r) => { order.push('reset'); return r; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const promotion = call(owner)('PATCH', `/api/members/${target.userId}`, { role: 'admin' }).then((r) => { order.push('promotion'); return r; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(order, [], 'the promotion waits for the reset’s locks');
      await holder.query('COMMIT');
      const [resetResult, promotionResult] = await Promise.all([reset, promotion]);
      // Serialized: the reset, decided while the agent was a member, commits
      // first; the promotion follows. Never a reset after the promotion.
      assert.deepEqual(order, ['reset', 'promotion']);
      assert.equal(resetResult.status, 200);
      assert.equal(promotionResult.status, 200);
    } finally {
      await holder.end();
    }
    await db.update(agentEmployees).set({ daily_action_count: 100 }).where(eq(agentEmployees.id, target.employeeId));
    assert.equal((await call(admin)('POST', `/api/agent-employees/${target.employeeId}/action-budget/reset`, {})).status, 403, 'after the promotion: owner-only');
    assert.equal((await snapshot(target)).employee!.daily_action_count, 100);
  });

  await t.test('the API tells the settings pages which agents a viewer may manage', async () => {
    const protectedAgent = await agent('demoted_admin');
    const plain = await agent('member');
    const view = async (as: Actor, id: string) => (await call(as)('GET', `/api/agent-employees/${id}`)).json.management;
    assert.deepEqual(await view(admin, protectedAgent.employeeId), { owner_only: true, can_manage: false });
    assert.deepEqual(await view(owner, protectedAgent.employeeId), { owner_only: true, can_manage: true });
    assert.deepEqual(await view(admin, plain.employeeId), { owner_only: false, can_manage: true });
    const list = (await call(admin)('GET', '/api/agent-employees')).json as Json[];
    assert.deepEqual(list.find((row) => row.id === protectedAgent.employeeId)?.management, { owner_only: true, can_manage: false });
    assert.deepEqual(list.find((row) => row.id === plain.employeeId)?.management, { owner_only: false, can_manage: true });
    // Members: a demoted admin agent is still the owner's (round 1 of #544).
    assert.equal((await call(admin)('GET', `/api/members/${protectedAgent.userId}/detail`)).json.member.owner_only, true);
    assert.equal((await call(admin)('GET', `/api/members/${plain.userId}/detail`)).json.member.owner_only, false);
    // API keys carry it too, a deleted agent's keys included (round 1 of #544).
    await db.update(agentEmployees).set({ is_deleted: true }).where(eq(agentEmployees.id, protectedAgent.employeeId));
    const keys = (await call(admin)('GET', '/api/api-keys')).json as unknown as Json[];
    assert.deepEqual(keys.find((k) => k.id === protectedAgent.apiKeyId)?.management, { owner_only: true, can_manage: false });
    assert.deepEqual(keys.find((k) => k.id === plain.apiKeyId)?.management, { owner_only: false, can_manage: true });
  });

  await t.test('round 1 of #544: reciprocal trigger reassignments do not deadlock', async () => {
    for (let round = 0; round < 5; round += 1) {
      await db.update(agentEmployees).set({ trigger_subscriptions: [] }).where(eq(agentEmployees.org_id, orgId));
      const x = await agent('member');
      const y = await agent('member');
      await db.update(agentEmployees).set({ trigger_subscriptions: ['member.joined'] }).where(inArray(agentEmployees.id, [x.employeeId, y.employeeId]));
      const results = await Promise.all([x, y, x, y].map((target) =>
        call(owner)('POST', `/api/agent-employees/${target.employeeId}/reassign-trigger`, { trigger_kind: 'member.joined', skill_id: skillId })));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200], JSON.stringify(results.map((r) => r.json)));
    }
  });

  await t.test('round 2 of #544: reassignments over clones (which share an account) do not deadlock', async () => {
    for (let round = 0; round < 8; round += 1) {
      await db.update(agentEmployees).set({ trigger_subscriptions: [] }).where(eq(agentEmployees.org_id, orgId));
      const x = await agent('member');
      const y = await agent('member');
      // A clone of x: another agent on x's account.
      const cloned = await call(owner)('POST', `/api/agent-employees/${x.employeeId}/clone`, {});
      assert.equal(cloned.status, 201);
      const ids = [x.employeeId, y.employeeId, cloned.json.employee.id as string];
      await db.update(agentEmployees).set({ trigger_subscriptions: ['member.joined'] }).where(inArray(agentEmployees.id, ids));
      const results = await Promise.all([...ids, ...ids].map((id) =>
        call(owner)('POST', `/api/agent-employees/${id}/reassign-trigger`, { trigger_kind: 'member.joined', skill_id: skillId })));
      assert.deepEqual(results.map((r) => r.status), results.map(() => 200), JSON.stringify(results.map((r) => r.json)));
    }
  });
});
