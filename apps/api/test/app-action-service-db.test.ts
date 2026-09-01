import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import {
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
} from '@deft/app-kit';
import {
  APP_RUN_CONTRACT_VERSIONS,
  CAPABILITY_CONTRACT_VERSIONS,
  RESOURCE_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
  type CapabilityProviderDiscoverySnapshot,
  type ModuleResourceRefV1,
} from '@deft/shared';
import {
  agentActions,
  agentEmployees,
  appActionBindings,
  appGrantSnapshots,
  appRuns,
  appVersions,
  mcpConnections,
  mcpTokens,
  orgMembers,
  orgs,
  users,
} from '@deft/db/schema';
import { AppError } from '../src/lib/app-errors.js';
import {
  AppActionService,
  type AppActionCaller,
  type AppActionPreparedInputPort,
  type AppActionRunReadPort,
  type AppActionRunPort,
} from '../src/lib/app-action-service.js';
import { closeDb, db } from '../src/lib/db.js';
import {
  activateAppInstallation,
  stageAppPackage,
} from '../src/lib/app-service.js';
import {
  activateConnectedAppInstallation,
  prepareConnectedAppReview,
} from '../src/lib/app-review-service.js';
import { PostgresAppRunLiveAuthorization } from '../src/lib/app-run-live-authorization.js';
import {
  APP_RUN_PREPARED_INPUT_VERSION,
  projectPreparedAppAuthorityRefs,
  type AppRunPreparedInputCandidate,
  type AppRunPreparedInputPayload,
} from '../src/lib/app-run-prepared-input.js';
import type { AppRunSafeView } from '../src/lib/app-run-repository.js';
import {
  createModuleRecord,
  deftyModuleActor,
  employeeModuleActor,
  getModuleInstallation,
  humanModuleActor,
  readModuleRecordScalarFields,
  updateModuleInstallation,
  updateModuleRecord,
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

async function sandboxCapability(orgId: string, connectionId: string, connectionSlug: string) {
  const stable = await createCapabilityProviderDiscoverySnapshot({
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
  let current: CapabilityProviderDiscoverySnapshot = stable;
  let discoveryCalls = 0;
  let invokeCalls = 0;
  const capability = {
    async discover() {
      discoveryCalls += 1;
      return {
        provider_kind: 'mcp' as const,
        tools: [{
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
        }],
        snapshot: current,
      };
    },
    async invoke() {
      invokeCalls += 1;
      throw new Error('AppActionService must never invoke capabilities during preparation');
    },
  };
  return {
    capability,
    stable,
    discoveryCalls: () => discoveryCalls,
    invokeCalls: () => invokeCalls,
    useSnapshot: (snapshot: CapabilityProviderDiscoverySnapshot) => { current = snapshot; },
  };
}

function candidate(candidateId: string): AppRunPreparedInputCandidate {
  const ciphertext = Buffer.from(candidateId, 'utf8').toString('base64');
  return {
    schema_version: APP_RUN_PREPARED_INPUT_VERSION,
    candidate_id: candidateId,
    expires_at: '2099-01-01T00:00:00.000Z',
    sealed_payload: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.secret_envelope,
      algorithm: 'aes-256-gcm',
      key_version: 'loop4-test',
      nonce_b64: Buffer.alloc(12).toString('base64'),
      ciphertext_b64: ciphertext,
      auth_tag_b64: Buffer.alloc(16).toString('base64'),
    },
    safe_envelope: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.secret_envelope,
      algorithm: 'aes-256-gcm',
      key_version: 'loop4-test',
      ciphertext_bytes: Buffer.byteLength(candidateId),
    },
  };
}

async function effectCounts(orgId: string) {
  const [[runs], [approvals]] = await Promise.all([
    db.select({ value: count() }).from(appRuns).where(eq(appRuns.org_id, orgId)),
    db.select({ value: count() }).from(agentActions).where(eq(agentActions.org_id, orgId)),
  ]);
  return { app_runs: runs?.value ?? 0, approvals: approvals?.value ?? 0 };
}

test('App actions resolve and prepare one reviewed relation identically across four live caller surfaces', {
  skip: !canRun,
}, async () => {
  const suffix = randomUUID();
  const orgId = randomUUID();
  const ownerUserId = randomUUID();
  const employeeUserId = randomUUID();
  const employeeId = randomUUID();
  const connectionId = randomUUID();
  const connectionSlug = `loop4-mail-${suffix}`;
  const mcpTokenId = randomUUID();

  await db.insert(orgs).values({ id: orgId, name: 'Loop 4 App actions', slug: `loop4-${suffix}` });
  await db.insert(users).values([
    {
      id: ownerUserId,
      email: `loop4-owner-${suffix}@example.test`,
      name: 'Loop 4 owner',
    },
    {
      id: employeeUserId,
      email: `loop4-employee-${suffix}@example.test`,
      name: 'Loop 4 employee',
      kind: 'agent',
      is_agent: true,
      agent_employee_id: employeeId,
    },
  ]);
  await db.insert(orgMembers).values([
    { id: randomUUID(), org_id: orgId, user_id: ownerUserId, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: orgId, user_id: employeeUserId, role: 'member', is_active: true },
  ]);

  const owner = humanModuleActor({
    orgId,
    userId: ownerUserId,
    role: 'owner',
    source: 'ui',
  });
  const dependencyPackage = await buildPhase5DependencyAppPackage();
  const dependencyStaged = await stageAppPackage(owner, dependencyPackage.json);
  await activateAppInstallation(owner, dependencyStaged.id, dependencyStaged.package_digest);

  const connectedPackage = await buildPhase5ConnectedAppPackage();
  const connectedStaged = await stageAppPackage(owner, connectedPackage.json);
  const [connectedVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, connectedStaged.version_id),
  ));
  if (!connectedVersion?.requested_grant_snapshot_id) throw new Error('Connected requested grant is missing');
  const [requested] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, connectedVersion.requested_grant_snapshot_id),
  ));
  if (!requested) throw new Error('Connected requested grant snapshot is missing');

  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: orgId,
    name: 'Loop 4 sandbox mail',
    slug: connectionSlug,
    server_url: 'https://loop4-sandbox.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    enabled_tools: ['send_email'],
    created_by: ownerUserId,
  });
  const provider = await sandboxCapability(orgId, connectionId, connectionSlug);
  const reviewRequest = {
    app_version_id: connectedVersion.id,
    expected_package_digest: connectedVersion.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: connectedStaged.lifecycle_epoch,
    expected_grant_epoch: connectedStaged.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const review = await prepareConnectedAppReview(
    owner,
    connectedStaged.id,
    reviewRequest,
    provider.capability,
  );
  await activateConnectedAppInstallation(owner, connectedStaged.id, {
    ...reviewRequest,
    expected_review_digest: review.review_digest,
    accept_host_policy: true,
  }, provider.capability);
  const [binding] = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, orgId),
    eq(appActionBindings.app_installation_id, connectedStaged.id),
  ));
  if (!binding) throw new Error('Reviewed App action binding is missing');

  let contacts = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-contacts' });
  let campaigns = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-campaigns' });
  contacts = await updateModuleInstallation(owner, contacts.slug, { agent_access: 'read' });
  campaigns = await updateModuleInstallation(owner, campaigns.slug, { agent_access: 'read' });

  const recipient = 'loop4-recipient@example.test';
  const subject = 'Loop 4 private campaign subject';
  const bodyText = 'Loop 4 private campaign body';
  const linkedContact = await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: { name: 'Linked contact', email: recipient },
    relations: {},
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `loop4-linked-${suffix}`,
  });
  const unrelatedContact = await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: { name: 'Unrelated contact', email: 'unrelated@example.test' },
    relations: {},
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `loop4-unrelated-${suffix}`,
  });
  const campaign = await createModuleRecord(owner, {
    module_id: campaigns.module_id,
    collection_key: 'campaigns',
    data: { name: 'Connected campaign', subject, body: bodyText, status: 'draft' },
    relations: {},
    expected_manifest_digest: campaigns.manifest_digest,
    idempotency_key: `loop4-campaign-${suffix}`,
  });
  if (!linkedContact.record || !unrelatedContact.record || !campaign.record) {
    throw new Error('Loop 4 Module records were not created');
  }
  const campaignRef = moduleRef(campaigns.id, 'campaigns', campaign.record.id);
  const contactRef = moduleRef(contacts.id, 'contacts', linkedContact.record.id);
  const unrelatedRef = moduleRef(contacts.id, 'contacts', unrelatedContact.record.id);
  const linked = await replaceResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: campaignRef,
    relation_key: 'contacts',
    refs: [contactRef],
    expected_revision: 0,
    idempotency_key: `loop4-link-${suffix}`,
  });
  assert.equal(linked.revision, 1);

  await db.insert(agentEmployees).values({
    id: employeeId,
    org_id: orgId,
    user_id: employeeUserId,
    name: 'Loop 4 employee',
    slug: `loop4-employee-${suffix}`,
    role: 'custom',
    system_prompt: 'Test reviewed App actions.',
    mcp_connection_ids: [connectionId],
    trust_level: 'autonomous',
    max_daily_actions: 5,
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
    name: 'Loop 4 human MCP token',
    token_hash: `loop4-hash-${suffix}`,
    token_prefix: `loop4-${suffix.slice(0, 8)}`,
    scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
    created_by: ownerUserId,
  });

  const protectedInputs: Parameters<AppActionPreparedInputPort['protect']>[0][] = [];
  const preparedPayloads = new Map<string, AppRunPreparedInputPayload>();
  const openedCandidates: string[] = [];
  const preparedInput: AppActionPreparedInputPort = {
    protect(input) {
      protectedInputs.push(input);
      const protectedCandidate = candidate(`loop4-candidate-${protectedInputs.length}`);
      const appRun = input.app_run;
      preparedPayloads.set(protectedCandidate.candidate_id, {
        schema_version: APP_RUN_PREPARED_INPUT_VERSION,
        expires_at: protectedCandidate.expires_at,
        replay_identity: input.replay_identity,
        binding_identity: input.binding_identity,
        provider_input: input.provider_input,
        ...(appRun ? {
          app_run: {
            ...appRun,
            authority_vector: appRun.authority_vector,
            authority_refs: projectPreparedAppAuthorityRefs(appRun.authority_vector),
          },
        } : {}),
      } as AppRunPreparedInputPayload);
      return protectedCandidate;
    },
    open(candidateOrgId, protectedCandidate) {
      assert.equal(candidateOrgId, orgId);
      openedCandidates.push(protectedCandidate.candidate_id);
      const payload = preparedPayloads.get(protectedCandidate.candidate_id);
      if (!payload) throw new Error('Prepared input candidate is unavailable');
      return payload;
    },
  };
  const submittedRuns: Array<Readonly<{
    context: Parameters<AppActionRunPort['submitPreparedApp']>[0];
    candidate: AppRunPreparedInputCandidate;
  }>> = [];
  const runs: AppActionRunPort = {
    async submitPreparedApp(context, protectedCandidate) {
      submittedRuns.push({ context, candidate: protectedCandidate });
      return { id: `loop5-run-${submittedRuns.length}` } as AppRunSafeView;
    },
  };
  const runReadCalls: Array<Readonly<{
    kind: 'inspect' | 'result';
    org_id: string;
    run_id: string;
    actor: unknown;
    required_authority_ref: unknown;
  }>> = [];
  const runReads: AppActionRunReadPort = {
    async inspect(readOrgId, runId, actor, requiredAuthorityRef) {
      runReadCalls.push({
        kind: 'inspect',
        org_id: readOrgId,
        run_id: runId,
        actor,
        required_authority_ref: requiredAuthorityRef,
      });
      return { id: runId } as AppRunSafeView;
    },
    async result(readOrgId, runId, actor, requiredAuthorityRef) {
      runReadCalls.push({
        kind: 'result',
        org_id: readOrgId,
        run_id: runId,
        actor,
        required_authority_ref: requiredAuthorityRef,
      });
      return { run: { id: runId } as AppRunSafeView, value: { status: 'delivered' } };
    },
  };
  let fieldReads = 0;
  const service = new AppActionService(
    provider.capability,
    new PostgresAppRunLiveAuthorization(),
    preparedInput,
    {
      async read(actor, ref, fieldKeys) {
        fieldReads += 1;
        return readModuleRecordScalarFields(actor, ref, fieldKeys);
      },
    },
    runs,
    runReads,
  );
  const sandboxEffect = new Phase4SandboxEmailProvider();
  const callers: ReadonlyArray<Readonly<{ name: string; caller: AppActionCaller }>> = [
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

  const beforeEffects = await effectCounts(orgId);

  assert.equal((await service.inspectRun(callers[0]!.caller, 'loop6-ui-run')).id, 'loop6-ui-run');
  assert.deepEqual(await service.result(callers[3]!.caller, 'loop6-mcp-run'), {
    run: { id: 'loop6-mcp-run' },
    value: { status: 'delivered' },
  });
  assert.deepEqual(runReadCalls.map((call) => ({ kind: call.kind, actor: call.actor })), [
    { kind: 'inspect', actor: { actor_type: 'human', user_id: ownerUserId } },
    { kind: 'result', actor: { actor_type: 'human', user_id: ownerUserId } },
  ]);
  assert.equal(runReadCalls[0]?.required_authority_ref, null);
  assert.deepEqual(runReadCalls[1]?.required_authority_ref, {
    authority_kind: 'token_scope',
    authority_id: mcpTokenId,
    version: (runReadCalls[1]?.required_authority_ref as { version: string }).version,
  });
  assert.match(
    (runReadCalls[1]?.required_authority_ref as { version: string }).version,
    /^sha256:[a-f0-9]{64}$/,
  );

  await db.update(mcpTokens).set({ scopes: ['read:modules', 'read:apps', 'invoke:apps'] }).where(and(
    eq(mcpTokens.org_id, orgId),
    eq(mcpTokens.id, mcpTokenId),
  ));
  await assert.rejects(
    service.inspectRun(callers[3]!.caller, 'loop6-hidden-run'),
    (error: unknown) => error instanceof AppError && error.code === 'APP_ACCESS_DENIED',
  );
  assert.equal(runReadCalls.length, 2, 'missing Run scope must fail before Run inspection');
  await db.update(mcpTokens).set({
    scopes: ['read:modules', 'read:apps', 'invoke:apps', 'read:app-runs'],
  }).where(and(eq(mcpTokens.org_id, orgId), eq(mcpTokens.id, mcpTokenId)));

  const semanticResults: Array<Readonly<{ list: unknown; resolve: unknown; preview: unknown }>> = [];
  const replayBySurface = new Map<string, string>();
  const preparedBySurface = new Map<string, Awaited<ReturnType<AppActionService['prepare']>>>();
  for (const surface of callers) {
    const listed = await service.list(surface.caller, { resource_ref: campaignRef });
    assert.deepEqual(listed.actions.map((item) => item.binding_id), [binding.id]);

    const resolved = await service.resolve(surface.caller, {
      binding_id: binding.id,
      resource_ref: campaignRef,
    });
    const relationInput = resolved.inputs.find((input) => input.kind === 'selected_relation_field');
    assert.ok(relationInput && relationInput.kind === 'selected_relation_field');
    assert.deepEqual(relationInput.options.map((option) => option.ref.resource_id), [contactRef.resource_id]);
    assert.equal(relationInput.options.some((option) => option.ref.resource_id === unrelatedRef.resource_id), false);

    const prepared = await service.prepare(surface.caller, {
      binding_id: binding.id,
      resource_ref: campaignRef,
      selections: [{ input_key: 'to', resource_ref: contactRef }],
      user_inputs: {},
      idempotency_key: `loop4-send-${suffix}`,
    });
    assert.equal(prepared.action.binding_id, binding.id);
    assert.equal(prepared.authority_vector.resources.length, 2);
    assert.equal(prepared.authority_vector.relations[0]?.selected_ref.resource_id, contactRef.resource_id);
    assert.deepEqual(protectedInputs.at(-1)?.provider_input, {
      idempotency_key: `loop4-send-${suffix}`,
      to: recipient,
      subject,
      body_text: bodyText,
    });
    const safeJson = JSON.stringify({ listed, resolved, prepared });
    for (const [field, secret] of [['recipient', recipient], ['subject', subject], ['body', bodyText]]) {
      assert.equal(
        safeJson.includes(secret),
        false,
        `${surface.name} safe output exposed prepared ${field} plaintext`,
      );
    }
    semanticResults.push({ list: listed, resolve: resolved, preview: prepared.safe_preview });
    replayBySurface.set(surface.name, prepared.replay_identity);
    preparedBySurface.set(surface.name, prepared);
  }
  for (const result of semanticResults.slice(1)) assert.deepEqual(result, semanticResults[0]);
  assert.equal(
    new Set(replayBySurface.values()).size,
    callers.length,
    'replay identity must isolate every pinned caller surface and token authority',
  );
  assert.equal(protectedInputs.length, callers.length);
  assert.equal(fieldReads, callers.length * 2);

  const uiPrepared = preparedBySurface.get('ui');
  if (!uiPrepared) throw new Error('UI preparation result is missing');
  const invokeInput = {
    binding_id: binding.id,
    resource_ref: campaignRef,
    selections: [{ input_key: 'to', resource_ref: contactRef }],
    user_inputs: {},
    idempotency_key: `loop4-send-${suffix}`,
    input_candidate: uiPrepared.input_candidate,
  } as const;
  const beforeInvokeProtects = protectedInputs.length;
  const invoked = await service.invoke(callers[0]!.caller, invokeInput);
  assert.equal(invoked.id, 'loop5-run-1');
  assert.equal(protectedInputs.length, beforeInvokeProtects + 1, 'invoke must reprepare exactly once');
  assert.deepEqual(openedCandidates.slice(-2), [
    uiPrepared.input_candidate.candidate_id,
    submittedRuns[0]!.candidate.candidate_id,
  ]);
  assert.notEqual(submittedRuns[0]!.candidate.candidate_id, uiPrepared.input_candidate.candidate_id);
  assert.equal(
    submittedRuns[0]!.candidate.candidate_id,
    `loop4-candidate-${protectedInputs.length}`,
    'invoke must submit only the freshly revalidated candidate',
  );
  assert.deepEqual(submittedRuns[0]!.context, {
    org_id: orgId,
    initiating_actor: { actor_type: 'human', user_id: ownerUserId },
    execution_actor: { actor_type: 'human', user_id: ownerUserId },
  });

  let beforeProtect = protectedInputs.length;
  await assert.rejects(
    service.invoke(callers[0]!.caller, {
      ...invokeInput,
      idempotency_key: `loop4-changed-${suffix}`,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'APP_STALE',
  );
  assert.equal(protectedInputs.length, beforeProtect + 1, 'stale invoke must still perform one live reprepare');
  assert.equal(submittedRuns.length, 1, 'a changed prepared input must never reach App Run submission');

  beforeProtect = protectedInputs.length;
  await assert.rejects(
    service.invoke(callers[1]!.caller, invokeInput),
    (error: unknown) => error instanceof AppError && error.code === 'APP_ACCESS_DENIED',
  );
  assert.equal(protectedInputs.length, beforeProtect, 'cross-surface candidate use must fail before reprepare');
  assert.equal(submittedRuns.length, 1);

  const prepare = (caller: AppActionCaller, selectedRef: ModuleResourceRefV1 = contactRef) => service.prepare(caller, {
    binding_id: binding.id,
    resource_ref: campaignRef,
    selections: [{ input_key: 'to', resource_ref: selectedRef }],
    user_inputs: {},
    idempotency_key: `loop4-denial-${suffix}`,
  });

  let beforeReads = fieldReads;
  beforeProtect = protectedInputs.length;
  await assert.rejects(
    prepare(callers[0]!.caller, unrelatedRef),
    (error: unknown) => error instanceof AppError && error.code === 'APP_ACTION_UNAVAILABLE',
  );
  assert.equal(fieldReads, beforeReads, 'an unrelated selection must fail before scalar field reads');
  assert.equal(protectedInputs.length, beforeProtect);

  await db.update(orgMembers).set({ is_active: false }).where(and(
    eq(orgMembers.org_id, orgId),
    eq(orgMembers.user_id, ownerUserId),
  ));
  beforeReads = fieldReads;
  beforeProtect = protectedInputs.length;
  try {
    await assert.rejects(
      prepare(callers[0]!.caller),
      (error: unknown) => error instanceof AppError && error.code === 'APP_ACCESS_DENIED',
    );
    assert.equal(fieldReads, beforeReads, 'revoked membership must fail before scalar field reads');
    assert.equal(protectedInputs.length, beforeProtect);
  } finally {
    await db.update(orgMembers).set({ is_active: true }).where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, ownerUserId),
    ));
  }

  await db.update(mcpTokens).set({ scopes: [] }).where(and(
    eq(mcpTokens.org_id, orgId),
    eq(mcpTokens.id, mcpTokenId),
  ));
  beforeReads = fieldReads;
  beforeProtect = protectedInputs.length;
  try {
    await assert.rejects(
      prepare(callers[3]!.caller),
      (error: unknown) => error instanceof AppError && error.code === 'APP_ACCESS_DENIED',
    );
    assert.equal(fieldReads, beforeReads, 'revoked MCP scope must fail before scalar field reads');
    assert.equal(protectedInputs.length, beforeProtect);
  } finally {
    await db.update(mcpTokens).set({ scopes: ['read:modules'] }).where(and(
      eq(mcpTokens.org_id, orgId),
      eq(mcpTokens.id, mcpTokenId),
    ));
  }

  const cleared = await replaceResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: campaignRef,
    relation_key: 'contacts',
    refs: [],
    expected_revision: linked.revision,
    idempotency_key: `loop4-clear-${suffix}`,
  });
  beforeReads = fieldReads;
  beforeProtect = protectedInputs.length;
  try {
    await assert.rejects(
      prepare(callers[0]!.caller),
      (error: unknown) => error instanceof AppError && error.code === 'APP_ACTION_UNAVAILABLE',
    );
    assert.equal(fieldReads, beforeReads, 'revoked relation must fail before scalar field reads');
    assert.equal(protectedInputs.length, beforeProtect);
  } finally {
    await replaceResourceRelation(owner, {
      schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
      source: campaignRef,
      relation_key: 'contacts',
      refs: [contactRef],
      expected_revision: cleared.revision,
      idempotency_key: `loop4-restore-${suffix}`,
    });
  }

  const driftedSnapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: provider.stable.adapter_contract_version,
    provider: provider.stable.provider,
    captured_at: '2026-08-31T12:05:00.000Z',
    operations: [{
      identity: provider.stable.operations[0]!.identity,
      title: provider.stable.operations[0]!.title,
      description: 'A changed provider contract.',
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
  provider.useSnapshot(driftedSnapshot);
  beforeReads = fieldReads;
  beforeProtect = protectedInputs.length;
  try {
    await assert.rejects(
      prepare(callers[0]!.caller),
      (error: unknown) => error instanceof AppError && error.code === 'APP_PROVIDER_UNAVAILABLE',
    );
    assert.equal(fieldReads, beforeReads, 'provider schema drift must fail before scalar field reads');
    assert.equal(protectedInputs.length, beforeProtect);
  } finally {
    provider.useSnapshot(provider.stable);
  }

  const withoutRecipient = await updateModuleRecord(owner, {
    record_id: linkedContact.record.id,
    patch: {},
    unset_fields: ['email'],
    relations: {},
    expected_revision: linkedContact.record.revision,
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `loop4-unset-email-${suffix}`,
  });
  if (!withoutRecipient.record) throw new Error('Recipient field was not revoked');
  beforeProtect = protectedInputs.length;
  try {
    await assert.rejects(prepare(callers[0]!.caller), /Module scalar field is absent: email/);
    assert.equal(protectedInputs.length, beforeProtect, 'an absent selected field must never reach input protection');
  } finally {
    await updateModuleRecord(owner, {
      record_id: linkedContact.record.id,
      patch: { email: recipient },
      unset_fields: [],
      relations: {},
      expected_revision: withoutRecipient.record.revision,
      expected_manifest_digest: contacts.manifest_digest,
      idempotency_key: `loop4-restore-email-${suffix}`,
    });
  }

  assert.deepEqual(await effectCounts(orgId), beforeEffects);
  assert.equal(provider.invokeCalls(), 0);
  assert.equal(sandboxEffect.callCount, 0);
  assert.equal(provider.discoveryCalls() > 0, true);
});
