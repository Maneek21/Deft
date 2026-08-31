import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, count, eq, sql } from 'drizzle-orm';
import { SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT } from '@deft/app-kit';
import {
  APP_RUN_CONTRACT_VERSIONS,
  CAPABILITY_CONTRACT_VERSIONS,
  RESOURCE_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
  type AppRunSafeView,
  type AppRunSubmission,
  type ModuleResourceRefV1,
} from '@deft/shared';
import {
  agentEmployees,
  agentActions,
  appActionBindings,
  appGrantSnapshots,
  appInstallations,
  appRunAttempts,
  appRunReceipts,
  appRunSecretPayloads,
  appRuns,
  appVersions,
  mcpConnections,
  mcpTokens,
  orgMembers,
  orgs,
  resourceRelationEdges,
  users,
} from '@deft/db/schema';
import { AppActionService, type AppActionCaller } from '../src/lib/app-action-service.js';
import { AppRunAttemptRunner } from '../src/lib/app-run-attempt-runner.js';
import { PostgresAppRunApprovalResolver, postgresAppRunApprovalAdapter } from '../src/lib/app-run-approval-adapter.js';
import { PostgresAppRunAuthorizer } from '../src/lib/app-run-authorization.js';
import { AppError } from '../src/lib/app-errors.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { PostgresAppRunLiveAuthorization } from '../src/lib/app-run-live-authorization.js';
import { AppRunPreparedInputService } from '../src/lib/app-run-prepared-input.js';
import { PinnedMcpAppRunProviderExecutor } from '../src/lib/app-run-provider-executor.js';
import { PostgresAppRunRepository, type AppRunTransaction } from '../src/lib/app-run-repository.js';
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
  deftyModuleActor,
  employeeModuleActor,
  getModuleInstallation,
  humanModuleActor,
  readModuleRecordScalarFields,
  updateModuleInstallation,
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

test('App actions create governed Runs once across every caller surface and fail closed on revocation', {
  skip: !canRun,
}, async () => {
  const suffix = randomUUID();
  const orgId = randomUUID();
  const ownerUserId = randomUUID();
  const employeeUserId = randomUUID();
  const employeeId = randomUUID();
  const mcpTokenId = randomUUID();
  const connectionId = randomUUID();
  const connectionSlug = `loop5-mail-${suffix}`;
  const recipient = `loop5-recipient-${suffix}@example.test`;
  const subject = `Loop 5 private subject ${suffix}`;
  const bodyText = `Loop 5 private body ${suffix}`;

  await db.insert(orgs).values({ id: orgId, name: 'Loop 5 App origin', slug: `loop5-${suffix}` });
  await db.insert(users).values([
    {
      id: ownerUserId,
      email: `loop5-owner-${suffix}@example.test`,
      name: 'Loop 5 owner',
    },
    {
      id: employeeUserId,
      email: `loop5-employee-${suffix}@example.test`,
      name: 'Loop 5 employee',
      kind: 'agent',
      is_agent: true,
      agent_employee_id: employeeId,
    },
  ]);
  await db.insert(orgMembers).values([
    {
      id: randomUUID(),
      org_id: orgId,
      user_id: ownerUserId,
      role: 'owner',
      is_active: true,
    },
    {
      id: randomUUID(),
      org_id: orgId,
      user_id: employeeUserId,
      role: 'member',
      is_active: true,
    },
  ]);
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
  let currentSnapshot = snapshot;
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
      return { provider_kind: 'mcp', tools: [tool], snapshot: currentSnapshot };
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

  let contacts = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-contacts' });
  let campaigns = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-campaigns' });
  contacts = await updateModuleInstallation(owner, contacts.slug, { agent_access: 'read' });
  campaigns = await updateModuleInstallation(owner, campaigns.slug, { agent_access: 'read' });
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
    data: { name: 'Connected campaign', subject, body: bodyText, status: 'draft' },
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

  await db.insert(agentEmployees).values({
    id: employeeId,
    org_id: orgId,
    user_id: employeeUserId,
    name: 'Loop 5 employee',
    slug: `loop5-employee-${suffix}`,
    role: 'custom',
    system_prompt: 'Test governed connected App execution.',
    mcp_connection_ids: [connectionId],
    trust_level: 'autonomous',
    max_daily_actions: 20,
    daily_action_count: 0,
    unhealthy: false,
    is_active: true,
    is_deleted: false,
    created_by: ownerUserId,
  });
  await db.insert(mcpTokens).values({
    id: mcpTokenId,
    org_id: orgId,
    user_id: ownerUserId,
    agent_employee_id: null,
    principal_kind: 'human',
    name: 'Loop 5 human MCP token',
    token_hash: `loop5-hash-${suffix}`,
    token_prefix: `loop5-${suffix.slice(0, 8)}`,
    scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
    created_by: ownerUserId,
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
      {
        inspect: (readOrgId, runId, actor) => runService.inspect(readOrgId, runId, actor),
        result: (readOrgId, runId, actor) => runService.result(readOrgId, runId, actor),
      },
    );
    const callers: ReadonlyArray<Readonly<{
      name: 'ui' | 'defty' | 'employee' | 'human_mcp';
      caller: AppActionCaller;
    }>> = [
      { name: 'ui', caller: { actor: owner } },
      {
        name: 'defty',
        caller: {
          actor: deftyModuleActor({ orgId, userId: ownerUserId, role: 'owner' }),
        },
      },
      {
        name: 'employee',
        caller: {
          actor: employeeModuleActor({
            orgId,
            employeeId,
            trustLevel: 'autonomous',
            source: 'runtime',
          }),
        },
      },
      {
        name: 'human_mcp',
        caller: {
          actor: humanModuleActor({
            orgId,
            userId: ownerUserId,
            role: 'owner',
            source: 'mcp',
            scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
          }),
          token_authorities: [{ token_kind: 'mcp', token_id: mcpTokenId }],
        },
      },
    ];
    const actionInput = (idempotencyKey: string) => ({
      binding_id: binding.id,
      resource_ref: campaignRef,
      selections: [{ input_key: 'to', resource_ref: contactRef }],
      user_inputs: {},
      idempotency_key: idempotencyKey,
    });

    const sharedInput = actionInput(`loop7-shared-principal-${suffix}`);
    const sharedPrepared = new Map<string, Awaited<ReturnType<AppActionService['prepare']>>>();
    for (const surface of callers) {
      const prepared = await actions.prepare(surface.caller, sharedInput);
      assert.equal(prepared.action.binding_id, binding.id);
      assert.equal(prepared.authority_vector.binding.id, binding.id);
      assert.equal(prepared.authority_vector.provider.connection_id, connectionId);
      sharedPrepared.set(surface.name, prepared);
    }
    const uiShared = sharedPrepared.get('ui');
    const deftyShared = sharedPrepared.get('defty');
    const employeeShared = sharedPrepared.get('employee');
    const humanMcpShared = sharedPrepared.get('human_mcp');
    if (!uiShared || !deftyShared || !employeeShared || !humanMcpShared) {
      throw new Error('A caller surface did not prepare the shared App action');
    }
    assert.equal(
      new Set([uiShared, deftyShared, employeeShared, humanMcpShared]
        .map((prepared) => prepared.replay_identity)).size,
      callers.length,
      'caller surfaces and token authority must own distinct replay identities',
    );
    assert.deepEqual(
      callers.map((surface) => sharedPrepared.get(surface.name)?.safe_preview),
      callers.map(() => uiShared.safe_preview),
    );

    const firstInput = sharedInput;
    const firstPrepared = uiShared;
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

    const surfaceRuns: Array<Readonly<{
      surface: typeof callers[number];
      run: AppRunSafeView;
    }>> = [];
    for (const surface of callers) {
      const prepared = sharedPrepared.get(surface.name);
      if (!prepared) throw new Error(`${surface.name} shared preparation is missing`);
      const [run, replayed] = await Promise.all([
        actions.invoke(surface.caller, { ...sharedInput, input_candidate: prepared.input_candidate }),
        actions.invoke(surface.caller, { ...sharedInput, input_candidate: prepared.input_candidate }),
      ]);
      assert.equal(run.id, replayed.id, `${surface.name} concurrent replay created more than one Run`);
      assert.equal(run.state, 'pending_approval');
      surfaceRuns.push({ surface, run });
    }
    const surfaceRun = (name: typeof callers[number]['name']) => {
      const found = surfaceRuns.find((item) => item.surface.name === name);
      if (!found) throw new Error(`${name} App Run is missing`);
      return found;
    };
    const uiRun = surfaceRun('ui');
    const deftyRun = surfaceRun('defty');
    const employeeRun = surfaceRun('employee');
    const humanMcpRun = surfaceRun('human_mcp');
    const distinctPositiveRuns = [uiRun, deftyRun, employeeRun, humanMcpRun] as const;
    assert.equal(
      new Set(distinctPositiveRuns.map((positive) => positive.run.id)).size,
      callers.length,
      'caller surfaces and token authority must own distinct Runs',
    );
    assert.equal(sandbox.callCount, 0, 'provider ran before approval');

    const persistedRuns = await db.select().from(appRuns).where(eq(appRuns.org_id, orgId));
    assert.equal(persistedRuns.length, distinctPositiveRuns.length, 'each caller authority must own one semantic Run');
    for (const positive of surfaceRuns) {
      const persisted = persistedRuns.find((run) => run.id === positive.run.id);
      assert.ok(persisted);
      assert.equal(persisted.origin_kind, 'app');
      assert.equal(persisted.origin_app_installation_id, connected.id);
      assert.equal(persisted.origin_app_version_id, connectedVersion.id);
      assert.equal(persisted.origin_app_binding_key, binding.action_key);
      assert.equal(persisted.origin_app_grant_snapshot_id, vector.grant.id);
      assert.equal(persisted.provider_instance_id, connectionId);
      if (positive.surface.name === 'employee') {
        assert.equal(persisted.initiating_actor_type, 'agent_employee');
        assert.equal(persisted.initiating_actor_id, employeeId);
        assert.equal(persisted.execution_actor_type, 'agent_employee');
        assert.equal(persisted.execution_actor_id, employeeId);
      } else {
        assert.equal(persisted.initiating_actor_type, 'human');
        assert.equal(persisted.initiating_actor_id, ownerUserId);
        assert.equal(persisted.execution_actor_type, 'human');
        assert.equal(persisted.execution_actor_id, ownerUserId);
      }
    }
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
    const preApprovalPrepared = await actions.prepare(callers[0]!.caller, firstInput);
    assert.deepEqual(
      preApprovalPrepared.authority_vector,
      firstPrepared.authority_vector,
      'App authority vector changed before approval',
    );

    let approvals = await db.select().from(agentActions).where(and(
      eq(agentActions.org_id, orgId),
      eq(agentActions.source, 'app_run'),
    ));
    assert.equal(approvals.length, distinctPositiveRuns.length, 'each Run must receive one per-invocation approval');
    for (const positive of distinctPositiveRuns) {
      const approval = approvals.find((item) => item.app_run_id === positive.run.id);
      if (!approval) throw new Error(`${positive.surface.name} App Run approval is missing`);
      assert.equal((await approvalResolver.approve(approval.id, ownerUserId)).status, 'approved');
    }
    assert.equal(sandbox.callCount, 0, 'approval itself must not dispatch the provider');

    let attempts = await db.select().from(appRunAttempts).where(eq(appRunAttempts.org_id, orgId));
    const dispatchPin = await repository.transaction(
      (tx) => repository.loadAppProviderDispatchPin(tx, orgId, uiRun.run.id),
    );
    assert.deepEqual(dispatchPin, {
      connector_authorization_version: vector.binding.connector_authorization_version,
      provider_snapshot_digest: vector.provider.snapshot_digest,
      operation_schema_digest: vector.provider.operation_schema_digest,
    });
    for (const positive of distinctPositiveRuns) {
      const attempt = attempts.find((item) => item.run_id === positive.run.id);
      if (!attempt) throw new Error(`${positive.surface.name} approved App Run attempt is missing`);
      const effectsBefore = sandbox.callCount;
      const workerResults = await Promise.all([
        attemptRunner.runImmediate(orgId, positive.run.id, attempt.id, `loop7-${positive.surface.name}-worker-a`),
        attemptRunner.runImmediate(orgId, positive.run.id, attempt.id, `loop7-${positive.surface.name}-worker-b`),
      ]);
      assert.equal(
        sandbox.callCount,
        effectsBefore + 1,
        `${positive.surface.name} concurrent workers produced an invalid effect count: ${JSON.stringify(
          workerResults.map((result) => ({ state: result.run.state, provider: result.provider_result })),
        )}`,
      );

      const runReceipts = await db.select({
        kind: appRunReceipts.receipt_kind,
        run_id: appRunReceipts.run_id,
      }).from(appRunReceipts).where(and(
        eq(appRunReceipts.org_id, orgId),
        eq(appRunReceipts.run_id, positive.run.id),
      ));
      assert.deepEqual(
        new Set(runReceipts.map((receipt) => receipt.kind)),
        new Set(['approval', 'attempt_terminal']),
      );
      assert.ok(runReceipts.every((receipt) => receipt.run_id === positive.run.id));

    }
    for (const positive of surfaceRuns) {
      const retained = await actions.result(positive.surface.caller, positive.run.id);
      assert.equal(retained.run.state, 'succeeded');
      assert.equal((retained.value as { provider_succeeded?: boolean }).provider_succeeded, true);
    }
    assert.equal(sandbox.callCount, distinctPositiveRuns.length, 'each caller-authority Run must produce one provider effect');
    assert.equal(pinnedRequests.length, distinctPositiveRuns.length);
    for (const request of pinnedRequests) {
      assert.equal(request.org_id, orgId);
      assert.equal(request.provider_instance_id, connectionId);
      assert.equal(request.operation_name, 'send_email');
      assert.deepEqual(request.dispatch_pin, dispatchPin);
      assert.equal(Object.hasOwn(request, 'connection_slug'), false);
    }

    const pendingRun = async (surface: typeof callers[number], label: string): Promise<AppRunSafeView> => {
      const input = actionInput(`loop7-stale-${label}-${suffix}`);
      const prepared = await actions.prepare(surface.caller, input);
      const run = await actions.invoke(surface.caller, {
        ...input,
        input_candidate: prepared.input_candidate,
      });
      assert.equal(run.state, 'pending_approval');
      return run;
    };
    const uiStaleRun = await pendingRun(callers[0]!, 'ui');
    const employeeStaleRun = await pendingRun(callers[2]!, 'employee');
    const tokenStaleRun = await pendingRun(callers[3]!, 'token');
    const connectorRun = await pendingRun(callers[0]!, 'connector');

    class ExpectedProbeRollback extends Error {}
    const expectTransactionalStale = async (
      label: string,
      run: AppRunSafeView,
      mutate: (tx: AppRunTransaction) => Promise<unknown>,
    ): Promise<void> => {
      await assert.rejects(
        db.transaction(async (tx) => {
          await mutate(tx);
          assert.equal(
            await liveAuthorization.authorizeApprovalInTransaction(tx, run),
            false,
            `${label} unexpectedly retained App-origin authority`,
          );
          throw new ExpectedProbeRollback(label);
        }),
        (error: unknown) => error instanceof ExpectedProbeRollback && error.message === label,
      );
    };

    const [relationEdge] = await db.select().from(resourceRelationEdges).where(and(
      eq(resourceRelationEdges.org_id, orgId),
      eq(resourceRelationEdges.target_provider_instance_id, contacts.id),
      eq(resourceRelationEdges.target_resource_id, contact.record.id),
      eq(resourceRelationEdges.is_deleted, false),
    ));
    if (!relationEdge) throw new Error('The connected proof relation edge is missing');

    const providerSchemaInput = actionInput(`loop7-stale-provider-schema-${suffix}`);
    const providerSchemaPrepared = await actions.prepare(callers[0]!.caller, providerSchemaInput);
    const driftedSnapshot = await createCapabilityProviderDiscoverySnapshot({
      adapter_contract_version: snapshot.adapter_contract_version,
      provider: snapshot.provider,
      captured_at: '2026-08-31T12:05:00.000Z',
      operations: [{
        identity: snapshot.operations[0]!.identity,
        title: snapshot.operations[0]!.title,
        description: 'A drifted sandbox email contract.',
        input_schema: {
          ...SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
          properties: {
            ...SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema.properties,
            drift_marker: { type: 'string' },
          },
        },
        output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
      }],
    });

    const staleCases: ReadonlyArray<Readonly<{ label: string; probe: () => Promise<void> }>> = [
      {
        label: 'App state',
        probe: () => expectTransactionalStale('App state', uiStaleRun, (tx) => tx.update(appInstallations).set({
          state: 'disabled',
          disabled_at: new Date(),
          active_grant_snapshot_id: null,
          active_grant_snapshot_kind: null,
          lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`,
          grant_epoch: sql`${appInstallations.grant_epoch} + 1`,
        }).where(and(eq(appInstallations.org_id, orgId), eq(appInstallations.id, connected.id)))),
      },
      {
        label: 'dependency',
        probe: () => expectTransactionalStale('dependency', uiStaleRun, (tx) => tx.update(appInstallations).set({
          state: 'disabled',
          disabled_at: new Date(),
          lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`,
        }).where(and(eq(appInstallations.org_id, orgId), eq(appInstallations.id, dependency.id)))),
      },
      {
        label: 'grant',
        probe: () => expectTransactionalStale('grant', uiStaleRun, (tx) => tx.update(appInstallations).set({
          active_grant_snapshot_id: null,
          active_grant_snapshot_kind: null,
          grant_epoch: sql`${appInstallations.grant_epoch} + 1`,
        }).where(and(eq(appInstallations.org_id, orgId), eq(appInstallations.id, connected.id)))),
      },
      {
        label: 'version',
        probe: () => expectTransactionalStale('version', uiStaleRun, (tx) => tx.update(appVersions).set({
          state: 'superseded',
          superseded_at: new Date(),
        }).where(and(eq(appVersions.org_id, orgId), eq(appVersions.id, connectedVersion.id)))),
      },
      {
        label: 'relation',
        probe: () => expectTransactionalStale('relation', uiStaleRun, (tx) => tx.update(resourceRelationEdges).set({
          is_deleted: true,
          deleted_at: new Date(),
        }).where(and(eq(resourceRelationEdges.org_id, orgId), eq(resourceRelationEdges.id, relationEdge.id)))),
      },
      {
        label: 'provider schema',
        probe: async () => {
          currentSnapshot = driftedSnapshot;
          try {
            await assert.rejects(
              actions.invoke(callers[0]!.caller, {
                ...providerSchemaInput,
                input_candidate: providerSchemaPrepared.input_candidate,
              }),
              (error: unknown) => error instanceof AppError && error.code === 'APP_PROVIDER_UNAVAILABLE',
            );
          } finally {
            currentSnapshot = snapshot;
          }
        },
      },
      {
        label: 'employee assignment',
        probe: () => expectTransactionalStale('employee assignment', employeeStaleRun, (tx) => tx.update(agentEmployees).set({
          mcp_connection_ids: [],
        }).where(and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.id, employeeId)))),
      },
      {
        label: 'employee health',
        probe: () => expectTransactionalStale('employee health', employeeStaleRun, (tx) => tx.update(agentEmployees).set({
          unhealthy: true,
        }).where(and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.id, employeeId)))),
      },
      {
        label: 'employee budget',
        probe: () => expectTransactionalStale('employee budget', employeeStaleRun, (tx) => tx.update(agentEmployees).set({
          daily_action_count: sql`${agentEmployees.max_daily_actions}`,
        }).where(and(eq(agentEmployees.org_id, orgId), eq(agentEmployees.id, employeeId)))),
      },
      {
        label: 'token scope',
        probe: () => expectTransactionalStale('token scope', tokenStaleRun, (tx) => tx.update(mcpTokens).set({
          scopes: ['read:modules', 'read:apps'],
        }).where(and(eq(mcpTokens.org_id, orgId), eq(mcpTokens.id, mcpTokenId)))),
      },
      {
        label: 'membership',
        probe: () => expectTransactionalStale('membership', uiStaleRun, (tx) => tx.update(orgMembers).set({
          is_active: false,
        }).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerUserId)))),
      },
    ];
    for (const staleCase of staleCases) await staleCase.probe();

    approvals = await db.select().from(agentActions).where(and(
      eq(agentActions.org_id, orgId),
      eq(agentActions.source, 'app_run'),
    ));
    const connectorApproval = approvals.find((approval) => approval.app_run_id === connectorRun.id);
    if (!connectorApproval) throw new Error('Connector revocation App Run approval is missing');
    assert.equal((await approvalResolver.approve(connectorApproval.id, ownerUserId)).status, 'approved');
    attempts = await db.select().from(appRunAttempts).where(eq(appRunAttempts.org_id, orgId));
    const connectorAttempt = attempts.find((attempt) => attempt.run_id === connectorRun.id);
    if (!connectorAttempt) throw new Error('Connector revocation App Run attempt is missing');

    await db.update(mcpConnections).set({ is_active: false }).where(and(
      eq(mcpConnections.org_id, orgId),
      eq(mcpConnections.id, connectionId),
    ));
    await assert.rejects(
      actions.result(callers[0]!.caller, uiRun.run.id),
      (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_AUTHORIZATION_STALE',
    );
    await attemptRunner.runImmediate(orgId, connectorRun.id, connectorAttempt.id, 'loop7-revoked-worker');
    assert.equal(sandbox.callCount, distinctPositiveRuns.length, 'revoked connector reached the provider');

    const [[runCount], [approvalCount]] = await Promise.all([
      db.select({ value: count() }).from(appRuns).where(eq(appRuns.org_id, orgId)),
      db.select({ value: count() }).from(agentActions).where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'app_run'),
      )),
    ]);
    assert.equal(runCount?.value, distinctPositiveRuns.length + 4);
    assert.equal(approvalCount?.value, distinctPositiveRuns.length + 4);
  } finally {
    keys.destroy();
  }
});
