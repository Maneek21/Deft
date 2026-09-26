import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import type { ServerType } from '@hono/node-server';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try { const u = new URL(target); return ['postgres:', 'postgresql:'].includes(u.protocol)
    && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260926_setup_test$/.test(u.pathname)
    && !u.search && !u.hash; } catch { return false; }
})();
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`management-http:${purpose}`).digest('base64') } });
const keyring = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('mgmt-enc'), receipt_signing: ring('mgmt-sign'), fingerprint: ring('mgmt-fp') });
process.env.DEFT_APP_RUN_KEYRINGS = keyring;
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

async function harness() {
  const [{ db }, schema, drizzle, session, keysModule, routes, hono, serverModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/web-sessions.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/routes/app-resource-sync-management.js'), import('hono'), import('@hono/node-server'),
  ]);
  const keys = keysModule.parseEnvironmentAppRunKeyrings(keyring);
  const fixture = await createReviewedResourceSyncFixture({ keys, clock: () => new Date() });
  const app = new hono.Hono();
  app.route('/manage', routes.createAppResourceSyncManagementRoutes({ management: async () => fixture.management }));
  let server!: ServerType;
  const base = await new Promise<string>((resolve) => {
    server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      resolve(`http://127.0.0.1:${info.port}/manage`);
    });
  });
  const token = async (id: string, orgId = fixture.org_id) => {
    const [user] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, id));
    return session.createWebSession({ id, org_id: orgId, email: user!.email });
  };
  const owner = await token(fixture.owner_user_id);
  const operator = await token(fixture.operator_user_id);
  const call = async (path: string, method = 'GET', value?: unknown, bearer = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() as any };
  };
  return { db, schema, ...drizzle, ...fixture, owner, operator, call, token, session, base,
    close: async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); keys.destroy(); } };
}

test('setup HTTP publishes self consent pins, recovers activation loss and requires expired consent revocation', { skip: !safe }, async () => {
  const h = await harness();
  try {
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false';
    const path = `/setup?installation_id=${h.consent_request.installation_id}`;
    const result = await h.call(path);
    assert.equal(result.status, 200);
    const setup = result.body.setup;
    assert.equal(setup.schema_version, 'deft.app_resource_sync_setup.v1');
    assert.equal(setup.owner_user_id, h.owner_user_id);
    assert.equal(setup.operator_user_id, h.owner_user_id);
    assert.equal(setup.descriptors.length, 1);
    const descriptor = setup.descriptors[0];
    assert.equal(descriptor.visibility, 'user_private');
    assert.equal(descriptor.existing_binding.binding_id, h.binding_id);
    assert.equal(descriptor.existing_binding.requires_revoke, false);
    assert.equal(descriptor.existing_binding.can_issue_session, false, 'another operator credential is never offered');
    const request = descriptor.consent_request;
    assert.equal(request.operator_user_id, h.owner_user_id);
    assert.equal(request.expected_grant_snapshot_digest, h.consent_request.expected_grant_snapshot_digest);
    for (const [key, value] of Object.entries(request.limits)) {
      assert.ok(Number(value) >= setup.host_limits.limits[key].min);
      assert.ok(Number(value) <= setup.host_limits.limits[key].max);
    }
    for (const secret of ['canonical_snapshot', 'record_schema', 'cursor_hmac', 'session_token', 'token_hash', 'provider_snapshot_id']) {
      assert.ok(!JSON.stringify(setup).includes(secret));
    }
    assert.equal((await h.call(`/bindings/${h.binding_id}/revoke`, 'POST')).status, 200);
    const shortRequest = { ...request, consent_expires_at: new Date(Date.now() + 3000).toISOString() };
    const shortReview = await h.call('/reviews/prepare', 'POST', shortRequest);
    assert.equal(shortReview.status, 200);
    const shortActivation = await h.call('/bindings/activate', 'POST', { ...shortRequest,
      expected_review_digest: shortReview.body.review.review_digest, accept_host_policy: true });
    assert.equal(shortActivation.status, 201);
    await new Promise(resolve => setTimeout(resolve,
      Math.max(0, new Date(shortRequest.consent_expires_at).getTime() - Date.now() + 20)));
    assert.equal((await h.call(path)).body.setup.descriptors[0].existing_binding.requires_revoke, true);
    const review = await h.call('/reviews/prepare', 'POST', request);
    assert.equal(review.status, 200);
    const activation = { ...request, expected_review_digest: review.body.review.review_digest, accept_host_policy: true };
    assert.equal((await h.call('/bindings/activate', 'POST', activation)).status, 409);
    assert.equal((await h.call(`/bindings/${shortActivation.body.binding.binding_id}/revoke`, 'POST')).status, 200);
    assert.equal((await h.call(path)).body.setup.descriptors[0].existing_binding, null);
    const activated = await h.call('/bindings/activate', 'POST', activation);
    assert.equal(activated.status, 201);
    assert.equal((await h.call('/bindings/activate', 'POST', activation)).status, 409);
    const recovered = (await h.call(path)).body.setup.descriptors[0].existing_binding;
    assert.equal(recovered.binding_id, activated.body.binding.binding_id);
    assert.equal(recovered.can_issue_session, true);
    assert.equal((await h.call(`/bindings/${recovered.binding_id}/sessions`, 'POST')).status, 201);
    const stale = { ...request, expected_grant_epoch: request.expected_grant_epoch + 1 };
    assert.equal((await h.call('/reviews/prepare', 'POST', stale)).status, 409);
    const apps = await import('../src/lib/app-service.js');
    await apps.disableAppInstallation(h.owner_actor, request.installation_id, request.expected_lifecycle_epoch);
    assert.equal((await h.call('/reviews/prepare', 'POST', request)).status, 409,
      'actual authority change invalidates previously discovered pins');
    assert.equal((await h.call('/bindings/activate', 'POST', activation)).status, 409);
    assert.equal((await h.call(path)).status, 409);
  } finally { await h.close(); }
});

test('setup HTTP denies non-manager/foreign identity and validates exact query under default-off', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const path = `/setup?installation_id=${h.consent_request.installation_id}`;
    assert.equal((await h.call(path, 'GET', undefined, h.operator.accessToken)).status, 403);
    for (const suffix of ['&owner_user_id=' + h.owner_user_id, '&installation_id=' + h.consent_request.installation_id]) {
      assert.equal((await h.call(path + suffix)).status, 400);
    }
    assert.equal((await h.call('/setup')).status, 400);
    assert.equal((await h.call(`/setup?installation_id=${randomUUID()}`)).status, 409);
    const foreignOrg = randomUUID();
    await h.db.insert(h.schema.orgs).values({ id: foreignOrg, name: 'foreign', slug: `foreign-${foreignOrg}` });
    await h.db.insert(h.schema.orgMembers).values({ org_id: foreignOrg, user_id: h.owner_user_id, role: 'owner', is_active: true });
    const foreign = await h.token(h.owner_user_id, foreignOrg);
    assert.equal((await h.call(path, 'GET', undefined, foreign.accessToken)).status, 409);
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
    assert.equal((await h.call(path)).status, 503);
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
    await h.db.update(h.schema.orgMembers).set({ role: 'guest' }).where(h.and(
      h.eq(h.schema.orgMembers.org_id, h.org_id), h.eq(h.schema.orgMembers.user_id, h.owner_user_id)));
    assert.equal((await h.call(path)).status, 403);
  } finally { process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true'; await h.close(); }
});

test('setup HTTP rechecks SID expiry and human kind after a real final SID lock wait', { skip: !safe }, async () => {
  for (const change of ['expiry', 'kind'] as const) {
    const h = await harness();
    let release = () => {};
    try {
      let acquired!: () => void;
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      let blockerPid = 0;
      const blocker = h.db.transaction(async tx => {
        blockerPid = (await tx.execute(h.sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
        await tx.execute(h.sql`SELECT id FROM web_sessions WHERE org_id = ${h.org_id}
          AND user_id = ${h.owner_user_id} FOR UPDATE`);
        acquired(); await released;
        if (change === 'expiry') await tx.update(h.schema.webSessions).set({ expires_at: new Date(Date.now() - 1000) })
          .where(h.and(h.eq(h.schema.webSessions.org_id, h.org_id), h.eq(h.schema.webSessions.user_id, h.owner_user_id)));
      });
      await locked;
      const pending = h.call(`/setup?installation_id=${h.consent_request.installation_id}`);
      let waited = false;
      for (let i = 0; i < 250; i++) {
        const result = await h.db.execute(h.sql<{ waiting: number }>`SELECT count(*)::int AS waiting
          FROM pg_stat_activity WHERE datname=current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))`);
        if (result.rows[0]!.waiting > 0) { waited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(waited, 'setup request waited on exact SID lock');
      if (change === 'kind') await h.db.update(h.schema.users).set({ kind: 'agent' })
        .where(h.eq(h.schema.users.id, h.owner_user_id));
      release(); await blocker;
      const result = await pending;
      assert.equal(result.status, change === 'expiry' ? 401 : 403);
      assert.equal(result.body.setup, undefined);
    } finally { release(); await h.close(); }
  }
});

test('setup discovery does not wait on a registration write or lock its binding first', { skip: !safe }, async () => {
  const h = await harness();
  let release = () => {};
  let pending: ReturnType<typeof h.call> | undefined;
  let blocker: Promise<void> | undefined;
  try {
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    blocker = h.db.transaction(async tx => {
      await tx.execute(h.sql`SELECT id FROM app_runtime_registrations WHERE org_id = ${h.org_id}
        AND id = ${h.registration_id} FOR UPDATE`);
      acquired(); await released;
      // A registration-first writer must not encounter a binding lock acquired
      // by discovery while discovery waits for this registration.
      await tx.execute(h.sql`SELECT id FROM app_resource_bindings WHERE org_id = ${h.org_id}
        AND id = ${h.binding_id} FOR UPDATE NOWAIT`);
    });
    await locked;
    pending = h.call(`/setup?installation_id=${h.consent_request.installation_id}`);
    const result = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 1500))]);
    release();
    await blocker;
    assert.ok(result, 'advisory setup discovery must not wait for registration writes');
    assert.equal(result.status, 200);
  } finally { release(); await blocker?.catch(() => {}); await pending?.catch(() => {}); await h.close(); }
});

