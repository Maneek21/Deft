import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { publicControlHttpFixture as setup } from './fixtures/public-control-http.js';

const url = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!url && url === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260927_c16_public_control_test(?:_v[0-9]+)?$/.test(url);
after(async () => { if (safe) {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
} });
test('public claim v2 retains only a scoped control digest and exact lost-response replay while legacy omission remains unchanged',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const c = await f.claim('Private control replay marker');
      assert.equal(c.result.schema_version, 'deft.app_public_claim_result.v2');
      const row = await f.retained(c.result.claim_id);
      assert.ok(row.control_digest?.startsWith('sha256:'));
      assert.equal(row.control_expires_at!.getTime() - row.budget_reserved_at!.getTime(), 604800000);
      assert.equal(JSON.stringify(row).includes(c.secret), false);
      const replay = (await f.call(f.path, c.body, 'anonymous')).result;
      assert.equal(replay.claim_id, c.result.claim_id); assert.equal(replay.replayed, true);
      assert.equal(replay.control_expires_at, c.result.control_expires_at);
      assert.equal((await f.request(f.path, { ...c.body, control_secret: randomBytes(32).toString('hex') }, 'anonymous')).response.status, 409);
      const { and, eq } = f.orm;
      await assert.rejects(f.db.update(f.schema.appCanonicalClaims).set({ control_expires_at: new Date(row.control_expires_at!.getTime() + 1) })
        .where(and(eq(f.schema.appCanonicalClaims.org_id, f.orgId), eq(f.schema.appCanonicalClaims.id, row.id))));
      await assert.rejects(f.db.update(f.schema.appPublicEndpoints).set({ cancellation_policy: { ...f.policy, control_ttl_seconds: 10 } })
        .where(and(eq(f.schema.appPublicEndpoints.org_id, f.orgId), eq(f.schema.appPublicEndpoints.id, f.endpoint.endpoint_id))));
      assert.equal((await f.request('/api/apps/public/endpoints/stage', { ...f.stageInput,
        cancellation_policy: { ...f.policy, cancel_native_binding_id: f.binding.binding_id } })).response.status, 409,
      'a reviewed create binding cannot stand in for reviewed cancellation consent');
      const denied = await f.request(c.statusPath, { schema_version: 'deft.app_public_control.v1', control_secret: randomBytes(32).toString('hex') }, 'owner');
      assert.equal(denied.response.status, 404);
      assert.equal((await f.status(c)).value.result.state, 'reserved');
      const withBearer = await f.request(c.statusPath, { schema_version: 'deft.app_public_control.v1', control_secret: c.secret }, 'foreign');
      assert.equal(withBearer.response.status, 200); assert.equal(withBearer.response.headers.get('cache-control'), 'no-store');
      assert.equal(JSON.stringify(withBearer.value).includes('Private control replay marker'), false);
      assert.equal(JSON.stringify(withBearer.value).includes(f.ownerId), false);
      assert.equal((await f.request(`${c.statusPath}?cursor=bad`, { schema_version: 'deft.app_public_control.v1', control_secret: c.secret }, 'anonymous')).response.status, 400);
      const legacyRecord = await f.createRecord('Legacy unaffected claim');
      const listing = await f.call(`${f.publicPath}/availability`, undefined, 'anonymous');
      const item = listing.result.items.find((r: { resource_ref: { resource_id: string } }) => r.resource_ref.resource_id === legacyRecord.id);
      const legacy = (await f.call(`${f.publicPath}/claims`, { resource_ref: item.resource_ref,
        expected_revision: item.revision, idempotency_key: randomUUID() }, 'anonymous')).result;
      assert.deepEqual(Object.keys(legacy).sort(), ['claim_id', 'claim_state', 'follow_up_state', 'replayed']);
      assert.equal((await f.retained(legacy.claim_id)).control_digest, null);
    } finally { await f.close(); }
  });

test('retained public control atomically withdraws an unadmitted claim across endpoint retirement and leased redelivery without refunding admission',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const c = await f.claim('Withdraw before admission');
      await f.call(`/api/apps/public/endpoints/${f.endpoint.endpoint_id}/disable`, {});
      process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'false';
      const [first, replay] = await Promise.all([f.cancel(c), f.cancel(c)]);
      assert.equal(first.response.status, 200); assert.equal(replay.response.status, 200);
      assert.equal(first.value.result.state, 'released_before_effect');
      assert.equal(first.value.result.cancellation_id, replay.value.result.cancellation_id);
      assert.equal((await f.status(c)).value.result.state, 'released_before_effect');
      assert.equal(await f.admit(c.result.claim_id), undefined);
      const row = await f.retained(c.result.claim_id); assert.ok(row.released_at); assert.ok(row.budget_reserved_at);
      const { and, eq } = f.orm;
      const cancellations = await f.db.select().from(f.schema.appPublicCancellations).where(eq(f.schema.appPublicCancellations.org_id, f.orgId));
      assert.equal(cancellations.length, 1); assert.equal(cancellations[0]!.original_run_id, null);
      await assert.rejects(f.db.delete(f.schema.appPublicCancellations).where(and(
        eq(f.schema.appPublicCancellations.org_id, f.orgId), eq(f.schema.appPublicCancellations.id, cancellations[0]!.id))));
      const timestamp = await f.db.execute(f.orm.sql`SELECT to_char(accepted_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS instant
        FROM app_public_cancellations WHERE org_id=${f.orgId}`);
      assert.equal(new Date(String(timestamp.rows[0]!.instant)).getTime(), cancellations[0]!.accepted_at.getTime());
      assert.equal((await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId))).length, 0);
    } finally { process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true'; await f.close(); }
  });

test('customer withdrawal cancels only the exact unstarted owner-approval Run and releases one pending unit without a daily refund',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const c = await f.claim('Pending owner review withdrawal'), run = await f.admit(c.result.claim_id);
      assert.equal(run?.state, 'pending_approval');
      const cancelled = await f.cancel(c); assert.equal(cancelled.value.result.state, 'released_before_effect');
      assert.equal((await f.runtime.repository.inspect(f.orgId, run!.id))?.state, 'cancelled');
      const { and, eq } = f.orm;
      const [approval] = await f.db.select().from(f.schema.agentActions).where(and(eq(f.schema.agentActions.org_id, f.orgId), eq(f.schema.agentActions.app_run_id, run!.id)));
      assert.ok(approval); assert.equal((await f.request(`/api/agent/actions/${approval.id}/approve`, {}, 'owner')).response.status, 400);
      const second = await f.claim('Second after released pending'); assert.equal((await f.cancel(second)).value.result.state, 'released_before_effect');
      const third = await f.createRecord('Original daily charge remains');
      const listed = await f.call(`/api/public/apps/${f.endpoint.slug}/availability`, undefined, 'anonymous');
      const item = listed.result.items.find((r: { resource_ref: { resource_id: string } }) => r.resource_ref.resource_id === third.id);
      assert.equal((await f.request(f.path, { ...c.body, resource_ref: item.resource_ref, expected_revision: item.revision,
        idempotency_key: randomUUID(), control_secret: randomBytes(32).toString('hex') }, 'anonymous')).response.status, 429);
      assert.equal((await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId))).length, 0);
    } finally { await f.close(); }
  });

test('a successful native Booking stays reserved and post-effect public cancellation is explicitly unavailable without a new owner Run',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const c = await f.claim('Post effect control unavailable'), run = await f.admit(c.result.claim_id);
      assert.ok(run); const { and, eq } = f.orm;
      const [approval] = await f.db.select().from(f.schema.agentActions).where(and(eq(f.schema.agentActions.org_id, f.orgId), eq(f.schema.agentActions.app_run_id, run.id)));
      assert.ok(approval); await f.call(`/api/agent/actions/${approval.id}/approve`, {}, 'owner');
      const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
        jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: run.id } });
      assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
      assert.equal((await f.runtime.repository.inspect(f.orgId, run.id))?.state, 'succeeded');
      const outcome = await f.cancel(c); assert.equal(outcome.value.result.state, 'cancellation_unavailable');
      assert.equal((await f.retained(c.result.claim_id)).released_at, null);
      assert.equal((await f.db.select().from(f.schema.appRuns).where(eq(f.schema.appRuns.org_id, f.orgId))).length, 1);
      assert.equal((await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId))).length, 1);
      assert.equal((await f.cancel(c)).value.result.cancellation_id, outcome.value.result.cancellation_id);
    } finally { await f.close(); }
  });

test('public control expiry is rechecked after a real endpoint lock wait and rolls back cancellation and claim release',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup(1);
    try {
      const c = await f.claim('Control expires while waiting');
      let release!: () => void, locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const blocker = f.db.transaction(async tx => {
        await tx.execute(f.orm.sql`SELECT id FROM app_public_endpoints WHERE org_id=${f.orgId} AND id=${f.endpoint.endpoint_id} FOR UPDATE`);
        locked(); await hold;
      });
      await ready;
      const pgNow = async () => Number((await f.db.execute(f.orm.sql`SELECT extract(epoch FROM clock_timestamp())*1000 AS now`)).rows[0]!.now);
      const expiry = new Date(c.result.control_expires_at).getTime();
      const waitUntil = expiry - await pgNow() - 350;
      if (waitUntil > 0) await new Promise(resolve => setTimeout(resolve, waitUntil));
      const pending = f.cancel(c);
      let observed = false;
      for (let n = 0; n < 40 && !observed; n++) {
        const rows = await f.db.execute(f.orm.sql`SELECT pg_stat_clear_snapshot();`);
        void rows;
        const waits = await f.db.execute(f.orm.sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND cardinality(pg_blocking_pids(pid))>0 AND query ILIKE '%app_public_endpoints%'`);
        observed = waits.rows.length > 0;
        if (!observed) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!observed) { release(); await blocker; }
      assert.ok(observed, 'actual public endpoint row wait observed');
      const untilExpiry = expiry - await pgNow() + 50;
      if (untilExpiry > 0) await new Promise(resolve => setTimeout(resolve, untilExpiry));
      assert.ok(await pgNow() >= expiry, 'actual PostgreSQL clock passed the stored UTC deadline before lock release');
      release(); await blocker;
      assert.equal((await pending).response.status, 404);
      assert.equal((await f.retained(c.result.claim_id)).released_at, null);
      assert.equal((await f.db.select().from(f.schema.appPublicCancellations).where(f.orm.eq(f.schema.appPublicCancellations.org_id, f.orgId))).length, 0);
    } finally { await f.close(); }
  });
