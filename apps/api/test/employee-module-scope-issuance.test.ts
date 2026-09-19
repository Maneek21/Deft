import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;
if (!DATABASE_URL || !/(?:test|ci|acceptance)/i.test(new URL(DATABASE_URL).pathname)) throw new Error('Scope issuance proof requires a disposable DEFT_TEST_DATABASE_URL');
assert.equal(process.env.DATABASE_URL?.trim(), DATABASE_URL.trim(), 'Set DATABASE_URL and DEFT_TEST_DATABASE_URL to the same disposable database');
const ORG_ID = randomUUID();
const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();
const EMPLOYEE_ID = randomUUID();
let db: typeof import('../src/lib/db.js').db;
let closeDb: (() => Promise<void>) | undefined;
let issueScopedEmployeeMcpToken: typeof import('../src/lib/mcp-token.js').issueScopedEmployeeMcpToken;
let resolveMcpPrincipal: typeof import('../src/lib/mcp-token.js').resolveMcpPrincipal;
let agentEmployeeRoutes: typeof import('../src/routes/agent-employees.js').agentEmployeeRoutes;

before(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  ({ db, closeDb } = await import('../src/lib/db.js'));
  ({ issueScopedEmployeeMcpToken, resolveMcpPrincipal } = await import('../src/lib/mcp-token.js'));
  ({ agentEmployeeRoutes } = await import('../src/routes/agent-employees.js'));
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`INSERT INTO users (id, email, name, is_agent) VALUES (${ADMIN_ID}, ${ADMIN_ID + '@test.local'}, 'Scope Admin', false), (${MEMBER_ID}, ${MEMBER_ID + '@test.local'}, 'Scope Member', false), (${EMPLOYEE_ID}, ${EMPLOYEE_ID + '@test.local'}, 'Scope Employee', true)`);
  await db.execute(sql`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES (${randomUUID()}, ${ORG_ID}, ${ADMIN_ID}, 'owner', true), (${randomUUID()}, ${ORG_ID}, ${MEMBER_ID}, 'member', true)`);
  await db.execute(sql`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, is_byoa, is_active, created_by) VALUES (${EMPLOYEE_ID}, ${ORG_ID}, ${EMPLOYEE_ID}, 'Scope Employee', ${'scope-' + EMPLOYEE_ID.slice(0, 8)}, 'project_manager', 'test', true, true, ${ADMIN_ID})`);
});

after(async () => {
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`DELETE FROM mcp_tokens WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM api_keys WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM agent_employees WHERE id = ${EMPLOYEE_ID}`);
  await db.execute(sql`DELETE FROM org_members WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN_ID}, ${MEMBER_ID}, ${EMPLOYEE_ID})`);
  await closeDb?.();
});

function appFor(userId: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: ORG_ID, email: userId + '@test.local' } as any);
    await next();
  });
  app.route('/api/agent-employees', agentEmployeeRoutes);
  return app;
}

test('employee resource scopes are opt-in, persisted, resolved, and route guarded', async () => {
  const defaultToken = await issueScopedEmployeeMcpToken({ orgId: ORG_ID, employeeId: EMPLOYEE_ID });
  assert.deepEqual(defaultToken.scopes, ['read:modules']);

  const explicit = await issueScopedEmployeeMcpToken({
    orgId: ORG_ID,
    employeeId: EMPLOYEE_ID,
    resourceScopes: ['read:tasks', 'write:tasks', 'write:modules'],
  });
  assert.deepEqual(explicit.scopes, ['read:modules', 'read:tasks', 'write:tasks', 'write:modules']);
  const principal = await resolveMcpPrincipal(explicit.raw);
  assert.equal(principal.kind, 'agent');
  assert.deepEqual(principal.scopes, explicit.scopes);

  await assert.rejects(() => issueScopedEmployeeMcpToken({ orgId: ORG_ID, employeeId: EMPLOYEE_ID, rawToken: 'unknown-scope-token-123456', resourceScopes: ['delete:modules' as never] }));

  const memberResponse = await appFor(MEMBER_ID).request(`/api/agent-employees/${EMPLOYEE_ID}/regenerate-token`, { method: 'POST', body: JSON.stringify({ mcp_resource_scopes: ['write:modules'] }), headers: { 'content-type': 'application/json' } });
  assert.equal(memberResponse.status, 403);

  const rotate = (body: unknown) => appFor(ADMIN_ID).request(`/api/agent-employees/${EMPLOYEE_ID}/regenerate-token`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  assert.equal((await rotate({ mcp_resource_scopes: ['delete:modules'] })).status, 400);
  const selected = ['read:modules', 'write:tasks', 'write:modules', 'read:app-runs'];
  const rotated = await rotate({ mcp_resource_scopes: ['write:tasks', 'write:modules'], mcp_app_scopes: ['read:app-runs'] });
  assert.equal(rotated.status, 200);
  const rotatedBody = await rotated.json();
  assert.deepEqual(rotatedBody.mcp_scopes, selected);
  assert.deepEqual((await resolveMcpPrincipal(rotatedBody.api_key)).scopes, selected);
  const reset = await rotate({});
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json()).mcp_scopes, ['read:modules']);
});
