import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { publicNativeHttpFixture } from './fixtures/public-native-http.js';
const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c13_public_native_test(?:_v[0-9]+)?$/.test(target);
after(async () => { if (safe) {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
} });
async function setup() {
  const f = await publicNativeHttpFixture();
  const endpoint = await f.call('/api/apps/public/endpoints/stage', { ...f.stageInput,
    budget_policy: { schema_version: 'deft.app_public_budget.v1', max_pending: 1, max_confirmed_per_utc_day: 2 } });
  await f.call(`/api/apps/public/endpoints/${endpoint.endpoint_id}/activate`, {
    expected_review_digest: endpoint.review_digest, expected_endpoint_epoch: endpoint.endpoint_epoch, accept_host_policy: true });
  const path = `/api/public/apps/${endpoint.slug}/claims`;
  const submit = async (record: { id: string; revision: number }, key = randomUUID()) => {
    const listed = await f.call(`/api/public/apps/${endpoint.slug}/availability`, undefined, 'anonymous');
    const item = listed.result.items.find((item: { resource_ref: { resource_id: string } }) => item.resource_ref.resource_id === record.id);
    assert.ok(item);
    const body = { resource_ref: item.resource_ref, expected_revision: record.revision, idempotency_key: key };
    return { body, ...await f.request(path, body, 'anonymous') };
  };
  const { and, eq } = f.orm;
  const admit = async (claimId: string) => {
    const [claim] = await f.db.select().from(f.schema.appCanonicalClaims).where(and(
      eq(f.schema.appCanonicalClaims.org_id, f.orgId), eq(f.schema.appCanonicalClaims.id, claimId)));
    assert.ok(claim);
    const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId, jobName: 'app-public-ingress',
      dataMatch: { key: 'ingress_id', value: claim.ingress_id } });
    assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
    const [run] = await f.db.select().from(f.schema.appRuns).where(and(eq(f.schema.appRuns.org_id, f.orgId),
      eq(f.schema.appRuns.origin_public_ingress_id, claim.ingress_id)));
    assert.ok(run); assert.equal(run.state, 'pending_approval'); return run;
  };
  const settle = async (runId: string, decision: 'approve' | 'reject') => {
    const [action] = await f.db.select().from(f.schema.agentActions).where(and(eq(f.schema.agentActions.org_id, f.orgId),
      eq(f.schema.agentActions.app_run_id, runId)));
    assert.ok(action); await f.call(`/api/agent/actions/${action.id}/${decision}`, {}, 'owner');
    if (decision === 'approve') {
      const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId, jobName: 'app-run-attempt',
        dataMatch: { key: 'runId', value: runId } });
      assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
    }
    return await f.runtime.repository.inspect(f.orgId, runId);
  };
  return { ...f, endpoint, path, submit, admit, settle };
}
test('native public successful terminal Run releases its exact pending slot while unrelated terminal Run cannot substitute and daily charge persists',
  { skip: !safe, timeout: 120_000 }, async () => {
    const f = await setup();
    try {
      const first = await f.submit(await f.createRecord('First native budget claim'));
      assert.equal(first.response.status, 201); const firstId = first.value.result.claim_id;
      const original = await f.admit(firstId);
      const { and, eq, count } = f.orm;
      const [binding] = await f.db.select().from(f.schema.appNativeBindings).where(and(eq(f.schema.appNativeBindings.org_id, f.orgId),
        eq(f.schema.appNativeBindings.id, f.binding.binding_id)));
      assert.ok(binding);
      const unrelated = await f.call(`/api/apps/native/bindings/${f.binding.binding_id}/invoke`, {
        expected_consent_digest: binding.consent_digest, idempotency_key: randomUUID(),
        input: { title: 'Unrelated owner invocation', start: '2055-11-07T01:30:00-04:00', end: '2055-11-07T01:45:00-04:00' } }, 'owner');
      assert.equal((await f.settle(unrelated.id, 'approve'))?.state, 'succeeded');
      const secondRecord = await f.createRecord('Second native budget claim');
      assert.equal((await f.submit(secondRecord)).response.status, 429, 'unrelated terminal native Run must not release the pending public claim');
      assert.equal((await f.settle(original.id, 'approve'))?.state, 'succeeded');
      assert.ok((await f.runtime.receiptReader.readVerified(f.orgId, original.id)).some(r => r.receipt_kind === 'attempt_terminal' && r.verified));
      const second = await f.submit(secondRecord); assert.equal(second.response.status, 201, 'exact succeeded native ancestry frees one pending slot');
      const replay = await f.request(f.path, first.body, 'anonymous'); assert.equal(replay.response.status, 200);
      assert.equal(replay.value.result.claim_id, firstId); assert.equal(replay.value.result.replayed, true);
      assert.equal((await f.db.select({ n: count() }).from(f.schema.appCanonicalClaims).where(and(
        eq(f.schema.appCanonicalClaims.org_id, f.orgId), eq(f.schema.appCanonicalClaims.endpoint_id, f.endpoint.endpoint_id))))[0]?.n, 2);
      const secondRun = await f.admit(second.value.result.claim_id); assert.equal((await f.settle(secondRun.id, 'reject'))?.state, 'cancelled');
      assert.equal((await f.submit(await f.createRecord('Daily quota remains charged'))).response.status, 429);
    } finally { await f.close(); }
  });
test('native public owner rejection releases pending capacity through supported terminalization without refunding its canonical daily reservation',
  { skip: !safe, timeout: 120_000 }, async () => {
    const f = await setup();
    try {
      const first = await f.submit(await f.createRecord('Owner rejects this native claim')); assert.equal(first.response.status, 201);
      const run = await f.admit(first.value.result.claim_id); assert.equal((await f.settle(run.id, 'reject'))?.state, 'cancelled');
      const second = await f.submit(await f.createRecord('Pending slot after rejection')); assert.equal(second.response.status, 201);
      const { and, eq } = f.orm;
      const claims = await f.db.select().from(f.schema.appCanonicalClaims).where(and(eq(f.schema.appCanonicalClaims.org_id, f.orgId),
        eq(f.schema.appCanonicalClaims.endpoint_id, f.endpoint.endpoint_id)));
      assert.equal(claims.length, 2); assert.ok(claims.every(claim => claim.budget_reserved_at && claim.released_at === null));
      assert.equal((await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId))).length, 0);
    } finally { await f.close(); }
  });
