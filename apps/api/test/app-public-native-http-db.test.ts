import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { publicNativeHttpFixture } from './fixtures/public-native-http.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c13_public_native_test(?:_v[0-9]+)?$/.test(target);
after(async () => { if (safe) {
  const { shutdownAppRunRuntime } = await import('../src/lib/app-run-runtime.js');
  await shutdownAppRunRuntime(); await (await import('../src/lib/db.js')).closeDb();
} });

test('packed native Booking public HTTP claim yields one owner-approved native event and verified receipt from immutable canonical input',
  { skip: !safe, timeout: 120_000 }, async () => {
  const f = await publicNativeHttpFixture();
  try {
    const record = await f.createRecord('Immutable reviewed native Booking');
    const listed = await f.request(`${f.publicPath}/availability`, undefined, 'anonymous');
    assert.equal(listed.response.status, 200); assert.equal(listed.response.headers.get('cache-control'), 'no-store');
    const item = listed.value.result.items.find((row: { resource_ref: { resource_id: string } }) => row.resource_ref.resource_id === record.id);
    assert.ok(item); assert.equal(JSON.stringify(item).includes('PRIVATE_UNSELECTED'), false);
    const body = { resource_ref: item.resource_ref, expected_revision: item.revision, idempotency_key: randomUUID() };
    const claimed = (await f.call(`${f.publicPath}/claims`, body, 'anonymous')).result;
    assert.equal(claimed.follow_up_state, 'pending');
    assert.equal(JSON.stringify(claimed).includes(f.ownerId), false);
    const { and, eq, count } = f.orm;
    const [claim] = await f.db.select().from(f.schema.appCanonicalClaims).where(and(
      eq(f.schema.appCanonicalClaims.org_id, f.orgId), eq(f.schema.appCanonicalClaims.id, claimed.claim_id)));
    assert.ok(claim); assert.equal(claim.claimed_resource_revision, record.revision);
    assert.equal((await f.db.select({ value: count() }).from(f.schema.appRuns).where(eq(f.schema.appRuns.org_id, f.orgId)))[0]?.value, 0);
    const publicJob = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
      jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: claim.ingress_id } });
    assert.ok(publicJob); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, publicJob);
    const runs = await f.db.select().from(f.schema.appRuns).where(and(eq(f.schema.appRuns.org_id, f.orgId),
      eq(f.schema.appRuns.origin_public_ingress_id, claim.ingress_id)));
    assert.equal(runs.length, 1); const run = runs[0]!;
    assert.equal(run.state, 'pending_approval'); assert.equal(run.execution_actor_type, 'human'); assert.equal(run.execution_actor_id, f.ownerId);
    assert.equal(run.initiating_actor_type, 'app_public'); assert.equal(run.initiating_actor_id, claim.ingress_id);
    assert.equal(run.origin_native_binding_id, f.binding.binding_id);
    const changed = await f.updateRecord(record.id, record.revision, { title: 'Changed after sealed admission',
      start_at: '2055-11-08T12:00:00Z', end_at: '2055-11-08T12:30:00Z' });
    assert.equal(changed.revision, record.revision + 1);
    const reviewPath = `/api/apps/native/runs/${run.id}/review`;
    assert.equal((await f.request(reviewPath, undefined, 'foreign')).response.status, 403);
    const review = await f.call(reviewPath, undefined, 'owner');
    assert.deepEqual(review.input, { title: 'Immutable reviewed native Booking', start: '2055-11-07T01:30:00-04:00',
      end: '2055-11-07T01:45:00-04:00', description: claim.id });
    assert.equal(JSON.stringify(review).includes('PRIVATE_UNSELECTED'), false);
    const [approval] = await f.db.select().from(f.schema.agentActions).where(and(eq(f.schema.agentActions.org_id, f.orgId),
      eq(f.schema.agentActions.app_run_id, run.id)));
    assert.ok(approval); assert.equal(approval.user_id, f.ownerId);
    assert.equal((await f.request(`/api/agent/actions/${approval.id}/approve`, {}, 'foreign')).response.status, 404);
    await f.call(`/api/agent/actions/${approval.id}/approve`, {}, 'owner');
    const attemptJob = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
      jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: run.id } });
    assert.ok(attemptJob); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, attemptJob);
    assert.equal((await f.runtime.repository.inspect(f.orgId, run.id))?.state, 'succeeded');
    const receipts = await f.runtime.receiptReader.readVerified(f.orgId, run.id);
    assert.ok(receipts.some(receipt => receipt.receipt_kind === 'attempt_terminal' && receipt.verified));
    const result = await f.call(`/api/app-runs/${run.id}/result`, undefined, 'owner');
    const native = result.value.output;
    assert.equal(native.schema_version, 'deft.native_calendar_create_result.v1'); assert.equal(native.status, 'created');
    const events = await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId));
    assert.equal(events.length, 1); const event = events[0]!;
    assert.equal(event.id, native.event_ref.resource_id); assert.equal(event.user_id, f.ownerId);
    assert.equal(event.title, 'Immutable reviewed native Booking');
    const metadata = event.metadata as { start: string; end: string };
    assert.equal(metadata.start, '2055-11-07T05:30:00.000Z'); assert.equal(metadata.end, '2055-11-07T05:45:00.000Z');
    assert.equal(event.body, claim.id);
    const resolvePath = `/api/resources/resolve?ref=${encodeURIComponent(JSON.stringify(native.event_ref))}`;
    const resolved = await f.request(resolvePath, undefined, 'owner');
    assert.equal(resolved.response.status, 200); assert.equal(resolved.response.headers.get('cache-control'), 'no-store');
    const foreign = await f.request(resolvePath, undefined, 'foreign');
    assert.equal(foreign.response.status, 200); assert.equal(foreign.value.state, 'unavailable');
    assert.equal(Object.hasOwn(foreign.value, 'resource'), false);
    const replayed = (await f.call(`${f.publicPath}/claims`, body, 'anonymous')).result;
    assert.equal(replayed.claim_id, claim.id); assert.equal(replayed.replayed, true);
    assert.equal((await f.db.select({ value: count() }).from(f.schema.appRuns).where(eq(f.schema.appRuns.org_id, f.orgId)))[0]?.value, 1);
    assert.equal((await f.db.select({ value: count() }).from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId)))[0]?.value, 1);
  } finally { await f.close(); }
});

test('native public claim denies a changed canonical record before Run admission without an event or fabricated release',
  { skip: !safe, timeout: 120_000 }, async () => {
  const f = await publicNativeHttpFixture();
  try {
    const record = await f.createRecord('Captured revision boundary');
    const listed = (await f.call(`${f.publicPath}/availability`, undefined, 'anonymous')).result;
    const item = listed.items.find((row: { resource_ref: { resource_id: string } }) => row.resource_ref.resource_id === record.id);
    assert.ok(item); assert.equal(JSON.stringify(item).includes('PRIVATE_UNSELECTED'), false);
    const claimed = (await f.call(`${f.publicPath}/claims`, { resource_ref: item.resource_ref,
      expected_revision: item.revision, idempotency_key: randomUUID() }, 'anonymous')).result;
    const { and, eq, count } = f.orm;
    const [claim] = await f.db.select().from(f.schema.appCanonicalClaims).where(and(
      eq(f.schema.appCanonicalClaims.org_id, f.orgId), eq(f.schema.appCanonicalClaims.id, claimed.claim_id)));
    assert.ok(claim); assert.equal(claim.claimed_resource_revision, record.revision);
    const changed = await f.updateRecord(record.id, record.revision, { title: 'Changed before native admission' });
    assert.equal(changed.revision, record.revision + 1);
    const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
      jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: claim.ingress_id } });
    assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
    const [ingress] = await f.db.select().from(f.schema.appPublicIngress).where(and(
      eq(f.schema.appPublicIngress.org_id, f.orgId), eq(f.schema.appPublicIngress.id, claim.ingress_id)));
    assert.equal(ingress?.state, 'confirmed'); assert.equal(ingress?.follow_up_state, 'unsupported');
    assert.equal((await f.db.select({ value: count() }).from(f.schema.appRuns).where(and(
      eq(f.schema.appRuns.org_id, f.orgId), eq(f.schema.appRuns.origin_public_ingress_id, claim.ingress_id))))[0]?.value, 0);
    assert.equal((await f.db.select({ value: count() }).from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId)))[0]?.value, 0);
    const [retained] = await f.db.select().from(f.schema.appCanonicalClaims).where(eq(f.schema.appCanonicalClaims.id, claim.id));
    assert.equal(retained?.released_at, null); assert.equal(retained?.claimed_resource_revision, record.revision);
  } finally { await f.close(); }
});

test('mixed protocol 6 public Runtime target admits its unchanged string mapping to one governed Runtime Run',
  { skip: !safe, timeout: 120_000 }, async () => {
  const f = await publicNativeHttpFixture({ mixedRuntime: true });
  try {
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'true';
    const bindingInput = { installation_id: f.staged.id, action_key: 'runtime_followup', operator_user_id: f.ownerId,
      expected_app_version_id: f.staged.version_id, expected_package_digest: f.staged.package_digest,
      expected_grant_snapshot_digest: f.grant.snapshot_digest, expected_lifecycle_epoch: f.active.installation.lifecycle_epoch,
      expected_grant_epoch: f.active.installation.grant_epoch };
    const review = (await f.call('/api/apps/runtime/reviews/prepare', bindingInput)).review;
    const binding = (await f.call('/api/apps/runtime/bindings/activate', { ...bindingInput,
      expected_review_digest: review.review_digest, accept_host_policy: true })).binding;
    const endpoint = await f.call('/api/apps/public/endpoints/stage', { ...f.stageInput, public_action_key: 'reserve_runtime',
      binding_target: { schema_version: 'deft.app_public_binding_target.v2', kind: 'runtime', runtime_binding_id: binding.binding_id } });
    await f.call(`/api/apps/public/endpoints/${endpoint.endpoint_id}/activate`, {
      expected_review_digest: endpoint.review_digest, expected_endpoint_epoch: endpoint.endpoint_epoch, accept_host_policy: true });
    const record = await f.createRecord('Mixed Runtime public mapping');
    const body = { resource_ref: { schema_version: 'deft.resource_ref.v1', provider: { kind: 'module', provider_instance_id: f.module.id },
      resource_type: 'bookings', resource_id: record.id }, expected_revision: record.revision, idempotency_key: randomUUID() };
    const result = (await f.call(`/api/public/apps/${endpoint.slug}/claims`, body, 'anonymous')).result;
    const { and, eq } = f.orm;
    const [claim] = await f.db.select().from(f.schema.appCanonicalClaims).where(and(eq(f.schema.appCanonicalClaims.org_id, f.orgId),
      eq(f.schema.appCanonicalClaims.id, result.claim_id)));
    assert.ok(claim); assert.equal(claim.claimed_resource_revision, null, 'revision pin is specific to native admission');
    const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
      jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: claim.ingress_id } });
    assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
    const runs = await f.db.select().from(f.schema.appRuns).where(and(eq(f.schema.appRuns.org_id, f.orgId),
      eq(f.schema.appRuns.origin_public_ingress_id, claim.ingress_id)));
    assert.equal(runs.length, 1); const run = runs[0]!;
    assert.equal(run.provider_kind, 'app_runtime'); assert.equal(run.origin_runtime_binding_id, binding.binding_id);
    assert.equal(run.origin_native_binding_id, null); assert.equal(run.state, 'pending_approval');
    const exact = (await f.call(`/api/app-runtime-actions/${run.id}/review`, undefined, 'owner')).review;
    assert.deepEqual(exact.input, { resource_id: record.id });
  } finally { process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false'; process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'false'; await f.close(); }
});

test('native public availability claim and replay deny authority withdrawn during a real endpoint lock wait',
  { skip: !safe, timeout: 120_000 }, async () => {
  const f = await publicNativeHttpFixture();
  try {
    const record = await f.createRecord('Post-wait native authority');
    const listing = (await f.call(`${f.publicPath}/availability`, undefined, 'anonymous')).result;
    const item = listing.items.find((row: { resource_ref: { resource_id: string } }) => row.resource_ref.resource_id === record.id);
    assert.ok(item);
    const body = { resource_ref: item.resource_ref, expected_revision: item.revision, idempotency_key: randomUUID() };
    async function afterEndpointWait(withdraw: () => Promise<void>, restore: () => Promise<void>) {
      let held!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { held = resolve; });
      const unlocked = new Promise<void>(resolve => { release = resolve; });
      const holder = f.db.transaction(async tx => {
        await tx.execute(f.orm.sql`SELECT id FROM app_public_endpoints WHERE org_id=${f.orgId}
          AND id=${f.endpoint.endpoint_id} FOR UPDATE`);
        held(); await unlocked;
      });
      await acquired;
      const availability = f.request(`${f.publicPath}/availability`, undefined, 'anonymous');
      const claim = f.request(`${f.publicPath}/claims`, body, 'anonymous');
      try {
        const deadline = Date.now() + 10_000;
        let waiting = 0;
        do {
          const result = await f.db.execute(f.orm.sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
            AND lower(query) LIKE '%app_public_endpoints%' AND lower(query) LIKE '%for share%'`);
          waiting = Number((result.rows[0] as { count: number }).count);
          if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 25));
        } while (waiting < 2 && Date.now() < deadline);
        assert.ok(waiting >= 2, 'both real HTTP requests reached the endpoint row wait');
        await withdraw(); release(); await holder;
        const outcomes = await Promise.all([availability, claim]);
        for (const outcome of outcomes) assert.equal(outcome.response.status, 404,
          'withdrawn native authority cannot deliver availability or a canonical outcome');
      } finally {
        release(); await holder; await Promise.allSettled([availability, claim]); await restore();
      }
    }
    await afterEndpointWait(async () => { process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'false'; },
      async () => { process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true'; });
    const { and, eq, count } = f.orm;
    const observed = async () => ({
      ingress: (await f.db.select({ value: count() }).from(f.schema.appPublicIngress).where(eq(f.schema.appPublicIngress.org_id, f.orgId)))[0]?.value,
      claims: (await f.db.select({ value: count() }).from(f.schema.appCanonicalClaims).where(eq(f.schema.appCanonicalClaims.org_id, f.orgId)))[0]?.value,
      nonces: (await f.db.select({ value: count() }).from(f.schema.appPublicHmacNonces).where(eq(f.schema.appPublicHmacNonces.org_id, f.orgId)))[0]?.value,
    });
    assert.deepEqual(await observed(), { ingress: 0, claims: 0, nonces: 0 });
    await afterEndpointWait(async () => { await f.db.update(f.schema.users).set({ kind: 'agent', is_agent: true })
      .where(eq(f.schema.users.id, f.ownerId)); }, async () => { await f.db.update(f.schema.users).set({ kind: 'human', is_agent: false })
      .where(eq(f.schema.users.id, f.ownerId)); });
    assert.deepEqual(await observed(), { ingress: 0, claims: 0, nonces: 0 });
    const accepted = (await f.call(`${f.publicPath}/claims`, body, 'anonymous')).result;
    assert.equal(accepted.replayed, false);
    const prior = await observed();
    await afterEndpointWait(async () => { process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'false'; },
      async () => { process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true'; });
    assert.deepEqual(await observed(), prior, 'denied replay creates no second ingress/claim/nonce');
    const [retained] = await f.db.select().from(f.schema.appCanonicalClaims).where(and(eq(f.schema.appCanonicalClaims.org_id, f.orgId),
      eq(f.schema.appCanonicalClaims.id, accepted.claim_id)));
    assert.ok(retained); assert.equal(retained.released_at, null);
  } finally { process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true'; await f.close(); }
});

test('native public activation denies owner human-kind withdrawal during a real endpoint update wait',
  { skip: !safe, timeout: 120_000 }, async () => {
  const f = await publicNativeHttpFixture();
  try {
    const staged = await f.call('/api/apps/public/endpoints/stage', f.stageInput);
    let held!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { held = resolve; });
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const holder = f.db.transaction(async tx => {
      await tx.execute(f.orm.sql`SELECT id FROM app_public_endpoints WHERE org_id=${f.orgId} AND id=${staged.endpoint_id} FOR UPDATE`);
      held(); await unlocked;
    });
    await acquired;
    const activation = f.request(`/api/apps/public/endpoints/${staged.endpoint_id}/activate`, {
      expected_review_digest: staged.review_digest, expected_endpoint_epoch: staged.endpoint_epoch, accept_host_policy: true });
    try {
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      do {
        const result = await f.db.execute(f.orm.sql`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
          AND lower(query) LIKE '%app_public_endpoints%' AND lower(query) LIKE '%for update%'`);
        waiting = Number((result.rows[0] as { count: number }).count);
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      } while (!waiting && Date.now() < deadline);
      assert.ok(waiting, 'real activation reached its final endpoint UPDATE wait');
      await f.db.update(f.schema.users).set({ kind: 'agent', is_agent: true }).where(f.orm.eq(f.schema.users.id, f.ownerId));
      release(); await holder;
      assert.equal((await activation).response.status, 409);
      const [retained] = await f.db.select().from(f.schema.appPublicEndpoints).where(f.orm.eq(f.schema.appPublicEndpoints.id, staged.endpoint_id));
      assert.equal(retained?.state, 'disabled'); assert.equal(retained?.endpoint_epoch, staged.endpoint_epoch);
      assert.equal(retained?.review_digest, staged.review_digest);
    } finally {
      release(); await holder; await Promise.allSettled([activation]);
      await f.db.update(f.schema.users).set({ kind: 'human', is_agent: false }).where(f.orm.eq(f.schema.users.id, f.ownerId));
    }
  } finally { await f.close(); }
});

test('native public admission rolls back partial Run capsule approval and receipts after a real late capsule INSERT wait',
  { skip: !safe, timeout: 120_000 }, async () => {
  for (const withdrawal of ['gate', 'owner-kind'] as const) {
    const f = await publicNativeHttpFixture();
    try {
      const record = await f.createRecord(`Late capsule ${withdrawal}`);
      const listing = (await f.call(`${f.publicPath}/availability`, undefined, 'anonymous')).result;
      const item = listing.items.find((row: { resource_ref: { resource_id: string } }) => row.resource_ref.resource_id === record.id);
      assert.ok(item);
      const accepted = (await f.call(`${f.publicPath}/claims`, { resource_ref: item.resource_ref,
        expected_revision: item.revision, idempotency_key: randomUUID() }, 'anonymous')).result;
      const { and, eq, count } = f.orm;
      const [claim] = await f.db.select().from(f.schema.appCanonicalClaims).where(and(eq(f.schema.appCanonicalClaims.org_id, f.orgId),
        eq(f.schema.appCanonicalClaims.id, accepted.claim_id)));
      assert.ok(claim);
      const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
        jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: claim.ingress_id } });
      assert.ok(job);
      let held!: () => void, release!: () => void;
      const acquired = new Promise<void>(resolve => { held = resolve; });
      const unlocked = new Promise<void>(resolve => { release = resolve; });
      const holder = f.db.transaction(async tx => {
        // This dedicated database has no automatic worker. SHARE allows reads
        // and holds only the actual encrypted capsule INSERT's table lock.
        await tx.execute(f.orm.sql`LOCK TABLE app_run_secret_payloads IN SHARE MODE`);
        held(); await unlocked;
      });
      await acquired;
      const processing = f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
      try {
        const deadline = Date.now() + 10_000; let waiting = 0;
        do {
          const result = await f.db.execute(f.orm.sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
            AND lower(query) LIKE '%insert into "app_run_secret_payloads"%'`);
          waiting = Number((result.rows[0] as { count: number }).count);
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
        } while (!waiting && Date.now() < deadline);
        assert.ok(waiting, 'actual native Run capsule INSERT reached the held PostgreSQL table lock');
        if (withdrawal === 'gate') process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'false';
        else await f.db.update(f.schema.users).set({ kind: 'agent', is_agent: true }).where(eq(f.schema.users.id, f.ownerId));
        release(); await holder; await processing;
        const [ingress] = await f.db.select().from(f.schema.appPublicIngress).where(eq(f.schema.appPublicIngress.id, claim.ingress_id));
        assert.equal(ingress?.state, 'confirmed'); assert.equal(ingress?.follow_up_state, 'unsupported');
        for (const table of [f.schema.appRuns, f.schema.appRunSecretPayloads, f.schema.agentActions, f.schema.appRunReceipts]) {
          assert.equal((await f.db.select({ value: count() }).from(table).where(eq(table.org_id, f.orgId)))[0]?.value, 0,
            'late stale capture must roll back every partial Run-side write before unsupported settlement');
        }
        const [retained] = await f.db.select().from(f.schema.appCanonicalClaims).where(eq(f.schema.appCanonicalClaims.id, claim.id));
        assert.equal(retained?.released_at, null); assert.equal(retained?.claimed_resource_revision, record.revision);
      } finally {
        release(); await holder; await Promise.allSettled([processing]);
        process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true';
        await f.db.update(f.schema.users).set({ kind: 'human', is_agent: false }).where(eq(f.schema.users.id, f.ownerId));
      }
    } finally { await f.close(); }
  }
});

test('public management gates follow actual runtime or native target across both independent host switches',
  { skip: !safe, timeout: 120_000 }, async () => {
  const f = await publicNativeHttpFixture();
  try {
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    const { publicAvailabilityFixture } = await import('./fixtures/public-availability.js');
    const runtime = await publicAvailabilityFixture();
    const [user] = await f.db.select().from(f.schema.users).where(f.orm.eq(f.schema.users.id, runtime.ownerId));
    assert.ok(user);
    const session = await (await import('../src/lib/web-sessions.js')).createWebSession({ id: runtime.ownerId,
      org_id: runtime.orgId, email: user.email });
    async function runtimeRequest(path: string, body: unknown) {
      const response = await fetch(`${f.base}${path}`, { method: 'POST', headers: {
        Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { response, value: await response.json() };
    }
    for (const [runtimeEnabled, nativeEnabled] of [[false, false], [false, true], [true, false], [true, true]]) {
      process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = String(runtimeEnabled);
      process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = String(nativeEnabled);
      const nativeStage = await f.request('/api/apps/public/endpoints/stage', f.stageInput);
      const runtimeStage = await runtimeRequest('/api/apps/public/endpoints/stage', runtime.endpointInput);
      assert.equal(nativeStage.response.status, nativeEnabled ? 201 : 503);
      assert.equal(runtimeStage.response.status, runtimeEnabled ? 201 : 503);
      if (nativeEnabled) {
        assert.equal((await f.request(`/api/apps/public/endpoints/${nativeStage.value.endpoint_id}/activate`, {
          expected_review_digest: nativeStage.value.review_digest, expected_endpoint_epoch: nativeStage.value.endpoint_epoch,
          accept_host_policy: true })).response.status, 200);
      }
      if (runtimeEnabled) {
        assert.equal((await runtimeRequest(`/api/apps/public/endpoints/${runtimeStage.value.endpoint_id}/activate`, {
          expected_review_digest: runtimeStage.value.review_digest, expected_endpoint_epoch: runtimeStage.value.endpoint_epoch,
          accept_host_policy: true })).response.status, 200);
      }
      if (!nativeEnabled) for (const operation of ['activate', 'rotate-signing-key', 'disable']) {
        const body = operation === 'disable' ? {} : operation === 'activate' ? f.activationInput
          : { expected_review_digest: f.endpoint.review_digest, expected_endpoint_epoch: f.endpoint.endpoint_epoch };
        assert.equal((await f.request(`/api/apps/public/endpoints/${f.endpoint.endpoint_id}/${operation}`, body)).response.status, 503);
      }
      if (!runtimeEnabled) for (const operation of ['activate', 'rotate-signing-key', 'disable']) {
        const body = operation === 'disable' ? {} : { expected_review_digest: runtime.endpoint.review_digest,
          expected_endpoint_epoch: runtime.endpoint.endpoint_epoch, ...(operation === 'activate' ? { accept_host_policy: true } : {}) };
        assert.equal((await runtimeRequest(`/api/apps/public/endpoints/${runtime.endpoint.endpoint_id}/${operation}`, body)).response.status, 503);
      }
    }
  } finally {
    process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true'; process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false';
    await f.close();
  }
});
