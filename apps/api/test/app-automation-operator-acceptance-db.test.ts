import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { and, eq } from 'drizzle-orm';
import { appActionBindings, appAutomationDefinitions, appGrantSnapshots, appInstallations, appModuleBindings, appVersions, mcpConnections, moduleInstallations, moduleRecords, moduleVersions, orgMembers, orgs, users } from '@deft/db/schema';
import { RESOURCE_CONTRACT_VERSIONS, ResourceRefV1Schema } from '@deft/shared';
import { db, closeDb } from '../src/lib/db.js';
import { createWebSession } from '../src/lib/web-sessions.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { appRoutes } from '../src/routes/apps.js';
import { appRunRoutes } from '../src/routes/app-runs.js';
import { mcpConnectionRoutes } from '../src/routes/mcp-connections.js';
import { expireAppAutomationDefinition } from '../src/lib/app-automation-definition-service.js';
import { humanModuleActor } from '../src/lib/module-service.js';
import { isCurrentAutomationConnector, isCurrentAutomationModulePin, nextManagedAppAutomationFire, projectAppAutomationManagementEligibility } from '../src/lib/app-automation-management-service.js';
import { CapabilityService } from '../src/lib/capability-service.js';
import { activateAppInstallation, stageAppPackage } from '../src/lib/app-service.js';
import { activateConnectedAppInstallation, prepareConnectedAppReview } from '../src/lib/app-review-service.js';
import { createModuleRecord, updateModuleRecord } from '../src/lib/module-service.js';
import { replaceResourceRelation } from '../src/lib/resource-relation-service.js';
import { createReviewedAppAutomationDefinition, prepareAppAutomationDefinitionReview } from '../src/lib/app-automation-definition-service.js';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';
import { buildPhase5DependencyAppPackage, buildTrackAAutomatedConnectedAppPackage } from './fixtures/phase5-connected-app-package.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const safe = databaseUrl === process.env.DEFT_TEST_DATABASE_URL
  && databaseUrl === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_phase5_test_c04_a01';

after(closeDb);

type OperatorDefinition = {
  id: string;
  state: string;
  eligibility: { status: string; reason: string };
  validity: { valid_from: string; valid_until: string };
  next_fire_at_utc: string | null;
  latest_fire: null | { state: string; terminal_reason: string | null };
  latest_run: null | { id: string; state: string };
  retry: { eligible: boolean; reason: string };
};

test('A01 controlled clock keeps a future next fire for live waiting authority and suppresses stale authority', () => {
  const definition = {
    state: 'active' as const,
    local_time: '10:00', timezone: 'UTC',
    valid_from: new Date('2030-01-02T00:00:00.000Z'),
    valid_until: new Date('2030-01-04T00:00:00.000Z'),
    state_changed_at: new Date('2030-01-01T00:00:00.000Z'),
  };
  const now = new Date('2030-01-01T12:00:00.000Z');
  assert.equal(projectAppAutomationManagementEligibility(definition, now, true, true).status, 'waiting');
  assert.equal(projectAppAutomationManagementEligibility(definition, now, true, false).status, 'blocked');
  assert.equal(nextManagedAppAutomationFire(definition, now, true, true), '2030-01-02T10:00:00.000Z');
  assert.equal(nextManagedAppAutomationFire(definition, now, true, false), null);
  assert.equal(nextManagedAppAutomationFire(definition, now, false, true), null);
});

/** Seed this dedicated disposable DB with the existing governed lifecycle fixture:
 * `pnpm exec tsx --test --test-name-pattern='Protocol v2 review and automation lifecycle converge on one governed Run' test/apps-connected-grants-db.test.ts`
 * It creates 101 approved definitions, real blocked fires, a Run and a signed receipt. */
test('A01 operator HTTP pages 100+ governed definitions and exposes current results and receipts',
  { skip: !safe }, async () => {
    const [fixtureOrg] = await db.select({ id: orgs.id }).from(orgs)
      .where(eq(orgs.name, 'Protocol v2 lifecycle')).limit(1);
    assert.ok(fixtureOrg, 'run the named governed lifecycle fixture on this dedicated DB first');
    const [seed] = await db.select().from(appAutomationDefinitions)
      .where(eq(appAutomationDefinitions.org_id, fixtureOrg.id)).limit(1);
    assert.ok(seed);
    const [installation] = await db.select().from(appInstallations)
      .where(and(eq(appInstallations.org_id, fixtureOrg.id),
        eq(appInstallations.id, seed.app_installation_id))).limit(1);
    assert.equal(installation?.state, 'disabled', 'fixture ends with an App kill');
    const [owner] = await db.select({ id: users.id, email: users.email }).from(users)
      .where(eq(users.id, seed.created_by_user_id)).limit(1);
    assert.ok(owner);
    const token = (await createWebSession({ id: owner.id, org_id: fixtureOrg.id,
      email: owner.email })).accessToken;
    const app = new Hono();
    app.use('/api/*', authMiddleware);
    app.route('/api/apps', appRoutes);
    app.route('/api/app-runs', appRunRoutes);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const request = (path: string) => fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const definitions: OperatorDefinition[] = [];
      const pageSizes: number[] = [];
      let cursor: string | null = null;
      do {
        const path = `/api/apps/${seed.app_installation_id}/automations?limit=50`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const response = await request(path);
        assert.equal(response.status, 200);
        const body = await response.json() as { automations: {
          definitions: OperatorDefinition[]; next_cursor: string | null;
          kill_switch: { enabled: boolean };
        } };
        assert.equal(body.automations.kill_switch.enabled, true);
        pageSizes.push(body.automations.definitions.length);
        definitions.push(...body.automations.definitions);
        cursor = body.automations.next_cursor;
      } while (cursor);
      assert.deepEqual(pageSizes, [50, 50, 7]);
      assert.equal(definitions.length, 107);
      assert.equal(new Set(definitions.map((item) => item.id)).size, 107);
      assert.ok(definitions.some((item) => item.state === 'paused'));
      assert.ok(definitions.every((item) => Date.parse(item.validity.valid_until)
        > Date.parse(item.validity.valid_from)));
      const blockedFire = definitions.find((item) => item.latest_fire?.state === 'dead_letter');
      assert.ok(blockedFire);
      assert.equal(blockedFire.retry.eligible, false);
      assert.match(blockedFire.retry.reason, /freshly reviewed/);
      const skipped = definitions.find((item) => item.latest_fire?.terminal_reason === 'definition_ineligible');
      assert.ok(skipped, 'paused/App-disabled delivery stays visible to the operator');
      const completed = definitions.find((item) => item.latest_run?.state === 'succeeded');
      assert.ok(completed?.latest_run);
      const runResponse = await request(`/api/app-runs/${completed.latest_run.id}`);
      assert.equal(runResponse.status, 200);
      await runResponse.json();
      const receiptResponse = await request(`/api/app-runs/${completed.latest_run.id}/receipts`);
      assert.equal(receiptResponse.status, 200);
      const receipt = await receiptResponse.json() as { run: { id: string }; receipts: unknown[] };
      assert.equal(receipt.run.id, completed.latest_run.id);
      assert.equal(receipt.receipts.length, 1);
      const invalidCursor = await request(`/api/apps/${seed.app_installation_id}/automations?cursor=bad`);
      assert.equal(invalidCursor.status, 400);
      await invalidCursor.json();

      const expiredRow = await db.select().from(appAutomationDefinitions).where(and(
        eq(appAutomationDefinitions.org_id, fixtureOrg.id),
        eq(appAutomationDefinitions.state, 'expired'),
      )).limit(1);
      const paused = await db.select().from(appAutomationDefinitions).where(and(
        eq(appAutomationDefinitions.org_id, fixtureOrg.id),
        eq(appAutomationDefinitions.state, 'paused'),
      )).limit(1);
      const expirationTarget = expiredRow[0] ?? paused[0];
      assert.ok(expirationTarget);
      if (!expiredRow[0]) {
        await expireAppAutomationDefinition(humanModuleActor({ orgId: fixtureOrg.id,
          userId: owner.id, role: 'owner', source: 'rest' }), {
          definition_id: expirationTarget.id, expected_epoch: expirationTarget.definition_epoch,
        });
      }
      let expired: OperatorDefinition | undefined;
      cursor = null;
      do {
        const response = await request(`/api/apps/${seed.app_installation_id}/automations?limit=50`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
        assert.equal(response.status, 200);
        const body = await response.json() as { automations: {
          definitions: OperatorDefinition[]; next_cursor: string | null;
        } };
        expired = body.automations.definitions.find((item) => item.id === expirationTarget.id) ?? expired;
        cursor = body.automations.next_cursor;
      } while (cursor);
      assert.equal(expired?.state, 'expired');
      assert.equal(expired.eligibility.status, 'expired');
      assert.equal(expired.next_fire_at_utc, null);

      const active = definitions.find((item) => item.state === 'active');
      assert.ok(active);
      assert.equal(active.eligibility.status, 'blocked');
      assert.equal(active.next_fire_at_utc, null);
      const pinned = await db.select().from(appAutomationDefinitions).where(eq(appAutomationDefinitions.id, active.id)).limit(1);
      assert.ok(pinned[0]);
      const placementRef = ResourceRefV1Schema.parse(pinned[0].placement_resource_ref);
      assert.equal(placementRef.provider.kind, 'module');
      const [record] = await db.select().from(moduleRecords).where(eq(moduleRecords.id, placementRef.resource_id)).limit(1);
      const [moduleInstallation] = await db.select().from(moduleInstallations)
        .where(eq(moduleInstallations.id, placementRef.provider.provider_instance_id)).limit(1);
      assert.ok(record && moduleInstallation);
      const liveModule = { ...moduleInstallation, is_enabled: true, is_deleted: false };
      assert.equal(isCurrentAutomationModulePin(pinned[0], 'placement', fixtureOrg.id, record, liveModule), true);
      assert.equal(isCurrentAutomationModulePin(pinned[0], 'placement', fixtureOrg.id,
        { ...record, revision: record.revision + 1 }, liveModule), false);
      assert.equal(isCurrentAutomationModulePin(pinned[0], 'placement', fixtureOrg.id,
        record, { ...liveModule, is_enabled: false }), false);
      const [connection] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, pinned[0].mcp_connection_id)).limit(1);
      assert.ok(connection);
      assert.equal(isCurrentAutomationConnector(pinned[0], connection, false), true);
      assert.equal(isCurrentAutomationConnector(pinned[0], {
        ...connection, app_run_authorization_version: connection.app_run_authorization_version + 1,
      }, false), false);
      assert.equal(isCurrentAutomationConnector(pinned[0], connection, true), false);
      console.log('A01_HTTP_RESULT', JSON.stringify({ pages: pageSizes,
        definitions: definitions.length, blocked_fire: blockedFire.latest_fire?.state,
        receipt_count: receipt.receipts.length, disabled_app_eligibility: active.eligibility.status,
        disabled_app_next: active.next_fire_at_utc }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

test('A01 live reviewed definition has a next fire, then blocks changed resource and revoked connector authority',
  { skip: !safe }, async () => {
    const outboxRoot = await mkdtemp(resolve(tmpdir(), 'deft-a01-live-'));
    const previous = {
      selfHosted: process.env.DEFT_SELF_HOSTED,
      unsafeStdio: process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO,
      allowlist: process.env.MCP_STDIO_ALLOWED_COMMANDS,
    };
    process.env.DEFT_SELF_HOSTED = 'true';
    process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
    process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
    try {
      const orgId = randomUUID();
      const userId = randomUUID();
      const email = `a01-live-${randomUUID()}@example.test`;
      await db.insert(orgs).values({ id: orgId, name: 'A01 live authority', slug: `a01-live-${randomUUID()}` });
      await db.insert(users).values({ id: userId, name: 'A01 live owner', email });
      await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
      const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
      const dependency = await buildPhase5DependencyAppPackage();
      const dependencyInstallation = await stageAppPackage(actor, dependency.json);
      await activateAppInstallation(actor, dependencyInstallation.id, dependencyInstallation.package_digest);
      const built = await buildTrackAAutomatedConnectedAppPackage();
      const staged = await stageAppPackage(actor, built.json);
      const [version] = await db.select().from(appVersions).where(eq(appVersions.id, staged.version_id)).limit(1);
      assert.ok(version?.requested_grant_snapshot_id);
      const [requested] = await db.select().from(appGrantSnapshots)
        .where(eq(appGrantSnapshots.id, version.requested_grant_snapshot_id)).limit(1);
      assert.ok(requested);
      const connectionId = randomUUID();
      const providerRoot = resolve(import.meta.dirname, '..', '..', '..', 'examples', 'app-platform-sandbox-email-provider');
      await db.insert(mcpConnections).values({
        id: connectionId, org_id: orgId, name: 'A01 synthetic mail', slug: `a01-mail-${randomUUID()}`,
        server_url: null, transport: 'stdio', stdio_command: process.execPath,
        stdio_args: [resolve(providerRoot, 'server.mjs'), '--outbox-file', resolve(outboxRoot, 'effects.jsonl')],
        auth_type: 'none', is_active: true, created_by: userId,
      });
      const capability = new CapabilityService();
      const reviewRequest = {
        app_version_id: version.id,
        expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest,
        expected_lifecycle_epoch: staged.lifecycle_epoch,
        expected_grant_epoch: staged.grant_epoch,
        connector_selections: [{ connector_requirement_key: 'mail_provider', mcp_connection_id: connectionId }],
      };
      const review = await prepareConnectedAppReview(actor, staged.id, reviewRequest, capability);
      await activateConnectedAppInstallation(actor, staged.id, {
        ...reviewRequest, expected_review_digest: review.review_digest, accept_host_policy: true,
      }, capability);
      const campaignBinding = await db.select({ binding: appModuleBindings, version: moduleVersions })
        .from(appModuleBindings).innerJoin(moduleVersions, and(
          eq(moduleVersions.org_id, appModuleBindings.org_id),
          eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
          eq(moduleVersions.id, appModuleBindings.module_version_id),
        )).where(and(eq(appModuleBindings.org_id, orgId), eq(appModuleBindings.app_installation_id, staged.id))).limit(1);
      const contactBinding = await db.select({ binding: appModuleBindings, version: moduleVersions })
        .from(appModuleBindings).innerJoin(moduleVersions, and(
          eq(moduleVersions.org_id, appModuleBindings.org_id),
          eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
          eq(moduleVersions.id, appModuleBindings.module_version_id),
        )).where(and(eq(appModuleBindings.org_id, orgId), eq(appModuleBindings.app_installation_id, dependencyInstallation.id))).limit(1);
      assert.ok(campaignBinding[0] && contactBinding[0]);
      const contact = await createModuleRecord(actor, {
        module_id: 'org.deft.reference.resource-contacts', collection_key: 'contacts',
        data: { name: 'A01 contact', email: 'a01@example.test' }, relations: {},
        expected_manifest_digest: contactBinding[0].version.manifest_digest,
        idempotency_key: `a01-contact-${randomUUID()}`,
      });
      const campaign = await createModuleRecord(actor, {
        module_id: 'org.deft.reference.resource-campaigns', collection_key: 'campaigns',
        data: { name: 'A01 campaign', subject: 'A01 proof', body: 'One daily action.', status: 'ready' }, relations: {},
        expected_manifest_digest: campaignBinding[0].version.manifest_digest,
        idempotency_key: `a01-campaign-${randomUUID()}`,
      });
      assert.ok(contact.record && campaign.record);
      const placementRef = { schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module' as const, provider_instance_id: campaignBinding[0].binding.module_installation_id },
        resource_type: 'campaigns', resource_id: campaign.record.id };
      const selectedRef = { schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
        provider: { kind: 'module' as const, provider_instance_id: contactBinding[0].binding.module_installation_id },
        resource_type: 'contacts', resource_id: contact.record.id };
      await replaceResourceRelation(actor, { schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
        source: placementRef, relation_key: 'contacts', refs: [selectedRef],
        expected_revision: 0, idempotency_key: `a01-relation-${randomUUID()}` });
      const [binding] = await db.select().from(appActionBindings).where(and(
        eq(appActionBindings.org_id, orgId), eq(appActionBindings.app_installation_id, staged.id),
        eq(appActionBindings.action_key, 'send_campaign_email'),
      )).limit(1);
      assert.ok(binding);
      const clock = new Date();
      const scheduled = new Date(Math.floor(clock.getTime() / 60_000) * 60_000 + 10 * 60_000);
      const definitionInput = {
        app_installation_id: staged.id, app_version_id: version.id, action_binding_id: binding.id,
        automation_request_key: 'daily_campaign_send',
        placement: { resource_ref: placementRef, revision: String(campaign.record.revision),
          content_digest: digestAppGrantValue(campaign.record.data) },
        selected: { resource_ref: selectedRef, revision: String(contact.record.revision),
          content_digest: digestAppGrantValue(contact.record.data) },
        local_time: scheduled.toISOString().slice(11, 16), timezone: 'UTC',
        validity_seconds: 30 * 24 * 60 * 60, max_org_runs_per_utc_day: 100,
        max_pending_org_fires: 25,
      } as const;
      const definitionReview = await prepareAppAutomationDefinitionReview(actor, definitionInput);
      const created = await createReviewedAppAutomationDefinition(actor, {
        ...definitionInput, expected_review_digest: definitionReview.review_digest,
        accept_code_owned_policy: true,
      }, { now: () => clock });
      const campaignTwo = await createModuleRecord(actor, {
        module_id: 'org.deft.reference.resource-campaigns', collection_key: 'campaigns',
        data: { name: 'A01 second campaign', subject: 'Second A01 proof', body: 'Independent pin.', status: 'ready' },
        relations: {}, expected_manifest_digest: campaignBinding[0].version.manifest_digest,
        idempotency_key: `a01-campaign-two-${randomUUID()}`,
      });
      assert.ok(campaignTwo.record);
      const placementTwo = { ...placementRef, resource_id: campaignTwo.record.id };
      await replaceResourceRelation(actor, { schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
        source: placementTwo, relation_key: 'contacts', refs: [selectedRef],
        expected_revision: 0, idempotency_key: `a01-relation-two-${randomUUID()}` });
      const secondInput = { ...definitionInput, placement: {
        resource_ref: placementTwo, revision: String(campaignTwo.record.revision),
        content_digest: digestAppGrantValue(campaignTwo.record.data),
      } };
      const secondReview = await prepareAppAutomationDefinitionReview(actor, secondInput);
      const second = await createReviewedAppAutomationDefinition(actor, {
        ...secondInput, expected_review_digest: secondReview.review_digest,
        accept_code_owned_policy: true,
      }, { now: () => clock });
      const token = (await createWebSession({ id: userId, org_id: orgId, email })).accessToken;
      const app = new Hono();
      app.use('/api/*', authMiddleware);
      app.route('/api/apps', appRoutes);
      app.route('/api/mcp-connections', mcpConnectionRoutes);
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      try {
        if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const url = `http://127.0.0.1:${address.port}/api/apps/${staged.id}/automations?limit=50`;
        const read = async (definitionId: string) => {
          const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          assert.equal(response.status, 200);
          return (await response.json() as { automations: { definitions: OperatorDefinition[] } }).automations.definitions
            .find((row) => row.id === definitionId);
        };
        const eligible = await read(created.id);
        assert.equal(eligible?.eligibility.status, 'awaiting_delivery_check');
        assert.equal(eligible.next_fire_at_utc, scheduled.toISOString());
        assert.equal((await read(second.id))?.eligibility.status, 'awaiting_delivery_check');
        const updated = await updateModuleRecord(actor, { record_id: campaign.record.id,
          patch: { subject: 'Changed A01 proof' }, expected_revision: campaign.record.revision,
          expected_manifest_digest: campaignBinding[0].version.manifest_digest,
          idempotency_key: `a01-update-${randomUUID()}` });
        assert.ok(updated.record);
        const changed = await read(created.id);
        assert.equal(changed?.eligibility.status, 'blocked');
        assert.equal(changed.next_fire_at_utc, null);
        assert.equal((await read(second.id))?.eligibility.status, 'awaiting_delivery_check');
        const addressUrl = `http://127.0.0.1:${address.port}`;
        const revoke = await fetch(`${addressUrl}/api/mcp-connections/${connectionId}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: false }),
        });
        assert.equal(revoke.status, 200);
        await revoke.json();
        const connectorRevoked = await read(second.id);
        assert.equal(connectorRevoked?.eligibility.status, 'blocked');
        assert.equal(connectorRevoked.next_fire_at_utc, null);
        console.log('A01_LIVE_RESULT', JSON.stringify({ eligible: eligible?.eligibility.status,
          next: eligible?.next_fire_at_utc, changed_resource: changed?.eligibility.status,
          revoked_connector: connectorRevoked.eligibility.status }));
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    } finally {
      if (previous.selfHosted === undefined) delete process.env.DEFT_SELF_HOSTED;
      else process.env.DEFT_SELF_HOSTED = previous.selfHosted;
      if (previous.unsafeStdio === undefined) delete process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO;
      else process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = previous.unsafeStdio;
      if (previous.allowlist === undefined) delete process.env.MCP_STDIO_ALLOWED_COMMANDS;
      else process.env.MCP_STDIO_ALLOWED_COMMANDS = previous.allowlist;
      if (resolve(outboxRoot) !== outboxRoot
        || !outboxRoot.startsWith(resolve(tmpdir(), 'deft-a01-live-'))) {
        throw new Error('Refusing to remove unexpected A01 temporary path');
      }
      await rm(outboxRoot, { recursive: true, force: true });
    }
  });
