import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { and, eq, like } from 'drizzle-orm';
import {
  appActionBindings,
  appAutomationDefinitions,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appVersions,
  mcpConnections,
  moduleRecords,
  orgMembers,
  users,
} from '@deft/db/schema';
import { RESOURCE_CONTRACT_VERSIONS, type ModuleResourceRefV1 } from '@deft/shared';
import { capabilityService } from '../lib/capability-service.js';
import { closeDb, db } from '../lib/db.js';
import {
  activateConnectedAppInstallation,
  prepareConnectedAppReview,
} from '../lib/app-review-service.js';
import { stageAppUpgrade } from '../lib/app-service.js';
import { getModuleInstallation, humanModuleActor } from '../lib/module-service.js';
import { listResourceRelation } from '../lib/resource-relation-service.js';

const CAMPAIGN_APP_ID = 'org.deft.reference.resource-campaigns-app';
const CONTACTS_APP_ID = 'org.deft.reference.resource-contacts-app';
const CAMPAIGN_MODULE_ID = 'org.deft.reference.resource-campaigns';
const CONTACTS_MODULE_ID = 'org.deft.reference.resource-contacts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

async function main(): Promise<void> {
  assert.equal(process.env.DEFT_APP_AUTOMATIONS_ENABLED, 'true');
  const proofEmail = required('DEFT_TEST_EMAIL');
  const packagePath = required('DEFT_TRACK_A_PACKAGE_PATH');
  const evidencePath = required('DEFT_TRACK_A_SETUP_EVIDENCE');
  const packageJson = await readFile(packagePath, 'utf8');
  const packed = JSON.parse(packageJson) as {
    package_format?: string;
    manifest?: { id?: string; version?: string; schema_version?: string; compatibility?: { app_protocol?: string } };
  };
  assert.equal(packed.package_format, 'deft.app.package.v2');
  assert.equal(packed.manifest?.id, CAMPAIGN_APP_ID);
  assert.equal(packed.manifest?.version, '4.0.0');
  assert.equal(packed.manifest?.schema_version, '2');
  assert.equal(packed.manifest?.compatibility?.app_protocol, '2');

  const managers = await db.select({
    user_id: users.id,
    org_id: orgMembers.org_id,
    role: orgMembers.role,
  }).from(users).innerJoin(orgMembers, and(
    eq(orgMembers.user_id, users.id),
    eq(orgMembers.is_active, true),
  )).where(eq(users.email, proofEmail));
  assert.equal(managers.length, 1);
  const manager = managers[0]!;
  assert.ok(manager.role === 'owner' || manager.role === 'admin');
  const actor = humanModuleActor({
    orgId: manager.org_id,
    userId: manager.user_id,
    role: manager.role,
    source: 'rest',
  });

  const [campaignApp] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.app_id, CAMPAIGN_APP_ID),
  ));
  assert.ok(campaignApp?.active_version_id);
  assert.equal(campaignApp.state, 'active');
  const [contactsApp] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.app_id, CONTACTS_APP_ID),
  ));
  assert.ok(contactsApp?.active_version_id);
  assert.equal(contactsApp.state, 'active');
  const [contactsVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id),
    eq(appVersions.id, contactsApp.active_version_id),
  ));
  assert.equal(contactsVersion?.version, '1.0.0');

  const connectors = await db.select().from(mcpConnections).where(and(
    eq(mcpConnections.org_id, actor.org_id),
    like(mcpConnections.slug, 'loop5-mail-%'),
  ));
  assert.equal(connectors.length, 1);
  const connector = connectors[0]!;
  assert.equal(connector.is_active, true);
  assert.equal(connector.transport, 'stdio');
  assert.ok(connector.enabled_tools?.includes('send_email'));

  const definitionsBefore = await db.select({ id: appAutomationDefinitions.id })
    .from(appAutomationDefinitions).where(and(
      eq(appAutomationDefinitions.org_id, actor.org_id),
      eq(appAutomationDefinitions.app_installation_id, campaignApp.id),
    ));
  assert.equal(definitionsBefore.length, 0);

  const staged = await stageAppUpgrade(
    actor,
    campaignApp.id,
    packageJson,
    campaignApp.lifecycle_epoch,
  );
  assert.equal(staged.version, '4.0.0');
  const [stagedVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id),
    eq(appVersions.id, staged.version_id),
  ));
  assert.ok(stagedVersion?.requested_grant_snapshot_id);
  const [requested] = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, actor.org_id),
    eq(appGrantSnapshots.id, stagedVersion.requested_grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'requested'),
  ));
  assert.ok(requested);
  const reviewInput = {
    app_version_id: stagedVersion.id,
    expected_package_digest: stagedVersion.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: staged.lifecycle_epoch,
    expected_grant_epoch: staged.grant_epoch,
    connector_selections: [{
      connector_requirement_key: 'mail_provider',
      mcp_connection_id: connector.id,
    }],
  };
  const review = await prepareConnectedAppReview(actor, campaignApp.id, reviewInput, capabilityService);
  const activated = await activateConnectedAppInstallation(actor, campaignApp.id, {
    ...reviewInput,
    expected_review_digest: review.review_digest,
    accept_host_policy: true,
  }, capabilityService);
  assert.equal(activated.app_version_id, stagedVersion.id);

  const [activeCampaignApp] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.id, campaignApp.id),
  ));
  assert.equal(activeCampaignApp?.state, 'active');
  assert.equal(activeCampaignApp?.active_version_id, stagedVersion.id);
  assert.ok(activeCampaignApp?.active_grant_snapshot_id);
  const [activeVersion] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id),
    eq(appVersions.id, stagedVersion.id),
  ));
  assert.equal(activeVersion?.state, 'active');
  assert.equal(activeVersion?.protocol_version, '2');
  assert.equal(activeVersion?.version, '4.0.0');
  const bindings = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, actor.org_id),
    eq(appActionBindings.app_installation_id, campaignApp.id),
    eq(appActionBindings.app_version_id, stagedVersion.id),
  ));
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.mcp_connection_id, connector.id);
  const locks = await db.select().from(appDependencyLocks).where(and(
    eq(appDependencyLocks.org_id, actor.org_id),
    eq(appDependencyLocks.app_installation_id, campaignApp.id),
    eq(appDependencyLocks.app_version_id, stagedVersion.id),
  ));
  assert.equal(locks.length, 1);
  assert.equal(locks[0]?.dependency_installation_id, contactsApp.id);
  assert.equal(locks[0]?.required_version, '1.0.0');

  const campaigns = await getModuleInstallation(actor, { moduleId: CAMPAIGN_MODULE_ID });
  const contacts = await getModuleInstallation(actor, { moduleId: CONTACTS_MODULE_ID });
  const campaignRecords = await db.select().from(moduleRecords).where(and(
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.installation_id, campaigns.id),
    eq(moduleRecords.collection_key, 'campaigns'),
    eq(moduleRecords.is_deleted, false),
  ));
  const contactRecords = await db.select().from(moduleRecords).where(and(
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.installation_id, contacts.id),
    eq(moduleRecords.collection_key, 'contacts'),
    eq(moduleRecords.is_deleted, false),
  ));
  assert.equal(campaignRecords.length, 1);
  assert.equal(campaignRecords[0]?.search_title, 'Connected campaign');
  assert.equal(contactRecords.length, 1);
  const relation = await listResourceRelation(actor, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source: moduleRef(campaigns.id, 'campaigns', campaignRecords[0]!.id),
    relation_key: 'contacts',
  });
  assert.equal(relation.items.length, 1);
  assert.equal(relation.items[0]?.state, 'available');
  assert.deepEqual(relation.items[0]?.ref, moduleRef(contacts.id, 'contacts', contactRecords[0]!.id));

  const definitionsAfter = await db.select({ id: appAutomationDefinitions.id })
    .from(appAutomationDefinitions).where(and(
      eq(appAutomationDefinitions.org_id, actor.org_id),
      eq(appAutomationDefinitions.app_installation_id, campaignApp.id),
    ));
  assert.equal(definitionsAfter.length, 0);
  await writeFile(evidencePath, `${JSON.stringify({
    schema: 'deft.app_platform.track_a.setup.v1',
    result: 'passed',
    app: { protocol: '2', version: '4.0.0', state: 'active' },
    dependency: { app: CONTACTS_APP_ID, version: '1.0.0', state: 'active' },
    connector: 'reviewed_stdio_sandbox',
    campaign_records: 1,
    contact_records: 1,
    related_contacts: 1,
    automation_definitions: 0,
  }, null, 2)}\n`, { mode: 0o644 });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Track A setup failed');
  process.exitCode = 1;
}).finally(() => closeDb());
