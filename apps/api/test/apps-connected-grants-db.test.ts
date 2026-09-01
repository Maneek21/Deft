import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { and, count, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
  canonicalAppPrivateInterfaceIdentity,
} from '@deft/app-kit';
import {
  CAPABILITY_CONTRACT_VERSIONS,
  RESOURCE_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import {
  agentActions,
  appActionBindings,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appRuns,
  appVersions,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpTokens,
  mcpToolOverrides,
  moduleRecords,
  moduleVersions,
  oauthAccessTokens,
  orgMembers,
  orgs,
  resourceRelationEdges,
  resourceRelationSets,
  users,
} from '@deft/db/schema';
import { AppError } from '../src/lib/app-errors.js';
import { closeDb, db } from '../src/lib/db.js';
import { ModuleError } from '../src/lib/module-errors.js';
import {
  activateAppInstallation,
  disableAppInstallation,
  enableAppInstallation,
  refuseAppUninstall,
  stageAppPackage,
  stageAppUpgrade,
} from '../src/lib/app-service.js';
import {
  activateConnectedAppInstallation,
  getConnectedAppGrantManagement,
  inspectConnectedAppHealth,
  prepareConnectedAppReview,
} from '../src/lib/app-review-service.js';
import { createModuleRecord, humanModuleActor } from '../src/lib/module-service.js';
import { replaceResourceRelation } from '../src/lib/resource-relation-service.js';
import { mcpConnectionRoutes } from '../src/routes/mcp-connections.js';
import { appRoutes } from '../src/routes/apps.js';
import {
  buildPhase5ConnectedAppPackage,
  buildPhase5ConnectedPredecessorAppPackage,
  buildPhase5DependencyAppPackage,
  buildTrackAAutomatedConnectedAppPackage,
} from './fixtures/phase5-connected-app-package.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!DATABASE_URL) throw new Error('Connected App grant DB tests require DEFT_TEST_DATABASE_URL');
if (process.env.CI !== 'true' && !/(?:test|ci|acceptance|phase5)/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error('Connected App grant DB tests require an explicitly disposable database');
}

const TEST_GENERATION = randomUUID();
const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();

function moduleRef(installationId: string, resourceType: string, resourceId: string) {
  return {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module' as const, provider_instance_id: installationId },
    resource_type: resourceType,
    resource_id: resourceId,
  };
}

async function relationPersistenceSnapshot(
  orgId: string,
  sourceInstallationId: string,
  sourceRecordId: string,
) {
  const [relation] = await db.select({
    set_id: resourceRelationSets.id,
    revision: resourceRelationSets.revision,
    edge_id: resourceRelationEdges.id,
    target_provider_kind: resourceRelationEdges.target_provider_kind,
    target_provider_instance_id: resourceRelationEdges.target_provider_instance_id,
    target_resource_type: resourceRelationEdges.target_resource_type,
    target_resource_id: resourceRelationEdges.target_resource_id,
    position: resourceRelationEdges.position,
  }).from(resourceRelationSets).innerJoin(resourceRelationEdges, and(
    eq(resourceRelationEdges.org_id, resourceRelationSets.org_id),
    eq(resourceRelationEdges.relation_set_id, resourceRelationSets.id),
    eq(resourceRelationEdges.is_deleted, false),
  )).where(and(
    eq(resourceRelationSets.org_id, orgId),
    eq(resourceRelationSets.source_provider_kind, 'module'),
    eq(resourceRelationSets.source_provider_instance_id, sourceInstallationId),
    eq(resourceRelationSets.source_resource_type, 'campaigns'),
    eq(resourceRelationSets.source_resource_id, sourceRecordId),
    eq(resourceRelationSets.relation_key, 'contacts'),
  ));
  assert.ok(relation);
  return relation;
}

async function sandboxReviewCapability(orgId: string, connectionId: string) {
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
  let discoveryCalls = 0;
  const capability = {
    discover: async () => {
      discoveryCalls += 1;
      return {
        provider_kind: 'mcp' as const,
        tools: [{
          name: 'mcp__reviewed__send_email',
          originalName: 'send_email',
          description: 'Send sandbox email',
          inputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
          outputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
          connectionId,
          connectionSlug: 'reviewed',
          isWrite: true,
          approvalTier: 'full-review' as const,
          rawTool: { name: 'send_email' },
        }],
        snapshot,
      };
    },
  };
  return { snapshot, capability, discoveryCalls: () => discoveryCalls };
}

before(async () => {
  await db.insert(orgs).values([
    { id: ORG_ID, name: 'Connected Apps', slug: `phase5-connected-${TEST_GENERATION}` },
    { id: OTHER_ORG_ID, name: 'Other Connected Apps', slug: `phase5-other-${TEST_GENERATION}` },
  ]).onConflictDoNothing();
  await db.insert(users).values([
    {
      id: USER_ID,
      email: `phase5-connected-${TEST_GENERATION}@example.test`,
      name: 'Connected Apps owner',
    },
    {
      id: OTHER_USER_ID,
      email: `phase5-other-${TEST_GENERATION}@example.test`,
      name: 'Other Connected Apps owner',
    },
  ]).onConflictDoNothing();
  await db.insert(orgMembers).values([
    { id: randomUUID(), org_id: ORG_ID, user_id: USER_ID, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: OTHER_ORG_ID, user_id: OTHER_USER_ID, role: 'owner', is_active: true },
  ]).onConflictDoUpdate({
    target: [orgMembers.org_id, orgMembers.user_id],
    set: { role: 'owner', is_active: true },
  });
});

after(async () => closeDb());

test('Protocol v1 staging writes one requested snapshot and no executable authority', async () => {
  const actor = humanModuleActor({ orgId: ORG_ID, userId: USER_ID, role: 'owner' });
  const built = await buildPhase5ConnectedAppPackage();
  const staged = await stageAppPackage(actor, built.json);

  assert.equal(staged.state, 'staged');
  assert.equal(staged.manifest.compatibility.app_protocol, '1');
  const [installation] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, ORG_ID),
    eq(appInstallations.id, staged.id),
  ));
  const [version] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, ORG_ID),
    eq(appVersions.installation_id, staged.id),
  ));
  assert.ok(installation);
  assert.ok(version?.requested_grant_snapshot_id);
  assert.equal(installation.active_grant_snapshot_id, null);
  assert.equal(installation.active_grant_snapshot_kind, null);
  assert.equal(installation.grant_epoch, 0);

  const snapshots = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, ORG_ID),
    eq(appGrantSnapshots.app_version_id, version.id),
  ));
  assert.equal(snapshots.length, 1);
  const requested = snapshots[0]!;
  assert.equal(requested.id, version.requested_grant_snapshot_id);
  assert.equal(requested.snapshot_kind, 'requested');
  assert.equal(requested.app_id, built.package.manifest.id);
  assert.equal(requested.app_version, built.package.manifest.version);
  assert.equal(requested.manifest_digest, built.package.manifest_digest);
  assert.equal(requested.package_digest, built.digest);
  assert.match(requested.snapshot_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(requested.reviewed_by_actor_type, null);
  assert.equal(requested.reviewed_by_actor_id, null);
  assert.equal(requested.reviewed_at, null);
  assert.equal(requested.classification.executable, false);
  assert.equal(requested.classification.provider_access, false);

  const zeroAuthorityCounts = {
    dependency_locks: (await db.select({ value: count() }).from(appDependencyLocks)
      .where(eq(appDependencyLocks.org_id, ORG_ID)))[0]?.value,
    action_bindings: (await db.select({ value: count() }).from(appActionBindings)
      .where(eq(appActionBindings.org_id, ORG_ID)))[0]?.value,
    app_runs: (await db.select({ value: count() }).from(appRuns)
      .where(eq(appRuns.org_id, ORG_ID)))[0]?.value,
    provider_snapshots: (await db.select({ value: count() }).from(capabilityProviderSnapshots)
      .where(eq(capabilityProviderSnapshots.org_id, ORG_ID)))[0]?.value,
    mcp_connections: (await db.select({ value: count() }).from(mcpConnections)
      .where(eq(mcpConnections.org_id, ORG_ID)))[0]?.value,
    mcp_tokens: (await db.select({ value: count() }).from(mcpTokens)
      .where(eq(mcpTokens.org_id, ORG_ID)))[0]?.value,
    oauth_tokens: (await db.select({ value: count() }).from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.org_id, ORG_ID)))[0]?.value,
    approvals: (await db.select({ value: count() }).from(agentActions)
      .where(eq(agentActions.org_id, ORG_ID)))[0]?.value,
  };
  assert.deepEqual(zeroAuthorityCounts, {
    dependency_locks: 0,
    action_bindings: 0,
    app_runs: 0,
    provider_snapshots: 0,
    mcp_connections: 0,
    mcp_tokens: 0,
    oauth_tokens: 0,
    approvals: 0,
  });
  await assert.rejects(
    () => activateAppInstallation(actor, staged.id, staged.package_digest),
    (error: unknown) => error instanceof AppError
      && error.code === 'APP_REVIEW_REQUIRED'
      && error.status === 409,
  );
  const [afterRejection] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(afterRejection?.state, 'staged');
  assert.equal(afterRejection?.active_version_id, null);
  assert.equal(afterRejection?.active_grant_snapshot_id, null);
  assert.equal((await db.select({ value: count() }).from(appActionBindings)
    .where(eq(appActionBindings.org_id, ORG_ID)))[0]?.value, 0);
  assert.equal((await db.select({ value: count() }).from(appRuns)
    .where(eq(appRuns.org_id, ORG_ID)))[0]?.value, 0);
  await assert.rejects(
    db.insert(appGrantSnapshots).values({
      ...requested,
      id: randomUUID(),
      org_id: OTHER_ORG_ID,
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23503'
      && error?.cause?.constraint === 'app_grant_snapshots_app_installation_fk',
  );
  await assert.rejects(
    db.update(appGrantSnapshots)
      .set({ classification: { ...requested.classification, executable: true } })
      .where(eq(appGrantSnapshots.id, requested.id)),
    (error: any) => error?.cause?.code === '55000'
      && error?.cause?.message === 'APP_FOUNDATION_APPEND_ONLY',
  );

  const effectiveValues = (
    id: string,
    reviewerId: string,
    supersedesSnapshotId: string | null = null,
  ) => ({
    ...requested,
    id,
    snapshot_kind: 'effective' as const,
    requested_snapshot_id: requested.id,
    supersedes_snapshot_id: supersedesSnapshotId,
    classification: { ...requested.classification, authority_state: 'effective' },
    canonical_snapshot: { ...requested.canonical_snapshot, snapshot_kind: 'effective' },
    snapshot_digest: `sha256:${'3'.repeat(64)}`,
    reviewed_by_actor_type: 'human',
    reviewed_by_actor_id: reviewerId,
    reviewed_at: new Date(),
    created_at: new Date(),
  });

  await assert.rejects(
    db.insert(appGrantSnapshots).values(effectiveValues(randomUUID(), OTHER_USER_ID)),
    (error: any) => error?.cause?.code === '23514'
      && error?.cause?.message === 'APP_GRANT_REVIEWER_NOT_AUTHORIZED',
  );
  const selfSupersedingId = randomUUID();
  await assert.rejects(
    db.insert(appGrantSnapshots).values(effectiveValues(
      selfSupersedingId,
      USER_ID,
      selfSupersedingId,
    )),
    (error: any) => error?.cause?.code === '23514'
      && error?.cause?.constraint === 'app_grant_snapshots_supersedes_self_check',
  );

  const effectiveId = randomUUID();
  await db.insert(appGrantSnapshots).values(effectiveValues(effectiveId, USER_ID));
  const [effective] = await db.select().from(appGrantSnapshots)
    .where(eq(appGrantSnapshots.id, effectiveId));
  assert.ok(effective);
  await assert.rejects(
    db.insert(appGrantSnapshots).values(effectiveValues(randomUUID(), USER_ID)),
    (error: any) => error?.cause?.code === '23505'
      && error?.cause?.constraint === 'app_grant_snapshots_one_root_unique',
  );

  const dependencyBuilt = await buildPhase5DependencyAppPackage();
  const dependencyStaged = await stageAppPackage(actor, dependencyBuilt.json);
  const dependency = await activateAppInstallation(
    actor,
    dependencyStaged.id,
    dependencyStaged.package_digest,
  );
  const [dependencyVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, ORG_ID),
    eq(appVersions.id, dependency.active_version_id!),
  ));
  assert.ok(dependencyVersion);

  const dependencyLockId = randomUUID();
  await db.insert(appDependencyLocks).values({
    id: dependencyLockId,
    org_id: ORG_ID,
    app_installation_id: staged.id,
    app_version_id: version.id,
    grant_snapshot_id: effective.id,
    grant_snapshot_kind: 'effective',
    dependency_key: 'contacts_app',
    required_app_id: dependency.app_id,
    required_version: dependencyVersion.version,
    dependency_installation_id: dependency.id,
    dependency_version_id: dependencyVersion.id,
    dependency_manifest_digest: dependencyVersion.manifest_digest,
    dependency_package_digest: dependencyVersion.package_digest,
    dependency_lifecycle_epoch: dependency.lifecycle_epoch,
    ownership: 'preexisting',
    canonical_lock: { dependency_key: 'contacts_app', ownership: 'preexisting' },
    lock_digest: `sha256:${'4'.repeat(64)}`,
  });
  const [dependencyLock] = await db.select().from(appDependencyLocks)
    .where(eq(appDependencyLocks.id, dependencyLockId));
  assert.ok(dependencyLock);

  await assert.rejects(
    db.insert(appDependencyLocks).values({
      ...dependencyLock,
      id: randomUUID(),
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23505',
  );
  await assert.rejects(
    db.insert(appDependencyLocks).values({
      ...dependencyLock,
      id: randomUUID(),
      dependency_key: 'contacts_alias',
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23505'
      && error?.cause?.constraint === 'app_dependency_locks_grant_installation_unique',
  );
  await assert.rejects(
    db.insert(appDependencyLocks).values({
      ...dependencyLock,
      id: randomUUID(),
      org_id: OTHER_ORG_ID,
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23503',
  );

  const connectionId = randomUUID();
  const providerSnapshotId = randomUUID();
  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: ORG_ID,
    name: 'Phase 5 sandbox mail',
    slug: `phase5-sandbox-mail-${TEST_GENERATION}`,
    server_url: 'https://sandbox-mail.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    app_run_authorization_version: 1,
    created_by: USER_ID,
  });
  await db.insert(capabilityProviderSnapshots).values({
    id: providerSnapshotId,
    org_id: ORG_ID,
    provider_kind: 'mcp',
    provider_instance_id: connectionId,
    adapter_contract_version: 'deft.capability_provider.v1',
    snapshot_digest: `sha256:${'5'.repeat(64)}`,
    safe_snapshot: { operations: ['sandbox_email_send'] },
    captured_at: new Date(),
  });

  const actionBindingId = randomUUID();
  await db.insert(appActionBindings).values({
    id: actionBindingId,
    org_id: ORG_ID,
    app_installation_id: staged.id,
    app_version_id: version.id,
    grant_snapshot_id: effective.id,
    grant_snapshot_kind: 'effective',
    action_key: 'send_campaign_email',
    capability_requirement_key: 'send_email',
    connector_requirement_key: 'mail_provider',
    interface_identity: canonicalAppPrivateInterfaceIdentity({
      organization_id: ORG_ID,
      app_lineage_id: staged.id,
      interface_key: 'sandbox_email_send',
      interface_version: '1',
    }),
    provider_kind: 'mcp',
    mcp_connection_id: connectionId,
    provider_snapshot_id: providerSnapshotId,
    operation_name: 'sandbox_email_send',
    operation_schema_digest: `sha256:${'6'.repeat(64)}`,
    connector_authorization_version: 1,
    risk_class: 'external_write',
    review_requirement: 'always',
    review_scope: 'per_invocation',
    egress_class: 'email',
    retry_class: 'idempotent_with_key',
    retention_class: 'standard',
    automation_eligibility: 'forbidden',
    provider_idempotency_key_required: true,
    canonical_binding: { action_key: 'send_campaign_email' },
    binding_digest: `sha256:${'7'.repeat(64)}`,
  });
  const [actionBinding] = await db.select().from(appActionBindings)
    .where(eq(appActionBindings.id, actionBindingId));
  assert.ok(actionBinding);
  await assert.rejects(
    db.update(appModuleBindings).set({ module_id: 'community.deft.rewritten' }).where(and(
      eq(appModuleBindings.org_id, ORG_ID),
      eq(appModuleBindings.app_installation_id, dependency.id),
    )),
    (error: any) => error?.cause?.code === '55000'
      && error?.cause?.message === 'APP_MODULE_BINDING_APPEND_ONLY',
  );
  await assert.rejects(
    db.delete(appModuleBindings).where(and(
      eq(appModuleBindings.org_id, ORG_ID),
      eq(appModuleBindings.app_installation_id, dependency.id),
    )),
    (error: any) => error?.cause?.code === '55000'
      && error?.cause?.message === 'APP_MODULE_BINDING_APPEND_ONLY',
  );

  await assert.rejects(
    db.insert(appActionBindings).values({
      ...actionBinding,
      id: randomUUID(),
      action_key: 'wrong_lineage_action',
      interface_identity: canonicalAppPrivateInterfaceIdentity({
        organization_id: OTHER_ORG_ID,
        app_lineage_id: staged.id,
        interface_key: 'sandbox_email_send',
        interface_version: '1',
      }),
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23514'
      && error?.cause?.constraint === 'app_action_bindings_interface_check',
  );
  await assert.rejects(
    db.insert(appActionBindings).values({
      ...actionBinding,
      id: randomUUID(),
      org_id: OTHER_ORG_ID,
      action_key: 'cross_tenant_action',
      interface_identity: canonicalAppPrivateInterfaceIdentity({
        organization_id: OTHER_ORG_ID,
        app_lineage_id: staged.id,
        interface_key: 'sandbox_email_send',
        interface_version: '1',
      }),
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23503',
  );
  await assert.rejects(
    db.update(appDependencyLocks)
      .set({ canonical_lock: { changed: true } })
      .where(eq(appDependencyLocks.id, dependencyLock.id)),
    (error: any) => error?.cause?.code === '55000'
      && error?.cause?.message === 'APP_FOUNDATION_APPEND_ONLY',
  );
  await assert.rejects(
    db.update(appActionBindings)
      .set({ operation_name: 'changed_operation' })
      .where(eq(appActionBindings.id, actionBinding.id)),
    (error: any) => error?.cause?.code === '55000'
      && error?.cause?.message === 'APP_FOUNDATION_APPEND_ONLY',
  );

  const routeApp = new Hono();
  routeApp.use('*', async (context, next) => {
    context.set('user', {
      id: USER_ID,
      org_id: ORG_ID,
      email: `phase5-connected-${TEST_GENERATION}@example.test`,
      name: 'Connected Apps owner',
      role: 'owner',
    });
    await next();
  });
  routeApp.route('/api/mcp-connections', mcpConnectionRoutes);
  const deleteResponse = await routeApp.request(
    `/api/mcp-connections/${connectionId}`,
    { method: 'DELETE' },
  );
  assert.equal(deleteResponse.status, 409);
  assert.equal((await deleteResponse.json() as { code: string }).code, 'CONNECTION_IN_USE');
  assert.equal((await db.select().from(mcpConnections)
    .where(eq(mcpConnections.id, connectionId))).length, 1);

  const unboundConnectionId = randomUUID();
  await db.insert(mcpConnections).values({
    id: unboundConnectionId,
    org_id: ORG_ID,
    name: 'Phase 5 unbound connector',
    slug: `phase5-unbound-${TEST_GENERATION}`,
    server_url: 'https://unbound.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    created_by: USER_ID,
  });
  const unboundDeleteResponse = await routeApp.request(
    `/api/mcp-connections/${unboundConnectionId}`,
    { method: 'DELETE' },
  );
  assert.equal(unboundDeleteResponse.status, 200);
  assert.equal((await db.select().from(mcpConnections)
    .where(eq(mcpConnections.id, unboundConnectionId))).length, 0);
});

test('Protocol v2 stages with zero authority and activates only through connected review', async () => {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({
    id: orgId,
    name: 'Protocol v2 lifecycle',
    slug: `track-a-v2-${randomUUID()}`,
  });
  await db.insert(users).values({
    id: userId,
    email: `track-a-v2-${randomUUID()}@example.test`,
    name: 'Protocol v2 owner',
  });
  await db.insert(orgMembers).values({
    id: randomUUID(),
    org_id: orgId,
    user_id: userId,
    role: 'owner',
    is_active: true,
  });
  const actor = humanModuleActor({ orgId, userId, role: 'owner' });

  const dependencyBuilt = await buildPhase5DependencyAppPackage();
  const dependencyStaged = await stageAppPackage(actor, dependencyBuilt.json);
  await activateAppInstallation(
    actor,
    dependencyStaged.id,
    dependencyStaged.package_digest,
  );

  const built = await buildTrackAAutomatedConnectedAppPackage();
  const staged = await stageAppPackage(actor, built.json);
  assert.equal(staged.state, 'staged');
  assert.equal(staged.manifest.compatibility.app_protocol, '2');
  assert.equal(staged.active_version_id, null);

  const [version] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, staged.version_id),
  ));
  const [requested] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, version!.requested_grant_snapshot_id!),
  ));
  assert.ok(version);
  assert.ok(requested);
  assert.equal(version.protocol_version, '2');
  assert.equal(requested.classification.executable, false);
  assert.equal(requested.classification.provider_access, false);
  assert.deepEqual(
    (requested.canonical_snapshot as any).requirements.automation_requests,
    built.package.manifest.automation_requests,
  );
  assert.equal((await db.select({ value: count() }).from(appRuns).where(
    eq(appRuns.org_id, orgId),
  ))[0]?.value, 0);
  await assert.rejects(
    activateAppInstallation(actor, staged.id, staged.package_digest),
    (error: unknown) => error instanceof AppError && error.code === 'APP_REVIEW_REQUIRED',
  );

  const connectionId = randomUUID();
  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: orgId,
    name: 'Protocol v2 sandbox mail',
    slug: `track-a-v2-mail-${randomUUID()}`,
    server_url: 'https://track-a-v2.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    created_by: userId,
  });
  const { capability } = await sandboxReviewCapability(orgId, connectionId);
  const request = {
    app_version_id: version.id,
    expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: staged.lifecycle_epoch,
    expected_grant_epoch: staged.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const management = await getConnectedAppGrantManagement(actor, staged.id);
  assert.equal(management.review_target?.protocol_version, '2');
  assert.deepEqual(
    (management.review_target?.requested_authority as any)?.requirements.automation_requests,
    built.package.manifest.automation_requests,
  );
  const review = await prepareConnectedAppReview(actor, staged.id, request, capability);
  await activateConnectedAppInstallation(actor, staged.id, {
    ...request,
    expected_review_digest: review.review_digest,
    accept_host_policy: true,
  }, capability);

  const [active] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, staged.id),
  ));
  const [effective] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, active!.active_grant_snapshot_id!),
  ));
  assert.equal(active?.state, 'active');
  assert.equal(active?.active_version_id, version.id);
  assert.equal((effective?.canonical_snapshot as any).app.protocol_version, '2');
  assert.equal((await db.select({ value: count() }).from(appRuns).where(
    eq(appRuns.org_id, orgId),
  ))[0]?.value, 0);

  const disabled = await disableAppInstallation(actor, staged.id, active!.lifecycle_epoch);
  assert.equal(disabled.state, 'disabled');
  await assert.rejects(
    enableAppInstallation(actor, staged.id, disabled.lifecycle_epoch),
    (error: unknown) => error instanceof AppError && error.code === 'APP_REVIEW_REQUIRED',
  );
});

test('explicit connected review activates atomically, rejects stale CAS, and re-reviews after revocation', async () => {
  const actor = humanModuleActor({ orgId: OTHER_ORG_ID, userId: OTHER_USER_ID, role: 'owner' });
  const dependencyBuilt = await buildPhase5DependencyAppPackage();
  const dependencyStaged = await stageAppPackage(actor, dependencyBuilt.json);
  const dependency = await activateAppInstallation(
    actor,
    dependencyStaged.id,
    dependencyStaged.package_digest,
  );

  const connectedBuilt = await buildPhase5ConnectedAppPackage();
  const staged = await stageAppPackage(actor, connectedBuilt.json);
  const [version] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, OTHER_ORG_ID),
    eq(appVersions.id, staged.version_id),
  ));
  const [requested] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, OTHER_ORG_ID),
    eq(appGrantSnapshots.id, version!.requested_grant_snapshot_id!),
  ));
  assert.ok(version);
  assert.ok(requested);

  const connectionId = randomUUID();
  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: OTHER_ORG_ID,
    name: 'Reviewed sandbox mail',
    slug: `phase5-reviewed-${TEST_GENERATION}`,
    server_url: 'https://reviewed-sandbox.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    created_by: OTHER_USER_ID,
  });
  const reviewProvider = await sandboxReviewCapability(OTHER_ORG_ID, connectionId);
  const { snapshot, capability } = reviewProvider;
  const [beforeOverride] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  await assert.rejects(
    db.insert(mcpToolOverrides).values({
      id: randomUUID(),
      org_id: ORG_ID,
      mcp_connection_id: connectionId,
      tool_name: 'send_email',
      is_disabled: false,
    }),
    (error: any) => error?.cause?.code === '23503'
      && error?.cause?.constraint === 'mcp_tool_overrides_org_connection_fk',
  );
  const overrideId = randomUUID();
  await db.insert(mcpToolOverrides).values({
    id: overrideId,
    org_id: OTHER_ORG_ID,
    mcp_connection_id: connectionId,
    tool_name: 'send_email',
    is_disabled: false,
  });
  await db.delete(mcpToolOverrides).where(eq(mcpToolOverrides.id, overrideId));
  const [afterOverride] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  assert.equal(
    afterOverride?.app_run_authorization_version,
    beforeOverride!.app_run_authorization_version + 2,
  );
  const baseRequest = {
    app_version_id: version.id,
    expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: staged.lifecycle_epoch,
    expected_grant_epoch: staged.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const legacyDisabledOverrideId = randomUUID();
  await db.insert(mcpToolOverrides).values({
    id: legacyDisabledOverrideId,
    org_id: OTHER_ORG_ID,
    mcp_connection_id: connectionId,
    tool_name: 'mcp__legacy_mail__send_email',
    is_disabled: true,
  });
  await assert.rejects(
    prepareConnectedAppReview(actor, staged.id, baseRequest, capability),
    (error: unknown) => error instanceof AppError && error.code === 'APP_PROVIDER_UNAVAILABLE',
  );
  await db.delete(mcpToolOverrides).where(eq(mcpToolOverrides.id, legacyDisabledOverrideId));
  const disabledDependency = await disableAppInstallation(
    actor,
    dependency.id,
    dependency.lifecycle_epoch,
  );
  await assert.rejects(
    prepareConnectedAppReview(actor, staged.id, baseRequest, capability),
    (error: unknown) => error instanceof AppError && error.code === 'APP_DEPENDENCY_UNHEALTHY',
  );
  const reenabledDependency = await enableAppInstallation(
    actor,
    dependency.id,
    disabledDependency.lifecycle_epoch,
  );
  const firstReview = await prepareConnectedAppReview(actor, staged.id, baseRequest, capability);
  assert.equal(firstReview.permission_diff.kind, 'initial');
  assert.equal(firstReview.action_bindings[0]?.operation_name, 'send_email');
  assert.equal((await db.select({ value: count() }).from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, OTHER_ORG_ID),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  )))[0]?.value, 0);

  const driftedDependency = await disableAppInstallation(
    actor,
    dependency.id,
    reenabledDependency.lifecycle_epoch,
  );
  await assert.rejects(
    activateConnectedAppInstallation(actor, staged.id, {
      ...baseRequest,
      expected_review_digest: firstReview.review_digest,
      accept_host_policy: true,
    }, capability),
    (error: unknown) => error instanceof AppError && error.code === 'APP_DEPENDENCY_UNHEALTHY',
  );
  const restoredDependency = await enableAppInstallation(
    actor,
    dependency.id,
    driftedDependency.lifecycle_epoch,
  );

  await db.update(mcpConnections).set({ is_active: false }).where(and(
    eq(mcpConnections.org_id, OTHER_ORG_ID),
    eq(mcpConnections.id, connectionId),
  ));
  await assert.rejects(
    activateConnectedAppInstallation(actor, staged.id, {
      ...baseRequest,
      expected_review_digest: firstReview.review_digest,
      accept_host_policy: true,
    }, capability),
    (error: unknown) => error instanceof AppError && error.code === 'APP_PROVIDER_UNAVAILABLE',
  );
  const [afterDrift] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(afterDrift?.state, 'staged');
  assert.equal(afterDrift?.active_grant_snapshot_id, null);
  assert.equal((await db.select({ value: count() }).from(appActionBindings).where(
    eq(appActionBindings.app_installation_id, staged.id),
  ))[0]?.value, 0);

  await db.update(mcpConnections).set({ is_active: true }).where(and(
    eq(mcpConnections.org_id, OTHER_ORG_ID),
    eq(mcpConnections.id, connectionId),
  ));
  const [restoredConnection] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId));
  const restoredRequest = { ...baseRequest };
  const restoredReview = await prepareConnectedAppReview(actor, staged.id, restoredRequest, capability);
  assert.notEqual(
    restoredReview.action_bindings[0]?.connector_authorization_version,
    firstReview.action_bindings[0]?.connector_authorization_version,
  );
  const concurrent = await Promise.allSettled([
    activateConnectedAppInstallation(actor, staged.id, {
      ...restoredRequest,
      expected_review_digest: restoredReview.review_digest,
      accept_host_policy: true,
    }, capability),
    activateConnectedAppInstallation(actor, staged.id, {
      ...restoredRequest,
      expected_review_digest: restoredReview.review_digest,
      accept_host_policy: true,
    }, capability),
  ]);
  assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter((item) => item.status === 'rejected').length, 1);
  assert.ok(concurrent.some((item) => item.status === 'rejected'
    && item.reason instanceof AppError
    && item.reason.code === 'APP_STALE'));

  const [active] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(active?.state, 'active');
  assert.ok(active?.active_grant_snapshot_id);
  assert.equal(active?.grant_epoch, 1);
  await assert.rejects(
    db.update(appInstallations).set({
      active_grant_snapshot_id: null,
      active_grant_snapshot_kind: null,
    }).where(eq(appInstallations.id, staged.id)),
    (error: any) => error?.cause?.code === '23514'
      && error?.cause?.message === 'APP_GRANT_EPOCH_MISMATCH',
  );
  await assert.rejects(
    db.update(appInstallations).set({
      state: 'disabled',
      disabled_at: new Date(),
    }).where(eq(appInstallations.id, staged.id)),
    (error: any) => error?.cause?.code === '23514'
      && error?.cause?.message === 'APP_LIFECYCLE_EPOCH_MISMATCH',
  );
  const [binding] = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, OTHER_ORG_ID),
    eq(appActionBindings.app_installation_id, staged.id),
    eq(appActionBindings.grant_snapshot_id, active!.active_grant_snapshot_id!),
  ));
  assert.equal(binding?.operation_name, 'send_email');
  assert.equal(binding?.provider_snapshot_id.length > 0, true);
  assert.equal((await db.select({ value: count() }).from(appRuns).where(
    eq(appRuns.org_id, OTHER_ORG_ID),
  ))[0]?.value, 0);
  const management = await getConnectedAppGrantManagement(actor, staged.id);
  assert.equal(management.installation.active_grant_snapshot_id, active!.active_grant_snapshot_id);
  assert.equal(management.compatibility.app_kit.package, '@deft/app-kit');
  assert.equal(management.compatibility.protocol_flows['1'].install_mode, 'stage_only');
  assert.equal(management.review_target, null);
  assert.equal(management.snapshots.filter((item) => item.snapshot_kind === 'effective').length, 1);
  assert.equal(management.dependencies.length, 1);
  assert.equal(management.dependencies[0]?.grant_snapshot_id, active!.active_grant_snapshot_id);
  assert.equal(management.action_bindings[0]?.operation_name, 'send_email');
  assert.equal(management.action_bindings[0]?.grant_snapshot_id, active!.active_grant_snapshot_id);
  assert.deepEqual(management.recent_runs, []);
  const managementJson = JSON.stringify(management);
  for (const forbidden of ['server_url', 'access_token', 'refresh_token', 'reviewed_by_actor_id', 'provider_snapshot_id']) {
    assert.equal(managementJson.includes(forbidden), false, `management projection leaked ${forbidden}`);
  }
  const healthy = await inspectConnectedAppHealth(
    actor,
    staged.id,
    { refresh_provider_schemas: true },
    capability,
  );
  assert.equal(healthy.status, 'healthy');
  const driftedSnapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
    provider: snapshot.provider,
    captured_at: '2026-08-31T12:05:00.000Z',
    operations: [{
      identity: snapshot.operations[0]!.identity,
      title: 'Send sandbox email',
      description: 'Changed provider contract.',
      input_schema: {
        ...SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
        properties: {
          ...SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema.properties,
          campaign_tag: { type: 'string' },
        },
      },
      output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    }],
  });
  const driftedHealth = await inspectConnectedAppHealth(
    actor,
    staged.id,
    { refresh_provider_schemas: true },
    { discover: async () => ({ ...await capability.discover(), snapshot: driftedSnapshot }) },
  );
  assert.equal(driftedHealth.status, 'unhealthy');
  assert.equal(driftedHealth.issues.some((issue) => issue.code === 'APP_PROVIDER_SCHEMA_DRIFT'), true);

  const disabled = await disableAppInstallation(actor, staged.id, active!.lifecycle_epoch);
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.grant_epoch, 2);
  const [revoked] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(revoked?.active_grant_snapshot_id, null);
  await assert.rejects(
    enableAppInstallation(actor, staged.id, revoked!.lifecycle_epoch),
    (error: unknown) => error instanceof AppError && error.code === 'APP_REVIEW_REQUIRED',
  );
  const disabledManagement = await getConnectedAppGrantManagement(actor, staged.id);
  assert.equal(disabledManagement.review_target?.activation_kind, 'reenable');
  assert.equal(disabledManagement.review_target?.app_version_id, active!.active_version_id);
  assert.equal(disabledManagement.review_target?.readiness.dependencies_ready, true);
  assert.equal(disabledManagement.review_target?.connector_requirements[0]?.current_binding?.configured, true);
  assert.equal(disabledManagement.installation.lifecycle_epoch, revoked!.lifecycle_epoch);
  assert.equal(disabledManagement.installation.grant_epoch, revoked!.grant_epoch);

  const reactivationRequest = {
    ...restoredRequest,
    expected_lifecycle_epoch: revoked!.lifecycle_epoch,
    expected_grant_epoch: revoked!.grant_epoch,
  };
  const reactivationReview = await prepareConnectedAppReview(
    actor,
    staged.id,
    reactivationRequest,
    capability,
  );
  assert.equal(reactivationReview.permission_diff.kind, 'unchanged');
  const reactivated = await activateConnectedAppInstallation(actor, staged.id, {
    ...reactivationRequest,
    expected_review_digest: reactivationReview.review_digest,
    accept_host_policy: false,
    allow_identical_carry_forward: true,
  }, capability);
  assert.equal(reactivated.permission_diff.carry_forward_eligible, true);
  const [afterReactivation] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(afterReactivation?.state, 'active');
  assert.equal(afterReactivation?.grant_epoch, 3);
  const effective = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, OTHER_ORG_ID),
    eq(appGrantSnapshots.app_installation_id, staged.id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  ));
  assert.equal(effective.length, 2);
  assert.equal(effective.some((item) => item.supersedes_snapshot_id === active!.active_grant_snapshot_id), true);
  const historicalLocks = await db.select().from(appDependencyLocks).where(and(
    eq(appDependencyLocks.org_id, OTHER_ORG_ID),
    eq(appDependencyLocks.app_installation_id, staged.id),
    eq(appDependencyLocks.dependency_installation_id, dependency.id),
  ));
  assert.equal(historicalLocks.length, 2);

  const dependencyRefusal: unknown = await refuseAppUninstall(
    actor,
    dependency.id,
    restoredDependency.lifecycle_epoch,
  ).catch((error: unknown) => error);
  assert.ok(dependencyRefusal instanceof AppError);
  assert.equal(dependencyRefusal.code, 'APP_DEPENDENCY_IN_USE');
  assert.deepEqual(dependencyRefusal.details, {
    dependents: [{
      installation_id: staged.id,
      app_id: 'org.deft.reference.resource-campaigns-app',
      state: 'active',
    }],
    cascaded: false,
  });

  const routeApp = new Hono();
  routeApp.use('*', async (context, next) => {
    context.set('user', {
      id: OTHER_USER_ID,
      org_id: OTHER_ORG_ID,
      email: `phase5-other-${TEST_GENERATION}@example.test`,
      name: 'Other Connected Apps owner',
      role: 'owner',
    });
    await next();
  });
  routeApp.route('/api/apps', appRoutes);
  const dependencyResponse = await routeApp.request(`/api/apps/${dependency.id}/uninstall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_lifecycle_epoch: restoredDependency.lifecycle_epoch }),
  });
  assert.equal(dependencyResponse.status, 409);
  assert.deepEqual(await dependencyResponse.json(), {
    error: 'App cannot be uninstalled while another App depends on it',
    code: 'APP_DEPENDENCY_IN_USE',
    details: dependencyRefusal.details,
  });

  const staleResponse = await routeApp.request(`/api/apps/${dependency.id}/uninstall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_lifecycle_epoch: restoredDependency.lifecycle_epoch + 1 }),
  });
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await staleResponse.json(), {
    error: 'App lifecycle changed',
    code: 'APP_STALE',
  });

  await db.update(orgMembers).set({ role: 'member' }).where(and(
    eq(orgMembers.org_id, OTHER_ORG_ID),
    eq(orgMembers.user_id, OTHER_USER_ID),
  ));
  try {
    await assert.rejects(
      getConnectedAppGrantManagement(actor, staged.id),
      (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_ACCESS_DENIED',
    );
    await assert.rejects(
      inspectConnectedAppHealth(actor, staged.id, { refresh_provider_schemas: false }),
      (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_ACCESS_DENIED',
    );
    const accessResponse = await routeApp.request(`/api/apps/${dependency.id}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_lifecycle_epoch: restoredDependency.lifecycle_epoch }),
    });
    assert.equal(accessResponse.status, 403);
    assert.deepEqual(await accessResponse.json(), {
      error: 'Only active workspace owners and admins can manage Apps',
      code: 'APP_ACCESS_DENIED',
    });
  } finally {
    await db.update(orgMembers).set({ role: 'owner' }).where(and(
      eq(orgMembers.org_id, OTHER_ORG_ID),
      eq(orgMembers.user_id, OTHER_USER_ID),
    ));
  }
  assert.equal(reviewProvider.discoveryCalls() >= 5, true);
  assert.equal(restoredConnection?.is_active, true);
});

test('reviewed v0-to-v1 upgrade atomically preserves App pointers, Module data, and rollback', async () => {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({
    id: orgId,
    name: 'Connected upgrade',
    slug: `phase5-upgrade-${randomUUID()}`,
  });
  await db.insert(users).values({
    id: userId,
    email: `phase5-upgrade-${randomUUID()}@example.test`,
    name: 'Connected upgrade owner',
  });
  await db.insert(orgMembers).values({
    id: randomUUID(),
    org_id: orgId,
    user_id: userId,
    role: 'owner',
    is_active: true,
  });
  const actor = humanModuleActor({ orgId, userId, role: 'owner' });

  const dependencyBuilt = await buildPhase5DependencyAppPackage();
  const dependencyStaged = await stageAppPackage(actor, dependencyBuilt.json);
  const dependency = await activateAppInstallation(
    actor,
    dependencyStaged.id,
    dependencyStaged.package_digest,
  );
  const [dependencyBinding] = await db.select({ binding: appModuleBindings, version: moduleVersions })
    .from(appModuleBindings)
    .innerJoin(moduleVersions, and(
      eq(moduleVersions.org_id, appModuleBindings.org_id),
      eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
      eq(moduleVersions.id, appModuleBindings.module_version_id),
    ))
    .where(and(
      eq(appModuleBindings.org_id, orgId),
      eq(appModuleBindings.app_installation_id, dependency.id),
      eq(appModuleBindings.app_version_id, dependency.active_version_id!),
    ));
  assert.ok(dependencyBinding);
  const contact = await createModuleRecord(actor, {
    module_id: 'org.deft.reference.resource-contacts',
    collection_key: 'contacts',
    data: { name: 'Ada Lovelace', email: 'ada@example.test' },
    relations: {},
    expected_manifest_digest: dependencyBinding.version.manifest_digest,
    idempotency_key: 'phase5-upgrade-preserved-contact',
  });
  assert.ok(contact.record);
  const predecessorBuilt = await buildPhase5ConnectedPredecessorAppPackage();
  const predecessorStaged = await stageAppPackage(actor, predecessorBuilt.json);
  const predecessor = await activateAppInstallation(
    actor,
    predecessorStaged.id,
    predecessorStaged.package_digest,
  );
  const [priorBinding] = await db.select({ binding: appModuleBindings, version: moduleVersions })
    .from(appModuleBindings)
    .innerJoin(moduleVersions, and(
      eq(moduleVersions.org_id, appModuleBindings.org_id),
      eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
      eq(moduleVersions.id, appModuleBindings.module_version_id),
    ))
    .where(and(
      eq(appModuleBindings.org_id, orgId),
      eq(appModuleBindings.app_installation_id, predecessor.id),
      eq(appModuleBindings.app_version_id, predecessor.active_version_id!),
    ));
  assert.ok(priorBinding);
  const created = await createModuleRecord(actor, {
    module_id: 'org.deft.reference.resource-campaigns',
    collection_key: 'campaigns',
    data: { name: 'Preserve this campaign', subject: 'Preserve this campaign', status: 'draft' },
    relations: {},
    expected_manifest_digest: priorBinding.version.manifest_digest,
    idempotency_key: 'phase5-upgrade-preserved-record',
  });
  assert.ok(created.record);
  const campaignRef = moduleRef(
    priorBinding.binding.module_installation_id,
    'campaigns',
    created.record.id,
  );
  const contactRef = moduleRef(
    dependencyBinding.binding.module_installation_id,
    'contacts',
    contact.record!.id,
  );
  const linked = await replaceResourceRelation(actor, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: campaignRef,
    relation_key: 'contacts',
    refs: [contactRef],
    expected_revision: 0,
    idempotency_key: 'phase5-upgrade-preserved-relation',
  });
  assert.equal(linked.revision, 1);
  const relationBeforeUpgrade = await relationPersistenceSnapshot(
    orgId,
    priorBinding.binding.module_installation_id,
    created.record.id,
  );
  assert.equal(relationBeforeUpgrade.revision, 1);
  assert.equal(relationBeforeUpgrade.target_resource_id, contact.record!.id);

  const olderUpgradeBuilt = await buildPhase5ConnectedAppPackage();
  const olderUpgrade = await stageAppUpgrade(
    actor,
    predecessor.id,
    olderUpgradeBuilt.json,
    predecessor.lifecycle_epoch,
  );
  const [olderUpgradeVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, olderUpgrade.version_id),
  ));
  const [olderUpgradeRequest] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, olderUpgradeVersion!.requested_grant_snapshot_id!),
  ));
  assert.ok(olderUpgradeVersion);
  assert.ok(olderUpgradeRequest);

  const upgradeBuilt = await buildPhase5ConnectedAppPackage({ app_version: '3.0.1' });
  const upgrade = await stageAppUpgrade(
    actor,
    predecessor.id,
    upgradeBuilt.json,
    predecessor.lifecycle_epoch,
  );
  const [upgradeVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, upgrade.version_id),
  ));
  const [upgradeRequest] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, upgradeVersion!.requested_grant_snapshot_id!),
  ));
  assert.ok(upgradeVersion);
  assert.ok(upgradeRequest);
  const stagedUpgradeManagement = await getConnectedAppGrantManagement(actor, predecessor.id);
  assert.equal(stagedUpgradeManagement.installation.active_version_id, predecessor.active_version_id);
  assert.equal(stagedUpgradeManagement.review_target?.activation_kind, 'upgrade');
  assert.equal(stagedUpgradeManagement.review_target?.app_version_id, upgradeVersion.id);
  assert.equal(stagedUpgradeManagement.review_target?.package_digest, upgradeVersion.package_digest);
  assert.equal(stagedUpgradeManagement.review_target?.requested_snapshot_digest, upgradeRequest.snapshot_digest);
  assert.equal(stagedUpgradeManagement.review_target?.provenance_trust, 'local_unsigned');
  assert.equal(stagedUpgradeManagement.review_target?.dependency_requirements[0]?.status, 'ready');
  assert.equal(stagedUpgradeManagement.review_target?.missing_binding_keys.includes('mail_provider'), true);
  const connectionId = randomUUID();
  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: orgId,
    name: 'Upgrade sandbox mail',
    slug: `phase5-upgrade-mail-${randomUUID()}`,
    server_url: 'https://upgrade-sandbox.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    created_by: userId,
  });
  const reviewProvider = await sandboxReviewCapability(orgId, connectionId);
  const olderReviewRequest = {
    app_version_id: olderUpgradeVersion.id,
    expected_package_digest: olderUpgradeVersion.package_digest,
    expected_requested_snapshot_digest: olderUpgradeRequest.snapshot_digest,
    expected_lifecycle_epoch: predecessor.lifecycle_epoch,
    expected_grant_epoch: predecessor.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const discoveryCallsBeforeOlderTarget = reviewProvider.discoveryCalls();
  await assert.rejects(
    prepareConnectedAppReview(actor, predecessor.id, olderReviewRequest, reviewProvider.capability),
    (error: unknown) => error instanceof AppError && error.code === 'APP_STALE',
  );
  assert.equal(reviewProvider.discoveryCalls(), discoveryCallsBeforeOlderTarget);
  const reviewRequest = {
    app_version_id: upgradeVersion.id,
    expected_package_digest: upgradeVersion.package_digest,
    expected_requested_snapshot_digest: upgradeRequest.snapshot_digest,
    expected_lifecycle_epoch: predecessor.lifecycle_epoch,
    expected_grant_epoch: predecessor.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const review = await prepareConnectedAppReview(
    actor,
    predecessor.id,
    reviewRequest,
    reviewProvider.capability,
  );
  const discoveryCallsBeforeDemotion = reviewProvider.discoveryCalls();
  await db.update(orgMembers).set({ role: 'member' }).where(and(
    eq(orgMembers.org_id, orgId),
    eq(orgMembers.user_id, userId),
  ));
  try {
    await assert.rejects(
      activateConnectedAppInstallation(actor, predecessor.id, {
        ...reviewRequest,
        expected_review_digest: review.review_digest,
        accept_host_policy: true,
      }, reviewProvider.capability),
      (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_ACCESS_DENIED',
    );
    assert.equal(reviewProvider.discoveryCalls(), discoveryCallsBeforeDemotion);
  } finally {
    await db.update(orgMembers).set({ role: 'owner' }).where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, userId),
    ));
  }
  await assert.rejects(
    activateConnectedAppInstallation(actor, predecessor.id, {
      ...reviewRequest,
      expected_review_digest: review.review_digest,
      accept_host_policy: true,
    }, reviewProvider.capability, { failBeforePointerSwap: true }),
    /Injected connected App activation failure/,
  );
  const [afterFailure] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, predecessor.id),
  ));
  const [moduleAfterFailure] = await db.select().from(moduleVersions).where(and(
    eq(moduleVersions.org_id, orgId),
    eq(moduleVersions.installation_id, priorBinding.binding.module_installation_id),
    eq(moduleVersions.is_active, true),
  ));
  const [recordAfterFailure] = await db.select().from(moduleRecords).where(and(
    eq(moduleRecords.org_id, orgId),
    eq(moduleRecords.id, created.record!.id),
  ));
  assert.equal(afterFailure?.active_version_id, predecessor.active_version_id);
  assert.equal(afterFailure?.active_grant_snapshot_id, null);
  assert.equal(afterFailure?.lifecycle_epoch, predecessor.lifecycle_epoch);
  assert.equal(moduleAfterFailure?.id, priorBinding.version.id);
  assert.equal(recordAfterFailure?.validated_version_id, priorBinding.version.id);
  assert.deepEqual(recordAfterFailure?.data, {
    name: 'Preserve this campaign',
    subject: 'Preserve this campaign',
    status: 'draft',
  });
  assert.deepEqual(
    await relationPersistenceSnapshot(
      orgId,
      priorBinding.binding.module_installation_id,
      created.record!.id,
    ),
    relationBeforeUpgrade,
  );
  assert.equal((await db.select({ value: count() }).from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.app_version_id, upgradeVersion.id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  )))[0]?.value, 0);

  await activateConnectedAppInstallation(actor, predecessor.id, {
    ...reviewRequest,
    expected_review_digest: review.review_digest,
    accept_host_policy: true,
  }, reviewProvider.capability);
  const [afterUpgrade] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, predecessor.id),
  ));
  const [oldVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, predecessor.active_version_id!),
  ));
  const [newModule] = await db.select().from(moduleVersions).where(and(
    eq(moduleVersions.org_id, orgId),
    eq(moduleVersions.installation_id, priorBinding.binding.module_installation_id),
    eq(moduleVersions.is_active, true),
  ));
  const [preservedRecord] = await db.select().from(moduleRecords).where(and(
    eq(moduleRecords.org_id, orgId),
    eq(moduleRecords.id, created.record!.id),
  ));
  assert.equal(afterUpgrade?.active_version_id, upgradeVersion.id);
  assert.ok(afterUpgrade?.active_grant_snapshot_id);
  assert.equal(afterUpgrade?.lifecycle_epoch, predecessor.lifecycle_epoch + 1);
  assert.equal(afterUpgrade?.grant_epoch, predecessor.grant_epoch + 1);
  assert.equal(oldVersion?.state, 'superseded');
  await assert.rejects(
    db.update(appVersions).set({ state: 'active', superseded_at: null }).where(and(
      eq(appVersions.org_id, orgId),
      eq(appVersions.id, oldVersion!.id),
    )),
    (error: any) => error?.cause?.code === '55000'
      && error?.cause?.message === 'APP_VERSION_INVALID_TRANSITION',
  );
  assert.equal(newModule?.version, '3.0.0');
  assert.equal(preservedRecord?.validated_version_id, newModule?.id);
  assert.deepEqual(preservedRecord?.data, {
    name: 'Preserve this campaign',
    subject: 'Preserve this campaign',
    status: 'draft',
  });
  assert.deepEqual(
    await relationPersistenceSnapshot(
      orgId,
      priorBinding.binding.module_installation_id,
      created.record!.id,
    ),
    relationBeforeUpgrade,
  );
  const bindings = await db.select().from(appModuleBindings).where(and(
    eq(appModuleBindings.org_id, orgId),
    eq(appModuleBindings.app_installation_id, predecessor.id),
    eq(appModuleBindings.module_installation_id, priorBinding.binding.module_installation_id),
  ));
  assert.equal(bindings.length, 2);
  assert.deepEqual(new Set(bindings.map((item) => item.app_version_id)), new Set([
    predecessor.active_version_id!,
    upgradeVersion.id,
  ]));

  const snapshotGraph = async () => {
    const installations = await db.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, orgId),
      inArray(appInstallations.id, [dependency.id, predecessor.id]),
    )).orderBy(appInstallations.id);
    const records = await db.select().from(moduleRecords).where(and(
      eq(moduleRecords.org_id, orgId),
      inArray(moduleRecords.id, [contact.record!.id, created.record!.id]),
    )).orderBy(moduleRecords.id);
    const dependencyLocks = await db.select().from(appDependencyLocks).where(and(
      eq(appDependencyLocks.org_id, orgId),
      eq(appDependencyLocks.app_installation_id, predecessor.id),
    )).orderBy(appDependencyLocks.app_version_id, appDependencyLocks.dependency_installation_id);
    return {
      installations,
      records,
      dependencyLocks,
      relation: await relationPersistenceSnapshot(
        orgId,
        priorBinding.binding.module_installation_id,
        created.record!.id,
      ),
    };
  };
  const graphBeforeUninstallRefusals = await snapshotGraph();
  assert.equal(graphBeforeUninstallRefusals.dependencyLocks.length, 1);
  assert.equal(
    graphBeforeUninstallRefusals.dependencyLocks[0]?.dependency_installation_id,
    dependency.id,
  );

  const dependencyRefusal: unknown = await refuseAppUninstall(
    actor,
    dependency.id,
    dependency.lifecycle_epoch,
  ).catch((error: unknown) => error);
  assert.ok(dependencyRefusal instanceof AppError);
  assert.equal(dependencyRefusal.code, 'APP_DEPENDENCY_IN_USE');
  assert.deepEqual(dependencyRefusal.details, {
    dependents: [{
      installation_id: predecessor.id,
      app_id: 'org.deft.reference.resource-campaigns-app',
      state: 'active',
    }],
    cascaded: false,
  });
  assert.deepEqual(await snapshotGraph(), graphBeforeUninstallRefusals);

  const retentionRefusal: unknown = await refuseAppUninstall(
    actor,
    predecessor.id,
    afterUpgrade!.lifecycle_epoch,
  ).catch((error: unknown) => error);
  assert.ok(retentionRefusal instanceof AppError);
  assert.equal(retentionRefusal.code, 'APP_UNINSTALL_REQUIRES_RETENTION_DECISION');
  assert.deepEqual(retentionRefusal.details, { cascaded: false, data_preserved: true });
  assert.deepEqual(await snapshotGraph(), graphBeforeUninstallRefusals);

  const identicalBuilt = await buildPhase5ConnectedAppPackage({ app_version: '3.0.2' });
  const identical = await stageAppUpgrade(
    actor,
    predecessor.id,
    identicalBuilt.json,
    afterUpgrade!.lifecycle_epoch,
  );
  const [identicalVersion] = await db.select().from(appVersions).where(eq(appVersions.id, identical.version_id));
  const [identicalRequest] = await db.select().from(appGrantSnapshots).where(
    eq(appGrantSnapshots.id, identicalVersion!.requested_grant_snapshot_id!),
  );
  const identicalReviewRequest = {
    ...reviewRequest,
    app_version_id: identicalVersion!.id,
    expected_package_digest: identicalVersion!.package_digest,
    expected_requested_snapshot_digest: identicalRequest!.snapshot_digest,
    expected_lifecycle_epoch: afterUpgrade!.lifecycle_epoch,
    expected_grant_epoch: afterUpgrade!.grant_epoch,
  };
  const identicalReview = await prepareConnectedAppReview(
    actor,
    predecessor.id,
    identicalReviewRequest,
    reviewProvider.capability,
  );
  assert.equal(identicalReview.permission_diff.kind, 'unchanged');
  assert.equal(identicalReview.permission_diff.carry_forward_eligible, true);
  await activateConnectedAppInstallation(actor, predecessor.id, {
    ...identicalReviewRequest,
    expected_review_digest: identicalReview.review_digest,
    accept_host_policy: false,
    allow_identical_carry_forward: true,
  }, reviewProvider.capability);
  const [afterCarry] = await db.select().from(appInstallations).where(eq(appInstallations.id, predecessor.id));
  assert.equal(afterCarry?.active_version_id, identicalVersion!.id);
  assert.equal(afterCarry?.grant_epoch, afterUpgrade!.grant_epoch + 1);

  const widenedBuilt = await buildPhase5ConnectedAppPackage({
    app_version: '3.1.0',
    module_version: '3.1.0',
    add_campaign_code: true,
  });
  const widened = await stageAppUpgrade(
    actor,
    predecessor.id,
    widenedBuilt.json,
    afterCarry!.lifecycle_epoch,
  );
  const [widenedVersion] = await db.select().from(appVersions).where(eq(appVersions.id, widened.version_id));
  const [widenedRequest] = await db.select().from(appGrantSnapshots).where(
    eq(appGrantSnapshots.id, widenedVersion!.requested_grant_snapshot_id!),
  );
  const widenedReviewRequest = {
    ...reviewRequest,
    app_version_id: widenedVersion!.id,
    expected_package_digest: widenedVersion!.package_digest,
    expected_requested_snapshot_digest: widenedRequest!.snapshot_digest,
    expected_lifecycle_epoch: afterCarry!.lifecycle_epoch,
    expected_grant_epoch: afterCarry!.grant_epoch,
  };
  const widenedReview = await prepareConnectedAppReview(
    actor,
    predecessor.id,
    widenedReviewRequest,
    reviewProvider.capability,
  );
  assert.equal(widenedReview.permission_diff.kind, 'widening_or_incompatible');
  assert.deepEqual(widenedReview.permission_diff.changed_atoms, ['resources', 'included_modules']);
  assert.equal(widenedReview.permission_diff.carry_forward_eligible, false);
  await assert.rejects(
    activateConnectedAppInstallation(actor, predecessor.id, {
      ...widenedReviewRequest,
      expected_review_digest: widenedReview.review_digest,
      accept_host_policy: false,
      allow_identical_carry_forward: true,
    }, reviewProvider.capability),
    (error: unknown) => error instanceof AppError && error.code === 'APP_REVIEW_REQUIRED',
  );
  const [afterWideningRejection] = await db.select().from(appInstallations).where(
    eq(appInstallations.id, predecessor.id),
  );
  assert.equal(afterWideningRejection?.active_version_id, identicalVersion!.id);
  assert.equal(afterWideningRejection?.grant_epoch, afterCarry!.grant_epoch);
  assert.equal((await db.select({ value: count() }).from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.app_version_id, widenedVersion!.id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  )))[0]?.value, 0);
});
