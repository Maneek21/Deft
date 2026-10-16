import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildDeftAppPackage, verifyDeftAppPackageJson } from '@deft/app-kit';
import { publicControlHttpFixture } from './fixtures/public-control-http.js';

const url = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!url && url === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260927_c19_public_cancellation_test(?:_v[0-9]+)?$/.test(url);
after(async () => { if (safe) {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
} });
async function setup(ttl = 604800) {
  const f = await publicControlHttpFixture(ttl);
  const approveAndExecute = async (runId: string) => {
    const { and, eq } = f.orm;
    const [approval] = await f.db.select().from(f.schema.agentActions).where(and(eq(f.schema.agentActions.org_id, f.orgId),
      eq(f.schema.agentActions.app_run_id, runId)));
    assert.ok(approval); await f.call(`/api/agent/actions/${approval.id}/approve`, {}, 'owner');
    const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
      jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: runId } });
    assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
    assert.equal((await f.runtime.repository.inspect(f.orgId, runId))?.state, 'succeeded');
  };
  const original = async () => {
    const c = await f.claim('Retained owner-approved Booking'), run = await f.admit(c.result.claim_id);
    assert.ok(run); await approveAndExecute(run.id);
    const cancellation = await f.cancel(c); assert.equal(cancellation.value.result.state, 'cancellation_unavailable');
    return { c, run, cancellationId: cancellation.value.result.cancellation_id as string };
  };
  const ownerReview = (id: string) => f.call(`/api/apps/public/cancellations/${id}/owner/review`, {
    schema_version: 'deft.app_public_cancellation_owner_review_request.v1',
    native_binding_id: f.policy.cancel_native_binding_id, expected_consent_digest: f.policy.expected_cancel_consent_digest,
  }, 'owner');
  const ownerSubmit = (id: string, review: Awaited<ReturnType<typeof ownerReview>>) => f.request(
    `/api/apps/public/cancellations/${id}/owner/submit`, { ...review.request, review_token: review.review_token,
      expected_review_digest: review.review_digest, accept_host_policy: true }, 'owner');
  return { ...f, original, ownerReview, ownerSubmit, approveAndExecute };
}

test('retained public cancellation selects one current owner binding and releases only after exact approved native effect and verified receipt',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const { c, run, cancellationId } = await f.original(), before = await f.retained(c.result.claim_id);
      const review = await f.ownerReview(cancellationId);
      assert.equal(review.input.create_run_id, run.id);
      const denied = await f.request(`/api/apps/public/cancellations/${cancellationId}/owner/review`, review.request, 'foreign');
      assert.notEqual(denied.response.status, 200);
      const otherOrg = randomUUID();
      await f.db.insert(f.schema.orgs).values({ id: otherOrg, name: 'Isolated cancellation observer', slug: `cancel-${otherOrg}` });
      await f.db.insert(f.schema.orgMembers).values({ id: randomUUID(), org_id: otherOrg, user_id: f.ownerId, role: 'owner', is_active: true });
      const [human] = await f.db.select().from(f.schema.users).where(f.orm.eq(f.schema.users.id, f.ownerId));
      const otherSession = await (await import('../src/lib/web-sessions.js')).createWebSession({ id: f.ownerId, org_id: otherOrg, email: human!.email });
      const crossOrg = await fetch(`${f.base}/api/apps/public/cancellations/${cancellationId}/owner/review`, { method: 'POST',
        headers: { Authorization: `Bearer ${otherSession.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(review.request) });
      assert.notEqual(crossOrg.status, 200, 'same human in another organization cannot use retained cancellation locator');
      const replacementSession = await (await import('../src/lib/web-sessions.js')).createWebSession({ id: f.ownerId, org_id: f.orgId, email: human!.email });
      const crossSid = await fetch(`${f.base}/api/apps/public/cancellations/${cancellationId}/owner/submit`, { method: 'POST',
        headers: { Authorization: `Bearer ${replacementSession.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...review.request, review_token: review.review_token,
          expected_review_digest: review.review_digest, accept_host_policy: true }) });
      assert.notEqual(crossSid.status, 200, 'owner review is bound to the initiating live Web SID');
      const [first, replay] = await Promise.all([f.ownerSubmit(cancellationId, review), f.ownerSubmit(cancellationId, review)]);
      assert.equal(first.response.status, 200); assert.equal(replay.response.status, 200);
      const selected = first.value.run;
      assert.equal(replay.value.run.id, selected.id); assert.equal(selected.state, 'pending_approval');
      assert.equal((await f.status(c)).value.result.state, 'cancel_run_pending');
      assert.equal((await f.retained(c.result.claim_id)).released_at, null);
      await f.approveAndExecute(selected.id);
      const receipt = await f.runtime.receiptReader.readVerified(f.orgId, selected.id);
      assert.ok(receipt.some(item => item.run_state === 'succeeded'));
      assert.equal((await f.status(c)).value.result.state, 'cancelled');
      const released = await f.retained(c.result.claim_id); assert.ok(released.released_at);
      assert.equal(released.budget_reserved_at!.getTime(), before.budget_reserved_at!.getTime());
      const { and, eq } = f.orm;
      assert.equal((await f.db.select().from(f.schema.appRuns).where(eq(f.schema.appRuns.org_id, f.orgId))).length, 2);
      assert.equal((await f.db.select().from(f.schema.appPublicCancellations).where(eq(f.schema.appPublicCancellations.org_id, f.orgId))).length, 1);
      const [selection] = await f.db.select().from(f.schema.appPublicCancellationSelections).where(and(
        eq(f.schema.appPublicCancellationSelections.org_id, f.orgId), eq(f.schema.appPublicCancellationSelections.cancellation_id, cancellationId)));
      assert.equal(selection!.cancel_run_id, selected.id);
      const [event] = await f.db.select().from(f.schema.events).where(eq(f.schema.events.org_id, f.orgId));
      assert.equal((event!.metadata as { status: string }).status, 'canceled');
      await assert.rejects(f.db.update(f.schema.appPublicCancellationSelections).set({ selection_digest: `sha256:${'b'.repeat(64)}` })
        .where(eq(f.schema.appPublicCancellationSelections.id, selection!.id)));
      assert.equal((await f.cancel(c)).value.result.cancellation_id, cancellationId);
    } finally { await f.close(); }
  });

test('controlled persisted failed and unknown cancel Runs project honest retained reservation states without a refund',
  { skip: !safe, timeout: 120000 }, async () => {
    for (const state of ['failed', 'unknown_outcome'] as const) {
    const f = await setup();
    try {
      const { c, cancellationId } = await f.original(), before = await f.retained(c.result.claim_id);
      const review = await f.ownerReview(cancellationId), selected = await f.ownerSubmit(cancellationId, review);
      assert.equal(selected.response.status, 200);
      const [action] = await f.db.select().from(f.schema.agentActions).where(f.orm.and(
        f.orm.eq(f.schema.agentActions.org_id, f.orgId), f.orm.eq(f.schema.agentActions.app_run_id, selected.value.run.id)));
      assert.ok(action); await f.call(`/api/agent/actions/${action.id}/approve`, {}, 'owner');
      // A supported repository transition controls this projection boundary.
      // This is not a claim that the atomic native provider produced ambiguity.
      await f.runtime.repository.transaction(async tx => {
        const run = await f.runtime.repository.lockRun(tx, f.orgId, selected.value.run.id);
        assert.ok(run);
        const running = await f.runtime.repository.transition(tx, { run, state: 'running', now: new Date() });
        await f.runtime.repository.transition(tx, { run: running, state, now: new Date(),
          ...(state === 'unknown_outcome' ? { error_code: 'APP_RUN_UNKNOWN_OUTCOME' as const } : {}) });
      });
      assert.equal((await f.status(c)).value.result.state, state === 'unknown_outcome' ? 'unknown_outcome' : 'cancel_failed');
      if (state === 'unknown_outcome') assert.equal((await f.cancel(c)).value.result.cancellation_id, cancellationId);
      const retained = await f.retained(c.result.claim_id);
      assert.equal(retained.released_at, null);
      assert.equal(retained.budget_reserved_at!.getTime(), before.budget_reserved_at!.getTime());
      const { and, eq } = f.orm;
      const [request] = await f.db.select().from(f.schema.appPublicCancellations).where(and(
        eq(f.schema.appPublicCancellations.org_id, f.orgId), eq(f.schema.appPublicCancellations.id, cancellationId)));
      assert.equal(request!.settled_at === null, state === 'unknown_outcome');
      assert.equal((await f.db.select().from(f.schema.nativeCreateRequests).where(and(
        eq(f.schema.nativeCreateRequests.org_id, f.orgId), eq(f.schema.nativeCreateRequests.operation, 'app-native:calendar.events.cancel.v1')))).length, 0);
    } finally { await f.close(); }
    }
  });

test('current cancel binding revocation after review or approval never releases the reservation or refunds the original daily charge',
  { skip: !safe, timeout: 120000 }, async () => {
    for (const phase of ['review', 'approval'] as const) {
      const f = await setup();
      try {
        const { c, cancellationId } = await f.original(), before = await f.retained(c.result.claim_id);
        const review = await f.ownerReview(cancellationId);
        let selected: string | undefined;
        if (phase === 'approval') {
          const submission = await f.ownerSubmit(cancellationId, review);
          assert.equal(submission.response.status, 200); selected = submission.value.run.id;
          const [action] = await f.db.select().from(f.schema.agentActions).where(f.orm.and(
            f.orm.eq(f.schema.agentActions.org_id, f.orgId), f.orm.eq(f.schema.agentActions.app_run_id, selected!)));
          assert.ok(action); await f.call(`/api/agent/actions/${action.id}/approve`, {}, 'owner');
        }
        const [binding] = await f.db.select().from(f.schema.appNativeBindings).where(f.orm.eq(f.schema.appNativeBindings.id, f.policy.cancel_native_binding_id));
        await f.call(`/api/apps/native/bindings/${binding!.id}/revoke`, { expected_proposal_digest: binding!.proposal_digest }, 'owner');
        if (phase === 'review') {
          assert.notEqual((await f.ownerSubmit(cancellationId, review)).response.status, 200);
          assert.equal((await f.db.select().from(f.schema.appPublicCancellationSelections).where(f.orm.eq(f.schema.appPublicCancellationSelections.org_id, f.orgId))).length, 0);
          assert.equal((await f.status(c)).value.result.state, 'cancellation_unavailable');
        } else {
          const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
            jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: selected! } });
          assert.ok(job); await f.workers._processDequeuedJobForTest(f.queues.QUEUE_NAMES.AGENT_JOBS, job);
          assert.equal((await f.runtime.repository.inspect(f.orgId, selected!))?.state, 'pending_approval');
          assert.equal((await f.status(c)).value.result.state, 'cancel_run_pending');
          assert.equal((await f.cancel(c)).value.result.cancellation_id, cancellationId);
        }
        const retained = await f.retained(c.result.claim_id);
        assert.equal(retained.released_at, null);
        assert.equal(retained.budget_reserved_at!.getTime(), before.budget_reserved_at!.getTime());
        const [event] = await f.db.select().from(f.schema.events).where(f.orm.eq(f.schema.events.org_id, f.orgId));
        assert.notEqual((event!.metadata as { status?: string }).status, 'canceled');
      } finally { await f.close(); }
    }
  });

test('public cancellation owner selection and replay never acquire a retained original or selected Run lock behind current App authority',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup(); let release: (() => void) | undefined;
    try {
      const { c, run, cancellationId } = await f.original(), review = await f.ownerReview(cancellationId);
      const holdRun = async (id: string) => {
        let ready!: () => void;
        const waiting = new Promise<void>(resolve => { ready = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const blocker = f.db.transaction(async tx => {
          await tx.execute(f.orm.sql`SELECT id FROM app_runs WHERE org_id=${f.orgId} AND id=${id} FOR UPDATE`);
          ready(); await held;
        });
        await waiting; return { blocker };
      };
      const originalBlocker = await holdRun(run.id);
      const selected = await f.ownerSubmit(cancellationId, review);
      assert.equal(selected.response.status, 200, 'selection commits while original Run UPDATE remains held');
      release!(); await originalBlocker.blocker;
      const selectedBlocker = await holdRun(selected.value.run.id);
      const replay = await f.ownerSubmit(cancellationId, review);
      assert.equal(replay.response.status, 200, 'replay reads while selected Run UPDATE remains held');
      assert.equal(replay.value.run.id, selected.value.run.id);
      release!(); await selectedBlocker.blocker;
      await f.approveAndExecute(selected.value.run.id);
      assert.equal((await f.status(c)).value.result.state, 'cancelled');
    } finally { release?.(); await f.close(); }
  });

test('retained customer cancellation after upgrade requires explicit current owner consent to exact historical create pins',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    try {
      const { c, run, cancellationId } = await f.original();
      const oldReview = await f.ownerReview(cancellationId);
      const original = await verifyDeftAppPackageJson(await readFile(process.env.DEFT_NATIVE_AUTHOR_PACKAGE!, 'utf8'));
      const next = await buildDeftAppPackage({ manifest: { ...original.package.manifest, version: '1.0.1' }, artifacts: original.package.artifacts });
      const staged = await f.call(`/api/apps/native/app/${f.staged.id}/upgrade/stage`, {
        schema_version: 'deft.app_native_upgrade_stage.v1', package_json: next.json,
        expected_lifecycle_epoch: f.active.installation.lifecycle_epoch });
      const context = await f.call(`/api/apps/native/app/${f.staged.id}/upgrade/context?app_version_id=${staged.app_version_id}`);
      const review = await f.call(`/api/apps/native/app/${f.staged.id}/upgrade/review`, context.review_request);
      const activated = await f.call(`/api/apps/native/app/${f.staged.id}/upgrade/activate`, {
        ...context.review_request, expected_review_digest: review.review_digest, accept_host_policy: true });
      const { and, eq } = f.orm;
      const [grant] = await f.db.select().from(f.schema.appGrantSnapshots).where(and(
        eq(f.schema.appGrantSnapshots.org_id, f.orgId), eq(f.schema.appGrantSnapshots.app_version_id, staged.app_version_id),
        eq(f.schema.appGrantSnapshots.snapshot_kind, 'effective')));
      assert.ok(grant);
      const stageInput = { schema_version: 'deft.app_native_binding_stage.v1', installation_id: f.staged.id, action_key: 'cancel_booking',
        target: { schema_version: 'deft.app_native_target.v1', provider_kind: 'native', adapter_contract_version: 'deft.native.calendar.v1',
          operation_name: 'calendar.events.cancel.v1', calendar_owner_user_id: f.ownerId },
        expected_app_version_id: staged.app_version_id, expected_package_digest: next.digest,
        expected_grant_snapshot_digest: grant.snapshot_digest, expected_lifecycle_epoch: activated.installation.lifecycle_epoch,
        expected_grant_epoch: activated.installation.grant_epoch };
      const consent = async (bindingId: string) => {
        const ctx = await f.call(`/api/apps/native/bindings/${bindingId}/context`, undefined, 'owner');
        const reviewed = await f.call(`/api/apps/native/bindings/${bindingId}/review`, ctx.review_request, 'owner');
        return f.call(`/api/apps/native/bindings/${bindingId}/accept`, { ...ctx.review_request,
          expected_review_digest: reviewed.review_digest, accept_host_policy: true }, 'owner');
      };
      const current = await f.call('/api/apps/native/bindings/stage', stageInput), accepted = await consent(current.binding_id);
      const ownerRequest = (bindingId: string, digest: string) => ({ schema_version: 'deft.app_public_cancellation_owner_review_request.v1',
        native_binding_id: bindingId, expected_consent_digest: digest });
      assert.notEqual((await f.request(`/api/apps/public/cancellations/${cancellationId}/owner/review`,
        ownerRequest(current.binding_id, accepted.consent_digest), 'owner')).response.status, 200);
      assert.notEqual((await f.ownerSubmit(cancellationId, oldReview)).response.status, 200, 'old endpoint binding is never implicitly rebound');
      await f.call(`/api/apps/native/bindings/${current.binding_id}/revoke`, { expected_proposal_digest: current.proposal_digest }, 'owner');
      const policy = { schema_version: 'deft.app_native_historical_create_policy.v1', creates: [oldReview.original_create_pin] };
      for (const pin of [{ ...oldReview.original_create_pin, package_digest: `sha256:${'c'.repeat(64)}` },
        { ...oldReview.original_create_pin, grant_snapshot_id: randomUUID() }]) {
        assert.notEqual((await f.request('/api/apps/native/bindings/stage', { ...stageInput,
          historical_create_policy: { ...policy, creates: [pin] } })).response.status, 200);
      }
      const widened = await f.call('/api/apps/native/bindings/stage', { ...stageInput, historical_create_policy: policy });
      const approved = await consent(widened.binding_id);
      const retained = await f.call(`/api/apps/public/cancellations/${cancellationId}/owner/review`,
        ownerRequest(widened.binding_id, approved.consent_digest), 'owner');
      const submitted = await f.ownerSubmit(cancellationId, retained);
      assert.equal(submitted.response.status, 200);
      const [captured] = await f.db.select().from(f.schema.appRuns).where(and(eq(f.schema.appRuns.org_id, f.orgId),
        eq(f.schema.appRuns.id, submitted.value.run.id)));
      assert.equal(captured?.origin_app_version_id, staged.app_version_id);
      assert.equal(captured?.origin_native_binding_id, widened.binding_id);
      assert.equal(retained.input.create_run_id, run.id);
      await f.approveAndExecute(submitted.value.run.id);
      assert.equal((await f.status(c)).value.result.state, 'cancelled');
      const [endpoint] = await f.db.select().from(f.schema.appPublicEndpoints).where(eq(f.schema.appPublicEndpoints.id, f.endpoint.endpoint_id));
      assert.equal(endpoint!.native_binding_id, f.binding.binding_id);
      assert.notEqual(endpoint!.state, 'active');
    } finally { await f.close(); }
  });

test('public cancellation late capsule writes roll back current owner human SID and native gate withdrawal without partial Run or selection',
  { skip: !safe, timeout: 120000 }, async () => {
    for (const withdrawal of ['human', 'sid', 'gate'] as const) {
      const f = await setup();
      let release!: () => void;
      try {
        const { c, cancellationId } = await f.original(), review = await f.ownerReview(cancellationId);
        let acquired!: () => void;
        const ready = new Promise<void>(resolve => { acquired = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const blocker = f.db.transaction(async tx => {
          await tx.execute(f.orm.sql`LOCK TABLE app_run_secret_payloads IN SHARE MODE`);
          acquired(); await held;
        });
        await ready;
        const submitting = f.ownerSubmit(cancellationId, review);
        try {
          const deadline = Date.now() + 900; let waiting = false;
          do {
            const observed = await f.db.execute(f.orm.sql`SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
              AND lower(query) LIKE '%insert into "app_run_secret_payloads"%'`);
            waiting = Number((observed.rows[0] as { count: number }).count) > 0;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
          } while (!waiting && Date.now() < deadline);
          assert.ok(waiting, 'actual encrypted cancellation capsule INSERT reached the held table');
          if (withdrawal === 'human') await f.db.update(f.schema.users).set({ kind: 'agent', is_agent: true }).where(f.orm.eq(f.schema.users.id, f.ownerId));
          else if (withdrawal === 'sid') await (await import('../src/lib/web-sessions.js')).revokeWebSession(f.sessions.owner.refreshToken);
          else process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'false';
          release(); await blocker;
          assert.notEqual((await submitting).response.status, 200);
          assert.equal((await f.db.select().from(f.schema.appRuns).where(f.orm.eq(f.schema.appRuns.org_id, f.orgId))).length, 1);
          assert.equal((await f.db.select().from(f.schema.appPublicCancellationSelections).where(f.orm.eq(f.schema.appPublicCancellationSelections.org_id, f.orgId))).length, 0);
          assert.equal((await f.retained(c.result.claim_id)).released_at, null);
        } finally { release(); await blocker; await Promise.allSettled([submitting]); }
      } finally {
        process.env.DEFT_APP_NATIVE_CALENDAR_ENABLED = 'true';
        await f.db.update(f.schema.users).set({ kind: 'human', is_agent: false }).where(f.orm.eq(f.schema.users.id, f.ownerId));
        await f.close();
      }
    }
  });

test('accepted current owner cancellation outlives customer control expiry without extending that public capability',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup(10);
    try {
      const { c, cancellationId } = await f.original(), review = await f.ownerReview(cancellationId);
      const selected = await f.ownerSubmit(cancellationId, review);
      assert.equal(selected.response.status, 200);
      const before = await f.retained(c.result.claim_id);
      assert.ok(before.control_expires_at);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, before.control_expires_at!.getTime() - Date.now() + 100)));
      assert.equal((await f.status(c)).response.status, 404);
      await f.approveAndExecute(selected.value.run.id);
      const retained = await f.retained(c.result.claim_id);
      assert.ok(retained.released_at, 'post-commit repair does not depend on the expired customer capability');
      assert.equal(retained.control_expires_at!.getTime(), before.control_expires_at!.getTime());
      assert.equal(retained.budget_reserved_at!.getTime(), before.budget_reserved_at!.getTime());
      assert.equal((await f.status(c)).response.status, 404);
      assert.equal((await f.cancel(c)).response.status, 404);
    } finally { await f.close(); }
  });

test('public cancellation maintenance repairs lost post-commit settlement after actual capsule purge using retained signed receipts and exact native ledger hashes',
  { skip: !safe, timeout: 120000 }, async () => {
    const f = await setup();
    const { AppRunMaintenance } = await import('../src/lib/app-run-maintenance.js');
    const maintenance = new AppRunMaintenance(() => true, () => new Date(), url!);
    try {
      const { c, cancellationId } = await f.original(), before = await f.retained(c.result.claim_id);
      const review = await f.ownerReview(cancellationId), selected = await f.ownerSubmit(cancellationId, review);
      assert.equal(selected.response.status, 200);
      const { and, eq } = f.orm;
      const [action] = await f.db.select().from(f.schema.agentActions).where(and(
        eq(f.schema.agentActions.org_id, f.orgId), eq(f.schema.agentActions.app_run_id, selected.value.run.id)));
      assert.ok(action); await f.call(`/api/agent/actions/${action.id}/approve`, {}, 'owner');
      const job = await f.queues.dequeueJob(f.queues.QUEUE_NAMES.AGENT_JOBS, { orgId: f.orgId,
        jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: selected.value.run.id } });
      assert.ok(job);
      // Execute the real native attempt, then deliberately omit the wrapper's
      // post-commit reconciliation and remove the actual leased queue job.
      await f.runtime.attemptRunner.run(f.orgId, selected.value.run.id, (job.data as { attemptId: string }).attemptId, `lost-settlement:${job.id}`);
      assert.equal(await f.queues.completeJob(job.id, job.lockToken), true);
      assert.equal((await f.runtime.repository.inspect(f.orgId, selected.value.run.id))?.state, 'succeeded');
      assert.equal((await f.retained(c.result.claim_id)).released_at, null);
      // Controlled retention cutoff, not a changed host/PostgreSQL clock:
      // the normal purge service physically removes the real sealed capsules.
      await f.runtime.secretRepository.purgeExpiredRunForMaintenance(f.orgId, selected.value.run.id,
        new Date(Date.now() + 8 * 86400000), work => f.db.transaction(work));
      assert.equal((await f.db.select().from(f.schema.appRunSecretPayloads).where(and(
        eq(f.schema.appRunSecretPayloads.org_id, f.orgId), eq(f.schema.appRunSecretPayloads.run_id, selected.value.run.id)))).length, 0);
      const [ledger] = await f.db.select().from(f.schema.nativeCreateRequests).where(and(
        eq(f.schema.nativeCreateRequests.org_id, f.orgId), eq(f.schema.nativeCreateRequests.operation, 'app-native:calendar.events.cancel.v1')));
      assert.ok(ledger);
      await f.db.delete(f.schema.nativeCreateRequests).where(eq(f.schema.nativeCreateRequests.id, ledger.id));
      assert.ok((await maintenance.run('recovery')).failed >= 1, 'missing retained proof remains observable repair');
      assert.equal((await f.retained(c.result.claim_id)).released_at, null);
      await f.db.insert(f.schema.nativeCreateRequests).values(ledger);
      assert.ok((await maintenance.run('recovery')).changed >= 1);
      const retained = await f.retained(c.result.claim_id);
      assert.ok(retained.released_at);
      assert.equal(retained.budget_reserved_at!.getTime(), before.budget_reserved_at!.getTime());
      const [request] = await f.db.select().from(f.schema.appPublicCancellations).where(eq(f.schema.appPublicCancellations.id, cancellationId));
      assert.equal(request!.state, 'cancelled');
      assert.equal((await maintenance.run('recovery')).changed, 0, 'settled association is not repeatedly discovered');
    } finally { await maintenance.stop(); await f.close(); }
  });
