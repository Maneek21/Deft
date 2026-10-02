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
    && u.username === 'gate_g_test' && !u.password && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260926_c12_private_reference_test(?:_v[0-9]+)?$/.test(u.pathname)
    && !u.search && !u.hash; } catch { return false; }
})();
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
// This HTTP profile shares its disposable DB/key material with management HTTP.
const ring = (purpose: string) => ({ current: purpose,
  keys: { [purpose]: createHash('sha256').update(`native-reference:${purpose}`).digest('base64') } });
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

test('native App reference resolves exact owner body and host href without widening other subjects', { skip: !safe }, async () => {
  const h = await harness();
  try {
    const page = await h.call(`/read/bindings/${h.binding_id}/records?limit=2`);
    const item = page.body.items[0];
    const path = `/read/references/${item.ref.provider.provider_instance_id}/${item.ref.resource_type}/${item.ref.resource_id}`;
    const result = await h.call(path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ref: item.ref, label: item.label, data: item.data, freshness: 'unknown', consent_expires_at: h.expires_at, search_href: `/app-resources/search/${h.binding_id}` });
    const { NativeResourceService } = await import('../src/lib/native-resource-service.js');
    const sid = JSON.parse(Buffer.from(h.owner.accessToken.split('.')[1]!, 'base64url').toString()).sid;
    const display = await new NativeResourceService().resolve({ org_id: h.org_id, user_id: h.owner_user_id, sid }, item.ref, `Bearer ${h.owner.accessToken}`);
    assert.equal(display.state, 'available');
    if (display.state !== 'available') throw Error('Missing display');
    assert.equal(display.resource.href, `/app-resources/${item.ref.provider.provider_instance_id}/${item.ref.resource_type}/${item.ref.resource_id}`);
    assert.equal('data' in display.resource, false);
    for (const auth of ['', h.runtimeAuth, `Bearer ${h.owner.refreshToken}`]) assert.equal((await h.call(path, auth)).status, 401);
    assert.equal((await h.call(path, `Bearer ${h.operator.accessToken}`)).status, 404);
    await h.db.update(h.schema.orgMembers).set({role:'admin'}).where(h.and(h.eq(h.schema.orgMembers.org_id,h.org_id),h.eq(h.schema.orgMembers.user_id,h.operator_user_id)));
    assert.equal((await h.call(path, `Bearer ${h.operator.accessToken}`)).status,404);
    const agentId=randomUUID();
    await h.db.insert(h.schema.users).values({id:agentId,name:'Synthetic agent',email:`${agentId}@example.test`,kind:'agent',is_agent:true});
    await h.db.insert(h.schema.orgMembers).values({org_id:h.org_id,user_id:agentId,role:'member',is_active:true});
    const agentToken=await h.token(agentId);
    assert.equal((await h.call(path,`Bearer ${agentToken.accessToken}`)).status,403);
    assert.equal((await h.call(path+'?actor=other')).status, 400);
    assert.equal((await h.call(path+'?ref=x&ref=y')).status, 400);
    assert.equal((await h.call(path.replace(item.ref.resource_type, 'other_type'))).status, 404);
    assert.equal((await h.call(path.replace(item.ref.resource_id, randomUUID()))).status, 404);
    const foreign = randomUUID();
    await h.db.insert(h.schema.orgs).values({ id: foreign, name: 'foreign', slug: foreign });
    await h.db.insert(h.schema.orgMembers).values({org_id: foreign,user_id:h.owner_user_id,role:'owner',is_active:true});
    const foreignToken = await h.token(h.owner_user_id,foreign);
    assert.equal((await h.call(path,`Bearer ${foreignToken.accessToken}`)).status,404);
    // Use the normal Run/channel/store transition. Only this test-owned service
    // clock advances beyond the interval; no shared DB clock or rows are forced.
    const [{AppRunSecretService},{AppResourceSyncSecretService},{AppRunAttemptRunner},
      {PinnedMcpAppRunProviderExecutor},{PostgresAppRunReceiptWriter},queue,
      {AppResourceSyncStore},{AppResourceSyncAdmissionService},{AppResourceSyncChannel}]=await Promise.all([
      import('../src/lib/app-run-secrets.js'),import('../src/lib/app-resource-sync-secrets.js'),
      import('../src/lib/app-run-attempt-runner.js'),import('../src/lib/app-run-provider-executor.js'),
      import('../src/lib/app-run-receipts.js'),import('../src/lib/app-run-scheduler.js'),
      import('../src/lib/app-resource-sync-store.js'),import('../src/lib/app-resource-sync-admission.js'),
      import('../src/lib/app-resource-sync-channel.js')]);
    const checkedAt=new Date(Date.now()+61_000);const clock=()=>new Date(checkedAt);
    const secrets=new AppRunSecretService(h.runtime.keys),syncSecrets=new AppResourceSyncSecretService(h.runtime.keys);
    const writer=new PostgresAppRunReceiptWriter(secrets,h.runtime.secretRepository);
    const runner=new AppRunAttemptRunner(h.runtime.repository,h.runtime.secretRepository,secrets,
      new PinnedMcpAppRunProviderExecutor(),undefined,clock,60_000,20_000,writer,undefined,
      queue.postgresAppRunAttemptQueue,new AppResourceSyncStore(syncSecrets,h.runtime.secretRepository));
    const admission=new AppResourceSyncAdmissionService(h.runtime.repository,h.runtime.secretRepository,secrets,syncSecrets,runner,clock,()=>true);
    assert.equal((await admission.admitDue({org_id:h.org_id,resource_binding_id:h.binding_id})).state,'created');
    const channel=new AppResourceSyncChannel(runner);
    const base={schema_version:'deft.app_runtime_channel.v2' as const,audience:'app_resource_sync' as const,
      session_id:h.runtime_session.session_id,session_token:h.runtime_session.session_token};
    const claim=await channel.claim({...base,max_claims:1});assert.ok(claim);
    const attempt={...base,run_id:claim.run_id,attempt_id:claim.attempt_id,claim_token:claim.claim_token,sequence:claim.sequence};
    assert.ok(await channel.start(attempt));
    assert.ok(await channel.complete({...attempt,status:'returned',provider_succeeded:true,page:{schema_version:'deft.app_sync_page.v1',upserts:[],tombstones:[{id:`provider-private-${item.revision.slice(1)}`,revision:'deleted'}],next_cursor:null,has_more:false}}));
    assert.equal((await h.call(path)).status,404);
    await h.management.revokeConsent(h.owner_actor,h.binding_id);
    assert.equal((await h.call(path)).status,404);
    const reviewed=await h.management.prepareConsent(h.owner_actor,h.consent_request);
    const renewed=await h.management.activateConsent(h.owner_actor,{...h.consent_request,expected_review_digest:reviewed.review_digest,accept_host_policy:true});
    assert.notEqual(renewed.binding_id,h.binding_id);
    const stale=page.body.items[1].ref;
    assert.equal((await h.call(`/read/references/${stale.provider.provider_instance_id}/${stale.resource_type}/${stale.resource_id}`)).status,404);
  } finally { await h.close(); }
});

test('native App reference denies sync gate withdrawal after an actual exact SID lock wait', { skip: !safe }, async () => {
  const h = await harness();
  let release = () => {};
  try {
    const page = await h.call(`/read/bindings/${h.binding_id}/records?limit=1`);
    const item = page.body.items[0];
    const path = `/read/references/${item.ref.provider.provider_instance_id}/${item.ref.resource_type}/${item.ref.resource_id}`;
    let acquired!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const sid = JSON.parse(Buffer.from(h.owner.accessToken.split('.')[1]!, 'base64url').toString()).sid;
    const blocker = h.db.transaction(async tx => {
      await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${sid} FOR UPDATE`);
      acquired(); await released;
    });
    await locked;
    const pending = h.call(path);
    await waitForLock(h, 'web_sessions');
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
    release(); await blocker;
    const denied = await pending;
    assert.equal(denied.status,404);
    assert.equal(denied.body.code,'APP_RESOURCE_PRIVATE_UNAVAILABLE');
    assert.deepEqual(Object.keys(denied.body).sort(),['code','error']);
  } finally { release(); process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED='true'; await h.close(); }
});

test('native App reference discards body when stored exact SID retires during its lock wait', { skip: !safe }, async () => {
  const h=await harness();let release=()=>{};
  try {
    const page=await h.call(`/read/bindings/${h.binding_id}/records?limit=1`);const ref=page.body.items[0].ref;
    const path=`/read/references/${ref.provider.provider_instance_id}/${ref.resource_type}/${ref.resource_id}`;
    const sid=JSON.parse(Buffer.from(h.owner.accessToken.split('.')[1]!, 'base64url').toString()).sid;
    let acquired!:()=>void;const locked=new Promise<void>(r=>{acquired=r;});const released=new Promise<void>(r=>{release=r;});
    const blocker=h.db.transaction(async tx=>{
      await tx.execute(h.sql`SELECT id FROM web_sessions WHERE id=${sid} FOR UPDATE`);acquired();await released;
      await tx.update(h.schema.webSessions).set({revoked_at:new Date()}).where(h.eq(h.schema.webSessions.id,sid));
    });
    await locked;const pending=h.call(path);await waitForLock(h,'web_sessions');release();await blocker;
    const denied=await pending;assert.equal(denied.status,401);assert.deepEqual(Object.keys(denied.body).sort(),['code','error']);
  } finally {release();await h.close();}
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
