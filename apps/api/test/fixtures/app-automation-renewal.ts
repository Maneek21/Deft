import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { appActionBindings, appGrantSnapshots, appModuleBindings, appVersions, mcpConnections, moduleVersions, orgMembers, orgs, users } from '@deft/db/schema';
import { RESOURCE_CONTRACT_VERSIONS } from '@deft/shared';
import { db } from '../../src/lib/db.js';
import { CapabilityService } from '../../src/lib/capability-service.js';
import { activateAppInstallation, stageAppPackage } from '../../src/lib/app-service.js';
import { activateConnectedAppInstallation, prepareConnectedAppReview } from '../../src/lib/app-review-service.js';
import { createModuleRecord, humanModuleActor } from '../../src/lib/module-service.js';
import { replaceResourceRelation } from '../../src/lib/resource-relation-service.js';
import { createReviewedAppAutomationDefinition, prepareAppAutomationDefinitionReview } from '../../src/lib/app-automation-definition-service.js';
import { digestAppGrantValue } from '../../src/lib/app-grant-service.js';
import { buildPhase5DependencyAppPackage, buildTrackAAutomatedConnectedAppPackage } from './phase5-connected-app-package.js';

/** Synthetic local provider and real reviewed Protocol v2 authority. No persisted
 * authority rows are fabricated and no production lifecycle state is patched. */
export async function createAutomationRenewalFixture() {
  const outboxRoot = await mkdtemp(resolve(tmpdir(), 'deft-a02-renewal-'));
  const orgId = randomUUID();
  const userId = randomUUID();
  const email = `a02-live-${randomUUID()}@example.test`;
  await db.insert(orgs).values({ id: orgId, name: 'A02 live authority', slug: `a02-live-${randomUUID()}` });
  await db.insert(users).values({ id: userId, name: 'A02 live owner', email });
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
  const providerRoot = resolve(import.meta.dirname, '..', '..', '..', '..', 'examples', 'app-platform-sandbox-email-provider');
  await db.insert(mcpConnections).values({
    id: connectionId, org_id: orgId, name: 'A02 synthetic mail', slug: `a02-mail-${randomUUID()}`,
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
    data: { name: 'A02 contact', email: 'a02@example.test' }, relations: {},
    expected_manifest_digest: contactBinding[0].version.manifest_digest,
    idempotency_key: `a02-contact-${randomUUID()}`,
  });
  const campaign = await createModuleRecord(actor, {
    module_id: 'org.deft.reference.resource-campaigns', collection_key: 'campaigns',
    data: { name: 'A02 campaign', subject: 'A02 proof', body: 'One daily action.', status: 'ready' }, relations: {},
    expected_manifest_digest: campaignBinding[0].version.manifest_digest,
    idempotency_key: `a02-campaign-${randomUUID()}`,
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
    expected_revision: 0, idempotency_key: `a02-relation-${randomUUID()}` });
  const [binding] = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, orgId), eq(appActionBindings.app_installation_id, staged.id),
    eq(appActionBindings.action_key, 'send_campaign_email'),
  )).limit(1);
  assert.ok(binding);
  const inputFor = (scheduledAt: Date, validitySeconds = 30 * 24 * 60 * 60) => ({
    app_installation_id: staged.id, app_version_id: version.id, action_binding_id: binding.id,
    automation_request_key: 'daily_campaign_send',
    placement: { resource_ref: placementRef, revision: String(campaign.record!.revision),
      content_digest: digestAppGrantValue(campaign.record!.data) },
    selected: { resource_ref: selectedRef, revision: String(contact.record!.revision),
      content_digest: digestAppGrantValue(contact.record!.data) },
    local_time: scheduledAt.toISOString().slice(11, 16), timezone: 'UTC',
    validity_seconds: validitySeconds, max_org_runs_per_utc_day: 100, max_pending_org_fires: 25,
  } as const);
  const create = async (scheduledAt: Date, approvedAt: Date, validitySeconds?: number) => {
    const input = inputFor(scheduledAt, validitySeconds);
    const review = await prepareAppAutomationDefinitionReview(actor, input);
    const definition = await createReviewedAppAutomationDefinition(actor, {
      ...input, expected_review_digest: review.review_digest, accept_code_owned_policy: true,
    }, { now: () => approvedAt });
    return { definition, input, review, scheduledAt };
  };
  const effects = async (): Promise<Array<Record<string, unknown>>> => {
    try {
      const raw = await readFile(resolve(outboxRoot, 'effects.jsonl'), 'utf8');
      return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return { orgId, userId, actor, staged, connectionId, outboxRoot, inputFor, create, effects };
}