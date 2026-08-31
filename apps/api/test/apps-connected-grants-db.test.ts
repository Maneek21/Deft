import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { canonicalAppPrivateInterfaceIdentity } from '@deft/app-kit';
import {
  agentActions,
  appActionBindings,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appRuns,
  appVersions,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpTokens,
  oauthAccessTokens,
  orgMembers,
  orgs,
  users,
} from '@deft/db/schema';
import { AppError } from '../src/lib/app-errors.js';
import { closeDb, db } from '../src/lib/db.js';
import { activateAppInstallation, stageAppPackage } from '../src/lib/app-service.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import { mcpConnectionRoutes } from '../src/routes/mcp-connections.js';
import {
  buildPhase5ConnectedAppPackage,
  buildPhase5DependencyAppPackage,
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
      && error.code === 'APP_PROTOCOL_UNSUPPORTED'
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
