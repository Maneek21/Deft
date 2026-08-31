import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT } from '@deft/app-kit';
import {
  CAPABILITY_CONTRACT_VERSIONS,
  createCapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import {
  appActionBindings,
  appGrantSnapshots,
  appVersions,
  mcpConnections,
  orgMembers,
  orgs,
  users,
} from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import { activateAppInstallation, stageAppPackage } from '../src/lib/app-service.js';
import {
  activateConnectedAppInstallation,
  prepareConnectedAppReview,
} from '../src/lib/app-review-service.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import {
  buildPhase5ConnectedAppPackage,
  buildPhase5DependencyAppPackage,
} from './fixtures/phase5-connected-app-package.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(databaseUrl && /phase5.*(?:test|loop4)|(?:test|loop4).*phase5/i.test(
  new URL(databaseUrl).pathname,
));

after(async () => closeDb());

test('App-origin rows require exact tenant-bound installation, version, effective grant, and binding ancestry', {
  skip: !canRun,
}, async () => {
  const suffix = randomUUID();
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const ownerUserId = randomUUID();
  const connectionId = randomUUID();
  const connectionSlug = `cutover-mail-${suffix}`;

  await db.insert(orgs).values([
    { id: orgId, name: 'App origin cutover', slug: `cutover-${suffix}` },
    { id: otherOrgId, name: 'Other cutover tenant', slug: `cutover-other-${suffix}` },
  ]);
  await db.insert(users).values({
    id: ownerUserId,
    email: `cutover-owner-${suffix}@example.test`,
    name: 'Cutover owner',
  });
  await db.insert(orgMembers).values({
    id: randomUUID(),
    org_id: orgId,
    user_id: ownerUserId,
    role: 'owner',
    is_active: true,
  });
  const owner = humanModuleActor({ orgId, userId: ownerUserId, role: 'owner', source: 'ui' });

  const dependencyPackage = await buildPhase5DependencyAppPackage();
  const dependency = await stageAppPackage(owner, dependencyPackage.json);
  await activateAppInstallation(owner, dependency.id, dependency.package_digest);

  const connectedPackage = await buildPhase5ConnectedAppPackage();
  const connected = await stageAppPackage(owner, connectedPackage.json);
  const [version] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.id, connected.version_id),
  ));
  assert.ok(version?.requested_grant_snapshot_id);
  const [requested] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id),
  ));
  assert.ok(requested);

  await db.insert(mcpConnections).values({
    id: connectionId,
    org_id: orgId,
    name: 'Cutover sandbox mail',
    slug: connectionSlug,
    server_url: 'https://cutover-sandbox.example.test/mcp',
    transport: 'streamable-http',
    auth_type: 'none',
    is_active: true,
    enabled_tools: ['send_email'],
    created_by: ownerUserId,
  });
  const discovery = await createCapabilityProviderDiscoverySnapshot({
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
  const capability = {
    async discover() {
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
        snapshot: discovery,
      };
    },
    async invoke() {
      throw new Error('schema cutover proof must not invoke the provider');
    },
  };
  const reviewRequest = {
    app_version_id: version.id,
    expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: connected.lifecycle_epoch,
    expected_grant_epoch: connected.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connectionId,
    }],
  };
  const review = await prepareConnectedAppReview(owner, connected.id, reviewRequest, capability);
  await activateConnectedAppInstallation(owner, connected.id, {
    ...reviewRequest,
    expected_review_digest: review.review_digest,
    accept_host_policy: true,
  }, capability);

  const [binding] = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, orgId),
    eq(appActionBindings.app_installation_id, connected.id),
    eq(appActionBindings.app_version_id, version.id),
  ));
  assert.ok(binding);
  const client = new pg.Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    const baseRunId = randomUUID();
    await client.query(
      `INSERT INTO app_runs (
         id, org_id, contract_version, origin_kind,
         initiating_actor_type, initiating_actor_id,
         execution_actor_type, execution_actor_id,
         provider_kind, provider_instance_id, operation_name, provider_snapshot_id,
         state, risk_class, review_requirement, review_scope, retry_class, retention_class,
         idempotency_key_version, idempotency_fingerprint,
         input_fingerprint_key_version, input_fingerprint,
         authorization_snapshot, safe_preview, root_run_id, parent_run_id, depth,
         input_expires_at, result_expires_at, idempotency_expires_at, attempt_limit
       ) VALUES (
         $1, $2, 'deft.app_run.v1', 'legacy_connector',
         'human', $3, 'human', $3,
         $4, $5, $6, $7,
         'pending', 'external_write', 'always', 'per_invocation', 'idempotent_with_key', 'standard',
         'cutover-v1', $8, 'cutover-v1', $9,
         '{}'::jsonb, '{}'::jsonb, $1, NULL, 0,
         now() + interval '5 minutes', now() + interval '10 minutes',
         now() + interval '1 day', 1
       )`,
      [
        baseRunId,
        orgId,
        ownerUserId,
        binding.provider_kind,
        binding.mcp_connection_id,
        binding.operation_name,
        binding.provider_snapshot_id,
        `hmac-sha256:${'1'.repeat(64)}`,
        `hmac-sha256:${'2'.repeat(64)}`,
      ],
    );

    const insertAppClone = async (values: {
      installationId: string | null;
      versionId: string | null;
      bindingKey: string | null;
      grantId: string | null;
    }) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO app_runs
         SELECT (jsonb_populate_record(
           NULL::app_runs,
           to_jsonb(source) || jsonb_build_object(
             'id', $2::text,
             'origin_kind', 'app',
             'origin_app_installation_id', $3::text,
             'origin_app_version_id', $4::text,
             'origin_app_binding_key', $5::text,
             'origin_app_grant_snapshot_id', $6::text,
             'root_run_id', $2::text,
             'parent_run_id', NULL
           )
         )).* FROM app_runs AS source WHERE source.org_id = $1 AND source.id = $7`,
        [
          orgId,
          id,
          values.installationId,
          values.versionId,
          values.bindingKey,
          values.grantId,
          baseRunId,
        ],
      );
      return id;
    };
    const exact = {
      installationId: binding.app_installation_id,
      versionId: binding.app_version_id,
      bindingKey: binding.action_key,
      grantId: binding.grant_snapshot_id,
    };

    await assert.rejects(
      insertAppClone({ ...exact, grantId: null }),
      (error: any) => error?.constraint === 'app_runs_app_origin_coherence_check',
    );

    const crossTenantInstallationId = randomUUID();
    await client.query(
      `INSERT INTO app_installations (
         id, org_id, app_id, lineage_key, lineage_authority_type, lineage_authority_id,
         source, state, installed_by_actor_type, installed_by_actor_id,
         updated_by_actor_type, updated_by_actor_id
       ) VALUES ($1, $2, $3, $4, 'local_user', $5, 'local', 'staged', 'human', $5, 'human', $5)`,
      [
        crossTenantInstallationId,
        otherOrgId,
        `community.deft.cutover-${suffix}`,
        `local:${suffix}`,
        ownerUserId,
      ],
    );
    await assert.rejects(
      insertAppClone({ ...exact, installationId: crossTenantInstallationId }),
      (error: any) => error?.code === '23503',
    );
    await assert.rejects(
      insertAppClone({ ...exact, versionId: randomUUID() }),
      (error: any) => error?.code === '23503',
    );
    await assert.rejects(
      insertAppClone({ ...exact, bindingKey: 'other_binding' }),
      (error: any) => error?.constraint === 'app_runs_app_action_binding_fk',
    );
    await assert.rejects(
      insertAppClone({ ...exact, grantId: requested.id }),
      (error: any) => error?.constraint === 'app_runs_app_action_binding_fk',
    );

    const validId = await insertAppClone(exact);
    const valid = await client.query<{
      origin_kind: string;
      origin_app_installation_id: string;
      origin_app_version_id: string;
      origin_app_binding_key: string;
      origin_app_grant_snapshot_id: string;
    }>(
      `SELECT origin_kind, origin_app_installation_id, origin_app_version_id,
              origin_app_binding_key, origin_app_grant_snapshot_id
         FROM app_runs WHERE org_id = $1 AND id = $2`,
      [orgId, validId],
    );
    assert.deepEqual(valid.rows[0], {
      origin_kind: 'app',
      origin_app_installation_id: exact.installationId,
      origin_app_version_id: exact.versionId,
      origin_app_binding_key: exact.bindingKey,
      origin_app_grant_snapshot_id: exact.grantId,
    });
  } finally {
    await client.end();
  }
});
