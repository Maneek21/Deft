import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';
import type { ServerType } from '@hono/node-server';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => { try {
  if (!target || target !== process.env.DATABASE_URL) return false;
  const u = new URL(target); return ['postgres:', 'postgresql:'].includes(u.protocol)
    && u.username === 'gate_g_test' && !u.password && u.hostname === '127.0.0.1' && u.port === '55435'
    && /^\/gate_g_20260926_c14_experience_search_test(?:_v[0-9]+)?$/.test(u.pathname) && !u.search && !u.hash;
} catch { return false; } })();
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
  DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'false', DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED: 'true' });
const ring = (purpose: string) => ({ current: purpose, keys: { [purpose]: createHash('sha256').update(`c14-experience-search:${purpose}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('c09-enc'), receipt_signing: ring('c09-sign'), fingerprint: ring('c09-fp') });
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

async function harness(version: 1 | 2, large = false) {
  const [{ db }, s, { eq, and, sql }, kit, runtimeModule, routes, web, { Hono }, { serve }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('@deft/app-kit'),
    import('../src/lib/app-run-runtime.js'), import('../src/routes/app-experiences.js'), import('../src/lib/web-sessions.js'),
    import('hono'), import('@hono/node-server'),
  ]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const artifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: version === 1 ? 'deft.experience_bundle.v1' : 'deft.experience_bundle.v2', ...(version === 2 ? { search_resource_keys: ['inbox'] } : {}), worker_source: 'self.onmessage=()=>{};', entry_view: 'main', resource_keys: ['inbox'], action_keys: [],
  });
  const owned = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date(), experience_artifact: artifact,
    descriptor: { schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox', runtime_requirement_key: 'provider',
      resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject', record_schema: {
        type: 'object', properties: { ...(large ? Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`field_${i}`, { type: 'string' as const, maxLength: 16384 }])) : {}), subject: { type: 'string', maxLength: 200 }, ...(large ? {} : { body: { type: 'string' as const, maxLength: 10000 },
          read: { type: 'boolean' as const }, count: { type: 'number' as const, minimum: 0, maximum: 100 } }) }, required: ['subject'], additionalProperties: false } } });
  const [owner] = await db.select().from(s.users).where(eq(s.users.id, owned.owner_user_id));
  const human = await web.createWebSession({ id: owned.owner_user_id, email: owner!.email, org_id: owned.org_id });
  const next = await web.createWebSession({ id: owned.owner_user_id, email: owner!.email, org_id: owned.org_id });
  const [operator] = await db.select().from(s.users).where(eq(s.users.id, owned.operator_user_id));
  const otherHuman = await web.createWebSession({ id: owned.operator_user_id, email: operator!.email, org_id: owned.org_id });
  const admitted = await runtime.resourceSyncAdmission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id });
  assert.equal(admitted.state, 'created');
  const credential = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
  const identity = { schema_version: 'deft.app_runtime_channel.v2' as const, audience: 'app_resource_sync' as const,
    session_id: credential.session_id, session_token: credential.session_token };
  const claim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 }); assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  assert.ok(await runtime.resourceSyncChannel.start(attempt));
  assert.ok(await runtime.resourceSyncChannel.complete({ ...attempt, status: 'returned', provider_succeeded: true, page: {
    schema_version: 'deft.app_sync_page.v1', upserts: Array.from({ length: large ? 1 : 100 }, (_, i) => ({ id: `provider-only-${i}`, revision: 'provider-private-revision',
      data: { subject: `Saved record ${i}`, ...(large ? Object.fromEntries(Array.from({ length: 31 }, (_, j) => [`field_${j}`, 'x'.repeat(16384)])) : { body: i === 1 ? 'x'.repeat(4097) : 'x'.repeat(4096), read: true, count: i }) } })),
    tombstones: [], next_cursor: 'provider-private-cursor', has_more: false } }));
  const app = new Hono(); app.route('/api/app-experiences', routes.appExperienceRoutes);
  let server!: ServerType;
  const base = await new Promise<string>(resolve => { server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}/api/app-experiences`)); });
  const call = async (path: string, method = 'GET', body?: unknown, token = human.accessToken) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() as any };
  };
  const created = await call(`/${owned.installation_id}/main/sessions`, 'POST'); assert.equal(created.status, 200);
  const path = `/sessions/${created.body.pin.session_id}`;
  const search = { schema_version: 'deft.experience_resource_request.v2', operation: 'search', query: 'Saved', field_keys: ['subject'] };
  const review = await call(`${path}/exposure/review`, 'POST', {}); assert.equal(review.status, 200);
  return { db, s, eq, and, sql, runtime, owned, human, next, otherHuman, identity, call, path, search, review,
    accept: { review_token: review.body.review_token, review_digest: review.body.review_digest, accept_exposure: true },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function addFive(h: Awaited<ReturnType<typeof harness>>, offset = 0, large = false) {
  const [{ AppRunSecretService }, { AppResourceSyncSecretService }, { AppRunAttemptRunner },
    { PinnedMcpAppRunProviderExecutor }, { PostgresAppRunReceiptWriter }, queue,
    { AppResourceSyncStore }, { AppResourceSyncAdmissionService }, { AppResourceSyncChannel }] = await Promise.all([
    import('../src/lib/app-run-secrets.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-run-attempt-runner.js'), import('../src/lib/app-run-provider-executor.js'),
    import('../src/lib/app-run-receipts.js'), import('../src/lib/app-run-scheduler.js'),
    import('../src/lib/app-resource-sync-store.js'), import('../src/lib/app-resource-sync-admission.js'), import('../src/lib/app-resource-sync-channel.js')]);
  const now = new Date(Date.now() + 61_000 * (offset + 1)), clock = () => new Date(now);
  const secrets = new AppRunSecretService(h.runtime.keys), syncSecrets = new AppResourceSyncSecretService(h.runtime.keys);
  const runner = new AppRunAttemptRunner(h.runtime.repository, h.runtime.secretRepository, secrets,
    new PinnedMcpAppRunProviderExecutor(), undefined, clock, 60_000, 20_000,
    new PostgresAppRunReceiptWriter(secrets, h.runtime.secretRepository), undefined,
    queue.postgresAppRunAttemptQueue, new AppResourceSyncStore(syncSecrets, h.runtime.secretRepository));
  const admission = new AppResourceSyncAdmissionService(h.runtime.repository, h.runtime.secretRepository, secrets, syncSecrets, runner, clock, () => true);
  assert.equal((await admission.admitDue({ org_id: h.owned.org_id, resource_binding_id: h.owned.binding_id })).state, 'created');
  const channel = new AppResourceSyncChannel(runner), claim = await channel.claim({ ...h.identity, max_claims: 1 }); assert.ok(claim);
  const attempt = { ...h.identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  assert.ok(await channel.start(attempt));
  assert.ok(await channel.complete({ ...attempt, status: 'returned', provider_succeeded: true, page: {
    schema_version: 'deft.app_sync_page.v1', upserts: Array.from({ length: large ? 1 : 5 }, (_, i) => ({ id: `provider-extra-${offset}-${i}`, revision: 'r2', data: { subject: `Saved extra ${i}`, ...(large ? Object.fromEntries(Array.from({ length: 31 }, (_, j) => [`field_${j}`, 'x'.repeat(16384)])) : {}) } })),
    tombstones: [], next_cursor: null, has_more: false } }));
}

test('versioned Experience search requires exact artifact declaration and immutable host consent', { skip: !safe }, async t => {
  const old = await harness(1), h = await harness(2);
  await addFive(h);
  try {
    await t.test('v1 artifact and v1 consent cannot acquire search through review-body negotiation or direct HTTP', async () => {
      assert.equal(old.review.body.snapshot.schema_version, 'deft.experience_resource_exposure.v1');
      assert.deepEqual(old.review.body.snapshot.resources[0].allowed_operations, ['list_summary', 'read_one']);
      assert.equal((await old.call(`${old.path}/resources/inbox`, 'POST', old.search)).status, 404);
      assert.equal((await old.call(`${old.path}/exposure/accept`, 'POST', old.accept)).status, 200);
      assert.equal((await old.call(`${old.path}/resources/inbox`, 'POST', old.search)).status, 404);
      assert.equal((await old.call(`${old.path}/exposure/review`, 'POST', { search_resource_keys: ['inbox'] })).status, 400);
    });
    await t.test('v2 review explicitly includes declared search and retains unchanged v1 list/read requests', async () => {
      assert.equal(h.review.body.snapshot.schema_version, 'deft.experience_resource_exposure.v2');
      assert.deepEqual(h.review.body.snapshot.resources[0].allowed_operations, ['list_summary', 'read_one', 'search']);
      assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', h.search)).status, 404);
      const accepted = await h.call(`${h.path}/exposure/accept`, 'POST', h.accept); assert.equal(accepted.status, 200);
      assert.equal((await h.call(`${h.path}/exposure/accept`, 'POST', h.accept)).body.exposure_id, accepted.body.exposure_id);
      const list = await h.call(`${h.path}/resources/inbox`, 'POST', { schema_version: 'deft.experience_resource_request.v1', operation: 'list_summary' });
      assert.equal(list.status, 200); assert.equal(list.body.output.schema_version, 'deft.experience_resource_payload.v1');
      const read = await h.call(`${h.path}/resources/inbox`, 'POST', { schema_version: 'deft.experience_resource_request.v1', operation: 'read_one', record_id: list.body.output.items.find((item: { label: string }) => item.label !== 'Saved record 1').record_id });
      assert.equal(read.status, 200);
      assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', { schema_version: 'deft.experience_resource_request.v2', operation: 'list_summary' })).status, 400);
    });
    await t.test('search cursor exhausts whole saved checkpoint without private scope metadata or substitution', async () => {
      const seen = new Set<string>(); let cursor: string | undefined;
      do {
        const r = await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, ...(cursor ? { cursor } : {}) });
        assert.equal(r.status, 200); const page = r.body.output;
        assert.equal(page.schema_version, 'deft.experience_resource_search_page.v1');
        assert.equal(page.scan.complete, page.next_cursor === null); assert.ok(page.items.length <= 10); assert.ok(page.scan.records_scanned <= 100);
        for (const item of page.items) { assert.deepEqual(Object.keys(item).sort(), ['field_key', 'label', 'record_id', 'snippet']); assert.equal(item.field_key, 'subject'); assert.ok(!seen.has(item.record_id)); seen.add(item.record_id); }
        cursor = page.next_cursor ?? undefined;
        if (cursor && seen.size === 10) {
          const decoded = Buffer.from(cursor.split('.')[0], 'base64url').toString();
          for (const secret of [h.owned.org_id, h.owned.binding_id, h.path.split('/').at(-1)!, 'Saved']) assert.ok(!decoded.includes(secret));
          assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, query: 'different', cursor })).status, 404);
          assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, field_keys: ['body'], cursor })).status, 404);
          assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, cursor }, h.next.accessToken)).status, 404);
          assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', h.search, h.otherHuman.accessToken)).status, 404);
          assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', h.search, old.human.accessToken)).status, 404);
          assert.equal((await old.call(`${old.path}/resources/inbox`, 'POST', { ...h.search, cursor })).status, 404);
        }
      } while (cursor);
      assert.equal(seen.size, 105);
      assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, field_keys: ['undeclared'] })).status, 404);
    });
    await t.test('search checkpoint cursor goes stale instead of silently skipping settled records', async () => {
      const first = await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, query: 'no matching subject' });
      assert.equal(first.status, 200); assert.equal(first.body.output.scan.records_scanned, 100);
      assert.equal(first.body.output.items.length, 0); assert.equal(first.body.output.scan.complete, false); assert.ok(first.body.output.next_cursor);
      await addFive(h, 1);
      const stale = await h.call(`${h.path}/resources/inbox`, 'POST', { ...h.search, query: 'no matching subject', cursor: first.body.output.next_cursor });
      assert.equal(stale.status, 409); assert.equal(stale.body.code, 'RESOURCE_CURSOR_STALE'); assert.equal(stale.body.output, undefined);
    });
    await t.test('search byte preflight continues contiguous large records without whole corpus rejection', async () => {
      const big = await harness(2, true);
      try {
        await addFive(big, 0, true); await addFive(big, 1, true);
        assert.equal((await big.call(`${big.path}/exposure/accept`, 'POST', big.accept)).status, 200);
        const first = await big.call(`${big.path}/resources/inbox`, 'POST', big.search); assert.equal(first.status, 200);
        assert.equal(first.body.output.scan.records_scanned, 2); assert.equal(first.body.output.scan.complete, false);
        const last = await big.call(`${big.path}/resources/inbox`, 'POST', { ...big.search, cursor: first.body.output.next_cursor });
        assert.equal(last.status, 200); assert.equal(last.body.output.scan.records_scanned, 1); assert.equal(last.body.output.scan.complete, true);
        assert.equal(new Set([...first.body.output.items, ...last.body.output.items].map((item: { record_id: string }) => item.record_id)).size, 3);
      } finally { await big.close(); }
    });
    await t.test('actual final SID wait denies withdrawn exposure gate before search delivery', async () => {
      const { default: pg } = await import('pg'), blocker = new pg.Client({ connectionString: target }); await blocker.connect();
      try {
        await blocker.query('BEGIN'); const { rows: [pid] } = await blocker.query('SELECT pg_backend_pid() AS id');
        const sid = JSON.parse(Buffer.from(h.human.accessToken.split('.')[1], 'base64url').toString()).sid;
        await blocker.query('SELECT id FROM web_sessions WHERE id=$1 FOR UPDATE', [sid]);
        const reading = h.call(`${h.path}/resources/inbox`, 'POST', h.search); let waiting = false;
        for (let i = 0; i < 30; i++) { const q = await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting', ['deft-experience-exposure', pid.id]);
          if (q.rows[0].waiting) { waiting = true; break; } await new Promise(r => setTimeout(r, 5)); }
        assert.equal(waiting, true); process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'false'; await blocker.query('COMMIT');
        const denied = await reading; assert.equal(denied.status, 503); assert.equal(denied.body.output, undefined);
      } finally { process.env.DEFT_APP_EXPERIENCE_RESOURCE_EXPOSURE_ENABLED = 'true'; await blocker.query('ROLLBACK'); await blocker.end(); }
    });
    await t.test('withdrawal retires exact session and no delivered search cursor can revive it', async () => {
      assert.equal((await h.call(`${h.path}/exposure`, 'DELETE')).status, 200);
      assert.equal((await h.call(`${h.path}/resources/inbox`, 'POST', h.search)).status, 404);
    });
  } finally { await old.close(); await h.close(); }
});
