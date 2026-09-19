import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDeftAppPackage, prepareModuleArtifact, SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT, verifyDeftAppPackageJson } from '@deft/app-kit';
import { and, eq } from 'drizzle-orm';
import { CAPABILITY_CONTRACT_VERSIONS, createCapabilityProviderDiscoverySnapshot } from '@deft/shared';
import { appInstallations, appGrantSnapshots, appVersions, mcpConnections, moduleVersions, orgMembers, orgs, projects, tasks, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { createModuleRecord, getModuleRecord, humanModuleActor } from '../src/lib/module-service.js';
import { activateAppInstallation, stageAppPackage, stageAppUpgrade } from '../src/lib/app-service.js';
import { activateConnectedAppInstallation, prepareConnectedAppReview } from '../src/lib/app-review-service.js';
import { linkModuleRecordToTask, listModuleRecordTaskLinks } from '../src/lib/module-task-links.js';
import { buildContactsCrmManifest } from '../../../modules/bundled/contacts/author/manifest.mjs';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const DATABASE_URL = safeTestDatabaseUrl();
if (!DATABASE_URL) throw new Error('CRM lifecycle proof requires matching DEFT_TEST_DATABASE_URL and runtime DATABASE_URL for a disposable database');
const orgId = randomUUID(), userId = randomUUID(), suffix = randomUUID().slice(0, 8);
let basePackage: string, connectedPackage: string;

async function sandboxReviewCapability(orgId: string, connectionId: string) {
  const snapshot = await createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
    provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId },
    captured_at: '2026-08-31T12:00:00.000Z',
    operations: [{
      identity: { provider: { org_id: orgId, provider_kind: 'mcp', provider_instance_id: connectionId }, operation_name: 'send_email' },
      title: 'Send sandbox email', description: 'Accept one deterministic sandbox email.',
      input_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
      output_schema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
    }],
  });
  return {
    capability: {
      discover: async () => ({
        provider_kind: 'mcp' as const,
        tools: [{
          name: 'mcp__reviewed__send_email', originalName: 'send_email', description: 'Send sandbox email',
          inputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
          outputSchema: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
          connectionId, connectionSlug: 'reviewed', isWrite: true, approvalTier: 'full-review' as const,
          rawTool: { name: 'send_email' },
        }],
        snapshot,
      }),
    },
  };
}

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'CRM Lifecycle Proof', slug: `crm-lifecycle-${suffix}` });
  await db.insert(users).values({ id: userId, email: `crm-lifecycle-${suffix}@example.test`, name: 'CRM Proof Owner' });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const module = JSON.parse(await readFile(new URL('../../../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8'));
  const artifact = await prepareModuleArtifact({ path: 'modules/contacts/deft.module.json', manifest: module });
  const make = async (connected: boolean, version: string) => buildDeftAppPackage({ manifest: buildContactsCrmManifest(module, artifact, { connected, appVersion: version }), artifacts: [artifact] });
  const externalBase = process.env.DEFT_CRM_BASE_PACKAGE_PATH?.trim();
  const externalConnected = process.env.DEFT_CRM_CONNECTED_PACKAGE_PATH?.trim();
  if (!!externalBase !== !!externalConnected) {
    throw new Error('CRM lifecycle proof requires both DEFT_CRM_BASE_PACKAGE_PATH and DEFT_CRM_CONNECTED_PACKAGE_PATH when using external packages');
  }
  if (externalBase && externalConnected) {
    basePackage = await readFile(resolve(externalBase), 'utf8');
    connectedPackage = await readFile(resolve(externalConnected), 'utf8');
    await verifyDeftAppPackageJson(basePackage);
    await verifyDeftAppPackageJson(connectedPackage);
  } else {
    basePackage = (await make(false, '1.8.0')).json;
    connectedPackage = (await make(true, '1.9.0')).json;
  }
});

// App module bindings are append-only by contract, so this proof uses a fresh
// disposable organization and leaves its lifecycle rows intact for auditability.
after(async () => { await closeDb(); });

test('CRM base installs records and links, then reviewed connected activation preserves them', async () => {
  const actor = humanModuleActor({ orgId, userId, role: 'owner' });
  const staged = await stageAppPackage(actor, basePackage);
  assert.equal(staged.manifest.compatibility.app_protocol, '0');
  const active = await activateAppInstallation(actor, staged.id, staged.package_digest);
  const binding = await db.query.appModuleBindings.findFirst({ where: (row, { eq }) => eq(row.app_installation_id, active.id) });
  assert.ok(binding);
  const [installedVersion] = await db.select({ manifest_digest: moduleVersions.manifest_digest }).from(moduleVersions).where(eq(moduleVersions.id, binding!.module_version_id));
  assert.ok(installedVersion);
  const expectedManifestDigest = installedVersion.manifest_digest;
  const company = await createModuleRecord(actor, { module_id: binding!.module_id, collection_key: 'companies', data: { name: 'Proof Company', status: 'prospect' }, expected_manifest_digest: expectedManifestDigest, idempotency_key: `company-${suffix}` });
  const contact = await createModuleRecord(actor, { module_id: binding!.module_id, collection_key: 'contacts', data: { name: 'Proof Contact', email: 'proof@example.test' }, relations: { company_id: [company.record!.id] }, expected_manifest_digest: expectedManifestDigest, idempotency_key: `contact-${suffix}` });
  const deal = await createModuleRecord(actor, { module_id: binding!.module_id, collection_key: 'deals', data: { name: 'Proof Deal', stage: 'qualified', value: 100 }, relations: { company_id: [company.record!.id], primary_contact_id: [contact.record!.id] }, expected_manifest_digest: expectedManifestDigest, idempotency_key: `deal-${suffix}` });
  assert.ok(company.record && contact.record && deal.record);
  const projectId = randomUUID(), taskId = randomUUID();
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'CRM proof', prefix: `CRM${suffix.toUpperCase()}`, lead_id: userId });
  await db.insert(tasks).values({ id: taskId, org_id: orgId, project_id: projectId, number: 1, title: 'Review CRM proof', status: 'todo', created_by: userId });
  await linkModuleRecordToTask(actor, taskId, contact.record.resource_id);
  const before = await getModuleRecord(actor, contact.record.id);
  assert.equal(before.relations.find((group) => group.field_key === 'company_id')?.records[0]?.id, company.record.id);
  const beforeTaskLinks = await listModuleRecordTaskLinks(actor, 'contacts', contact.record.id);
  assert.equal(beforeTaskLinks.length, 1);
  assert.equal(beforeTaskLinks[0]?.task_id, taskId);
  const upgrade = await stageAppUpgrade(actor, active.id, connectedPackage, active.lifecycle_epoch);
  assert.equal(upgrade.manifest.id, staged.manifest.id);
  assert.equal(upgrade.manifest.version, '1.9.0');
  assert.equal(upgrade.manifest.compatibility.app_protocol, '1');
  assert.equal(upgrade.manifest.connector_requirements[0].key, 'mail_provider');
  const [requested] = await db.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.app_installation_id, active.id), eq(appGrantSnapshots.app_version_id, upgrade.version_id)));
  assert.equal(requested?.snapshot_kind, 'requested');
  assert.equal(requested?.classification.executable, false);
  const connectionId = randomUUID();
  await db.insert(mcpConnections).values({ id: connectionId, org_id: orgId, name: 'CRM proof sandbox', slug: `crm-proof-${suffix}`, server_url: 'https://crm-proof.example.test/mcp', transport: 'streamable-http', auth_type: 'none', is_active: true, enabled_tools: ['send_email'], created_by: userId });
  const { capability } = await sandboxReviewCapability(orgId, connectionId);
  const reviewRequest = { app_version_id: upgrade.version_id, expected_package_digest: upgrade.package_digest, expected_requested_snapshot_digest: requested!.snapshot_digest, expected_lifecycle_epoch: upgrade.lifecycle_epoch, expected_grant_epoch: upgrade.grant_epoch, connector_selections: [{ connector_requirement_key: 'mail_provider', mcp_connection_id: connectionId }] };
  const review = await prepareConnectedAppReview(actor, active.id, reviewRequest, capability);
  await activateConnectedAppInstallation(actor, active.id, { ...reviewRequest, expected_review_digest: review.review_digest, accept_host_policy: true }, capability);
  const after = await getModuleRecord(actor, contact.record.id);
  assert.equal(after.id, before.id);
  assert.equal(after.relations.find((group) => group.field_key === 'company_id')?.records[0]?.id, company.record.id);
  const afterDeal = await getModuleRecord(actor, deal.record.id);
  assert.equal(afterDeal.relations.find((group) => group.field_key === 'company_id')?.records[0]?.id, company.record.id);
  assert.equal(afterDeal.relations.find((group) => group.field_key === 'primary_contact_id')?.records[0]?.id, contact.record.id);
  const afterTaskLinks = await listModuleRecordTaskLinks(actor, 'contacts', contact.record.id);
  assert.equal(afterTaskLinks.length, 1);
  assert.equal(afterTaskLinks[0]?.task_id, taskId);
  const [installationAfter] = await db.select({ active_version_id: appInstallations.active_version_id }).from(appInstallations).where(eq(appInstallations.id, active.id));
  assert.equal(installationAfter?.active_version_id, upgrade.version_id);
  assert.equal((await db.select().from(appVersions).where(eq(appVersions.id, upgrade.version_id))).length, 1);
});
