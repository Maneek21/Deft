import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import {
  buildDeftAppPackage,
  prepareModuleArtifact,
  type DeftAppManifestV0Input,
} from '@deft/app-kit';
import {
  RESOURCE_CONTRACT_VERSIONS,
  type ModuleResourceRefV1,
} from '@deft/shared/resources';
import {
  activateAppInstallation,
  disableAppInstallation,
  enableAppInstallation,
  stageAppPackage,
} from '../src/lib/app-service.js';
import { closeDb } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import {
  createModuleRecord,
  employeeModuleActor,
  getModuleInstallation,
  humanModuleActor,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import {
  listResourceRelation,
} from '../src/lib/resource-relation-service.js';
import { searchAuthorizedModuleResources } from '../src/lib/resource-search-service.js';
import { moduleRoutes } from '../src/routes/modules.js';
import { Phase4SandboxEmailProvider } from './fixtures/phase4-sandbox-email-provider.js';
import { seedPhase4ResourceParity } from './fixtures/phase4-resource-parity.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(databaseUrl && /phase4.*test/i.test(new URL(databaseUrl).pathname));
const client = databaseUrl ? new pg.Client({ connectionString: databaseUrl }) : null;

after(async () => {
  await closeDb();
  await client?.end().catch(() => undefined);
});

async function buildExampleApp(directory: 'contacts' | 'campaigns') {
  const root = new URL(`../../../examples/resource-participation-${directory}-app/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('deft.app.json', root), 'utf8')) as DeftAppManifestV0Input;
  const reference = manifest.modules?.[0];
  assert.ok(reference);
  const moduleManifest = JSON.parse(await readFile(new URL(reference.manifest_path, root), 'utf8')) as unknown;
  const artifact = await prepareModuleArtifact({ path: reference.manifest_path, manifest: moduleManifest });
  assert.equal(artifact.digest, reference.manifest_digest, `${directory} fixture digest must be current`);
  return buildDeftAppPackage({ manifest, artifacts: [artifact] });
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

test('independent Contacts and Campaigns Apps compose through live-authorized resources', { skip: !canRun }, async () => {
  assert.ok(client && databaseUrl);
  await client.connect();
  const ids = await seedPhase4ResourceParity(client);
  const owner = humanModuleActor({
    orgId: ids.org_id,
    userId: ids.owner_user_id,
    role: 'owner',
    source: 'rest',
  });
  const employee = employeeModuleActor({
    orgId: ids.org_id,
    employeeId: ids.employee_id,
    trustLevel: 'standard',
    source: 'runtime',
  });
  const sandboxEmail = new Phase4SandboxEmailProvider();
  const nativeApp = new Hono();
  nativeApp.use('*', async (context, next) => {
    context.set('user', {
      id: ids.owner_user_id,
      org_id: ids.org_id,
      email: 'phase4-owner@example.test',
      name: 'Phase 4 Owner',
      role: 'owner',
    });
    await next();
  });
  nativeApp.route('/api/modules', moduleRoutes);

  const [contactsPackage, campaignsPackage] = await Promise.all([
    buildExampleApp('contacts'),
    buildExampleApp('campaigns'),
  ]);
  assert.notEqual(contactsPackage.digest, campaignsPackage.digest);
  const stagedContacts = await stageAppPackage(owner, contactsPackage.json);
  const stagedCampaigns = await stageAppPackage(owner, campaignsPackage.json);
  const contactsApp = await activateAppInstallation(owner, stagedContacts.id, stagedContacts.package_digest);
  const campaignsApp = await activateAppInstallation(owner, stagedCampaigns.id, stagedCampaigns.package_digest);
  assert.notEqual(contactsApp.id, campaignsApp.id);
  assert.notEqual(contactsApp.app_id, campaignsApp.app_id);

  let contacts = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-contacts' });
  let campaigns = await getModuleInstallation(owner, { moduleId: 'org.deft.reference.resource-campaigns' });
  assert.notEqual(contacts.id, campaigns.id);
  contacts = await updateModuleInstallation(owner, contacts.slug, { agent_access: 'read' });
  campaigns = await updateModuleInstallation(owner, campaigns.slug, { agent_access: 'read' });

  const contact = await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: {
      name: 'Ada Lovelace',
      email: 'ada@phase4.test',
      company: 'Analytical Engines',
      status: 'active',
    },
    relations: {},
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `phase4-app-contact-${ids.org_id}`,
  });
  const campaign = await createModuleRecord(owner, {
    module_id: campaigns.module_id,
    collection_key: 'campaigns',
    data: {
      name: 'August launch',
      subject: 'A durable App platform',
      status: 'draft',
      audience_notes: 'Phase 4 proof only; no send.',
    },
    relations: {},
    expected_manifest_digest: campaigns.manifest_digest,
    idempotency_key: `phase4-app-campaign-${ids.org_id}`,
  });
  assert.ok(contact.record && campaign.record);
  assert.equal(Object.hasOwn(campaign.record.data, 'contacts'), false, 'the Campaign record must not copy Contact data');

  const source = moduleRef(campaigns.id, 'campaigns', campaign.record.id);
  const target = moduleRef(contacts.id, 'contacts', contact.record.id);
  const relationPath = `/api/modules/${campaigns.slug}/records/${campaign.record.id}/resource-relations/contacts`;
  const routeReplace = await nativeApp.request(relationPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refs: [target],
      expected_revision: 0,
      idempotency_key: `phase4-app-route-link-${ids.org_id}`,
    }),
  });
  assert.equal(routeReplace.status, 200);
  assert.equal((await routeReplace.json() as { relation: { revision: number } }).relation.revision, 1);
  const humanRelation = await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  });
  const employeeRelation = await listResourceRelation(employee, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  });
  assert.equal(humanRelation.items[0]?.state, 'available');
  assert.equal(humanRelation.items[0]?.state === 'available' ? humanRelation.items[0].resource.label : null, 'Ada Lovelace');
  assert.equal(employeeRelation.items[0]?.state, 'available');

  const routeRead = await nativeApp.request(relationPath);
  assert.equal(routeRead.status, 200);
  assert.equal((await routeRead.json() as { relation: { items: unknown[] } }).relation.items.length, 1);
  const routeOptions = await nativeApp.request(`${relationPath}/options?q=Ada`);
  assert.equal(routeOptions.status, 200);
  assert.equal((await routeOptions.json() as { options: Array<{ label: string }> }).options[0]?.label, 'Ada Lovelace');
  const searchInput = {
    query: 'Ada',
    module_id: contacts.module_id,
    collection_key: 'contacts',
    limit: 10,
  };
  assert.equal((await searchAuthorizedModuleResources(owner, searchInput)).items[0]?.title, 'Ada Lovelace');
  assert.equal((await searchAuthorizedModuleResources(employee, searchInput)).items[0]?.title, 'Ada Lovelace');
  const agentSearch = await executeToolCall(
    'module_record_search',
    searchInput,
    ids.org_id,
    ids.employee_user_id,
    undefined,
    ids.employee_id,
  );
  assert.equal(agentSearch.citations[0]?.title, 'Ada Lovelace');

  const disabledContacts = await disableAppInstallation(owner, contactsApp.id, contactsApp.lifecycle_epoch);
  const disabledRelation = await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  });
  assert.equal(disabledRelation.items[0]?.state, 'unavailable');
  assert.equal((await searchAuthorizedModuleResources(owner, searchInput)).items.length, 0);
  assert.equal((await executeToolCall(
    'module_record_search',
    searchInput,
    ids.org_id,
    ids.employee_user_id,
    undefined,
    ids.employee_id,
  )).citations.length, 0, 'disabled indexed resources must not produce citations');

  await enableAppInstallation(owner, disabledContacts.id, disabledContacts.lifecycle_epoch);
  assert.equal((await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  })).items[0]?.state, 'available');
  assert.equal((await searchAuthorizedModuleResources(owner, searchInput)).items[0]?.title, 'Ada Lovelace');

  await client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [
    ids.org_id,
    ids.owner_user_id,
  ]);
  await assert.rejects(
    executeToolCall('module_record_search', searchInput, ids.org_id, ids.owner_user_id),
    /active member/i,
  );
  assert.equal(sandboxEmail.callCount, 0, 'Phase 4 must not invoke the future email effect');
});
