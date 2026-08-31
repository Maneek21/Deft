import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import pg from 'pg';
import {
  RESOURCE_CONTRACT_VERSIONS,
  type ModuleResourceRefV1,
  type TaskResourceRefV1,
} from '@deft/shared/resources';
import {
  archiveModuleRecord,
  createModuleRecord,
  employeeModuleActor,
  humanModuleActor,
  installModuleFromManifest,
  listModuleRecordReferences,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { closeDb } from '../src/lib/db.js';
import { ResourceAuthorizationError } from '../src/lib/resource-authorization.js';
import { resourceAuthorizationService } from '../src/lib/resource-provider-adapters.js';
import { seedPhase4ResourceParity } from './fixtures/phase4-resource-parity.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(databaseUrl && /phase4.*test/i.test(new URL(databaseUrl).pathname));
const client = databaseUrl ? new pg.Client({ connectionString: databaseUrl }) : null;

after(async () => {
  await closeDb();
  await client?.end().catch(() => undefined);
});

function resourceCode(code: ResourceAuthorizationError['code']) {
  return (error: unknown) => error instanceof ResourceAuthorizationError && error.code === code;
}

test('Module and Task adapters preserve owner authorization on live data', { skip: !canRun }, async () => {
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
  const manifest = JSON.parse(await readFile(
    new URL('../../../examples/resource-participation-contacts-app/modules/resource-contacts/deft.module.json', import.meta.url),
    'utf8',
  ));
  const installation = await installModuleFromManifest(owner, manifest, { source: 'sideloaded' });
  const enabled = await updateModuleInstallation(owner, installation.slug, { agent_access: 'read' });
  const created = await createModuleRecord(owner, {
    module_id: enabled.module_id,
    collection_key: 'contacts',
    data: {
      name: 'Ada Lovelace',
      email: 'ada@phase4.test',
      company: 'Analytical Engines',
      status: 'active',
    },
    relations: {},
    expected_manifest_digest: enabled.manifest_digest,
    idempotency_key: `phase4-resource-create-${ids.org_id}`,
  });
  assert.ok(created.record);
  const moduleRef: ModuleResourceRefV1 = {
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'module', provider_instance_id: enabled.id },
    resource_type: 'contacts',
    resource_id: created.record.id,
  };
  const ownerReference = await listModuleRecordReferences(
    owner,
    enabled.slug,
    'contacts',
    [created.record.id],
  );
  const ownerProjection = await resourceAuthorizationService.resolve(
    { org_id: ids.org_id, actor: owner },
    moduleRef,
  );
  assert.equal(ownerProjection.label, ownerReference[0]?.label);
  assert.equal(ownerProjection.revision, String(created.record.revision));
  assert.equal((await resourceAuthorizationService.resolve(
    { org_id: ids.org_id, actor: employee },
    moduleRef,
  )).label, ownerReference[0]?.label);

  const taskRef = (taskId: string): TaskResourceRefV1 => ({
    schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
    provider: { kind: 'core', provider_instance_id: 'tasks' },
    resource_type: 'task',
    resource_id: taskId,
  });
  assert.equal((await resourceAuthorizationService.resolve(
    { org_id: ids.org_id, actor: owner },
    taskRef(ids.allowed_task_id),
  )).label, 'Allowed Phase 4 task');
  assert.equal((await resourceAuthorizationService.resolve(
    { org_id: ids.org_id, actor: employee },
    taskRef(ids.allowed_task_id),
  )).label, 'Allowed Phase 4 task');
  await assert.rejects(
    resourceAuthorizationService.resolve(
      { org_id: ids.org_id, actor: employee },
      taskRef(ids.denied_task_id),
    ),
    resourceCode('RESOURCE_NOT_FOUND'),
  );
  await assert.rejects(
    resourceAuthorizationService.resolve(
      { org_id: ids.org_id, actor: employee },
      taskRef(ids.restricted_task_id),
    ),
    resourceCode('RESOURCE_NOT_FOUND'),
  );
  await assert.rejects(
    resourceAuthorizationService.resolve(
      { org_id: ids.org_id, actor: owner },
      taskRef(ids.deleted_task_id),
    ),
    resourceCode('RESOURCE_NOT_FOUND'),
  );
  await assert.rejects(
    resourceAuthorizationService.resolve(
      { org_id: ids.org_id, actor: owner },
      taskRef(ids.other_org_task_id),
    ),
    resourceCode('RESOURCE_NOT_FOUND'),
  );

  await client.query('UPDATE agent_employees SET is_active = false WHERE id = $1', [ids.employee_id]);
  await assert.rejects(
    resourceAuthorizationService.resolve(
      { org_id: ids.org_id, actor: employee },
      taskRef(ids.allowed_task_id),
    ),
    resourceCode('RESOURCE_ACCESS_DENIED'),
  );
  await client.query('UPDATE agent_employees SET is_active = true WHERE id = $1', [ids.employee_id]);

  await updateModuleInstallation(owner, enabled.slug, { enabled: false });
  await assert.rejects(
    resourceAuthorizationService.resolve({ org_id: ids.org_id, actor: owner }, moduleRef),
    resourceCode('RESOURCE_UNAVAILABLE'),
  );
  await updateModuleInstallation(owner, enabled.slug, { enabled: true });
  await archiveModuleRecord(owner, {
    record_id: created.record.id,
    expected_revision: created.record.revision,
    expected_manifest_digest: enabled.manifest_digest,
    idempotency_key: `phase4-resource-archive-${ids.org_id}`,
  });
  await assert.rejects(
    resourceAuthorizationService.resolve({ org_id: ids.org_id, actor: owner }, moduleRef),
    resourceCode('RESOURCE_NOT_FOUND'),
  );
});
