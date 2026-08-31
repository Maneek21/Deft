import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import { SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT } from '@deft/app-kit';
import {
  APP_RUN_CONTRACT_VERSIONS,
  CAPABILITY_CONTRACT_VERSIONS,
  RESOURCE_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
  type AppRunSubmission,
  type ModuleResourceRefV1,
} from '@deft/shared';
import {
  agentActions,
  appActionBindings,
  appGrantSnapshots,
  appRunAttempts,
  appRunReceipts,
  appRunSecretPayloads,
  appRuns,
  appVersions,
  mcpConnections,
  orgMembers,
  orgs,
  users,
} from '@deft/db/schema';
import { AppActionService } from '../src/lib/app-action-service.js';
import { AppRunAttemptRunner } from '../src/lib/app-run-attempt-runner.js';
import { PostgresAppRunApprovalResolver, postgresAppRunApprovalAdapter } from '../src/lib/app-run-approval-adapter.js';
import { PostgresAppRunAuthorizer } from '../src/lib/app-run-authorization.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { PostgresAppRunLiveAuthorization } from '../src/lib/app-run-live-authorization.js';
import { AppRunPreparedInputService } from '../src/lib/app-run-prepared-input.js';
import { PinnedMcpAppRunProviderExecutor } from '../src/lib/app-run-provider-executor.js';
import { PostgresAppRunRepository } from '../src/lib/app-run-repository.js';
import { AppRunSecretRepository } from '../src/lib/app-run-secret-repository.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { AppRunService } from '../src/lib/app-run-service.js';
import { noOpAppRunAttentionProjector } from '../src/lib/app-run-attention.js';
import { PostgresAppRunReceiptWriter } from '../src/lib/app-run-receipts.js';
import { CapabilityService, type CapabilityPinnedInvocationRequest } from '../src/lib/capability-service.js';
import type {
  McpCapabilityDiscoveryRequest,
  McpCapabilityDiscoveryResult,
  McpCapabilityInvocationRequest,
  McpPinnedExecutionResult,
} from '../src/lib/capability-providers/mcp.js';
import { closeDb, db } from '../src/lib/db.js';
import { activateAppInstallation, stageAppPackage } from '../src/lib/app-service.js';
import {
  activateConnectedAppInstallation,
  prepareConnectedAppReview,
} from '../src/lib/app-review-service.js';
import {
  createModuleRecord,
  getModuleInstallation,
  humanModuleActor,
  readModuleRecordScalarFields,
} from '../src/lib/module-service.js';
import { replaceResourceRelation } from '../src/lib/resource-relation-service.js';
import { Phase4SandboxEmailProvider } from './fixtures/phase4-sandbox-email-provider.js';
import {
  buildPhase5ConnectedAppPackage,
  buildPhase5DependencyAppPackage,
} from './fixtures/phase5-connected-app-package.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(databaseUrl && /phase5.*(?:test|loop4)|(?:test|loop4).*phase5/i.test(
  new URL(databaseUrl).pathname,
));

after(async () => closeDb());

function key(purpose: string, keyId: string): string {
  return createHash('sha256').update(`loop5-lifecycle:${purpose}:${keyId}`).digest('base64');
}

function keyMap(purpose: string, keyIds: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries([...keyIds].map((keyId) => [keyId, key(purpose, keyId)]));
}

function moduleRef(
  installationId: string,
  resourceType: string,
  resourceId: string,
): ModuleResourceRefV1 {
  return {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module', provider_instance_id: installationId },
    resource_type: resourceType,
    resource_id: resourceId,
  };
}

test('sealed App action candidate creates one governed Run, executes once after approval, and fails closed on revocation', {
  skip: !canRun,
}, async () => {
  const suffix = randomUUID();
  const orgId = randomUUID();
  const ownerUserId = randomUUID();
  const connectionId = randomUUID();
  const connectionSlug = `loop5-mail-${suffix}`;
  const recipient = `loop5-recipient-${suffix}@example.test`;
  const subject = `Loop 5 private subject ${suffix}`;
  const bodyText = `Loop 5 private body ${suffix}`;

  await db.insert(orgs).values({ id: orgId, name: 'Loop 5 App origin', slug: `loop5-${suffix}` });
  await db.insert(users).values({
    id: ownerUserId,
    email: `loop5-owner-${suffix}@example.test`,
    name: 'Loop 5 owner',
  });
  await db.insert(orgMembers).values({
    id: randomUUID(),
    org_id: orgId,
    user_id: ownerUserId,
    role: 'owner',
    is_active: true,
  });
  const owner = humanModuleActor({
    orgId,
    userId: ownerUserId,
    role: 'owner',
    source: 'ui',
  });
  const initiatingActor = { actor_type: 'human' as const, user_id: ownerUserId };

  const dependencyPackage = await buildPhase5DependencyAppPackage();
  const dependency = await stageAppPackage(owner, dependencyPackage.json);
  await activateAppInstallation(owner, dependency.id, dependency.package_digest);

  const connectedPackage = await buildPhase5ConnectedAppPackage();
  const connected = await stageAppPackage(owner, connectedPackage.json);
  const [connectedVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, connected.version_id),
  ));
  if (!connectedVersion?.requested_grant_snapshot_id) {
    throw new Error('Connected requested grant is missing');
  }
  const [requestedGrant] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, connectedVersion.requested_grant_snapshot_id),
  ));
  if (!requestedGrant) throw new Error('Connected requested grant row is missing');

  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: orgId,
    name: 'Loop 5 sandbox mail',
    slug: connectionSlug,
    server_url: 'https://loop5-sandbox.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    enabled_tools: ['send_email'],
    created_by: ownerUserId,
  });

  const snapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
    provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId },
    captured_at: '2026-08-31T12:00:00.000Z',
    operations: [{
      identity: {
        provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId },
        operation_name: 'send_email',
      },
      title: 'Send sandbox email',
      description: 'Accept one deterministic sandbox email.',
      input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
      output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    }],
  });
  const tool = {
    name: `mcp__${connectionSlug}__send_email`,
    originalName: 'send_email',
    description: 'Send sandbox email',
    inputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
    outputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    connectionId,
    connectionSlug,
    isWrite: true,
    approvalTier: 'full-review' as const,
    rawTool: { name: 'send_email' },
  };
  const sandbox = new Phase4SandboxEmailProvider();
  const pinnedRequests: CapabilityPinnedInvocationRequest[] = [];
  const providerPort = {
    async discover(request: McpCapabilityDiscoveryRequest): Promise<McpCapabilityDiscoveryResult> {
      assert.equal(request.org_id, orgId);
      assert.equal(request.provider_instance_id, connectionId);
      return { provider_kind: 'mcp', tools: [tool], snapshot };
    },
    async invoke(_request: McpCapabilityInvocationRequest): Promise<never> {
      throw new Error('Legacy capability invocation must not serve App-origin Runs');
    },
    async executePinned(request: CapabilityPinnedInvocationRequest): Promise<McpPinnedExecutionResult> {
      pinnedRequests.push(request);
      const effect = await sandbox.invoke({
        to: String(request.input.to),
        subject: String(request.input.subject),
        body_text: String(request.input.body_text),
        idempotency_key: String(request.input.idempotency_key),
      });
      return {
        status: 'returned',
        provider_succeeded: true,
        output: { message_id: effect.message_id, status: effect.status },
        duration_ms: 1,
      };
    },
  };
  const capabilities = new CapabilityService(providerPort);
  const reviewRequest = {
    app_version_id: connectedVersion.id,
    expected_package_digest: connectedVersion.package_digest,
    expected_requested_snapshot_digest: requestedGrant.snapshot_digest,
    expected_lifecycle_epoch: connected.lifecycle_epoch,
    expected_grant_epoch: connected.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const review = await prepareConnectedAppReview(owner, connected.id, reviewRequest, capabilities);
  await activateConnectedAppInstallation(owner, connected.id, {
    ...reviewRequest,
    expected_review_digest: review.review_digest,
    accept_host_policy: true,
  }, capabilities);
  const [binding] = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, orgId),
    eq(appActionBindings.app_installation_id, connected.id),
  ));
  if (!binding) throw new Error('Reviewed App action binding is missing');

  const contacts = await getModuleInstallation(owner, { moduleId: 'community.deft.contacts' });
  const campaigns = await getModuleInstallation(owner, { moduleId: 'community.deft.connected-campaigns' });
  const contact = await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: { name: 'Loop 5 recipient', email: recipient },
    relations: {},
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `loop5-contact-${suffix}`,
  });
  const campaign = await createModuleRecord(owner, {
    module_id: campaigns.module_id,
    collection_key: 'campaigns',
    data: { subject, body: bodyText },
    relations: {},
    expected_manifest_digest: campaigns.manifest_digest,
    idempotency_key: `loop5-campaign-${suffix}`,
  });
  if (!contact.record || !campaign.record) throw new Error('Loop 5 proof records were not created');
  const campaignRef = moduleRef(campaigns.id, 'campaigns', campaign.record.id);
  const contactRef = moduleRef(contacts.id, 'contacts', contact.record.id);
  await replaceResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: campaignRef,
    relation_key: 'contacts',
    refs: [contactRef],
    expected_revision: 0,
    idempotency_key: `loop5-link-${suffix}`,
  });

  const [fingerprintRows, encryptionRows, signingRows] = await Promise.all([
    db.select({
      idempotency: appRuns.idempotency_key_version,
      input: appRuns.input_fingerprint_key_version,
    }).from(appRuns),
    db.selectDistinct({ keyId: appRunSecretPayloads.key_version }).from(appRunSecretPayloads),
    db.selectDistinct({ keyId: appRunReceipts.signing_key_version }).from(appRunReceipts),
  ]);
  const fingerprintKeyIds = new Set([
    'fp-v1',
    ...fingerprintRows.flatMap((row) => [row.idempotency, row.input]),
  ]);
  const encryptionKeyIds = new Set(['enc-v1', ...encryptionRows.map((row) => row.keyId)]);
  const signingKeyIds = new Set(['sig-v1', ...signingRows.map((row) => row.keyId)]);
  const keys = parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: keyMap('run_encryption', encryptionKeyIds) },
    receipt_signing: { current: 'sig-v1', keys: keyMap('receipt_signing', signingKeyIds) },
    fingerprint: { current: 'fp-v1', keys: keyMap('fingerprint', fingerprintKeyIds) },
  }));
  try {
    const secrets = new AppRunSecretService(keys);
    const preparedInputs = new AppRunPreparedInputService(secrets);
    const repository = new PostgresAppRunRepository();
    const secretRepository = new AppRunSecretRepository(secrets);
    const liveAuthorization = new PostgresAppRunLiveAuthorization();
    const receipts = new PostgresAppRunReceiptWriter(secrets, secretRepository);
    const pinnedExecutor = new PinnedMcpAppRunProviderExecutor({
      executePinned: (request) => capabilities.invokePinned(request),
    });
    const attemptRunner = new AppRunAttemptRunner(
      repository,
      secretRepository,
      secrets,
      pinnedExecutor,
      liveAuthorization,
      () => new Date(),
      60_000,
      20_000,
      receipts,
    );
    const runService = new AppRunService(
      repository,
      secretRepository,
      secrets,
      keys,
      new PostgresAppRunAuthorizer(),
      () => new Date(),
      postgresAppRunApprovalAdapter,
      receipts,
      noOpAppRunAttentionProjector,
      attemptRunner,
      preparedInputs,
      liveAuthorization,
      () => true,
    );
    const approvalResolver = new PostgresAppRunApprovalResolver(
      repository,
      liveAuthorization,
      () => new Date(),
      receipts,
      noOpAppRunAttentionProjector,
      attemptRunner,
    );
    const actions = new AppActionService(
      capabilities,
      liveAuthorization,
      preparedInputs,
      { read: readModuleRecordScalarFields },
      { submitPreparedApp: (context, candidate) => runService.submitPreparedApp(context, candidate) },
    );
    const caller = { actor: owner };
    const actionInput = (idempotencyKey: string) => ({
      binding_id: binding.id,
      resource_ref: campaignRef,
      selections: [{ input_key: 'to', resource_ref: contactRef }],
      user_inputs: {},
      idempotency_key: idempotencyKey,
    });

    const firstInput = actionInput(`loop5-positive-${suffix}`);
    const firstPrepared = await actions.prepare(caller, firstInput);
    const serializedCandidate = JSON.stringify(firstPrepared.input_candidate);
    for (const sensitive of [recipient, subject, bodyText, firstInput.idempotency_key]) {
      assert.equal(serializedCandidate.includes(sensitive), false, 'sealed candidate exposed plaintext');
    }
    const firstPayload = preparedInputs.open(orgId, firstPrepared.input_candidate);
    const preparedApp = firstPayload.app_run;
    if (!preparedApp) throw new Error('Prepared App Run authority is missing');
    const vector = preparedApp.authority_vector;
    const rawSubmission: AppRunSubmission = {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      org_id: orgId,
      initiating_actor: initiatingActor,
      execution_actor: initiatingActor,
      origin: {
        origin_kind: 'app',
        installation_id: vector.installation.id,
        app_version_id: vector.app_version.id,
        binding_key: vector.binding.action_key,
        grant_snapshot_id: vector.grant.id,
      },
      operation: {
        provider: {
          org_id: orgId,
          provider_kind: 'mcp',
          provider_instance_id: vector.provider.connection_id,
        },
        operation_name: vector.provider.operation_name,
      },
      provider_snapshot_digest: vector.provider.snapshot_digest,
      policy: {
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'per_invocation',
        retry_class: 'idempotent_with_key',
      },
      retention_class: 'standard',
      idempotency_key: `raw-app-origin-${suffix}`,
      input: firstPayload.provider_input,
      authorization_snapshot: {
        ...vector.run_authorization,
        authority_refs: [
          ...vector.run_authorization.authority_refs,
          ...preparedApp.authority_refs,
        ],
      },
      safe_preview: preparedApp.safe_preview,
    };
    await assert.rejects(
      runService.submit({ org_id: orgId, initiating_actor: initiatingActor, execution_actor: initiatingActor }, rawSubmission),
      (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_ACCESS_DENIED',
    );

    const [firstRun, replayedRun] = await Promise.all([
      actions.invoke(caller, { ...firstInput, input_candidate: firstPrepared.input_candidate }),
      actions.invoke(caller, { ...firstInput, input_candidate: firstPrepared.input_candidate }),
    ]);
    assert.equal(firstRun.id, replayedRun.id, 'concurrent replay created more than one Run');
    assert.equal(firstRun.state, 'pending_approval');
    assert.equal(sandbox.callCount, 0, 'provider ran before approval');

    const secondInput = actionInput(`loop5-revoked-${suffix}`);
    const secondPrepared = await actions.prepare(caller, secondInput);
    const secondRun = await actions.invoke(caller, {
      ...secondInput,
      input_candidate: secondPrepared.input_candidate,
    });
    assert.equal(secondRun.state, 'pending_approval');

    const persistedRuns = await db.select().from(appRuns).where(eq(appRuns.org_id, orgId));
    assert.equal(persistedRuns.length, 2, 'each invocation identity must own exactly one Run');
    const persistedFirst = persistedRuns.find((run) => run.id === firstRun.id);
    assert.ok(persistedFirst);
    assert.equal(persistedFirst.origin_kind, 'app');
    assert.equal(persistedFirst.origin_app_installation_id, connected.id);
    assert.equal(persistedFirst.origin_app_version_id, connectedVersion.id);
    assert.equal(persistedFirst.origin_app_binding_key, binding.action_key);
    assert.equal(persistedFirst.origin_app_grant_snapshot_id, vector.grant.id);
    assert.equal(persistedFirst.provider_instance_id, connectionId);
    const recapturedBase = await liveAuthorization.capture({
      org_id: orgId,
      authenticated_subject: initiatingActor,
      execution_actor: initiatingActor,
      provider_instance_id: connectionId,
      provider_snapshot_id: vector.provider.snapshot_id,
      operation_name: vector.provider.operation_name,
      policy: rawSubmission.policy,
      required_token_scopes: [],
      token_authorities: [],
    });
    assert.deepEqual(
      recapturedBase.authority_refs,
      vector.run_authorization.authority_refs,
      'base Run authority changed before approval',
    );
    const preApprovalPrepared = await actions.prepare(caller, firstInput);
    assert.deepEqual(
      preApprovalPrepared.authority_vector,
      firstPrepared.authority_vector,
      'App authority vector changed before approval',
    );

    const approvals = await db.select().from(agentActions).where(and(
      eq(agentActions.org_id, orgId),
      eq(agentActions.source, 'app_run'),
    ));
    assert.equal(approvals.length, 2, 'each Run must receive one per-invocation approval');
    const firstApproval = approvals.find((approval) => approval.app_run_id === firstRun.id);
    const secondApproval = approvals.find((approval) => approval.app_run_id === secondRun.id);
    if (!firstApproval || !secondApproval) throw new Error('App Run approvals are missing');

    assert.equal((await approvalResolver.approve(firstApproval.id, ownerUserId)).status, 'approved');
    assert.equal((await approvalResolver.approve(secondApproval.id, ownerUserId)).status, 'approved');
    assert.equal(sandbox.callCount, 0, 'approval itself must not dispatch the provider');

    const attempts = await db.select().from(appRunAttempts).where(eq(appRunAttempts.org_id, orgId));
    const firstAttempt = attempts.find((attempt) => attempt.run_id === firstRun.id);
    const secondAttempt = attempts.find((attempt) => attempt.run_id === secondRun.id);
    if (!firstAttempt || !secondAttempt) throw new Error('Approved App Run attempts are missing');
    const dispatchPin = await repository.transaction(
      (tx) => repository.loadAppProviderDispatchPin(tx, orgId, firstRun.id),
    );
    assert.deepEqual(dispatchPin, {
      connector_authorization_version: vector.binding.connector_authorization_version,
      provider_snapshot_digest: vector.provider.snapshot_digest,
      operation_schema_digest: vector.provider.operation_schema_digest,
    });
    const workerResults = await Promise.all([
      attemptRunner.runImmediate(orgId, firstRun.id, firstAttempt.id, 'loop5-worker-a'),
      attemptRunner.runImmediate(orgId, firstRun.id, firstAttempt.id, 'loop5-worker-b'),
    ]);
    assert.equal(sandbox.callCount, 1, `concurrent workers produced an invalid effect count: ${JSON.stringify(
      workerResults.map((result) => ({ state: result.run.state, provider: result.provider_result })),
    )}`);
    assert.equal(pinnedRequests.length, 1);
    assert.equal(pinnedRequests[0]?.org_id, orgId);
    assert.equal(pinnedRequests[0]?.provider_instance_id, connectionId);
    assert.equal(pinnedRequests[0]?.operation_name, 'send_email');
    assert.deepEqual(pinnedRequests[0]?.dispatch_pin, dispatchPin);
    assert.equal(Object.hasOwn(pinnedRequests[0] ?? {}, 'connection_slug'), false);

    const firstReceipts = await db.select({
      kind: appRunReceipts.receipt_kind,
      run_id: appRunReceipts.run_id,
    }).from(appRunReceipts).where(and(
      eq(appRunReceipts.org_id, orgId),
      eq(appRunReceipts.run_id, firstRun.id),
    ));
    assert.deepEqual(
      new Set(firstReceipts.map((receipt) => receipt.kind)),
      new Set(['approval', 'attempt_terminal']),
    );
    assert.ok(firstReceipts.every((receipt) => receipt.run_id === firstRun.id));

    const retained = await runService.result(orgId, firstRun.id, initiatingActor);
    assert.equal(retained.run.state, 'succeeded');
    assert.equal((retained.value as { provider_succeeded?: boolean }).provider_succeeded, true);

    await db.update(mcpConnections).set({ is_active: false }).where(and(
      eq(mcpConnections.org_id, orgId),
      eq(mcpConnections.id, connectionId),
    ));
    await assert.rejects(
      runService.result(orgId, firstRun.id, initiatingActor),
      (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_AUTHORIZATION_STALE',
    );
    await attemptRunner.runImmediate(orgId, secondRun.id, secondAttempt.id, 'loop5-revoked-worker');
    assert.equal(sandbox.callCount, 1, 'revoked connector reached the provider');

    const [[runCount], [approvalCount]] = await Promise.all([
      db.select({ value: count() }).from(appRuns).where(eq(appRuns.org_id, orgId)),
      db.select({ value: count() }).from(agentActions).where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'app_run'),
      )),
    ]);
    assert.equal(runCount?.value, 2);
    assert.equal(approvalCount?.value, 2);
  } finally {
    keys.destroy();
  }
});
