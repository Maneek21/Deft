import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
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
  appRunEvents,
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
import {
  MCP_APP_RUN_RESULT_VERSION,
  PinnedMcpAppRunProviderExecutor,
} from '../src/lib/app-run-provider-executor.js';
import { PostgresAppRunRepository, type AppRunTransaction } from '../src/lib/app-run-repository.js';
import { AppRunSecretRepository } from '../src/lib/app-run-secret-repository.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { AppRunService } from '../src/lib/app-run-service.js';
import { noOpAppRunAttentionProjector } from '../src/lib/app-run-attention.js';
import {
  PostgresAppRunReceiptReader,
  PostgresAppRunReceiptWriter,
} from '../src/lib/app-run-receipts.js';
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
  const secondMcpTokenId = randomUUID();
  const otherUserId = randomUUID();
  const otherMcpTokenId = randomUUID();
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
    {
      id: otherUserId,
      email: `loop5-other-${suffix}@example.test`,
      name: 'Loop 5 other member',
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
    {
      id: randomUUID(),
      org_id: orgId,
      user_id: otherUserId,
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
  const forcedPinnedResults: McpPinnedExecutionResult[] = [];
  let pinnedBlock: Readonly<{
    entered: () => void;
    wait: Promise<void>;
  }> | null = null;
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
      const block = pinnedBlock;
      if (block) {
        pinnedBlock = null;
        block.entered();
        await block.wait;
      }
      const forced = forcedPinnedResults.shift();
      if (forced) return forced;
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
  await db.insert(mcpTokens).values([
    {
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
    },
    {
      id: secondMcpTokenId,
      org_id: orgId,
      user_id: ownerUserId,
      agent_employee_id: null,
      principal_kind: 'human',
      name: 'Loop 5 second same-actor MCP token',
      token_hash: `loop5-second-hash-${suffix}`,
      token_prefix: `loop5-second-${suffix.slice(0, 8)}`,
      scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
      created_by: ownerUserId,
    },
    {
      id: otherMcpTokenId,
      org_id: orgId,
      user_id: otherUserId,
      agent_employee_id: null,
      principal_kind: 'human',
      name: 'Loop 5 other-actor MCP token',
      token_hash: `loop5-other-hash-${suffix}`,
      token_prefix: `loop5-other-${suffix.slice(0, 8)}`,
      scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
      created_by: ownerUserId,
    },
  ]);

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
    const receiptReader = new PostgresAppRunReceiptReader(secrets);
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
        inspect: (readOrgId, runId, actor, requiredAuthorityRef) => (
          runService.inspect(readOrgId, runId, actor, requiredAuthorityRef)
        ),
        result: (readOrgId, runId, actor, requiredAuthorityRef) => (
          runService.result(readOrgId, runId, actor, requiredAuthorityRef)
        ),
      },
      receiptReader,
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
    const successfulRunIds = distinctPositiveRuns.map((positive) => positive.run.id);
    const successfulEvents = await db.select({
      run_id: appRunEvents.run_id,
      sequence: appRunEvents.sequence,
      event_type: appRunEvents.event_type,
      payload: appRunEvents.payload,
    }).from(appRunEvents).where(and(
      eq(appRunEvents.org_id, orgId),
      inArray(appRunEvents.run_id, successfulRunIds),
    )).orderBy(asc(appRunEvents.run_id), asc(appRunEvents.sequence));
    const successParity: unknown[] = [];
    for (const positive of surfaceRuns) {
      const retained = await actions.result(positive.surface.caller, positive.run.id);
      assert.equal(retained.run.state, 'succeeded');
      const result = retained.value as Readonly<{
        schema_version?: string;
        provider_succeeded?: boolean;
        output?: Readonly<{
          schema_version?: string;
          legacy_output?: Readonly<{ status?: string }>;
        }>;
      }>;
      assert.equal(result.provider_succeeded, true);
      const receiptBundle = await actions.inspectReceipts(positive.surface.caller, positive.run.id);
      const persisted = persistedRuns.find((run) => run.id === positive.run.id);
      if (!persisted) throw new Error(`${positive.surface.name} persisted Run is missing`);
      const normalizedEvents = successfulEvents
        .filter((event) => event.run_id === positive.run.id)
        .map((event) => {
          const payload = event.payload as Record<string, unknown>;
          return {
            event_type: event.event_type,
            ...(typeof payload.from_state === 'string' ? { from_state: payload.from_state } : {}),
            ...(typeof payload.to_state === 'string' ? { to_state: payload.to_state } : {}),
          };
        });
      successParity.push({
        binding: {
          origin_kind: persisted.origin_kind,
          binding_key: persisted.origin_app_binding_key,
          operation_name: retained.run.operation_name,
        },
        policy: {
          risk_class: retained.run.risk_class,
          review_requirement: retained.run.review_requirement,
          review_scope: retained.run.review_scope,
          retry_class: retained.run.retry_class,
          retention_class: retained.run.retention_class,
        },
        state: retained.run.state,
        safe_preview: retained.run.safe_preview,
        safe_outcome: retained.run.safe_outcome,
        result: {
          schema_version: result.schema_version,
          provider_succeeded: result.provider_succeeded,
          output_schema_version: result.output?.schema_version,
          legacy_status: result.output?.legacy_output?.status,
        },
        transitions: normalizedEvents,
        receipts: receiptBundle.receipts.map((receipt) => ({
          receipt_kind: receipt.receipt_kind,
          run_state: receipt.run_state,
          verified: receipt.verified,
        })),
      });
    }
    const successBaseline = successParity[0];
    assert.ok(successBaseline);
    assert.ok((successBaseline as { transitions: Array<{ to_state?: string }> }).transitions
      .some((event) => event.to_state === 'succeeded'));
    for (const normalized of successParity.slice(1)) assert.deepEqual(normalized, successBaseline);
    assert.equal(
      (await actions.inspectRun(humanMcpRun.surface.caller, humanMcpRun.run.id)).id,
      humanMcpRun.run.id,
      'the original live token must inspect its Run',
    );
    assert.equal(
      (await actions.inspectReceipts(humanMcpRun.surface.caller, humanMcpRun.run.id)).receipts.length,
      2,
      'the original live token must inspect verified receipts',
    );

    const alternateTokenCallers: ReadonlyArray<Readonly<{
      label: string;
      caller: AppActionCaller;
    }>> = [
      {
        label: 'second token for the same actor',
        caller: {
          actor: humanModuleActor({
            orgId,
            userId: ownerUserId,
            role: 'owner',
            source: 'mcp',
            scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
          }),
          token_authorities: [{ token_kind: 'mcp', token_id: secondMcpTokenId }],
        },
      },
      {
        label: 'different actor and token',
        caller: {
          actor: humanModuleActor({
            orgId,
            userId: otherUserId,
            role: 'member',
            source: 'mcp',
            scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
          }),
          token_authorities: [{ token_kind: 'mcp', token_id: otherMcpTokenId }],
        },
      },
    ];
    for (const alternate of alternateTokenCallers) {
      for (const read of [
        () => actions.inspectRun(alternate.caller, humanMcpRun.run.id),
        () => actions.result(alternate.caller, humanMcpRun.run.id),
        () => actions.inspectReceipts(alternate.caller, humanMcpRun.run.id),
      ]) {
        await assert.rejects(
          read,
          (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_ACCESS_DENIED',
          `${alternate.label} read another token's Run`,
        );
      }
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

    const approvedRun = async (label: string) => {
      const input = actionInput(`loop7-${label}-${suffix}`);
      const prepared = await actions.prepare(callers[0]!.caller, input);
      const run = await actions.invoke(callers[0]!.caller, {
        ...input,
        input_candidate: prepared.input_candidate,
      });
      const [approval] = await db.select().from(agentActions).where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'app_run'),
        eq(agentActions.app_run_id, run.id),
      ));
      if (!approval) throw new Error(`${label} App-origin approval is missing`);
      assert.equal((await approvalResolver.approve(approval.id, ownerUserId)).status, 'approved');
      const [attempt] = await db.select().from(appRunAttempts).where(and(
        eq(appRunAttempts.org_id, orgId),
        eq(appRunAttempts.run_id, run.id),
        eq(appRunAttempts.attempt_number, 1),
      ));
      if (!attempt) throw new Error(`${label} App-origin attempt is missing`);
      return { run, attempt };
    };
    const verifiedReceiptKinds = async (runId: string) => {
      const bundle = await actions.inspectReceipts(callers[0]!.caller, runId);
      assert.equal(bundle.receipts.every((receipt) => receipt.verified), true);
      return bundle.receipts.map((receipt) => receipt.receipt_kind).sort();
    };

    const retryCase = await approvedRun('indeterminate-retry');

    const retryRequestStart = pinnedRequests.length;
    forcedPinnedResults.push({ status: 'indeterminate' });
    const ambiguous = await attemptRunner.runImmediate(
      orgId,
      retryCase.run.id,
      retryCase.attempt.id,
      'loop7-indeterminate-worker',
    );
    assert.equal(ambiguous.run.state, 'running');
    assert.deepEqual(ambiguous.provider_result, { status: 'indeterminate' });
    const retryAttempts = await db.select().from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.run_id, retryCase.run.id),
    )).orderBy(asc(appRunAttempts.attempt_number));
    assert.equal(retryAttempts.length, 2);
    assert.equal(retryAttempts[0]?.state, 'unknown_outcome');
    assert.equal(retryAttempts[1]?.state, 'pending');
    assert.equal(retryAttempts[1]?.retry_of_attempt_id, retryAttempts[0]?.id);

    const recovered = await attemptRunner.runImmediate(
      orgId,
      retryCase.run.id,
      retryAttempts[1]!.id,
      'loop7-retry-worker',
    );
    assert.equal(recovered.run.state, 'succeeded');
    const retryRequests = pinnedRequests.slice(retryRequestStart);
    assert.equal(retryRequests.length, 2);
    assert.equal(
      retryRequests[0]?.input.idempotency_key,
      retryRequests[1]?.input.idempotency_key,
      'App-origin ambiguity retry must preserve the provider idempotency key',
    );
    assert.equal(typeof retryRequests[0]?.input.idempotency_key, 'string');
    const retryResult = await actions.result(callers[0]!.caller, retryCase.run.id);
    assert.equal(retryResult.run.state, 'succeeded');
    assert.equal((retryResult.value as { provider_succeeded?: boolean }).provider_succeeded, true);
    const retryReceiptBundle = await actions.inspectReceipts(callers[0]!.caller, retryCase.run.id);
    assert.deepEqual(
      retryReceiptBundle.receipts.map((receipt) => receipt.receipt_kind),
      ['approval', 'attempt_terminal', 'attempt_terminal'],
    );
    assert.equal(retryReceiptBundle.receipts.every((receipt) => receipt.verified), true);
    assert.equal(
      (retryResult.value as { output?: { schema_version?: string } }).output?.schema_version,
      MCP_APP_RUN_RESULT_VERSION,
    );
    assert.equal(sandbox.callCount, distinctPositiveRuns.length + 1);

    const failureCase = await approvedRun('provider-declared-failure');
    const failureEffectsBefore = sandbox.callCount;
    forcedPinnedResults.push({
      status: 'returned',
      provider_succeeded: false,
      output: { code: 'recipient_rejected' },
      error: 'recipient rejected',
      duration_ms: 1,
    });
    const providerFailure = await attemptRunner.runImmediate(
      orgId,
      failureCase.run.id,
      failureCase.attempt.id,
      'loop7-provider-failure-worker',
    );
    assert.equal(providerFailure.run.state, 'failed');
    assert.deepEqual(providerFailure.run.safe_outcome, {
      success: false,
      provider_call_attempted: true,
      result_status: 'retained',
      error_code: 'APP_RUN_PROVIDER_ERROR',
    });
    assert.equal(sandbox.callCount, failureEffectsBefore);
    const failureResult = await actions.result(callers[0]!.caller, failureCase.run.id);
    assert.equal(
      (failureResult.value as { provider_succeeded?: boolean }).provider_succeeded,
      false,
    );
    assert.deepEqual(
      await verifiedReceiptKinds(failureCase.run.id),
      ['approval', 'attempt_terminal'],
    );

    const timeoutCase = await approvedRun('pre-aborted-timeout');
    const timeoutRequestsBefore = pinnedRequests.length;
    const timeoutController = new AbortController();
    timeoutController.abort();
    const timedOut = await attemptRunner.runImmediate(
      orgId,
      timeoutCase.run.id,
      timeoutCase.attempt.id,
      'loop7-timeout-worker',
      timeoutController.signal,
    );
    assert.equal(timedOut.run.state, 'failed');
    assert.deepEqual(timedOut.provider_result, {
      status: 'not_attempted',
      error_code: 'APP_RUN_PROVIDER_TIMEOUT',
    });
    assert.deepEqual(timedOut.run.safe_outcome, {
      success: false,
      provider_call_attempted: false,
      result_status: 'unavailable',
      error_code: 'APP_RUN_PROVIDER_TIMEOUT',
    });
    assert.equal(pinnedRequests.length, timeoutRequestsBefore);
    await assert.rejects(
      actions.result(callers[0]!.caller, timeoutCase.run.id),
      (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_RESULT_EXPIRED',
    );
    assert.deepEqual(
      await verifiedReceiptKinds(timeoutCase.run.id),
      ['approval', 'attempt_terminal'],
    );

    const claimedCase = await approvedRun('stale-claimed-recovery');
    const claimedAt = new Date(Date.now() - 2_000);
    const [staleClaim] = await db.update(appRunAttempts).set({
      state: 'claimed',
      claim_owner: 'loop7-stale-claimed-worker',
      claim_token: randomUUID(),
      claimed_at: claimedAt,
      lease_expires_at: new Date(claimedAt.getTime() + 1_000),
      updated_at: claimedAt,
    }).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.id, claimedCase.attempt.id),
    )).returning();
    assert.ok(staleClaim);
    const claimedRequestsBefore = pinnedRequests.length;
    const claimedEffectsBefore = sandbox.callCount;
    assert.equal(await attemptRunner.recoverRun(orgId, claimedCase.run.id), 1);
    const claimedAttempts = await db.select().from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.run_id, claimedCase.run.id),
    )).orderBy(asc(appRunAttempts.attempt_number));
    assert.equal(claimedAttempts.length, 2);
    assert.equal(claimedAttempts[0]?.state, 'failed');
    assert.equal(claimedAttempts[0]?.error_code, 'APP_RUN_PROVIDER_UNAVAILABLE');
    assert.equal(claimedAttempts[1]?.retry_of_attempt_id, claimedAttempts[0]?.id);
    assert.equal(pinnedRequests.length, claimedRequestsBefore);
    assert.equal((await attemptRunner.runImmediate(
      orgId,
      claimedCase.run.id,
      claimedAttempts[1]!.id,
      'loop7-stale-claimed-retry-worker',
    )).run.state, 'succeeded');
    assert.equal(pinnedRequests.length, claimedRequestsBefore + 1);
    assert.equal(sandbox.callCount, claimedEffectsBefore + 1);
    assert.deepEqual(
      await verifiedReceiptKinds(claimedCase.run.id),
      ['approval', 'attempt_terminal', 'attempt_terminal'],
    );

    const startedCase = await approvedRun('stale-provider-call-started-recovery');
    let releasePinned!: () => void;
    const pinnedWait = new Promise<void>((resolve) => { releasePinned = resolve; });
    let markPinnedEntered!: () => void;
    const pinnedEntered = new Promise<void>((resolve) => { markPinnedEntered = resolve; });
    pinnedBlock = { entered: markPinnedEntered, wait: pinnedWait };
    let recoveryNow = new Date();
    const recoveryRunner = new AppRunAttemptRunner(
      repository,
      secretRepository,
      secrets,
      pinnedExecutor,
      liveAuthorization,
      () => recoveryNow,
      1_000,
      60_000,
      receipts,
    );
    const startedRequestsBefore = pinnedRequests.length;
    const startedEffectsBefore = sandbox.callCount;
    const lateProvider = recoveryRunner.runImmediate(
      orgId,
      startedCase.run.id,
      startedCase.attempt.id,
      'loop7-stale-provider-call-worker',
    );
    await pinnedEntered;
    recoveryNow = new Date(recoveryNow.getTime() + 2_000);
    let startedRecoveryCount = 0;
    try {
      startedRecoveryCount = await recoveryRunner.recoverRun(orgId, startedCase.run.id);
    } finally {
      releasePinned();
    }
    await lateProvider;
    assert.equal(startedRecoveryCount, 1);
    const startedAttempts = await db.select().from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.run_id, startedCase.run.id),
    )).orderBy(asc(appRunAttempts.attempt_number));
    assert.equal(startedAttempts.length, 2);
    assert.equal(startedAttempts[0]?.state, 'unknown_outcome');
    assert.equal(startedAttempts[1]?.retry_of_attempt_id, startedAttempts[0]?.id);
    assert.equal((await recoveryRunner.runImmediate(
      orgId,
      startedCase.run.id,
      startedAttempts[1]!.id,
      'loop7-provider-call-retry-worker',
    )).run.state, 'succeeded');
    const startedRequests = pinnedRequests.slice(startedRequestsBefore);
    assert.equal(startedRequests.length, 2);
    assert.equal(
      startedRequests[0]?.input.idempotency_key,
      startedRequests[1]?.input.idempotency_key,
    );
    assert.equal(typeof startedRequests[0]?.input.idempotency_key, 'string');
    assert.equal(sandbox.callCount, startedEffectsBefore + 1);
    assert.deepEqual(
      await verifiedReceiptKinds(startedCase.run.id),
      ['approval', 'attempt_terminal', 'attempt_terminal'],
    );

    const repairCase = await approvedRun('post-result-finalization-repair');
    const repairRequestsBefore = pinnedRequests.length;
    const repairEffectsBefore = sandbox.callCount;
    const originalTransition = repository.transition.bind(repository);
    let injectFinalizationFailure = true;
    repository.transition = async (tx, input) => {
      if (
        injectFinalizationFailure
        && input.run.id === repairCase.run.id
        && input.state === 'succeeded'
      ) {
        injectFinalizationFailure = false;
        throw new Error('injected App-origin finalization failure');
      }
      return originalTransition(tx, input);
    };
    try {
      await assert.rejects(
        attemptRunner.runImmediate(
          orgId,
          repairCase.run.id,
          repairCase.attempt.id,
          'loop7-finalization-failure-worker',
        ),
        /injected App-origin finalization failure/,
      );
    } finally {
      repository.transition = originalTransition;
    }
    const [knownResultAttempt] = await db.select().from(appRunAttempts).where(and(
      eq(appRunAttempts.org_id, orgId),
      eq(appRunAttempts.id, repairCase.attempt.id),
    ));
    assert.equal(knownResultAttempt?.state, 'provider_call_started');
    assert.ok(knownResultAttempt?.provider_call_finished_at);
    assert.ok(knownResultAttempt?.safe_outcome);
    const repairNow = new Date(Date.now() + 2 * 60_000);
    const repairRunner = new AppRunAttemptRunner(
      repository,
      secretRepository,
      secrets,
      pinnedExecutor,
      liveAuthorization,
      () => repairNow,
      60_000,
      20_000,
      receipts,
    );
    assert.equal(await repairRunner.recoverRun(orgId, repairCase.run.id), 1);
    assert.equal(pinnedRequests.length, repairRequestsBefore + 1);
    assert.equal(sandbox.callCount, repairEffectsBefore + 1);
    const repairedResult = await actions.result(callers[0]!.caller, repairCase.run.id);
    assert.equal(repairedResult.run.state, 'succeeded');
    assert.equal((repairedResult.value as { provider_succeeded?: boolean }).provider_succeeded, true);
    assert.deepEqual(
      await verifiedReceiptKinds(repairCase.run.id),
      ['approval', 'attempt_terminal'],
    );
    assert.ok(await runService.purgeExpiredSecrets(
      new Date(repairedResult.run.result_expires_at.getTime() + 1),
      1_000,
    ));
    await assert.rejects(
      actions.result(callers[0]!.caller, repairCase.run.id),
      (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_RESULT_EXPIRED',
    );
    assert.equal(sandbox.callCount, distinctPositiveRuns.length + 4);

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
    assert.equal(sandbox.callCount, distinctPositiveRuns.length + 4, 'revoked connector reached the provider');

    const [[runCount], [approvalCount]] = await Promise.all([
      db.select({ value: count() }).from(appRuns).where(eq(appRuns.org_id, orgId)),
      db.select({ value: count() }).from(agentActions).where(and(
        eq(agentActions.org_id, orgId),
        eq(agentActions.source, 'app_run'),
      )),
    ]);
    assert.equal(runCount?.value, distinctPositiveRuns.length + 10);
    assert.equal(approvalCount?.value, distinctPositiveRuns.length + 10);
  } finally {
    keys.destroy();
  }
});
