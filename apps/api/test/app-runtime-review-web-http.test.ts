import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { ServerType } from '@hono/node-server';

const safe = process.env.DATABASE_URL === process.env.DEFT_TEST_DATABASE_URL
  && process.env.DATABASE_URL === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_v5_activation_test';
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`activation-http:${purpose}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('act-enc'), receipt_signing: ring('act-sig'), fingerprint: ring('act-fp') });
let server: ServerType | undefined;
let base: string;
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
  if (safe) await (await import('../src/lib/db.js')).closeDb();
});

async function fixture(protocol: '3' | '4' | '5' = '5', mixed = false, withModule = false) {
  const [{ app }, { db }, schema, drizzle, kit, sessions, serverModule] = await Promise.all([
    import('../src/index.js'), import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('@deft/app-kit'), import('../src/lib/web-sessions.js'), import('@hono/node-server'),
  ]);
  if (!server) base = await new Promise<string>(resolve => {
    server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`));
  });
  const org = randomUUID(); const owner = randomUUID(); const peer = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  await db.insert(schema.orgs).values({ id: org, name: 'Activation HTTP', slug: `activation-${suffix}` });
  await db.insert(schema.users).values([{ id: owner, name: 'Owner', email: `${owner}@example.test` },
    { id: peer, name: 'Member', email: `${peer}@example.test` }]);
  await db.insert(schema.orgMembers).values([{ org_id: org, user_id: owner, role: 'owner', is_active: true },
    { org_id: org, user_id: peer, role: 'member', is_active: true }]);
  const token = (id = owner, orgId = org) => sessions.createWebSession({ id, org_id: orgId, email: `${id}@example.test` });
  const web = await token(); const memberWeb = await token(peer);
  const call = async (path: string, value?: unknown, auth = web.accessToken) => {
    const response = await fetch(`${base}${path}`, { method: value === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${auth}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() as any,
      cache: response.headers.get('cache-control') };
  };
  const shape = { type: 'object' as const, properties: { subject: { type: 'string' as const, maxLength: 200 } },
    required: ['subject'], additionalProperties: false as const };
  const actions = protocol !== '5' || mixed;
  const moduleManifest = { schema_version: '1', id: `community.example.items.a${suffix}`, slug: `items-${suffix}`,
    version: '1.0.0', name: 'Items', collections: [{ key: 'items', name: 'Items', singular_name: 'Item',
      fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }],
      search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
    navigation: { default_collection: 'items', default_view: 'all' } };
  const artifacts = withModule ? [await kit.prepareModuleArtifact({ path: 'modules/items/deft.module.json', manifest: moduleManifest })] : [];
  const manifest = { schema_version: protocol, id: `community.example.activation.a${suffix}`, version: '1.0.0',
    name: 'Activation fixture', license: 'AGPL-3.0-only', compatibility: { app_protocol: protocol },
    runtime_requirements: [
      ...(protocol === '5' ? [{ key: 'sync', protocol_version: 'deft.app_runtime_channel.v2' }] : []),
      ...(actions ? [{ key: 'actions', protocol_version: 'deft.app_runtime_channel.v1' }] : []),
    ],
    private_capabilities: actions ? [{ key: 'message', version: '1', input_schema: shape, output_schema: shape }] : [],
    runtime_actions: actions ? [{ key: 'send_message', label: 'Send message', capability_key: 'message', runtime_requirement_key: 'actions' }] : [],
    modules: artifacts.map(artifact => ({ module_id: moduleManifest.id,
      version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest })),
    navigation: [],
    ...(protocol !== '3' ? { experiences: [], public_actions: [] } : {}),
    ...(protocol === '5' ? { sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
      runtime_requirement_key: 'sync', resource_type: 'email_message', requested_visibility: 'user_private',
      record_schema: shape, label_field: 'subject' }] } : {}),
  };
  const pkg = await kit.buildDeftAppPackage({ manifest, artifacts });
  const staged = await call('/api/apps/stage', JSON.parse(pkg.json));
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const installed = staged.body.app;
  const path = `/api/app-runtime-review/${installed.id}`;
  const context = () => call(`${path}/context?app_version_id=${installed.version_id}`);
  return { db, schema, ...drizzle, sessions, org, owner, peer, web, memberWeb, token, call, installed, path, context };
}

test('staged sync-only v5 activates over v2-only HTTP using typed current pins', { skip: !safe }, async () => {
  const h = await fixture();
  const context = await h.context();
  assert.equal(context.status, 200);
  assert.equal(context.cache, 'no-store');
  assert.equal(context.body.schema_version, 'deft.app_runtime_review_context.v1');
  const input = context.body.review_request;
  const review = await h.call(`${h.path}/review`, input);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const activated = await h.call(`${h.path}/activate`, { ...input, expected_review_digest: review.body.review_digest, accept_host_policy: true });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const current = await h.context();
  assert.equal(current.body.state, 'active');
  assert.equal(current.body.review_request, null);
  assert.equal(current.body.current_activation.review_digest, review.body.review_digest);
  for (const table of [h.schema.appResourceBindings, h.schema.appRuntimeRegistrations, h.schema.appRuntimeSessions,
    h.schema.appSyncCheckpoints, h.schema.appRuns]) {
    assert.equal((await h.db.select({ id: table.id }).from(table).where(h.eq(table.org_id, h.org))).length, 0);
  }
});

test('runtime review discovery and activation enforce pins purpose tenant and default-off gates', { skip: !safe }, async () => {
  const h = await fixture();
  const context = await h.context();
  const input = context.body.review_request;
  const jwt = (await import('jsonwebtoken')).default;
  const { env } = await import('../src/lib/env.js');
  const caller = await h.sessions.verifyWebAccess(h.web.accessToken);
  const signed = (purpose: string, sid = caller.sid) => jwt.sign({ id: h.owner, org_id: h.org,
    email: `${h.owner}@example.test`, purpose, sid, jti: randomUUID() }, env.JWT_SECRET, { expiresIn: 60 });
  for (const auth of [h.web.refreshToken, signed('personal-mcp'), signed('employee'), signed('developer'),
    signed('web-access', randomUUID()), 'AppRuntime invalid']) {
    assert.equal((await h.call(`${h.path}/context?app_version_id=${h.installed.version_id}`, undefined, auth)).status, 401);
    assert.equal((await h.call(`${h.path}/review`, input, auth)).status, 401);
    assert.equal((await h.call(`${h.path}/activate`, { ...input,
      expected_review_digest: `sha256:${'0'.repeat(64)}`, accept_host_policy: true }, auth)).status, 401);
  }
  assert.equal((await h.call(`${h.path}/review`, input, h.memberWeb.accessToken)).status, 403);
  const foreignOrg = randomUUID();
  await h.db.insert(h.schema.orgs).values({ id: foreignOrg, name: 'Other org', slug: foreignOrg });
  await h.db.insert(h.schema.orgMembers).values({ org_id: foreignOrg, user_id: h.owner, role: 'owner', is_active: true });
  const foreign = await h.token(h.owner, foreignOrg);
  assert.equal((await h.call(`${h.path}/review`, input, foreign.accessToken)).status, 409);
  for (const query of ['', `?app_version_id=${h.installed.version_id}&extra=yes`,
    `?app_version_id=${h.installed.version_id}&app_version_id=${h.installed.version_id}`]) {
    assert.equal((await h.call(`${h.path}/context${query}`)).status, 400);
  }
  assert.equal((await h.call(`${h.path}/context?app_version_id=${randomUUID()}`)).status, 409);
  for (const change of [{ expected_package_digest: `sha256:${'0'.repeat(64)}` },
    { expected_requested_snapshot_digest: `sha256:${'0'.repeat(64)}` },
    { expected_lifecycle_epoch: input.expected_lifecycle_epoch + 1 },
    { expected_grant_epoch: input.expected_grant_epoch + 1 }, { app_version_id: randomUUID() }]) {
    assert.equal((await h.call(`${h.path}/review`, { ...input, ...change })).status, 409);
  }
  assert.equal((await h.call(`${h.path}/activate`, { ...input,
    expected_review_digest: `sha256:${'0'.repeat(64)}`, accept_host_policy: true })).status, 409);
  assert.equal((await h.call(`${h.path}/review`, { ...input, authority: {} })).status, 400);
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
  try { assert.equal((await h.context()).status, 503); assert.equal((await h.call(`${h.path}/review`, input)).status, 503); }
  finally { process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true'; }
});

test('disabled sync-only App requires fresh pins and explicit admin acceptance', { skip: !safe }, async () => {
  const h = await fixture('5', false, true);
  const input = (await h.context()).body.review_request;
  const review = await h.call(`${h.path}/review`, input);
  const original = { ...input, expected_review_digest: review.body.review_digest, accept_host_policy: true };
  const activated = await h.call(`${h.path}/activate`, original);
  assert.equal(activated.status, 200);
  const disabled = await h.call(`/api/apps/${h.installed.id}/disable`,
    { expected_lifecycle_epoch: activated.body.installation.lifecycle_epoch });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  await h.db.update(h.schema.orgMembers).set({ role: 'admin' }).where(h.and(
    h.eq(h.schema.orgMembers.org_id, h.org), h.eq(h.schema.orgMembers.user_id, h.owner)));
  const next = await h.context();
  assert.equal(next.status, 200);
  assert.equal(next.body.state, 'disabled');
  assert.equal(next.body.current_activation, null);
  assert.ok(next.body.review_request.expected_lifecycle_epoch > input.expected_lifecycle_epoch);
  assert.equal((await h.call(`${h.path}/activate`, original)).status, 409);
  const prepared = await h.call(`${h.path}/review`, next.body.review_request);
  assert.equal(prepared.status, 200);
  assert.notEqual(prepared.body.review_digest, review.body.review_digest);
  const accepted = await h.call(`${h.path}/activate`, { ...next.body.review_request,
    expected_review_digest: prepared.body.review_digest, accept_host_policy: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.notEqual(accepted.body.grant_snapshot_id, activated.body.grant_snapshot_id);
  assert.equal((await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.org_id, h.org))).length, 1);
  const [module] = await h.db.select().from(h.schema.moduleInstallations).where(h.eq(h.schema.moduleInstallations.org_id, h.org));
  assert.equal(module!.is_enabled, true);
  assert.equal(module!.disabled_at, null);
  assert.equal((await h.context()).body.current_activation.review_digest, prepared.body.review_digest);
});

test('v3 v4 and mixed v5 preserve v1 admission without acquiring v5 action support', { skip: !safe }, async () => {
  for (const protocol of ['3', '4', '5'] as const) {
    const h = await fixture(protocol, true);
    assert.equal((await h.context()).status, 503, `${protocol} must not use the sync-only exception`);
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    try {
      const input = (await h.context()).body.review_request;
      const review = await h.call(`${h.path}/review`, input);
      assert.equal(review.status, 200);
      const accepted = { ...input, expected_review_digest: review.body.review_digest, accept_host_policy: true };
      const result = await h.call(`${h.path}/activate`, accepted);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const { loadReviewedRuntimeAction } = await import('../src/lib/app-runtime-review.js');
      const load = () => h.db.transaction(tx => loadReviewedRuntimeAction(tx, h.org, h.installed.id, 'send_message'));
      if (protocol === '5') await assert.rejects(load()); else assert.ok((await load()).action);
    } finally { process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false'; }
  }
});

test('concurrent accepts create one grant and lost response is recovered by exact current digest', { skip: !safe }, async () => {
  const h = await fixture('5', false, true);
  const input = (await h.context()).body.review_request;
  const review = await h.call(`${h.path}/review`, input);
  const value = { ...input, expected_review_digest: review.body.review_digest, accept_host_policy: true };
  const outcomes = await Promise.all([h.call(`${h.path}/activate`, value), h.call(`${h.path}/activate`, value)]);
  assert.deepEqual(outcomes.map(item => item.status).sort(), [200, 409]);
  const current = (await h.context()).body;
  assert.equal(current.current_activation.review_digest, review.body.review_digest);
  assert.equal(current.review_request, null);
  const grants = await h.db.select().from(h.schema.appGrantSnapshots).where(h.and(
    h.eq(h.schema.appGrantSnapshots.org_id, h.org), h.eq(h.schema.appGrantSnapshots.snapshot_kind, 'effective')));
  assert.equal(grants.length, 1);
  assert.equal((await h.db.select().from(h.schema.appModuleBindings).where(h.eq(h.schema.appModuleBindings.org_id, h.org))).length, 1);
  const [installation] = await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id, h.installed.id));
  assert.equal(installation!.lifecycle_epoch, input.expected_lifecycle_epoch + 1);
  assert.equal(installation!.grant_epoch, input.expected_grant_epoch + 1);
  assert.equal((await h.db.select().from(h.schema.auditLog).where(h.and(
    h.eq(h.schema.auditLog.org_id, h.org), h.eq(h.schema.auditLog.action, 'app.runtime.review_activate')))).length, 1);
});

async function waitForSidLock(h: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 200; i++) {
    const result = await h.db.execute(h.sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%web_sessions%'
        AND query ILIKE '%for share%'`);
    if (result.rows[0]!.count > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('request never reached final SID lock');
}

for (const operation of ['context', 'review', 'activate'] as const) {
  for (const race of ['revoke', 'expire', 'token', 'kind', 'flag'] as const) {
    test(`web ${operation} rejects ${race} at final SID lock and activation rolls back modules`, { skip: !safe }, async () => {
      const h = await fixture('5', false, operation === 'activate');
      const input = (await h.context()).body.review_request;
      const review = await h.call(`${h.path}/review`, input);
      const value = operation === 'activate' ? { ...input, expected_review_digest: review.body.review_digest, accept_host_policy: true } : input;
      const caller = await h.sessions.verifyWebAccess(h.web.accessToken);
      const expiry = new Date(Date.now() + 1_200);
      if (race === 'expire') await h.db.update(h.schema.webSessions).set({ expires_at: expiry }).where(h.eq(h.schema.webSessions.id, caller.sid));
      let release!: () => void; let entered!: () => void;
      const held = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const blocker = h.db.transaction(async tx => {
        await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id = ${caller.sid} FOR UPDATE`);
        entered(); await released;
        if (race === 'revoke') await tx.update(h.schema.webSessions).set({ revoked_at: new Date() }).where(h.eq(h.schema.webSessions.id, caller.sid));
      });
      let pending: Promise<Awaited<ReturnType<typeof h.call>>> | undefined;
      try {
        await held;
        let auth = h.web.accessToken;
        const tokenExpiry = Math.floor(Date.now() / 1000) + 3;
        if (race === 'token') {
          const jwt = (await import('jsonwebtoken')).default;
          const { env } = await import('../src/lib/env.js');
          auth = jwt.sign({ id: h.owner, org_id: h.org, email: `${h.owner}@example.test`,
            sid: caller.sid, jti: randomUUID(), purpose: 'web-access', exp: tokenExpiry }, env.JWT_SECRET);
        }
        pending = operation === 'context'
          ? h.call(`${h.path}/context?app_version_id=${h.installed.version_id}`, undefined, auth)
          : h.call(`${h.path}/${operation}`, value, auth);
        await waitForSidLock(h);
        if (race === 'kind') await h.db.update(h.schema.users).set({ kind: 'agent' }).where(h.eq(h.schema.users.id, h.owner));
        if (race === 'flag') process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
        if (race === 'expire') {
          assert.ok(Date.now() < expiry.getTime());
          await new Promise(resolve => setTimeout(resolve, expiry.getTime() - Date.now() + 30));
        }
        if (race === 'token') {
          assert.ok(Date.now() < tokenExpiry * 1000);
          await new Promise(resolve => setTimeout(resolve, tokenExpiry * 1000 - Date.now() + 30));
        }
        release(); await blocker;
        const denied = await pending;
        assert.equal(denied.status, race === 'kind' ? 403 : race === 'flag' ? 503 : 401, JSON.stringify(denied.body));
        const [installation] = await h.db.select().from(h.schema.appInstallations).where(h.eq(h.schema.appInstallations.id, h.installed.id));
        assert.equal(installation!.state, 'staged');
        assert.equal(installation!.lifecycle_epoch, input.expected_lifecycle_epoch);
        assert.equal(installation!.grant_epoch, input.expected_grant_epoch);
        const [version] = await h.db.select().from(h.schema.appVersions).where(h.eq(h.schema.appVersions.id, input.app_version_id));
        assert.equal(version!.state, 'staged');
        for (const table of [h.schema.appModuleBindings, h.schema.moduleInstallations]) {
          assert.equal((await h.db.select({ id: table.id }).from(table).where(h.eq(table.org_id, h.org))).length, 0);
        }
        assert.equal((await h.db.select().from(h.schema.appGrantSnapshots).where(h.and(
          h.eq(h.schema.appGrantSnapshots.org_id, h.org), h.eq(h.schema.appGrantSnapshots.snapshot_kind, 'effective')))).length, 0);
        assert.equal((await h.db.select().from(h.schema.auditLog).where(h.and(
          h.eq(h.schema.auditLog.org_id, h.org), h.eq(h.schema.auditLog.action, 'app.runtime.review_activate')))).length, 0);
      } finally {
        release(); await blocker; await pending;
        process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
      }
    });
  }
}
