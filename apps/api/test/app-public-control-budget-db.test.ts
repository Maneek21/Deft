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
/** Synthetic retained history tests cardinality against real SQL constraints.
 * It is not evidence of thousands of HTTP bookings or a real UTC-day rollover. */
async function addHistory(f: Awaited<ReturnType<typeof setup>>, originalClaimId: string, entries: number, acceptedToday: boolean) {
  await f.db.execute(f.orm.sql`WITH source AS (
    SELECT gen_random_uuid()::text AS ingress_id,gen_random_uuid()::text AS claim_id,gen_random_uuid()::text AS cancellation_id,n
    FROM generate_series(1,${entries}::integer) n
  ), original AS (
    SELECT c.* FROM app_canonical_claims c WHERE c.org_id=${f.orgId} AND c.id=${originalClaimId}
  ), ingress AS (
    INSERT INTO app_public_ingress(id,org_id,endpoint_id,endpoint_epoch,request_key_digest,input_digest,state,follow_up_state,follow_up_code,handled_at,created_at)
    SELECT s.ingress_id,c.org_id,c.endpoint_id,${f.activation.endpoint_epoch},'sha256:'||repeat(md5(s.ingress_id),2),
      'sha256:'||repeat(md5(s.claim_id),2),'confirmed','unsupported','PUBLIC_WITHDRAWN',
      (clock_timestamp() AT TIME ZONE 'UTC')-interval '1 day',(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 day'
    FROM source s CROSS JOIN original c RETURNING id
  ), claims AS (
    INSERT INTO app_canonical_claims(id,org_id,endpoint_id,ingress_id,provider_kind,provider_instance_id,resource_type,resource_id,
      claim_kind,released_at,budget_reserved_at,created_at)
    SELECT s.claim_id,c.org_id,c.endpoint_id,s.ingress_id,c.provider_kind,c.provider_instance_id,c.resource_type,c.resource_id,c.claim_kind,
      (clock_timestamp() AT TIME ZONE 'UTC')-interval '23 hours',(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 day',
      (clock_timestamp() AT TIME ZONE 'UTC')-interval '1 day'
    FROM source s JOIN ingress i ON i.id=s.ingress_id CROSS JOIN original c RETURNING id
  ) INSERT INTO app_public_cancellations(id,org_id,app_installation_id,endpoint_id,claim_id,request_key_digest,state,accepted_at,settled_at)
    SELECT s.cancellation_id,${f.orgId},${f.staged.id},${f.endpoint.endpoint_id},s.claim_id,'sha256:'||repeat(md5(s.cancellation_id),2),
      'released_before_effect',(clock_timestamp() AT TIME ZONE 'UTC')-CASE WHEN ${acceptedToday} THEN interval '0 days' ELSE interval '1 day' END,
      (clock_timestamp() AT TIME ZONE 'UTC')-CASE WHEN ${acceptedToday} THEN interval '0 days' ELSE interval '1 day' END
    FROM source s JOIN claims c ON c.id=s.claim_id`);
}

test('public cancellation daily hundred-operation boundary charges one canonical operation and preserves replay and status at quota',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const prior = await f.claim('Daily quota retained replay'); const outcome = await f.cancel(prior);
      assert.equal(outcome.value.result.state, 'released_before_effect');
      await addHistory(f, prior.result.claim_id, 99, true);
      const target = await f.claim('Hundred and first cancellation');
      const denied = await f.cancel(target); assert.equal(denied.response.status, 429);
      const { eq } = f.orm;
      const rows = await f.db.select().from(f.schema.appPublicCancellations).where(eq(f.schema.appPublicCancellations.org_id, f.orgId));
      assert.equal(rows.length, 100); assert.equal((await f.retained(target.result.claim_id)).released_at, null);
      const replay = await f.cancel(prior); assert.equal(replay.response.status, 200);
      assert.equal(replay.value.result.cancellation_id, outcome.value.result.cancellation_id);
      assert.equal((await f.status(prior)).response.status, 200);
      assert.equal((await f.db.select().from(f.schema.appPublicCancellations).where(eq(f.schema.appPublicCancellations.org_id, f.orgId))).length, 100);
    } finally { await f.close(); }
  });

test('public withdrawal takes the original Run before App locks and fences an already queued native attempt after a real Run wait',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    let release: (() => void) | undefined;
    try {
      const c = await f.claim('Queued attempt withdrawal'), run = await f.admit(c.result.claim_id);
      assert.ok(run); const { and, eq, sql } = f.orm;
      const [approval] = await f.db.select().from(f.schema.agentActions).where(and(eq(f.schema.agentActions.org_id, f.orgId),
        eq(f.schema.agentActions.app_run_id, run.id)));
      assert.ok(approval); await f.call(`/api/agent/actions/${approval.id}/approve`, {}, 'owner');
      assert.equal((await f.runtime.repository.inspect(f.orgId, run.id))?.state, 'pending_approval');
      assert.ok((await f.runtime.repository.inspect(f.orgId, run.id))?.execution_released_at);
      const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
        jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: run.id } });
      assert.ok(job);
      let locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const blocker = f.db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM app_runs WHERE org_id=${f.orgId} AND id=${run.id} FOR UPDATE`);
        locked(); await hold;
      });
      await ready;
      const cancellation = f.cancel(c);
      let observed = false;
      for (let n = 0; n < 40 && !observed; n++) {
        await f.db.execute(sql`SELECT pg_stat_clear_snapshot()`);
        const wait = await f.db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND cardinality(pg_blocking_pids(pid))>0 AND query ILIKE '%app_runs%'`);
        observed = wait.rows.length > 0;
        if (!observed) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!observed) { release!(); await blocker; }
      assert.ok(observed, 'actual original Run UPDATE wait observed before public App prefix');
      const attempt = f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
      release!(); await blocker;
      const result = await cancellation; await attempt;
      assert.equal(result.response.status, 200); assert.equal(result.value.result.state, 'released_before_effect');
      assert.equal((await f.runtime.repository.inspect(f.orgId, run.id))?.state, 'cancelled');
      assert.ok((await f.retained(c.result.claim_id)).released_at);
      assert.equal((await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId))).length, 0);
      const retained = await f.db.select().from(f.schema.appRunAttempts).where(and(eq(f.schema.appRunAttempts.org_id, f.orgId),
        eq(f.schema.appRunAttempts.run_id, run.id)));
      assert.equal(retained.length, 1); assert.equal(retained[0]!.state, 'pending');
      assert.equal(retained[0]!.claim_token, null); assert.equal(retained[0]!.claimed_at, null);
      assert.equal(retained[0]!.provider_call_started_at, null); assert.equal(retained[0]!.provider_call_finished_at, null);
      assert.equal(retained[0]!.safe_outcome, null);
    } finally { release?.(); await f.close(); }
  });

test('public cancellation retained metadata cap rejects new identities without blocking retained status replay or deleting FK ancestry',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const prior = await f.claim('Metadata quota retained replay'); const outcome = await f.cancel(prior);
      await addHistory(f, prior.result.claim_id, 4095, false);
      const target = await f.claim('Retained cancellation hard cap');
      assert.equal((await f.cancel(target)).response.status, 429);
      const total = await f.db.execute(f.orm.sql`SELECT count(*)::integer AS n FROM app_public_cancellations WHERE org_id=${f.orgId}`);
      assert.equal(total.rows[0]!.n, 4096);
      assert.equal((await f.retained(target.result.claim_id)).released_at, null);
      assert.equal((await f.cancel(prior)).value.result.cancellation_id, outcome.value.result.cancellation_id);
      assert.equal((await f.status(prior)).response.status, 200);
      await assert.rejects(f.db.delete(f.schema.appCanonicalClaims).where(f.orm.and(
        f.orm.eq(f.schema.appCanonicalClaims.org_id, f.orgId), f.orm.eq(f.schema.appCanonicalClaims.id, prior.result.claim_id))));
    } finally { await f.close(); }
  });
