import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_s05_(?:v5_review(?:_v[0-9]+)?|root(?:_v[0-9]+)?)$/.test(new URL(target).pathname);

test('authenticated HTTP v5 review and activation reject foreign and stale requests', { skip: !safe }, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`v5-review-http:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } } });
  const [{ app }, { db, closeDb }, schema, kit, apps, modules, sessions, serverModule] = await Promise.all([
    import('../src/index.js'), import('../src/lib/db.js'), import('@deft/db/schema'),
    import('@deft/app-kit'), import('../src/lib/app-service.js'), import('../src/lib/module-service.js'),
    import('../src/lib/web-sessions.js'), import('@hono/node-server'),
  ]);
  const { eq } = await import('drizzle-orm');
  const base = 'http://127.0.0.1:4341';
  let server: ReturnType<typeof serverModule.serve> | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4341 }, resolve);
    });
    const suffix = randomUUID().replaceAll('-', '');
    const orgId = randomUUID(); const otherOrgId = randomUUID();
    const ownerId = randomUUID(); const memberId = randomUUID(); const foreignId = randomUUID();
    const ownerEmail = `v5-http-owner-${suffix}@example.test`;
    await db.insert(schema.orgs).values([{ id: orgId, name: 'v5 HTTP', slug: `v5-http-${suffix}` },
      { id: otherOrgId, name: 'other v5 HTTP', slug: `v5-http-other-${suffix}` }]);
    await db.insert(schema.users).values([
      { id: ownerId, name: 'Owner', email: ownerEmail },
      { id: memberId, name: 'Member', email: `v5-http-member-${suffix}@example.test` },
      { id: foreignId, name: 'Foreign', email: `v5-http-foreign-${suffix}@example.test` },
    ]);
    await db.insert(schema.orgMembers).values([
      { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
      { id: randomUUID(), org_id: orgId, user_id: memberId, role: 'member', is_active: true },
      { id: randomUUID(), org_id: otherOrgId, user_id: foreignId, role: 'owner', is_active: true },
    ]);
    const owner = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const descriptor = { schema_version: 'deft.app_sync_descriptor.v1' as const, key: 'mail',
      runtime_requirement_key: 'mail_sync', resource_type: 'email_message',
      requested_visibility: 'user_private' as const, label_field: 'subject',
      record_schema: { type: 'object' as const,
        properties: { subject: { type: 'string' as const, maxLength: 200 } },
        required: ['subject'], additionalProperties: false as const } };
    const pkg = await kit.buildDeftAppPackage({ manifest: {
      schema_version: '5', id: `community.example.v5-http.a${suffix}`, version: '1.0.0',
      name: 'v5 HTTP', license: 'AGPL-3.0-only', compatibility: { app_protocol: '5' },
      modules: [], navigation: [],
      runtime_requirements: [{ key: 'mail_sync', protocol_version: 'deft.app_runtime_channel.v2' }],
      private_capabilities: [], runtime_actions: [], sync_descriptors: [descriptor],
      experiences: [], public_actions: [],
    }, artifacts: [] });
    const staged = await apps.stageAppPackage(owner, pkg.json);
    const [version] = await db.select().from(schema.appVersions).where(eq(schema.appVersions.id, staged.version_id));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(eq(
      schema.appGrantSnapshots.id, version.requested_grant_snapshot_id));
    assert.ok(requested);
    const input = { app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const ownerWeb = await sessions.createWebSession({ id: ownerId, email: ownerEmail, org_id: orgId });
    const memberWeb = await sessions.createWebSession({ id: memberId,
      email: `v5-http-member-${suffix}@example.test`, org_id: orgId });
    const foreignWeb = await sessions.createWebSession({ id: foreignId,
      email: `v5-http-foreign-${suffix}@example.test`, org_id: otherOrgId });
    async function post(operation: string, body: unknown, token: string) {
      const response = await fetch(`${base}/api/app-runtime-review/${staged.id}/${operation}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { response, value: await response.json() as Record<string, any> };
    }
    for (const token of [memberWeb.accessToken, foreignWeb.accessToken]) {
      const denied = await post('review', input, token);
      assert.notEqual(denied.response.status, 200);
      assert.equal(denied.response.headers.get('cache-control'), 'no-store');
    }
    const stale = await post('review', { ...input, expected_grant_epoch: input.expected_grant_epoch + 1 },
      ownerWeb.accessToken);
    assert.equal(stale.response.status, 409);
    const prepared = await post('review', input, ownerWeb.accessToken);
    assert.equal(prepared.response.status, 200, JSON.stringify(prepared.value));
    assert.equal(prepared.value.authority.schema, 'deft.app_runtime_grant.v2');
    const activated = await post('activate', { ...input, expected_review_digest: prepared.value.review_digest,
      accept_host_policy: true }, ownerWeb.accessToken);
    assert.equal(activated.response.status, 200, JSON.stringify(activated.value));
    assert.equal(activated.value.installation.state, 'active');
    assert.ok(activated.value.grant_snapshot_id);
    assert.deepEqual(await db.select({ id: schema.appResourceBindings.id }).from(schema.appResourceBindings)
      .where(eq(schema.appResourceBindings.org_id, orgId)), []);
  } finally {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await closeDb();
  }
});
