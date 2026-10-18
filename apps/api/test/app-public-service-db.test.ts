import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, count, eq, sql } from 'drizzle-orm';
import { SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT } from '@deft/app-kit';
import { CAPABILITY_CONTRACT_VERSIONS, RESOURCE_CONTRACT_VERSIONS, createCapabilityProviderDiscoverySnapshot } from '@deft/shared';
import {
  appCanonicalClaims, appGrantSnapshots, appInstallations, appModuleBindings, appPublicEndpoints,
  appPublicIngress, appVersions, jobQueue, mcpConnections, orgMembers, orgs, users,
} from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import { activateAppInstallation, stageAppPackage } from '../src/lib/app-service.js';
import { activateConnectedAppInstallation, prepareConnectedAppReview } from '../src/lib/app-review-service.js';
import { createModuleRecord, getModuleInstallation, humanModuleActor } from '../src/lib/module-service.js';
import { AppPublicClaimService, AppPublicError, publicEndpointReviewDigest } from '../src/lib/app-public-service.js';
import { dequeueJob, enqueue, QUEUE_NAMES } from '../src/lib/queues.js';
import { _getAgentJobHandlerForTest, _processDequeuedJobForTest } from '../src/workers/index.js';
import { createAppPublicRoutes } from '../src/routes/app-public.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { buildPhase5ConnectedAppPackage, buildPhase5DependencyAppPackage } from './fixtures/phase5-connected-app-package.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(async () => closeDb());
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function fixture() {
  const suffix = randomUUID();
  const orgId = randomUUID();
  const ownerUserId = randomUUID();
  const connectionId = randomUUID();
  const connectionSlug = `public-mail-${suffix}`;
  await db.insert(orgs).values({ id: orgId, name: 'Gate G public test', slug: `public-${suffix}` });
  await db.insert(users).values({ id: ownerUserId, email: `public-${suffix}@example.test`, name: 'Public reviewer' });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: ownerUserId, role: 'owner', is_active: true });
  const owner = humanModuleActor({ orgId, userId: ownerUserId, role: 'owner', source: 'ui' });
  const dependencyPackage = await buildPhase5DependencyAppPackage();
  const dependency = await stageAppPackage(owner, dependencyPackage.json);
  await activateAppInstallation(owner, dependency.id, dependency.package_digest);
  const connectedPackage = await buildPhase5ConnectedAppPackage();
  const staged = await stageAppPackage(owner, connectedPackage.json);
  const [version] = await db.select().from(appVersions).where(eq(appVersions.id, staged.version_id));
  assert.ok(version?.requested_grant_snapshot_id);
  const [requested] = await db.select().from(appGrantSnapshots).where(eq(appGrantSnapshots.id, version.requested_grant_snapshot_id));
  assert.ok(requested);
  await db.insert(mcpConnections).values({
    id: connectionId, org_id: orgId, name: 'Synthetic capability', slug: connectionSlug,
    server_url: 'https://public-fixture.example.test/mcp', transport: 'streamable-http', auth_type: 'none',
    is_active: true, enabled_tools: ['send_email'], created_by: ownerUserId,
  });
  const snapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
    provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId },
    captured_at: '2026-08-31T12:00:00.000Z',
    operations: [{
      identity: { provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId }, operation_name: 'send_email' },
      title: 'Synthetic send', description: 'No invocation',
      input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
      output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    }],
  });
  const capability = {
    async discover() {
      return {
        provider_kind: 'mcp' as const,
        tools: [{
          name: `mcp__${connectionSlug}__send_email`, originalName: 'send_email', description: 'Synthetic send',
          inputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
          outputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
          connectionId, connectionSlug, isWrite: true, approvalTier: 'full-review' as const,
          rawTool: { name: 'send_email' },
        }],
        snapshot,
      };
    },
    async invoke(): Promise<never> { throw new Error('fixture must never invoke capability'); },
  };
  const reviewRequest = {
    app_version_id: version.id,
    expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: staged.lifecycle_epoch,
    expected_grant_epoch: staged.grant_epoch,
    connector_selections: [{ connector_requirement_key: 'mail_provider', mcp_connection_id: connectionId }],
  };
  const review = await prepareConnectedAppReview(owner, staged.id, reviewRequest, capability);
  await activateConnectedAppInstallation(owner, staged.id, {
    ...reviewRequest, expected_review_digest: review.review_digest, accept_host_policy: true,
  }, capability);
  const [app] = await db.select().from(appInstallations).where(and(eq(appInstallations.org_id, orgId), eq(appInstallations.id, staged.id)));
  assert.ok(app?.active_version_id && app.active_grant_snapshot_id);
  const module = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-campaigns' });
  const [binding] = await db.select().from(appModuleBindings).where(and(
    eq(appModuleBindings.org_id, orgId), eq(appModuleBindings.app_installation_id, staged.id),
    eq(appModuleBindings.module_installation_id, module.id),
  ));
  assert.ok(binding);
  const slug = randomBytes(32).toString('base64url');
  const endpoint = {
    id: randomUUID(), org_id: orgId, slug_digest: digest(slug), app_installation_id: app.id,
    app_version_id: app.active_version_id, grant_snapshot_id: app.active_grant_snapshot_id,
    installation_lifecycle_epoch: app.lifecycle_epoch, installation_grant_epoch: app.grant_epoch,
    module_installation_id: module.id, collection_key: 'campaigns', endpoint_epoch: 1,
    public_label: 'Reserve resource', max_body_bytes: 1024,
  };
  await db.insert(appPublicEndpoints).values({
    ...endpoint, state: 'disabled', review_digest: publicEndpointReviewDigest(endpoint),
    reviewed_by_user_id: ownerUserId, reviewed_at: new Date(),
  });
  async function record(name: string) {
    const created = await createModuleRecord(owner, {
      module_id: module.module_id, collection_key: 'campaigns',
      data: { name, subject: `Private ${name}`, body: `Private body ${name}`, status: 'draft' },
      relations: {}, expected_manifest_digest: module.manifest_digest, idempotency_key: `public-${name}-${suffix}`,
    });
    assert.ok(created.record);
    return created.record;
  }
  function body(recordId: string, revision: number, key: string) {
    return Buffer.from(JSON.stringify({
      resource_ref: {
        schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module', provider_instance_id: module.id },
        resource_type: 'campaigns', resource_id: recordId,
      }, expected_revision: revision, idempotency_key: key,
    }));
  }
  return { orgId, ownerUserId, slug, endpoint, body, record };
}

test('reviewed public claims use canonical rows and one transaction for ingress and queue', { skip: !canRun }, async () => {
  const f = await fixture();
  const firstRecord = await f.record('first');
  const disabled = new AppPublicClaimService({ enabled: true });
  await assert.rejects(disabled.claim(f.slug, f.body(firstRecord.id, firstRecord.revision, 'disabled')),
    (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_NOT_FOUND');
  await db.update(appPublicEndpoints).set({ state: 'enabled' }).where(eq(appPublicEndpoints.id, f.endpoint.id));
  const defaultOff = new AppPublicClaimService();
  await assert.rejects(defaultOff.claim(f.slug, f.body(firstRecord.id, firstRecord.revision, 'default-off')),
    (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_NOT_FOUND');
  const input = JSON.parse(f.body(firstRecord.id, firstRecord.revision, 'negative').toString('utf8')) as Record<string, any>;
  const negativeCases: Array<[Buffer, AppPublicError['code']]> = [
    [Buffer.from('{broken'), 'PUBLIC_INVALID_INPUT'],
    [Buffer.from(JSON.stringify({ ...input, caller_org_id: f.orgId })), 'PUBLIC_INVALID_INPUT'],
    [Buffer.from(JSON.stringify({ ...input, resource_ref: { ...input.resource_ref,
      provider: { kind: 'module', provider_instance_id: randomUUID() } } })), 'PUBLIC_NOT_FOUND'],
    [Buffer.from(JSON.stringify({ ...input, resource_ref: { ...input.resource_ref,
      resource_type: 'contacts' } })), 'PUBLIC_NOT_FOUND'],
    [f.body(firstRecord.id, firstRecord.revision + 1, 'wrong-revision'), 'PUBLIC_CLAIM_CONFLICT'],
    [Buffer.alloc(8193, 120), 'PUBLIC_PAYLOAD_TOO_LARGE'],
  ];
  const [beforeNegativeClaims] = await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.org_id, f.orgId));
  const [beforeNegativeJobs] = await db.select({ value: count() }).from(jobQueue).where(and(
    eq(jobQueue.org_id, f.orgId), eq(jobQueue.name, 'app-public-ingress'),
  ));
  for (const [body, code] of negativeCases) {
    await assert.rejects(disabled.claim(f.slug, body),
      (error: unknown) => error instanceof AppPublicError && error.code === code);
  }
  for (const epochField of ['installation_grant_epoch', 'installation_lifecycle_epoch'] as const) {
    const staleSlug = randomBytes(32).toString('base64url');
    const staleEndpoint = {
      ...f.endpoint, id: randomUUID(), slug_digest: digest(staleSlug),
      [epochField]: f.endpoint[epochField] + 1,
    };
    await db.insert(appPublicEndpoints).values({
      ...staleEndpoint, state: 'enabled', review_digest: publicEndpointReviewDigest(staleEndpoint),
      reviewed_by_user_id: f.ownerUserId, reviewed_at: new Date(),
    });
    await assert.rejects(disabled.claim(staleSlug, f.body(firstRecord.id, firstRecord.revision, `stale-${epochField}`)),
      (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_NOT_FOUND');
  }
  const [afterNegativeClaims] = await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.org_id, f.orgId));
  const [afterNegativeJobs] = await db.select({ value: count() }).from(jobQueue).where(and(
    eq(jobQueue.org_id, f.orgId), eq(jobQueue.name, 'app-public-ingress'),
  ));
  assert.equal(afterNegativeClaims?.value, beforeNegativeClaims?.value);
  assert.equal(afterNegativeJobs?.value, beforeNegativeJobs?.value);

  const attempts = await Promise.allSettled(Array.from({ length: 100 }, (_, i) =>
    disabled.claim(f.slug, f.body(firstRecord.id, firstRecord.revision, `race-${i}`))));
  const winners = attempts.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected'
    && result.reason instanceof AppPublicError && result.reason.code === 'PUBLIC_CLAIM_CONFLICT').length, 99);
  const [firstClaim] = await db.select().from(appCanonicalClaims).where(and(
    eq(appCanonicalClaims.org_id, f.orgId), eq(appCanonicalClaims.resource_id, firstRecord.id),
  ));
  assert.ok(firstClaim);
  const dequeued = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, {
    orgId: f.orgId, jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: firstClaim.ingress_id },
  });
  assert.ok(dequeued);
  const handler = await _getAgentJobHandlerForTest('app-public-ingress');
  assert.ok(handler);
  await assert.rejects(handler({
    id: dequeued.id, name: dequeued.name, data: { ...dequeued.data, endpoint_id: randomUUID() },
    attempts: dequeued.attempts,
  }), /Invalid public ingress queue identity/);
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, dequeued);
  const [handled] = await db.select().from(appPublicIngress).where(eq(appPublicIngress.id, firstClaim.ingress_id));
  assert.equal(handled?.follow_up_state, 'unsupported');
  assert.equal(handled?.follow_up_code, 'APP_HANDLER_UNAVAILABLE');
  assert.ok(handled.handled_at);
  await handler({ id: dequeued.id, name: dequeued.name, data: dequeued.data, attempts: dequeued.attempts });
  const [handledAgain] = await db.select().from(appPublicIngress).where(eq(appPublicIngress.id, firstClaim.ingress_id));
  assert.equal(handledAgain?.handled_at?.getTime(), handled.handled_at.getTime());
  const winnerIndex = attempts.findIndex((result) => result.status === 'fulfilled');
  const handledReplay = await disabled.claim(f.slug, f.body(firstRecord.id, firstRecord.revision, `race-${winnerIndex}`));
  assert.equal(handledReplay.follow_up_state, 'unsupported');
  assert.equal(handledReplay.replayed, true);
  const [firstIngressCount] = await db.select({ value: count() }).from(appPublicIngress).where(eq(appPublicIngress.endpoint_id, f.endpoint.id));
  assert.equal(firstIngressCount?.value, 101, '100 race receipts plus the rejected revision receipt');
  const secondSlug = randomBytes(32).toString('base64url');
  const peerEndpoint = { ...f.endpoint, id: randomUUID(), slug_digest: digest(secondSlug) };
  await db.insert(appPublicEndpoints).values({
    ...peerEndpoint, state: 'enabled', review_digest: publicEndpointReviewDigest(peerEndpoint),
    reviewed_by_user_id: f.ownerUserId, reviewed_at: new Date(),
  });
  await assert.rejects(disabled.claim(secondSlug, f.body(firstRecord.id, firstRecord.revision, 'other-endpoint')),
    (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_CLAIM_CONFLICT');
  const [peerClaims] = await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.endpoint_id, peerEndpoint.id));
  assert.equal(peerClaims?.value, 0);

  const secondRecord = await f.record('second');
  const sameKey = f.body(secondRecord.id, secondRecord.revision, 'same-key');
  const replays = await Promise.all(Array.from({ length: 20 }, () => disabled.claim(f.slug, sameKey)));
  assert.equal(replays.filter((value) => !value.replayed).length, 1);
  assert.equal(new Set(replays.map((value) => value.claim_id)).size, 1);
  await assert.rejects(disabled.claim(f.slug, f.body(firstRecord.id, firstRecord.revision, 'same-key')),
    (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_IDEMPOTENCY_CONFLICT');

  const thirdRecord = await f.record('third');
  const rollbackKey = f.body(thirdRecord.id, thirdRecord.revision, 'rollback');
  const broken = new AppPublicClaimService({ enabled: true, deliver: async () => { throw new Error('injected'); } });
  await assert.rejects(broken.claim(f.slug, rollbackKey),
    (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_UNAVAILABLE');
  const [rolledBack] = await db.select({ value: count() }).from(appPublicIngress).where(and(
    eq(appPublicIngress.endpoint_id, f.endpoint.id), eq(appPublicIngress.request_key_digest, digest(`${f.endpoint.id}\0rollback`)),
  ));
  assert.equal(rolledBack?.value, 0);
  const afterRetry = await disabled.claim(f.slug, rollbackKey);
  assert.equal(afterRetry.replayed, false);
  const [claimCount] = await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.org_id, f.orgId));
  const [queueCount] = await db.select({ value: count() }).from(jobQueue).where(and(
    eq(jobQueue.org_id, f.orgId), eq(jobQueue.name, 'app-public-ingress'),
  ));
  assert.equal(claimCount?.value, 3);
  assert.equal(queueCount?.value, 3);

  const routes = createAppPublicRoutes(disabled);
  const response = await routes.request(`/${f.slug}/claims`, {
    method: 'POST', headers: {
      'content-type': 'application/json', cookie: 'session=forged-employee', authorization: 'Bearer forged-employee',
    }, body: sameKey,
  });
  assert.equal(response.status, 200);
  const projected = await response.json() as { result: Record<string, unknown> };
  assert.deepEqual(Object.keys(projected.result).sort(), ['claim_id', 'claim_state', 'follow_up_state', 'replayed']);
  assert.equal(JSON.stringify(projected).includes('Private'), false);
  assert.equal(projected.result.claim_id, replays[0]?.claim_id);
  const fourthRecord = await f.record('fourth');
  let enteredDelivery!: () => void;
  let releaseDelivery!: () => void;
  const inDelivery = new Promise<void>((resolve) => { enteredDelivery = resolve; });
  const deliveryReleased = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  const held = new AppPublicClaimService({ enabled: true, deliver: async (tx, orgId, endpointId, ingressId, epoch) => {
    enteredDelivery();
    await deliveryReleased;
    await enqueue(QUEUE_NAMES.AGENT_JOBS, 'app-public-ingress', {
      organization_id: orgId, endpoint_id: endpointId, ingress_id: ingressId, endpoint_epoch: epoch,
    }, { executor: tx, orgId, dedupeKey: `app-public-ingress:${ingressId}`, maxAttempts: 3 });
  } });
  const inFlight = held.claim(f.slug, f.body(fourthRecord.id, fourthRecord.revision, 'disable-race'));
  await inDelivery;
  try {
    await assert.rejects(db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '150ms'`);
      await tx.update(appPublicEndpoints).set({ state: 'disabled' }).where(eq(appPublicEndpoints.id, f.endpoint.id));
    }), (error: unknown) => {
      const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
      return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '55P03';
    });
  } finally {
    releaseDelivery();
  }
  const orderedClaim = await inFlight;
  assert.equal(orderedClaim.claim_state, 'confirmed');
  await db.update(appPublicEndpoints).set({ state: 'disabled' }).where(eq(appPublicEndpoints.id, f.endpoint.id));
  const [orderedReceipt] = await db.select().from(appPublicIngress).where(and(
    eq(appPublicIngress.endpoint_id, f.endpoint.id),
    eq(appPublicIngress.request_key_digest, digest(`${f.endpoint.id}\0disable-race`)),
  ));
  assert.ok(orderedReceipt);
  const revokedJob = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, {
    orgId: f.orgId, jobName: 'app-public-ingress', dataMatch: { key: 'ingress_id', value: orderedReceipt.id },
  });
  assert.ok(revokedJob);
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, revokedJob);
  const [revokedReceipt] = await db.select().from(appPublicIngress).where(eq(appPublicIngress.id, orderedReceipt.id));
  assert.equal(revokedReceipt?.follow_up_state, 'unsupported');
  assert.equal(revokedReceipt?.follow_up_code, 'ENDPOINT_REVOKED');
  await assert.rejects(disabled.claim(f.slug, f.body(thirdRecord.id, thirdRecord.revision, 'after-disable')),
    (error: unknown) => error instanceof AppPublicError && error.code === 'PUBLIC_NOT_FOUND');
  const [retained] = await db.select({ value: count() }).from(appCanonicalClaims).where(eq(appCanonicalClaims.org_id, f.orgId));
  assert.equal(retained?.value, 4);
});
