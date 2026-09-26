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
    && /^\/gate_g_20260926_(?:management|root)(?:_v[0-9]+)?$/.test(u.pathname)
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

test('private sync management rejects disabled rollout and non-web credentials over HTTP', async () => {
  const [{ Hono }, { serve }, routes] = await Promise.all([import('hono'), import('@hono/node-server'),
    import('../src/routes/app-resource-sync-management.js')]);
  const app = new Hono();
  app.route('/manage', routes.createAppResourceSyncManagementRoutes({ management: async () => { throw Error('must not initialize'); } }));
  let server!: ServerType;
  const base = await new Promise<string>(resolve => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`));
  });
  try {
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
    const disabled = await fetch(`${base}/manage/bindings`);
    assert.equal(disabled.status, 503);
    assert.equal(disabled.headers.get('cache-control'), 'no-store');
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
    for (const Authorization of ['', 'AppRuntime synthetic_runtime_token', 'Bearer synthetic_mcp_token']) {
      const denied = await fetch(`${base}/manage/bindings`, { headers: { Authorization } });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
    }
  } finally { process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
    await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('private sync HTTP owner review activation, operator-only credential and strict request boundaries', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const ownStatus = await h.call(`/bindings/${h.binding_id}`);
    assert.equal(ownStatus.status, 200);
    assert.equal(ownStatus.body.binding.resource_key, 'inbox');
    assert.equal(ownStatus.body.checkpoint.cursor_sequence, 0);
    assert.equal(ownStatus.body.latest_run, null);
    const readText = JSON.stringify(ownStatus.body);
    for (const secret of ['cursor_hmac', 'cursor_ciphertext', 'session_token', 'token_hash',
      'provider_instance_id', 'reviewed_descriptor', 'safe_outcome', 'authorization_snapshot']) assert.ok(!readText.includes(secret));
    assert.equal((await h.call(`/bindings/${h.binding_id}/sessions`, 'POST')).status, 403);
    const issued = await h.call(`/bindings/${h.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken);
    assert.equal(issued.status, 201);
    assert.match(issued.body.session.session_token, /^[A-Za-z0-9_-]{40,}$/);
    for (const path of ['/bindings', `/bindings/${h.binding_id}`]) {
      const observed = await h.call(path);
      assert.equal(observed.status, 200);
      assert.ok(!JSON.stringify(observed.body).includes(issued.body.session.session_token));
      assert.ok(!JSON.stringify(observed.body).includes('session_token'));
    }
    assert.equal((await h.call('/reviews/prepare', 'POST', { oversized: 'x'.repeat(16_384) })).status, 413);
    for (const [contentType, raw] of [['application/json', '{'], ['text/plain', '{}']]) {
      const malformed = await fetch(`${h.base}/reviews/prepare`, { method: 'POST',
        headers: { Authorization: `Bearer ${h.owner.accessToken}`, 'Content-Type': contentType! }, body: raw });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await h.call(`/sessions/${issued.body.session.session_id}/revoke`, 'POST')).status, 403);
    assert.equal((await h.call(`/sessions/${issued.body.session.session_id}/revoke`, 'POST', undefined, h.operator.accessToken)).status, 200);
    assert.equal((await h.call(`/bindings/${h.binding_id}/sessions`, 'POST', { owner_user_id: h.owner_user_id }, h.operator.accessToken)).status, 400);
    assert.equal((await h.call('/reviews/prepare', 'POST', { ...h.consent_request, owner_user_id: h.operator_user_id })).status, 400);
    assert.equal((await h.call('/reviews/prepare', 'POST', h.consent_request, h.operator.accessToken)).status, 403);
    assert.equal((await h.call(`/bindings/${h.binding_id}/revoke`, 'POST')).status, 200);
    const review = await h.call('/reviews/prepare', 'POST', h.consent_request);
    assert.equal(review.status, 200);
    const activation = { ...h.consent_request, expected_review_digest: review.body.review.review_digest, accept_host_policy: true };
    assert.equal((await h.call('/bindings/activate', 'POST', { ...activation, expected_review_digest: `sha256:${'0'.repeat(64)}` })).status, 409);
    const activated = await h.call('/bindings/activate', 'POST', activation);
    assert.equal(activated.status, 201);
    assert.equal((await h.call('/bindings/activate', 'POST', activation)).status, 409);
    assert.equal((await h.call(`/registrations/${activated.body.binding.registration_id}/revoke`, 'POST')).status, 200);
    assert.equal((await h.call(`/bindings/${activated.body.binding.binding_id}`)).body.binding.state, 'revoked');
  } finally { await h.close(); }
});

test('private sync HTTP current SID membership tenant and self-owner privacy with bounded pagination', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const { db, schema: s, eq, and } = h;
    assert.equal((await h.call(`/bindings/${h.binding_id}`, 'GET', undefined, h.operator.accessToken)).status, 403);
    await db.update(s.orgMembers).set({ role: 'guest' }).where(and(eq(s.orgMembers.org_id, h.org_id), eq(s.orgMembers.user_id, h.operator_user_id)));
    assert.equal((await h.call(`/bindings/${h.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken)).status, 403);
    await db.update(s.orgMembers).set({ role: 'admin' }).where(and(eq(s.orgMembers.org_id, h.org_id), eq(s.orgMembers.user_id, h.operator_user_id)));
    assert.equal((await h.call(`/bindings/${h.binding_id}`, 'GET', undefined, h.operator.accessToken)).status, 403);
    assert.deepEqual((await h.call('/bindings', 'GET', undefined, h.operator.accessToken)).body.bindings, []);
    assert.equal((await h.call(`/registrations/${h.registration_id}/revoke`, 'POST', undefined, h.operator.accessToken)).status, 403);
    assert.equal((await h.call(`/bindings/${h.binding_id}`)).body.binding.state, 'active', 'denied registration mutation rolls back');
    const foreignOrg = randomUUID();
    await db.insert(s.orgs).values({ id: foreignOrg, name: 'foreign', slug: `foreign-${foreignOrg}` });
    await db.insert(s.orgMembers).values({ org_id: foreignOrg, user_id: h.owner_user_id, role: 'owner', is_active: true });
    const foreign = await h.token(h.owner_user_id, foreignOrg);
    assert.equal((await h.call(`/bindings/${h.binding_id}`, 'GET', undefined, foreign.accessToken)).status, 403);
    assert.deepEqual((await h.call('/bindings', 'GET', undefined, foreign.accessToken)).body.bindings, []);
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('../src/lib/env.js');
    for (const token of [h.owner.refreshToken, jwt.sign({ id: h.owner_user_id, org_id: h.org_id,
      email: 'synthetic@example.test', purpose: 'employee', sid: randomUUID(), jti: randomUUID() }, env.JWT_SECRET, { expiresIn: 60 }),
      jwt.sign({ id: h.owner_user_id, org_id: h.org_id, email: 'synthetic@example.test', purpose: 'web-access',
        sid: randomUUID(), jti: randomUUID() }, env.JWT_SECRET, { expiresIn: 60 })]) {
      assert.equal((await h.call('/bindings', 'GET', undefined, token)).status, 401);
    }
    for (const query of ['?limit=0', '?limit=51', '?after=bad', '?owner_user_id=other', '?limit=1&limit=2']) {
      assert.equal((await h.call(`/bindings${query}`)).status, 400);
    }
    await h.call(`/bindings/${h.binding_id}/revoke`, 'POST');
    const shortRequest = { ...h.consent_request, consent_expires_at: new Date(Date.now() + 3000).toISOString() };
    const shortReview = await h.management.prepareConsent(h.owner_actor, shortRequest);
    const next = await h.management.activateConsent(h.owner_actor, { ...shortRequest,
      expected_review_digest: shortReview.review_digest, accept_host_policy: true });
    const first = await h.call('/bindings?limit=1');
    const second = await h.call(`/bindings?limit=1&after=${first.body.next_after}`);
    assert.equal(first.body.bindings.length, 1); assert.equal(second.body.bindings.length, 1);
    assert.equal(second.body.next_after, null);
    assert.deepEqual(new Set([first.body.bindings[0].binding_id, second.body.bindings[0].binding_id]), new Set([h.binding_id, next.binding_id]));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(shortRequest.consent_expires_at).getTime() - Date.now() + 10)));
    assert.ok(new Date(shortRequest.consent_expires_at).getTime() <= Date.now());
    assert.equal((await h.call(`/bindings/${next.binding_id}`)).status, 200, 'expired consent still inspectable');
    assert.equal((await h.call(`/bindings/${next.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken)).status, 403);
    await db.update(s.orgMembers).set({ role: 'member' }).where(and(eq(s.orgMembers.org_id, h.org_id), eq(s.orgMembers.user_id, h.owner_user_id)));
    assert.equal((await h.call('/bindings')).status, 403, 'current role overrides JWT session identity');
    await db.update(s.orgMembers).set({ role: 'owner', is_active: false }).where(and(eq(s.orgMembers.org_id, h.org_id), eq(s.orgMembers.user_id, h.owner_user_id)));
    assert.equal((await h.call('/bindings')).status, 401);
    await db.update(s.orgMembers).set({ is_active: true }).where(and(eq(s.orgMembers.org_id, h.org_id), eq(s.orgMembers.user_id, h.owner_user_id)));
    await db.update(s.webSessions).set({ expires_at: new Date(Date.now() - 1000) }).where(and(eq(s.webSessions.org_id, h.org_id), eq(s.webSessions.user_id, h.owner_user_id)));
    assert.equal((await h.call('/bindings')).status, 401);
  } finally { await h.close(); }
});

test('private sync HTTP revocation while waiting rolls back session issuance at final SID guard', { skip: !safe }, async () => {
  const h = await harness();
  let release = () => {};
  try {
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = h.db.transaction(async tx => {
      await tx.execute(h.sql`SELECT id FROM org_members WHERE org_id = ${h.org_id}
        AND user_id = ${h.operator_user_id} FOR UPDATE`);
      acquired(); await released;
    });
    await locked;
    const pending = h.call(`/bindings/${h.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken);
    let observedWait = false;
    for (let i = 0; i < 100; i++) {
      const result = await h.db.execute(h.sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname=current_database() AND pid <> pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%org_members%'`);
      if (result.rows[0]!.waiting > 0) { observedWait = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(observedWait, 'actual HTTP request waited on member lock');
    await h.session.revokeWebSession(h.operator.refreshToken);
    release(); await blocker;
    assert.equal((await pending).status, 401);
    const sessions = await h.db.select().from(h.schema.appRuntimeSessions).where(h.eq(h.schema.appRuntimeSessions.resource_binding_id, h.binding_id));
    assert.equal(sessions.length, 0, 'session insert rolls back after web revocation');
    const audits = await h.db.select().from(h.schema.auditLog).where(h.and(h.eq(h.schema.auditLog.org_id, h.org_id),
      h.eq(h.schema.auditLog.action, 'app.resource_sync_session_issue')));
    assert.equal(audits.length, 0, 'issuance audit rolls back in the same transaction');
  } finally { release(); await h.close(); }
});

test('private sync HTTP status exposes generic Run metadata without private Run result authority', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const { getAppRunRuntime } = await import('../src/lib/app-run-runtime.js');
    const runtime = await getAppRunRuntime();
    const admitted = await runtime.resourceSyncAdmission.admitDue({ org_id: h.org_id, resource_binding_id: h.binding_id });
    assert.equal(admitted.state, 'created');
    assert.ok('run_id' in admitted);
    const canary = `private-provider-detail-${randomUUID()}`;
    await h.db.update(h.schema.appRuns).set({ safe_outcome: { detail: canary } })
      .where(h.and(h.eq(h.schema.appRuns.org_id, h.org_id), h.eq(h.schema.appRuns.id, admitted.run_id)));
    const status = await h.call(`/bindings/${h.binding_id}`);
    assert.equal(status.status, 200);
    assert.deepEqual(Object.keys(status.body.latest_run).sort(), ['created_at', 'receipt_id', 'run_id', 'state', 'terminal_at']);
    assert.equal(status.body.latest_run.run_id, admitted.run_id);
    assert.equal(status.body.latest_run.state, 'pending');
    assert.equal(status.body.latest_run.receipt_id, null);
    assert.ok(!JSON.stringify(status.body).includes(canary));
    const { PostgresAppRunAuthorizer } = await import('../src/lib/app-run-authorization.js');
    const run = await runtime.repository.inspect(h.org_id, admitted.run_id);
    assert.ok(run);
    for (const action of ['inspect', 'result'] as const) {
      assert.equal(await new PostgresAppRunAuthorizer().authorize({ action, org_id: h.org_id,
        actor: { actor_type: 'human', user_id: h.owner_user_id }, run, required_authority_ref: null }), false);
    }
  } finally { await h.close(); }
});

test('private sync HTTP denies nonhuman accounts even with a valid web SID', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const validSession = await h.management.issueOperatorSession(h.operator_actor, h.binding_id);
    await h.db.update(h.schema.users).set({ kind: 'agent' }).where(h.eq(h.schema.users.id, h.operator_user_id));
    assert.equal((await h.call('/reviews/prepare', 'POST', h.consent_request)).status, 403, 'selected operator must be a stored human');
    await assert.rejects(h.management.issueOperatorSession(h.operator_actor, h.binding_id));
    const authority = await import('../src/lib/app-resource-sync-authority.js');
    const { hashAppResourceSyncToken } = await import('../src/lib/app-resource-sync-policy.js');
    assert.equal(await h.db.transaction(tx => authority.loadLiveResourceSyncAuthority(tx, {
      org_id: h.org_id, session_id: validSession.session_id, token_hash: hashAppResourceSyncToken(validSession.session_token), clock: () => new Date() })), null);
    const denied = await h.call(`/bindings/${h.binding_id}/sessions`, 'POST', undefined, h.operator.accessToken);
    assert.equal(denied.status, 403);
    assert.ok(!JSON.stringify(denied.body).includes('session_token'));
    for (const kind of ['agent', 'system'] as const) {
      await h.db.update(h.schema.users).set({ kind }).where(h.eq(h.schema.users.id, h.owner_user_id));
      assert.equal((await h.call('/bindings')).status, 403);
      assert.equal((await h.call(`/bindings/${h.binding_id}/revoke`, 'POST')).status, 403);
    }
  } finally { await h.close(); }
});
