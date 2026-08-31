import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import pg from 'pg';
import {
  RESOURCE_CONTRACT_VERSIONS,
  type ModuleResourceRefV1,
} from '@deft/shared/resources';
import {
  archiveModuleRecord,
  createModuleRecord,
  employeeModuleActor,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
  upgradeModuleInstallationToManifest,
} from '../src/lib/module-service.js';
import { closeDb } from '../src/lib/db.js';
import {
  listResourceRelation,
  replaceResourceRelation,
  ResourceRelationError,
} from '../src/lib/resource-relation-service.js';
import { seedPhase4ResourceParity } from './fixtures/phase4-resource-parity.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(databaseUrl && /phase4.*test/i.test(new URL(databaseUrl).pathname));
const client = databaseUrl ? new pg.Client({ connectionString: databaseUrl }) : null;

after(async () => {
  await closeDb();
  await client?.end().catch(() => undefined);
});

function relationCode(code: ResourceRelationError['code']) {
  return (error: unknown) => error instanceof ResourceRelationError && error.code === code;
}

function ref(installationId: string, resourceType: string, resourceId: string): ModuleResourceRefV1 {
  return {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module', provider_instance_id: installationId },
    resource_type: resourceType,
    resource_id: resourceId,
  };
}

test('Module v2 relations remain live-authorized, revisioned, replay-safe, and additive', { skip: !canRun }, async () => {
  assert.ok(client && databaseUrl);
  await client.connect();
  const ids = await seedPhase4ResourceParity(client);
  const owner = humanModuleActor({
    orgId: ids.org_id,
    userId: ids.owner_user_id,
    role: 'owner',
    source: 'rest',
  });
  const otherOwner = humanModuleActor({
    orgId: ids.other_org_id,
    userId: ids.other_owner_user_id,
    role: 'owner',
    source: 'rest',
  });
  const employee = employeeModuleActor({
    orgId: ids.org_id,
    employeeId: ids.employee_id,
    trustLevel: 'standard',
    source: 'runtime',
  });
  const contactsManifest = JSON.parse(await readFile(
    new URL('../../../examples/resource-participation-contacts-app/modules/resource-contacts/deft.module.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  const campaignsManifest = {
    schema_version: '2',
    id: 'org.deft.reference.resource-campaigns',
    slug: 'resource-campaigns',
    version: '2.0.0',
    name: 'Resource Campaigns',
    collections: [{
      key: 'campaigns',
      name: 'Campaigns',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        {
          key: 'contacts',
          label: 'Contacts',
          type: 'resource_ref',
          target: { module_id: 'org.deft.reference.resource-contacts', resource_type: 'contacts' },
          multiple: true,
        },
      ],
      search: { title_field: 'name', fields: ['name'] },
    }],
  };
  let contacts = await installModuleFromManifest(owner, contactsManifest, { source: 'sideloaded' });
  let campaigns = await installModuleFromManifest(owner, campaignsManifest, { source: 'sideloaded' });
  contacts = await updateModuleInstallation(owner, contacts.slug, { agent_access: 'read' });
  campaigns = await updateModuleInstallation(owner, campaigns.slug, { agent_access: 'read' });

  const firstContact = await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: { name: 'Ada Lovelace', email: 'ada@phase4.test' },
    relations: {},
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `phase4-contact-1-${ids.org_id}`,
  });
  const secondContact = await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: { name: 'Grace Hopper', email: 'grace@phase4.test' },
    relations: {},
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `phase4-contact-2-${ids.org_id}`,
  });
  const campaign = await createModuleRecord(owner, {
    module_id: campaigns.module_id,
    collection_key: 'campaigns',
    data: { name: 'Launch' },
    relations: {},
    expected_manifest_digest: campaigns.manifest_digest,
    idempotency_key: `phase4-campaign-${ids.org_id}`,
  });
  assert.ok(firstContact.record && secondContact.record && campaign.record);
  const source = ref(campaigns.id, 'campaigns', campaign.record.id);
  const first = ref(contacts.id, 'contacts', firstContact.record.id);
  const second = ref(contacts.id, 'contacts', secondContact.record.id);
  const relation = (refs: ModuleResourceRefV1[], revision: number, key: string) => ({
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
    refs,
    expected_revision: revision,
    idempotency_key: key,
  });

  await assert.rejects(
    replaceResourceRelation(owner, relation([first, first], 0, 'duplicate-targets')),
    relationCode('RESOURCE_RELATION_INVALID'),
  );
  const created = await replaceResourceRelation(owner, relation([first, second], 0, 'create-audience'));
  assert.equal(created.revision, 1);
  assert.equal(created.replayed, false);
  assert.equal((await replaceResourceRelation(owner, relation([first, second], 0, 'create-audience'))).replayed, true);
  await assert.rejects(
    replaceResourceRelation(owner, relation([second], 1, 'create-audience')),
    relationCode('RESOURCE_RELATION_IDEMPOTENCY_CONFLICT'),
  );
  await assert.rejects(
    replaceResourceRelation(owner, relation([first], 0, 'stale-revision')),
    relationCode('RESOURCE_RELATION_REVISION_CONFLICT'),
  );

  const reordered = await replaceResourceRelation(owner, relation([second, first], 1, 'reorder-audience'));
  assert.equal(reordered.revision, 2);
  let listed = await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  });
  assert.deepEqual(listed.items.map((item) => item.ref.resource_id), [second.resource_id, first.resource_id]);
  assert.deepEqual(listed.items.map((item) => item.state), ['available', 'available']);
  assert.deepEqual(listed.items.map((item) => item.state === 'available' ? item.resource.label : null), ['Grace Hopper', 'Ada Lovelace']);
  assert.equal((await listResourceRelation(employee, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  })).items.length, 2);

  await assert.rejects(
    listResourceRelation(otherOwner, {
      schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
      source,
      relation_key: 'contacts',
    }),
    relationCode('RESOURCE_RELATION_NOT_FOUND'),
  );

  await updateModuleInstallation(owner, contacts.slug, { enabled: false });
  listed = await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  });
  assert.deepEqual(listed.items.map((item) => item.state), ['unavailable', 'unavailable']);
  await updateModuleInstallation(owner, contacts.slug, { enabled: true });
  assert.deepEqual((await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  })).items.map((item) => item.state), ['available', 'available']);

  contacts = await upgradeModuleInstallationToManifest(owner, contacts.slug, {
    ...contactsManifest,
    version: '1.0.1',
  }, {
    source: 'sideloaded',
    expected_active_manifest_digest: contacts.manifest_digest,
  });
  assert.equal((await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  })).items.length, 2);

  await assert.rejects(
    upgradeModuleInstallationToManifest(owner, campaigns.slug, {
      ...campaignsManifest,
      version: '2.0.1',
      collections: [{
        ...campaignsManifest.collections[0],
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      }],
    }, {
      source: 'sideloaded',
      expected_active_manifest_digest: campaigns.manifest_digest,
    }),
    /Existing resource relation contacts is incompatible/,
  );
  assert.equal((await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  })).revision, 2);

  await archiveModuleRecord(owner, {
    record_id: firstContact.record.id,
    expected_revision: firstContact.record.revision,
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: `archive-contact-${ids.org_id}`,
  });
  listed = await listResourceRelation(owner, {
    schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
    source,
    relation_key: 'contacts',
  });
  assert.deepEqual(listed.items.map((item) => item.state), ['available', 'unavailable']);

  const cleared = await replaceResourceRelation(owner, relation([], 2, 'clear-audience'));
  assert.equal(cleared.revision, 3);
  const retained = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM resource_relation_edges e
       JOIN resource_relation_sets s ON s.org_id = e.org_id AND s.id = e.relation_set_id
      WHERE s.org_id = $1 AND s.source_resource_id = $2`,
    [ids.org_id, source.resource_id],
  );
  assert.equal(Number(retained.rows[0]?.count), 4, 'two replacements retain four soft-deleted historical edges');

  const raced = await Promise.allSettled([
    replaceResourceRelation(owner, relation([second], 3, 'race-audience-a')),
    replaceResourceRelation(owner, relation([], 3, 'race-audience-b')),
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => (
    result.status === 'rejected'
    && relationCode('RESOURCE_RELATION_REVISION_CONFLICT')(result.reason)
  )).length, 1);

  await updateModuleInstallation(owner, campaigns.slug, { enabled: false });
  await assert.rejects(
    listResourceRelation(owner, {
      schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
      source,
      relation_key: 'contacts',
    }),
    relationCode('RESOURCE_RELATION_NOT_FOUND'),
  );
});
