import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
import type { ServerType } from '@hono/node-server';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const u = new URL(target); return ['postgres:', 'postgresql:'].includes(u.protocol)
    && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260926_resource_resolve_test$/.test(u.pathname)
    && !u.search && !u.hash; } catch { return false; }
})();
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
// Deterministic keys are confined to the explicitly named disposable test database.
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`management-http:${purpose}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('mgmt-enc'), receipt_signing: ring('mgmt-sign'), fingerprint: ring('mgmt-fp') });
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

async function harness(shortConsentMs?: number) {
  const [{ db }, schema, drizzle, webSessions, runtimeModule, privateRoutes, channelRoutes,
    managementRoutes, hono, serverModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js'),
    import('../src/routes/resources.js'), import('../src/routes/app-resource-sync-channel.js'),
    import('../src/routes/app-resource-sync-management.js'), import('hono'), import('@hono/node-server'),
  ]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const fixture = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date(),
    descriptor: { schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox', runtime_requirement_key: 'provider',
      resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject',
      record_schema: { type: 'object', properties: { subject: { type: 'string', maxLength: 200 },
        body: { type: 'string', maxLength: 200 } }, required: ['subject', 'body'], additionalProperties: false } } });
  const token = async (id: string, orgId = fixture.org_id) => {
    const [user] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, id));
    return webSessions.createWebSession({ id, org_id: orgId, email: user!.email });
  };
  const owner = await token(fixture.owner_user_id);
  const operator = await token(fixture.operator_user_id);
  const app = new hono.Hono();
  const { authMiddleware } = await import('../src/middleware/auth.js');
  app.use('/resolve', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    await next();
  });
  app.use('/resolve', authMiddleware);
  app.route('/', privateRoutes.resourceRoutes);
  app.route('/sync', channelRoutes.appResourceSyncChannelRoutes);
  app.route('/manage', managementRoutes.appResourceSyncManagementRoutes);
  let server!: ServerType;
  const base = await new Promise<string>(resolve => {
    server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      info => resolve(`http://127.0.0.1:${info.port}`));
  });
  const call = async (path: string, auth = `Bearer ${owner.accessToken}`, method = 'GET', value?: unknown) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(auth ? { Authorization: auth } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (path.startsWith('/resolve')) assert.equal(response.headers.get('pragma'), 'no-cache');
    return { status: response.status, body: await response.json() as any };
  };
  let bindingId = fixture.binding_id;
  let registrationId = fixture.registration_id;
  let expiresAt = fixture.consent_request.consent_expires_at;
  if (shortConsentMs) {
    await fixture.management.revokeConsent(fixture.owner_actor, fixture.binding_id);
    const request = { ...fixture.consent_request, consent_expires_at: new Date(Date.now() + shortConsentMs).toISOString() };
    const review = await fixture.management.prepareConsent(fixture.owner_actor, request);
    const activated = await fixture.management.activateConsent(fixture.owner_actor, { ...request,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    bindingId = activated.binding_id;
    registrationId = activated.registration_id;
    expiresAt = request.consent_expires_at;
  }
  const issued = await call(`/manage/bindings/${bindingId}/sessions`, `Bearer ${operator.accessToken}`, 'POST');
  assert.equal(issued.status, 201);
  const session = issued.body.session;
  const admitted = await runtime.resourceSyncAdmission.admitDue({ org_id: fixture.org_id, resource_binding_id: bindingId });
  assert.equal(admitted.state, 'created');
  const identity = { schema_version: 'deft.app_runtime_channel.v2', audience: 'app_resource_sync', session_id: session.session_id };
  const runtimeAuth = `AppRuntime ${session.session_token}`;
  const claimed = await call('/sync/claim', runtimeAuth, 'POST', { ...identity, max_claims: 1 });
  assert.equal(claimed.status, 200);
  const claim = claimed.body.claim;
  assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id,
    claim_token: claim.claim_token, sequence: claim.sequence };
  assert.equal((await call('/sync/start', runtimeAuth, 'POST', attempt)).status, 200);
  const completed = await call('/sync/result', runtimeAuth, 'POST', { ...attempt,
    status: 'returned', provider_succeeded: true, page: { schema_version: 'deft.app_sync_page.v1',
      upserts: Array.from({ length: 3 }, (_, i) => ({ id: `provider-private-${i}`, revision: `r${i}`,
        data: { subject: `Private HTTP message ${i}`, body: `Secret body ${i}` } })), tombstones: [],
      next_cursor: 'provider-private-cursor', has_more: false } });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.accepted, true);
  const marker = `private-http-${fixture.org_id}`;
  const originalTransaction = runtime.repository.transaction.bind(runtime.repository);
  runtime.repository.transaction = <T>(work: (tx: AppRunTransaction) => Promise<T>) => originalTransaction(async tx => {
    await tx.execute(drizzle.sql`SELECT set_config('application_name', ${marker}, true)`);
    return work(tx);
  });
  return { db, schema, ...drizzle, ...fixture, binding_id: bindingId, registration_id: registrationId, expires_at: expiresAt, marker,
    owner, operator, runtime, webSessions, call, token, runtimeAuth, runtime_session: session,
    close: () => { runtime.repository.transaction = originalTransaction;
      return new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}

async function waitForLock(h: Awaited<ReturnType<typeof harness>>, table: string) {
  for (let i = 0; i < 250; i++) {
    const result = await h.db.execute(h.sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=current_database() AND pid <> pg_backend_pid() AND wait_event_type='Lock'
        AND application_name = ${h.marker}
        AND query LIKE ${`%${table}%`}`);
    if (result.rows[0]!.waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`actual HTTP request did not wait on ${table}`);
}

async function reference(h: Awaited<ReturnType<typeof harness>>) {
  const [projection] = await h.db.select().from(h.schema.appResourceProjections)
    .where(h.eq(h.schema.appResourceProjections.resource_binding_id, h.binding_id));
  return { schema_version: 'deft.resource_ref.v2', provider: { kind: 'app_runtime',
    provider_instance_id: h.registration_id }, resource_type: 'email_message', resource_id: projection!.id };
}
const resolvePath = (ref: unknown) => `/resolve?ref=${encodeURIComponent(JSON.stringify(ref))}`;

test('canonical resolver returns only the owner safe display from a settled private resource', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const ref = await reference(h);
    const result = await h.call(resolvePath(ref));
    assert.equal(result.status, 200);
    assert.equal(result.body.state, 'available');
    assert.deepEqual(result.body.ref, ref);
    assert.deepEqual(Object.keys(result.body.resource).sort(), ['label', 'ref', 'schema_version']);
    assert.match(result.body.resource.label, /^Private HTTP message [0-2]$/);
    const serialized = JSON.stringify(result.body);
    for (const secret of ['Secret body', 'provider-private', 'cursor', 'ciphertext', 'data',
      h.binding_id, h.owner_user_id, h.operator_user_id, h.runtime_session.session_token]) {
      assert.ok(!serialized.includes(secret), `safe projection leaked ${secret}`);
    }
  } finally { await h.close(); }
});

test('canonical private locator denies foreign and mismatched authority without distinguishing existence', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const ref = await reference(h);
    const unavailable = async (locator = ref, auth?: string) => {
      const result = await h.call(resolvePath(locator), auth);
      assert.deepEqual(result, { status: 200, body: { schema_version: 'deft.resource_resolve.v2',
        ref: locator, state: 'unavailable' } });
    };
    await unavailable(ref, `Bearer ${h.operator.accessToken}`);
    await h.db.update(h.schema.orgMembers).set({ role: 'admin' }).where(h.and(
      h.eq(h.schema.orgMembers.org_id, h.org_id), h.eq(h.schema.orgMembers.user_id, h.operator_user_id)));
    const admin = await h.token(h.operator_user_id);
    await unavailable(ref, `Bearer ${admin.accessToken}`);
    const foreignOrg = randomUUID();
    await h.db.insert(h.schema.orgs).values({ id: foreignOrg, name: 'foreign', slug: `resolve-${foreignOrg}` });
    await h.db.insert(h.schema.orgMembers).values({ org_id: foreignOrg, user_id: h.owner_user_id, role: 'owner', is_active: true });
    const foreign = await h.token(h.owner_user_id, foreignOrg);
    await unavailable(ref, `Bearer ${foreign.accessToken}`);
    await unavailable({ ...ref, resource_type: 'other_resource' });
    await unavailable({ ...ref, resource_id: randomUUID() });
    await unavailable({ ...ref, resource_id: 'not-a-host-uuid' });
    await unavailable({ ...ref, provider: { ...ref.provider, provider_instance_id: randomUUID() } });
    await unavailable({ ...ref, provider: { ...ref.provider, provider_instance_id: 'not-a-host-uuid' } });
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
    await unavailable();
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
    assert.equal((await h.call(resolvePath(ref))).body.state, 'available');
    await h.management.revokeConsent(h.owner_actor, h.binding_id);
    await unavailable();
  } finally { process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true'; await h.close(); }
});

test('canonical private resolver fences durable tombstones and paused checkpoints', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const ref = await reference(h);
    // Inject durable record state, never authority, through the DB's enforced transition.
    await h.db.update(h.schema.appResourceProjections).set({ state: 'tombstone',
      tombstoned_at: new Date(), applied_sequence: 2, body_bytes: 0, body_envelope_version: null,
      body_algorithm: null, body_key_version: null, body_nonce_b64: null,
      body_ciphertext_b64: null, body_auth_tag_b64: null })
      .where(h.eq(h.schema.appResourceProjections.id, ref.resource_id));
    assert.equal((await h.call(resolvePath(ref))).body.state, 'unavailable');
    const [other] = await h.db.select().from(h.schema.appResourceProjections).where(h.and(
      h.eq(h.schema.appResourceProjections.resource_binding_id, h.binding_id),
      h.eq(h.schema.appResourceProjections.state, 'live')));
    const otherRef = { ...ref, resource_id: other!.id };
    assert.equal((await h.call(resolvePath(otherRef))).body.state, 'available');
    await h.db.update(h.schema.appSyncCheckpoints).set({ state: 'paused' })
      .where(h.eq(h.schema.appSyncCheckpoints.id, h.checkpoint_id));
    assert.equal((await h.call(resolvePath(otherRef))).body.state, 'unavailable');
  } finally { await h.close(); }
});

test('canonical resolver rejects a different current SID and bearer purpose', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const ref = await reference(h);
    for (const auth of ['', h.runtimeAuth, `Bearer ${h.runtime_session.session_token}`,
      `Bearer ${h.owner.refreshToken}`, 'Bearer synthetic-personal-mcp']) {
      // The authenticated route harness rejects non-web bearer purposes before resolution.
      const denied = await h.call(resolvePath(ref), auth);
      assert.equal(denied.status, 401);
      assert.ok(!JSON.stringify(denied.body).includes('Private HTTP'));
    }
    const current = await h.webSessions.verifyWebAccess(h.owner.accessToken);
    const other = await h.token(h.owner_user_id);
    const { NativeResourceService } = await import('../src/lib/native-resource-service.js');
    await assert.rejects(new NativeResourceService().resolve({ org_id: h.org_id, user_id: h.owner_user_id,
      sid: current.sid }, ref, `Bearer ${other.accessToken}`),
    (error: unknown) => (error as { code: string }).code === 'RESOURCE_ACCESS_DENIED');
  } finally { await h.close(); }
});

for (const race of ['sid-revoked', 'sid-expired', 'consent-expired', 'operator-nonhuman'] as const) {
  test(`canonical resolver discards private display after actual SID lock wait: ${race}`, { skip: !safe }, async () => {
    const h = await harness(race === 'consent-expired' ? 10_000 : undefined);
    let release = () => {};
    try {
      const ref = await reference(h);
      const current = await h.webSessions.verifyWebAccess(h.owner.accessToken);
      const expiresAt = new Date(Date.now() + 3_000);
      if (race === 'sid-expired') await h.db.update(h.schema.webSessions).set({ expires_at: expiresAt })
        .where(h.eq(h.schema.webSessions.id, current.sid));
      let acquired!: () => void;
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const blocker = h.db.transaction(async tx => {
        await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id = ${current.sid} FOR UPDATE`);
        acquired(); await released;
        if (race === 'sid-revoked') await tx.update(h.schema.webSessions).set({ revoked_at: new Date() })
          .where(h.eq(h.schema.webSessions.id, current.sid));
      });
      await locked;
      const pending = h.call(resolvePath(ref));
      await waitForLock(h, 'web_sessions');
      if (race === 'operator-nonhuman') await h.db.update(h.schema.users).set({ kind: 'agent' })
        .where(h.eq(h.schema.users.id, h.operator_user_id));
      if (race === 'sid-expired' || race === 'consent-expired') {
        const deadline = race === 'sid-expired' ? expiresAt.getTime() : new Date(h.expires_at).getTime();
        assert.ok(Date.now() < deadline, 'request reached actual lock before expiry');
        await new Promise(resolve => setTimeout(resolve, deadline - Date.now() + 30));
      }
      release(); await blocker;
      const denied = await pending;
      assert.equal(denied.status, race.startsWith('sid-') ? 403 : 200);
      if (!race.startsWith('sid-')) assert.equal(denied.body.state, 'unavailable');
      assert.ok(!JSON.stringify(denied.body).includes('Private HTTP message'));
      assert.ok(!JSON.stringify(denied.body).includes('Secret body'));
    } finally { release(); await h.close(); }
  });
}


