import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = Boolean(target && process.env.DATABASE_URL === target);

test('installation trust API requires a current administrator, persists audit state and rejects stale revisions', { skip: !safe }, async t => {
  const [{ Hono }, { db, closeDb }, s, { eq, and }, web, { authMiddleware }, { appRoutes }, apps, modules, kit] = await Promise.all([
    import('hono'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/web-sessions.js'),
    import('../src/middleware/auth.js'), import('../src/routes/apps.js'), import('../src/lib/app-service.js'),
    import('../src/lib/module-service.js'), import('@deft/app-kit'),
  ]);
  t.after(closeDb);
  const org = randomUUID(), otherOrg = randomUUID(), admin = randomUUID(), member = randomUUID(), foreign = randomUUID();
  await db.insert(s.orgs).values([{ id: org, name: 'Upgrade trust test', slug: 'upgrade-trust-' + org },
    { id: otherOrg, name: 'Foreign upgrade trust test', slug: 'upgrade-trust-' + otherOrg }]);
  await db.insert(s.users).values([admin, member, foreign].map(id => ({ id, name: 'Synthetic trust test', email: id + '@example.test' })));
  await db.insert(s.orgMembers).values([{ org_id: org, user_id: admin, role: 'admin', is_active: true },
    { org_id: org, user_id: member, role: 'member', is_active: true }, { org_id: otherOrg, user_id: foreign, role: 'admin', is_active: true }]);
  const tokens = await Promise.all([[admin, org], [member, org], [foreign, otherOrg]].map(([id, org_id]) =>
    web.createWebSession({ id: id!, org_id: org_id!, email: id + '@example.test' })));
  const shape = { type: 'object', properties: { value: { type: 'string', maxLength: 40 } }, required: ['value'], additionalProperties: false };
  const pkg = await kit.buildDeftAppPackage({ manifest: { schema_version: '3', compatibility: { app_protocol: '3' },
    id: 'community.example.trust.a' + org.replaceAll('-', ''), name: 'Upgrade trust test', version: '1.0.0', license: 'AGPL-3.0-only', modules: [],
    runtime_requirements: [{ key: 'actions', protocol_version: 'deft.app_runtime_channel.v1' }],
    private_capabilities: [{ key: 'test_action', version: '1', input_schema: shape, output_schema: shape }],
    runtime_actions: [{ key: 'test_action', label: 'Test action', capability_key: 'test_action', runtime_requirement_key: 'actions' }] }, artifacts: [] });
  const installed = await apps.stageAppPackage(modules.humanModuleActor({ orgId: org, userId: admin, role: 'admin', source: 'rest' }), pkg.json);
  const app = new Hono(); app.use('/api/*', authMiddleware); app.route('/api/apps', appRoutes);
  const path = `/api/apps/${installed.id}/upgrade-trust`;
  const call = async (method = 'GET', body?: unknown, index = 0) => {
    const response = await app.request(path, { method, headers: { authorization: 'Bearer ' + tokens[index]!.accessToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') };
  };
  const initial = await call(); assert.equal(initial.status, 200); assert.deepEqual(initial.body, { trusted: false, revision: 0 });
  assert.equal(initial.cache, 'no-store');
  assert.equal((await call('PUT', { trusted: true, expected_revision: 0 }, 1)).status, 403);
  assert.equal((await call('PUT', { trusted: true, expected_revision: 0 }, 2)).status, 404);
  assert.equal((await call('PUT', { trusted: true, expected_revision: 0, unknown_authority: true })).status, 400);
  assert.deepEqual((await call('PUT', { trusted: true, expected_revision: 0 })).body, { trusted: true, revision: 1 });
  assert.deepEqual((await call()).body, { trusted: true, revision: 1 }, 'a separate request reads persisted policy');
  assert.equal((await call('PUT', { trusted: false, expected_revision: 0 })).status, 409);
  assert.deepEqual((await call('PUT', { trusted: false, expected_revision: 1 })).body, { trusted: false, revision: 2 });
  const audits = await db.select().from(s.auditLog).where(and(eq(s.auditLog.org_id, org), eq(s.auditLog.entity_id, installed.id),
    eq(s.auditLog.action, 'app.upgrade_continuity_trust_changed')));
  assert.equal(audits.length, 2); assert.ok(audits.every(row => row.actor_id === admin && row.actor_type === 'human'));
  await web.revokeWebSession(tokens[0]!.refreshToken);
  assert.equal((await call('PUT', { trusted: true, expected_revision: 2 })).status, 401);
});
