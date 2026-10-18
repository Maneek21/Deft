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
    && /^\/gate_g_20260926_(?:management|root)(?:_v[0-9]+)?$/.test(u.pathname)
    && !u.search && !u.hash; } catch { return false; }
})();
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
// This HTTP profile shares its disposable DB/key material with management HTTP.
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
    import('../src/routes/app-resource-private-read.js'), import('../src/routes/app-resource-sync-channel.js'),
    import('../src/routes/app-resource-sync-management.js'), import('hono'), import('@hono/node-server'),
  ]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const fixture = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date() });
  const token = async (id: string, orgId = fixture.org_id) => {
    const [user] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, id));
    return webSessions.createWebSession({ id, org_id: orgId, email: user!.email });
  };
  const owner = await token(fixture.owner_user_id);
  const operator = await token(fixture.operator_user_id);
  const app = new hono.Hono();
  app.route('/read', privateRoutes.appResourcePrivateReadRoutes);
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
    if (path.startsWith('/read/')) assert.equal(response.headers.get('pragma'), 'no-cache');
    return { status: response.status, body: await response.json() as any };
  };
  let bindingId = fixture.binding_id;
  let expiresAt = fixture.consent_request.consent_expires_at;
  if (shortConsentMs) {
    await fixture.management.revokeConsent(fixture.owner_actor, fixture.binding_id);
    const request = { ...fixture.consent_request, consent_expires_at: new Date(Date.now() + shortConsentMs).toISOString() };
    const review = await fixture.management.prepareConsent(fixture.owner_actor, request);
    const activated = await fixture.management.activateConsent(fixture.owner_actor, { ...request,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    bindingId = activated.binding_id;
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
        data: { subject: `Private HTTP message ${i}` } })), tombstones: [],
      next_cursor: 'provider-private-cursor', has_more: false } });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.accepted, true);
  const marker = `private-http-${fixture.org_id}`;
  const originalTransaction = runtime.repository.transaction.bind(runtime.repository);
  runtime.repository.transaction = <T>(work: (tx: AppRunTransaction) => Promise<T>) => originalTransaction(async tx => {
    await tx.execute(drizzle.sql`SELECT set_config('application_name', ${marker}, true)`);
    return work(tx);
  });
  return { db, schema, ...drizzle, ...fixture, binding_id: bindingId, expires_at: expiresAt, marker,
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

test('private read HTTP returns settled owner records with signed pagination and private response headers', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const path = `/read/bindings/${h.binding_id}/records`;
    const first = await h.call(`${path}?limit=2`);
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.checkpoint.cursor_sequence, 1);
    assert.equal(first.body.checkpoint.freshness, 'unknown');
    assert.ok(first.body.next_cursor);
    const second = await h.call(`${path}?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    assert.equal(second.status, 200); assert.equal(second.body.items.length, 1);
    assert.equal(second.body.next_cursor, null);
    const items = [...first.body.items, ...second.body.items];
    assert.equal(new Set(items.map(item => item.projection_id)).size, 3);
    assert.deepEqual(new Set(items.map(item => item.data.subject)), new Set(['Private HTTP message 0', 'Private HTTP message 1', 'Private HTTP message 2']));
    for (const item of items) {
      const detail = await h.call(`${path}/${item.projection_id}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.body.item, item);
      assert.equal(item.ref.resource_id, item.projection_id);
    }
    const text = JSON.stringify(first.body);
    for (const secret of ['provider-private-', 'cursor_hmac', 'ciphertext', 'body_nonce',
      h.owner_user_id, h.operator_user_id, h.runtime_session.session_token]) assert.ok(!text.includes(secret));
    const status = await h.call(`/manage/bindings/${h.binding_id}`);
    assert.equal(status.body.latest_run.state, 'succeeded');
    assert.ok(status.body.latest_run.receipt_id);
    const receipts = await h.runtime.receiptReader.readVerified(h.org_id, status.body.latest_run.run_id);
    assert.ok(receipts.some(receipt => receipt.receipt_kind === 'attempt_terminal'));
  } finally { await h.close(); }
});

test('private read HTTP denies disabled rollout non-web foreign actors and query/cursor tampering', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const path = `/read/bindings/${h.binding_id}/records`;
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
    assert.equal((await h.call(path)).status, 503);
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
    for (const auth of ['', h.runtimeAuth, `Bearer ${h.runtime_session.session_token}`, `Bearer ${h.owner.refreshToken}`,
      'Bearer synthetic-personal-mcp', 'Bearer synthetic-employee']) assert.equal((await h.call(path, auth)).status, 401);
    assert.equal((await h.call(path, `Bearer ${h.operator.accessToken}`)).status, 404);
    await h.db.update(h.schema.orgMembers).set({ role: 'admin' }).where(h.and(
      h.eq(h.schema.orgMembers.org_id, h.org_id), h.eq(h.schema.orgMembers.user_id, h.operator_user_id)));
    assert.equal((await h.call(path, `Bearer ${h.operator.accessToken}`)).status, 404);
    const foreignOrg = randomUUID();
    await h.db.insert(h.schema.orgs).values({ id: foreignOrg, name: 'foreign', slug: `private-read-http-${foreignOrg}` });
    await h.db.insert(h.schema.orgMembers).values({ org_id: foreignOrg, user_id: h.owner_user_id, role: 'owner', is_active: true });
    const foreign = await h.token(h.owner_user_id, foreignOrg);
    assert.equal((await h.call(path, `Bearer ${foreign.accessToken}`)).status, 404);
    const page = await h.call(`${path}?limit=1`);
    for (const query of ['?limit=0', '?limit=26', '?limit=1&limit=2', '?owner_user_id=other', '?cursor=']) {
      assert.equal((await h.call(`${path}${query}`)).status, 400);
    }
    assert.equal((await h.call(`${path}?cursor=${page.body.next_cursor.slice(0, -2)}AA`)).status, 404);
    assert.equal((await h.call(`${path}/${page.body.items[0].projection_id}?owner_user_id=other`)).status, 400);
    assert.equal((await h.call(`${path}/${randomUUID()}`)).status, 404);
    await h.management.revokeConsent(h.owner_actor, h.binding_id);
    const revoked = await h.call(path);
    assert.equal(revoked.status, 404);
    assert.deepEqual(Object.keys(revoked.body).sort(), ['code', 'error']);
  } finally { process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true'; await h.close(); }
});

test('private read HTTP discards decrypted records when exact web SID is revoked during a real authority lock wait', { skip: !safe }, async () => {
  const h = await harness();
  let release = () => {};
  try {
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = h.db.transaction(async tx => {
      await tx.execute(h.sql`SELECT id FROM org_members WHERE org_id = ${h.org_id} AND user_id = ${h.owner_user_id} FOR UPDATE`);
      acquired(); await released;
    });
    await locked;
    const pending = h.call(`/read/bindings/${h.binding_id}/records`);
    await waitForLock(h, 'org_members');
    await h.webSessions.revokeWebSession(h.owner.refreshToken);
    release(); await blocker;
    const denied = await pending;
    assert.equal(denied.status, 401);
    assert.deepEqual(Object.keys(denied.body).sort(), ['code', 'error']);
    assert.ok(!JSON.stringify(denied.body).includes('Private HTTP message'));
  } finally { release(); await h.close(); }
});

test('private read HTTP rechecks consent after the final web SID lock wait', { skip: !safe }, async () => {
  const h = await harness(8000);
  let release = () => {};
  try {
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = h.db.transaction(async tx => {
      await tx.execute(h.sql`SELECT id FROM web_sessions WHERE org_id = ${h.org_id} AND user_id = ${h.owner_user_id} FOR UPDATE`);
      acquired(); await released;
    });
    await locked;
    const pending = h.call(`/read/bindings/${h.binding_id}/records`);
    await waitForLock(h, 'web_sessions');
    assert.ok(Date.now() < new Date(h.expires_at).getTime(), 'reader reached final SID wait before consent expiry');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(h.expires_at).getTime() - Date.now() + 20)));
    release(); await blocker;
    const denied = await pending;
    assert.equal(denied.status, 404, 'completed decrypted data must not escape after consent expired during SID lock wait');
    assert.ok(!JSON.stringify(denied.body).includes('Private HTTP message'));
  } finally { release(); await h.close(); }
});

test('private read HTTP rejects nonhuman owner and operator identity in current sync authority', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const path = `/read/bindings/${h.binding_id}/records`;
    await h.db.update(h.schema.users).set({ kind: 'agent' }).where(h.eq(h.schema.users.id, h.operator_user_id));
    assert.equal((await h.call(path)).status, 404, 'nonhuman selected operator ends current delivery authority');
    const { loadLiveResourceSyncAuthority } = await import('../src/lib/app-resource-sync-authority.js');
    const { hashAppResourceSyncToken } = await import('../src/lib/app-resource-sync-policy.js');
    assert.equal(await h.db.transaction(tx => loadLiveResourceSyncAuthority(tx, {
      org_id: h.org_id, session_id: h.runtime_session.session_id,
      token_hash: hashAppResourceSyncToken(h.runtime_session.session_token), clock: () => new Date(),
    })), null, 'previously issued v2 session is fenced by current operator kind');
    await h.db.update(h.schema.users).set({ kind: 'human' }).where(h.eq(h.schema.users.id, h.operator_user_id));
    assert.equal((await h.call(path)).status, 200);
    await h.db.update(h.schema.users).set({ kind: 'agent' }).where(h.eq(h.schema.users.id, h.owner_user_id));
    assert.equal((await h.call(path)).status, 403, 'web SID alone does not turn a stored agent into a human');
    const { AppResourcePrivateReadService } = await import('../src/lib/app-resource-private-read.js');
    await assert.rejects(new AppResourcePrivateReadService(h.runtime.keys).listOwnerPrivateResourcePage(
      { kind: 'human', org_id: h.org_id, user_id: h.owner_user_id }, { resource_binding_id: h.binding_id }),
    (error: unknown) => (error as { code?: string }).code === 'APP_RESOURCE_PRIVATE_UNAVAILABLE');
  } finally { await h.close(); }
});

test('private read HTTP rechecks participant kind after the final web SID lock wait', { skip: !safe }, async () => {
  const h = await harness();
  let release = () => {};
  try {
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const blocker = h.db.transaction(async tx => {
      await tx.execute(h.sql`SELECT id FROM web_sessions WHERE org_id = ${h.org_id} AND user_id = ${h.owner_user_id} FOR UPDATE`);
      acquired(); await released;
    });
    await locked;
    const pending = h.call(`/read/bindings/${h.binding_id}/records`);
    await waitForLock(h, 'web_sessions');
    await h.db.update(h.schema.users).set({ kind: 'agent' }).where(h.eq(h.schema.users.id, h.operator_user_id));
    release(); await blocker;
    const denied = await pending;
    assert.equal(denied.status, 404, 'operator becoming nonhuman during final SID wait must fence delivery');
    assert.ok(!JSON.stringify(denied.body).includes('Private HTTP message'));
  } finally { release(); await h.close(); }
});
