import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03b_(?:public|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);
const dbRejects = (code: string) => (error: unknown) =>
  error instanceof Error && 'cause' in error
  && (error.cause as Error | undefined)?.message === code;

test('packed v4 public claim creates a distinct principal Run, approved Runtime effect and signed receipt',
  { skip: !safe }, async () => {
    const artifactPath = process.env.DEFT_INSTALLED_AUTHOR_PACKAGE;
    assert.ok(artifactPath, 'DEFT_INSTALLED_AUTHOR_PACKAGE must point to a packed v4 installed App artifact');
    process.env.DEFT_APPS_ENABLED = 'true';
    process.env.DEFT_APP_DEVELOPER_PAIRING_ENABLED = 'true';
    process.env.DEFT_APP_RUNS_ENABLED = 'true';
    process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    process.env.DEFT_APP_PUBLIC_INGRESS_ENABLED = 'true';
    const key = (purpose: string) => createHash('sha256').update(`public-runtime-http:${purpose}`).digest('base64');
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
      run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
      receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
      fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } } });
    const [{ app }, { db, closeDb }, schema, sessionModule, runModule, keyringFixture,
      moduleService, queues, workers, serverModule, shared] = await Promise.all([
      import('../src/index.js'), import('../src/lib/db.js'), import('@deft/db/schema'),
      import('../src/lib/web-sessions.js'), import('../src/lib/app-run-runtime.js'),
      import('./fixtures/app-run-test-keyrings.js'), import('../src/lib/module-service.js'),
      import('../src/lib/queues.js'), import('../src/workers/index.js'),
      import('@hono/node-server'), import('@deft/shared'),
    ]);
    const { and, eq } = await import('drizzle-orm');
    const base = 'http://127.0.0.1:4338';
    let server: ReturnType<typeof serverModule.serve> | undefined;
    let child: ChildProcess | undefined;
    try {
      await new Promise<void>((resolve) => {
        server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4338 }, resolve);
      });
      const ring = await keyringFixture.databaseCompleteAppRunTestKeyringFixture('public-runtime-http');
      process.env.DEFT_APP_RUN_KEYRINGS = ring.environment;
      ring.keys.destroy();
      const suffix = randomUUID();
      const orgId = randomUUID();
      const ownerId = randomUUID();
      const otherId = randomUUID();
      const email = `public-runtime-${suffix}@example.test`;
      await db.insert(schema.orgs).values({ id: orgId, name: 'Public Runtime journey',
        slug: `public-runtime-${suffix}` });
      await db.insert(schema.users).values([{ id: ownerId, email, name: 'Public approver' },
        { id: otherId, email: `public-other-${suffix}@example.test`, name: 'Other owner' }]);
      await db.insert(schema.orgMembers).values([
        { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
        { id: randomUUID(), org_id: orgId, user_id: otherId, role: 'owner', is_active: true },
      ]);
      const web = await sessionModule.createWebSession({ id: ownerId, email, org_id: orgId });
      const otherWeb = await sessionModule.createWebSession({ id: otherId,
        email: `public-other-${suffix}@example.test`, org_id: orgId });
      const auth = { Authorization: `Bearer ${web.accessToken}` };
      async function call(path: string, method = 'GET', body?: unknown, token = auth.Authorization) {
        const response = await fetch(new Request(`${base}${path}`, { method,
          headers: { Authorization: token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        const value = await response.json() as any;
        assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
        return value;
      }
      const pairing = (await call('/api/apps/pairings', 'POST')).pairing;
      const exchanged = await call('/api/app-developer/pair/exchange', 'POST', { code: pairing.code }, '');
      const packed = await readFile(artifactPath, 'utf8');
      const installResponse = await fetch(new Request(`${base}/api/app-developer/install`, {
        method: 'POST', headers: { Authorization: `Bearer ${exchanged.token}`,
          'Content-Type': 'application/json' }, body: packed,
      }));
      const installed = await installResponse.json() as any;
      assert.equal(installResponse.status, 201, JSON.stringify(installed));
      const staged = installed.app;
      const grants = (await call(`/api/apps/${staged.id}/grants`)).grants;
      const version = grants.versions.find((row: any) => row.id === staged.version_id);
      const requested = grants.snapshots.find((row: any) => row.id === version.requested_grant_snapshot_id);
      assert.ok(requested);
      const reviewInput = { app_version_id: version.id,
        expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest,
        expected_lifecycle_epoch: grants.installation.lifecycle_epoch,
        expected_grant_epoch: grants.installation.grant_epoch };
      const review = await call(`/api/app-runtime-review/${staged.id}/review`, 'POST', reviewInput);
      const activated = await call(`/api/app-runtime-review/${staged.id}/activate`, 'POST', {
        ...reviewInput, expected_review_digest: review.review_digest, accept_host_policy: true,
      });
      const effective = (await call(`/api/apps/${staged.id}/grants`)).grants;
      const grant = effective.snapshots.find((row: any) => row.id === activated.grant_snapshot_id);
      assert.ok(grant);
      const bindingInput = { installation_id: staged.id, action_key: 'create_shipping_label',
        operator_user_id: ownerId, expected_app_version_id: version.id,
        expected_package_digest: version.package_digest,
        expected_grant_snapshot_digest: grant.snapshot_digest,
        expected_lifecycle_epoch: effective.installation.lifecycle_epoch,
        expected_grant_epoch: effective.installation.grant_epoch };
      const bindingReview = (await call('/api/apps/runtime/reviews/prepare', 'POST', bindingInput)).review;
      const binding = (await call('/api/apps/runtime/bindings/activate', 'POST', {
        ...bindingInput, expected_review_digest: bindingReview.review_digest,
        accept_host_policy: true,
      })).binding;
      const stage = await call('/api/apps/public/endpoints/stage', 'POST', {
        installation_id: staged.id, public_action_key: 'claim_label',
        runtime_binding_id: binding.binding_id, approver_user_id: ownerId,
        public_label: 'Claim a shipping label', max_body_bytes: 1024,
        expected_app_version_id: version.id,
        expected_grant_snapshot_id: grant.id,
        expected_lifecycle_epoch: effective.installation.lifecycle_epoch,
        expected_grant_epoch: effective.installation.grant_epoch,
      });
      assert.equal(stage.state, 'disabled');
      const owner = moduleService.humanModuleActor({ orgId, userId: ownerId,
        role: 'owner', source: 'ui' });
      const module = await moduleService.getModuleInstallation(owner,
        { moduleId: 'community.example.hello-workspace' });
      const created = await moduleService.createModuleRecord(owner, {
        module_id: module.module_id, collection_key: 'greetings',
        data: { message: 'Synthetic shipment' }, relations: {},
        expected_manifest_digest: module.manifest_digest,
        idempotency_key: `public-shipment-${suffix}`,
      });
      assert.ok(created.record);
      const claimBody = { resource_ref: { schema_version: shared.RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module', provider_instance_id: module.id },
        resource_type: 'greetings', resource_id: created.record.id },
      expected_revision: created.record.revision, idempotency_key: `claim-${suffix}` };
      const publicPath = `/api/public/apps/${stage.slug}/claims`;
      const disabled = await fetch(`${base}${publicPath}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claimBody) });
      assert.equal(disabled.status, 404);
      await call(`/api/apps/public/endpoints/${stage.endpoint_id}/activate`, 'POST', {
        expected_review_digest: stage.review_digest,
        expected_endpoint_epoch: stage.endpoint_epoch, accept_host_policy: true,
      });
      const publicHeaders = { 'Content-Type': 'application/json',
        Cookie: `access_token=${otherWeb.accessToken}; employee=forged`,
        Authorization: `Bearer ${otherWeb.accessToken}` };
      const claimResponse = await fetch(`${base}${publicPath}`, { method: 'POST',
        headers: publicHeaders, body: JSON.stringify(claimBody) });
      const claimResult = await claimResponse.json() as any;
      assert.equal(claimResponse.status, 201, JSON.stringify(claimResult));
      assert.deepEqual(Object.keys(claimResult.result).sort(),
        ['claim_id', 'claim_state', 'follow_up_state', 'replayed']);
      assert.equal(claimResult.result.follow_up_state, 'pending');
      const [claim] = await db.select().from(schema.appCanonicalClaims).where(and(
        eq(schema.appCanonicalClaims.org_id, orgId),
        eq(schema.appCanonicalClaims.id, claimResult.result.claim_id)));
      assert.ok(claim);
      const job = await queues.dequeueJob(queues.QUEUE_NAMES.AGENT_JOBS, { orgId,
        jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: claim.ingress_id } });
      assert.ok(job);
      const handler = await workers._getAgentJobHandlerForTest('app-public-ingress');
      assert.ok(handler);
      await assert.rejects(handler({ id: job.id, name: job.name,
        data: { ...job.data, endpoint_id: randomUUID() }, attempts: job.attempts }),
      /Invalid public ingress queue identity/);
      await Promise.all([handler({ id: job.id, name: job.name, data: job.data,
        attempts: job.attempts }), handler({ id: job.id, name: job.name,
        data: job.data, attempts: job.attempts })]);
      await workers._processDequeuedJobForTest(queues.QUEUE_NAMES.AGENT_JOBS, job);
      const [run] = await db.select().from(schema.appRuns).where(and(
        eq(schema.appRuns.org_id, orgId),
        eq(schema.appRuns.origin_public_ingress_id, claim.ingress_id)));
      assert.ok(run);
      assert.equal(run.initiating_actor_type, 'app_public');
      assert.equal(run.initiating_actor_id, claim.ingress_id);
      assert.equal(run.execution_actor_type, 'human');
      assert.equal(run.execution_actor_id, ownerId);
      assert.equal(run.state, 'pending_approval');
      const [ingress] = await db.select().from(schema.appPublicIngress).where(eq(schema.appPublicIngress.id, claim.ingress_id));
      assert.equal(ingress?.follow_up_state, 'run_created');
      await handler({ id: job.id, name: job.name, data: job.data, attempts: job.attempts });
      const [runCount] = await db.select({ value: (await import('drizzle-orm')).count() }).from(schema.appRuns)
        .where(eq(schema.appRuns.origin_public_ingress_id, claim.ingress_id));
      assert.equal(runCount?.value, 1);
      const replay = await fetch(`${base}${publicPath}`, { method: 'POST',
        headers: publicHeaders, body: JSON.stringify(claimBody) });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as any).result.follow_up_state, 'run_created');
      const reviewPath = `/api/app-runtime-actions/${run.id}/review`;
      const foreignReview = await fetch(`${base}${reviewPath}`, {
        headers: { Authorization: `Bearer ${otherWeb.accessToken}` },
      });
      assert.equal(foreignReview.status, 403);
      const reviewResponse = await fetch(`${base}${reviewPath}`, { headers: auth });
      assert.equal(reviewResponse.status, 200);
      assert.equal(reviewResponse.headers.get('cache-control'), 'no-store');
      const exact = (await reviewResponse.json() as any).review;
      assert.deepEqual(exact.input, { shipment_id: created.record.id });
      const [approval] = await db.select().from(schema.agentActions).where(and(
        eq(schema.agentActions.org_id, orgId), eq(schema.agentActions.app_run_id, run.id)));
      assert.ok(approval);
      assert.equal(approval.user_id, ownerId);
      const [attention] = await db.select().from(schema.attentionItems).where(and(
        eq(schema.attentionItems.org_id, orgId),
        eq(schema.attentionItems.user_id, ownerId),
        eq(schema.attentionItems.source_type, 'agent_action'),
        eq(schema.attentionItems.source_id, approval.id),
      ));
      assert.ok(attention, 'post-commit public approval reaches the human Attention inbox');
      assert.equal(JSON.stringify({ preview: run.safe_preview, params: approval.params })
        .includes(created.record.id), true, 'canonical public resource id is safe preview metadata');
      const runtime = await runModule.getAppRunRuntime();
      assert.equal((await runtime.approvalResolver.approve(approval.id, otherId)).status, 'error');
      assert.equal((await runtime.approvalResolver.approve(approval.id, ownerId)).status, 'approved');
      const session = (await call(`/api/apps/runtime/bindings/${binding.binding_id}/sessions`, 'POST')).session;
      const ledgerPath = join(await mkdtemp(join(tmpdir(), 'deft-public-runtime-')), 'carrier.jsonl');
      child = fork(fileURLToPath(new URL('./fixtures/app-runtime-provider-child.ts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, DEFT_RUNTIME_PROVIDER_FIXTURE: 'true' },
      });
      const events: Array<Record<string, unknown>> = [];
      const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Runtime child timed out: ${JSON.stringify(events)}`)), 30_000);
        child!.on('message', (message) => {
          if (!message || typeof message !== 'object') return;
          const event = message as Record<string, unknown>;
          events.push(event);
          if (event.type === 'result' || event.type === 'error') {
            clearTimeout(timer);
            if (event.type === 'error') reject(new Error(`Runtime child: ${JSON.stringify(event)}`));
            else resolve(event);
          }
        });
        child!.once('exit', (code) => { clearTimeout(timer);
          reject(new Error(`Runtime child exited ${code}: ${JSON.stringify(events)}`)); });
      });
      child.send({ type: 'start', channel_url: `${base}/api/app-runtime/channel`,
        session_id: session.session_id, session_token: session.session_token,
        ledger_path: ledgerPath, mode: 'normal' });
      assert.equal((await completed).type, 'result');
      assert.deepEqual((await readFile(ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse),
        [{ run_id: run.id, item_id: created.record.id, effect: 'synthetic_carrier_label' }]);
      assert.equal((await runtime.repository.inspect(orgId, run.id))?.state, 'succeeded');
      assert.ok((await runtime.receiptReader.readVerified(orgId, run.id))
        .some((receipt) => receipt.receipt_kind === 'attempt_terminal' && receipt.verified));
      await assert.rejects(db.update(schema.appRuns).set({ origin_public_ingress_id: null })
        .where(eq(schema.appRuns.id, run.id)), dbRejects('APP_RUN_IMMUTABLE_FIELD'));
      await assert.rejects(db.update(schema.appPublicEndpoints)
        .set({ input_mapping: { shipment_id: 'claim.claim_id' } })
        .where(eq(schema.appPublicEndpoints.id, stage.endpoint_id)),
      dbRejects('APP_PUBLIC_MAPPING_REVIEW_REQUIRED'));

      const second = await moduleService.createModuleRecord(owner, {
        module_id: module.module_id, collection_key: 'greetings',
        data: { message: 'Second synthetic shipment' }, relations: {},
        expected_manifest_digest: module.manifest_digest,
        idempotency_key: `public-shipment-two-${suffix}`,
      });
      assert.ok(second.record);
      const secondBody = { ...claimBody,
        resource_ref: { ...claimBody.resource_ref, resource_id: second.record.id },
        expected_revision: second.record.revision,
        idempotency_key: `claim-two-${suffix}` };
      const secondClaimResponse = await fetch(`${base}${publicPath}`, { method: 'POST',
        headers: publicHeaders, body: JSON.stringify(secondBody) });
      assert.equal(secondClaimResponse.status, 201);
      const secondClaimId = (await secondClaimResponse.json() as any).result.claim_id as string;
      const [secondClaim] = await db.select().from(schema.appCanonicalClaims).where(and(
        eq(schema.appCanonicalClaims.org_id, orgId), eq(schema.appCanonicalClaims.id, secondClaimId)));
      assert.ok(secondClaim);
      await assert.rejects(db.transaction(async (tx) => {
        await runtime.service.submitReviewedPublicRuntimeInTransaction(tx, {
          org_id: orgId, endpoint_id: stage.endpoint_id, ingress_id: secondClaim.ingress_id,
        });
        throw new Error('injected-after-run-before-ingress');
      }), /injected-after-run-before-ingress/);
      assert.deepEqual(await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
        .where(eq(schema.appRuns.origin_public_ingress_id, secondClaim.ingress_id)), []);
      const [pendingIngress] = await db.select().from(schema.appPublicIngress)
        .where(eq(schema.appPublicIngress.id, secondClaim.ingress_id));
      assert.equal(pendingIngress?.follow_up_state, 'pending');
      const secondJob = await queues.dequeueJob(queues.QUEUE_NAMES.AGENT_JOBS, { orgId,
        jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: secondClaim.ingress_id } });
      assert.ok(secondJob);
      await workers._processDequeuedJobForTest(queues.QUEUE_NAMES.AGENT_JOBS, secondJob);
      const [pendingRun] = await db.select().from(schema.appRuns)
        .where(eq(schema.appRuns.origin_public_ingress_id, secondClaim.ingress_id));
      assert.ok(pendingRun);
      assert.equal(pendingRun.state, 'pending_approval');
      const disabledEndpoint = await call(`/api/apps/public/endpoints/${stage.endpoint_id}/disable`, 'POST');
      assert.equal(disabledEndpoint.state, 'disabled');
      const staleReview = await fetch(`${base}/api/app-runtime-actions/${pendingRun.id}/review`,
        { headers: auth });
      assert.equal(staleReview.status, 409);
      const [pendingApproval] = await db.select().from(schema.agentActions).where(and(
        eq(schema.agentActions.org_id, orgId), eq(schema.agentActions.app_run_id, pendingRun.id)));
      assert.ok(pendingApproval);
      assert.equal((await runtime.approvalResolver.approve(pendingApproval.id, ownerId)).status, 'error');
      const disabledReplay = await fetch(`${base}${publicPath}`, { method: 'POST',
        headers: publicHeaders, body: JSON.stringify(secondBody) });
      assert.equal(disabledReplay.status, 404);
      await assert.rejects(db.update(schema.appPublicEndpoints)
        .set({ input_mapping: { shipment_id: 'claim.claim_id' } })
        .where(eq(schema.appPublicEndpoints.id, stage.endpoint_id)),
      dbRejects('APP_PUBLIC_MAPPING_REVIEW_REQUIRED'));
    } finally {
      if (child && child.exitCode === null) child.kill();
      if (server) { server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve())); }
      await runModule.shutdownAppRunRuntime();
      await closeDb();
    }
  });
