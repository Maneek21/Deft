import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { publicControlHttpFixture } from './fixtures/public-control-http.js';

const url = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!url && url === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260927_c20_public_cancellation_ui_test(?:_v[0-9]+)?$/.test(url);
after(async () => { if (safe) {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
} });
async function setup() {
  const f = await publicControlHttpFixture();
  const c = await f.claim('Outside customer retained cancellation'), run = await f.admit(c.result.claim_id);
  assert.ok(run);
  const [approval] = await f.db.select().from(f.schema.agentActions).where(f.orm.and(
    f.orm.eq(f.schema.agentActions.org_id, f.orgId), f.orm.eq(f.schema.agentActions.app_run_id, run.id)));
  assert.ok(approval); await f.call(`/api/agent/actions/${approval.id}/approve`, {}, 'owner');
  const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId, jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: run.id } });
  assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
  assert.equal((await f.runtime.repository.inspect(f.orgId, run.id))?.state, 'succeeded');
  const cancelled = await f.cancel(c); assert.equal(cancelled.response.status, 200);
  const id = cancelled.value.result.cancellation_id as string;
  return { ...f, c, run, id, contextPath: `/api/apps/public/cancellations/${id}/owner/context`, listPath: `/api/apps/public/cancellations/owner?installation_id=${f.staged.id}` };
}
async function lockWait(f: Awaited<ReturnType<typeof setup>>, fragment: string) {
  const deadline = Date.now() + 900;
  do {
    const result = await f.db.execute(f.orm.sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND lower(query) LIKE ${`%${fragment}%`}`);
    if (Number((result.rows[0] as { count: number }).count)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`expected real held ${fragment} query`);
}

test('public cancellation owner discovery is bounded metadata and current binding choices for the immutable Calendar owner only',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const listed = await f.request(f.listPath, undefined, 'owner'); assert.equal(listed.response.status, 200);
      assert.equal(listed.response.headers.get('cache-control'), 'no-store');
      assert.equal(listed.value.items.length, 1); assert.equal(listed.value.items[0].id, f.id);
      assert.deepEqual(Object.keys(listed.value.items[0]).sort(), ['id', 'state', 'accepted_at', 'original_version', 'cancel_run_id', 'cancel_run_state'].sort());
      assert.equal(JSON.stringify(listed.value).includes('PRIVATE_UNSELECTED'), false);
      assert.equal((await f.call(f.listPath, undefined, 'foreign')).items.length, 0);
      assert.notEqual((await f.request(f.contextPath, undefined, 'foreign')).response.status, 200);
      assert.notEqual((await f.request(f.contextPath, undefined, 'anonymous')).response.status, 200);
      const context = await f.call(f.contextPath, undefined, 'owner');
      assert.equal(context.choices.length, 1); assert.equal(context.choices[0].native_binding_id, f.policy.cancel_native_binding_id);
      assert.equal(context.choices[0].consent_digest, f.policy.expected_cancel_consent_digest);
      for (const path of [`${f.listPath}&unknown=x`, `${f.listPath}&installation_id=${f.staged.id}`, `${f.contextPath}?unknown=x`]) {
        assert.equal((await f.request(path, undefined, 'owner')).response.status, 400);
      }
      const otherOrg = randomUUID();
      await f.db.insert(f.schema.orgs).values({ id: otherOrg, name: 'Different owner scope', slug: `scope-${otherOrg}` });
      await f.db.insert(f.schema.orgMembers).values({ id: randomUUID(), org_id: otherOrg, user_id: f.ownerId, role: 'member', is_active: true });
      const session = await (await import('../src/lib/web-sessions.js')).createWebSession({ id: f.ownerId, org_id: otherOrg, email: `scope-${otherOrg}@example.test` });
      const cross = await fetch(`${f.base}${f.contextPath}`, { headers: { Authorization: `Bearer ${session.accessToken}` } }); assert.notEqual(cross.status, 200);
      await f.db.update(f.schema.appNativeBindings).set({ state: 'revoked' }).where(f.orm.eq(f.schema.appNativeBindings.id, f.policy.cancel_native_binding_id));
      assert.equal((await f.call(f.contextPath, undefined, 'owner')).choices.length, 0);
      assert.equal((await f.call(f.listPath, undefined, 'owner')).items.length, 1, 'retained metadata is not execution authority');
    } finally { await f.close(); }
  });

test('selected public cancellation Run exposes exact retained input only to its current owner and refuses review after binding revocation',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const review = await f.call(`/api/apps/public/cancellations/${f.id}/owner/review`, {
        schema_version: 'deft.app_public_cancellation_owner_review_request.v1',
        native_binding_id: f.policy.cancel_native_binding_id,
        expected_consent_digest: f.policy.expected_cancel_consent_digest,
      }, 'owner');
      const selected = await f.call(`/api/apps/public/cancellations/${f.id}/owner/submit`, {
        ...review.request, review_token: review.review_token,
        expected_review_digest: review.review_digest, accept_host_policy: true,
      }, 'owner');
      const path = `/api/apps/native/runs/${selected.run.id}/review`;
      const exact = await f.call(path, undefined, 'owner');
      assert.equal(exact.run_id, selected.run.id);
      assert.equal(exact.native_binding_id, f.policy.cancel_native_binding_id);
      assert.deepEqual(exact.input, review.input);
      assert.notEqual((await f.request(path, undefined, 'foreign')).response.status, 200);
      await f.db.update(f.schema.appNativeBindings).set({ state: 'revoked' })
        .where(f.orm.eq(f.schema.appNativeBindings.id, f.policy.cancel_native_binding_id));
      assert.notEqual((await f.request(path, undefined, 'owner')).response.status, 200);
      assert.equal((await f.runtime.repository.inspect(f.orgId, selected.run.id))?.state, 'pending_approval');
      assert.equal((await f.db.select().from(f.schema.events).where(f.orm.eq(f.schema.events.org_id, f.orgId))).length, 1);
    } finally { await f.close(); }
  });

test('public cancellation discovery rejects owner SID withdrawal after an actual held final session read',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    const sid = (JSON.parse(Buffer.from(f.sessions.owner.accessToken.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
    let release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = f.db.transaction(async tx => {
      await tx.execute(f.orm.sql`SELECT id FROM web_sessions WHERE id=${sid} FOR UPDATE`);
      acquired(); await held;
      await tx.update(f.schema.webSessions).set({ revoked_at: new Date() }).where(f.orm.eq(f.schema.webSessions.id, sid));
    });
    let context: ReturnType<typeof f.request> | undefined;
    try {
      await ready;
      context = f.request(f.contextPath, undefined, 'owner');
      await lockWait(f, 'web_sessions'); release(); await blocker;
      assert.equal((await context).response.status, 401);
      assert.equal((await f.db.select().from(f.schema.appPublicCancellationSelections).where(f.orm.eq(f.schema.appPublicCancellationSelections.org_id, f.orgId))).length, 0);
    } finally { release(); await blocker; if (context) await Promise.allSettled([context]); await f.close(); }
  });

test('public cancellation context rejects a changed candidate locator set after App wait without locking a new manager late',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    let release!: () => void, acquired!: () => void, changed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const change = new Promise<void>(resolve => { changed = resolve; });
    const blocker = f.db.transaction(async tx => {
      await tx.execute(f.orm.sql`SELECT id FROM app_installations WHERE org_id=${f.orgId} AND id=${f.staged.id} FOR UPDATE`);
      acquired(); await change;
      const [old] = await tx.select().from(f.schema.appNativeBindings).where(f.orm.eq(f.schema.appNativeBindings.id, f.policy.cancel_native_binding_id));
      assert.ok(old);
      // Controlled malformed persisted candidate tests the fail-closed observer;
      // it is never claimed as a normal manager-reviewed binding.
      await tx.insert(f.schema.appNativeBindings).values({ ...old, id: randomUUID(), action_key: 'unreviewed_candidate', stage_manager_user_id: f.foreignId });
      await held;
    });
    let releaseManager!: () => void, managerReady!: () => void;
    const managerHeld = new Promise<void>(resolve => { releaseManager = resolve; });
    const managerWaiting = new Promise<void>(resolve => { managerReady = resolve; });
    const managerBlocker = f.db.transaction(async tx => {
      // NO KEY UPDATE permits the candidate's FK KEY SHARE, but would block
      // an unsafe newly acquired participant SHARE behind the App fence.
      await tx.execute(f.orm.sql`SELECT id FROM org_members WHERE org_id=${f.orgId} AND user_id=${f.foreignId} FOR NO KEY UPDATE`); managerReady(); await managerHeld;
    });
    let context: ReturnType<typeof f.request> | undefined;
    try {
      await Promise.all([ready, managerWaiting]);
      context = f.request(f.contextPath, undefined, 'owner');
      await lockWait(f, 'app_installations'); changed(); release(); await blocker;
      assert.equal((await context).response.status, 409);
      assert.equal((await f.db.select().from(f.schema.appPublicCancellationSelections).where(f.orm.eq(f.schema.appPublicCancellationSelections.org_id, f.orgId))).length, 0);
      releaseManager(); await managerBlocker;
      const [original] = await f.db.select().from(f.schema.appNativeBindings).where(f.orm.eq(f.schema.appNativeBindings.id, f.policy.cancel_native_binding_id));
      assert.ok(original);
      await f.db.insert(f.schema.appNativeBindings).values(Array.from({ length: 7 }, (_, index) => ({ ...original,
        id: randomUUID(), action_key: `malformed_candidate_${index}` })));
      assert.equal((await f.request(f.contextPath, undefined, 'owner')).response.status, 409,
        'nine persisted candidates fail closed before binding projection even though the authoring contract permits at most eight');
    } finally { changed(); release(); releaseManager(); await Promise.all([blocker, managerBlocker]); if (context) await Promise.allSettled([context]); await f.close(); }
  });
