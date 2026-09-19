import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import {
  crossReferences,
  moduleRecords,
  orgMembers,
  orgs,
  projects,
  tasks,
  users,
} from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { moduleTaskLinkRoutes } from '../src/routes/module-task-links.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

test('task and record link routes page beyond 100 without hidden links consuming slots', { skip: !canRun }, async () => {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const projectId = randomUUID();
  const hubTaskId = randomUUID();

  await db.insert(orgs).values({ id: orgId, name: 'Link pagination', slug: `link-pages-${orgId}` });
  await db.insert(users).values([
    { id: ownerId, name: 'Link owner', email: `${ownerId}@example.test` },
    { id: memberId, name: 'Link member', email: `${memberId}@example.test` },
  ]);
  await db.insert(orgMembers).values([
    { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: orgId, user_id: memberId, role: 'member', is_active: true },
  ]);
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'Paged work', prefix: 'PAGE', lead_id: ownerId });
  await db.insert(tasks).values({
    id: hubTaskId,
    org_id: orgId,
    project_id: projectId,
    number: 1,
    title: 'Record collection hub',
    created_by: ownerId,
  });

  const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
  const contacts = await installModuleFromManifest(owner, getBundledModule('contacts')!, { source: 'bundled' });
  const hubRecord = (await createModuleRecord(owner, {
    module_id: contacts.module_id,
    collection_key: 'contacts',
    data: { name: 'Task collection hub' },
    expected_manifest_digest: contacts.manifest_digest,
    idempotency_key: randomUUID(),
  })).record!;

  const disabled = await installModuleFromManifest(owner, {
    schema_version: '1',
    id: `test.deft.disabled-${randomUUID()}`,
    slug: `disabled-${randomUUID()}`,
    version: '1.0.0',
    name: 'Disabled records',
    collections: [{
      key: 'items',
      name: 'Items',
      singular_name: 'Item',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      search: { title_field: 'name', fields: ['name'] },
      views: [{ key: 'all', name: 'All items', type: 'table', fields: ['name'] }],
    }],
  }, { source: 'sideloaded' });
  const hiddenRecord = (await createModuleRecord(owner, {
    module_id: disabled.module_id,
    collection_key: 'items',
    data: { name: 'Never disclose disabled record' },
    expected_manifest_digest: disabled.manifest_digest,
    idempotency_key: randomUUID(),
  })).record!;
  await updateModuleInstallation(owner, disabled.slug, { enabled: false });

  const recordIds = Array.from({ length: 102 }, () => randomUUID());
  const retiredCollectionRecordId = randomUUID();
  await db.insert(moduleRecords).values([...recordIds.map((id, index) => ({
    id,
    org_id: orgId,
    installation_id: contacts.id,
    collection_key: 'contacts',
    validated_version_id: contacts.active_version_id,
    data: { name: `Paged contact ${index + 1}` },
    search_title: `Paged contact ${index + 1}`,
    search_text: `Paged contact ${index + 1}`,
    created_by_actor_type: 'human',
    created_by_actor_id: ownerId,
    updated_by_actor_type: 'human',
    updated_by_actor_id: ownerId,
  })), {
    id: retiredCollectionRecordId,
    org_id: orgId,
    installation_id: contacts.id,
    collection_key: 'retired_contacts',
    validated_version_id: contacts.active_version_id,
    data: { name: 'Never disclose retired collection record' },
    search_title: 'Never disclose retired collection record',
    search_text: 'Never disclose retired collection record',
    created_by_actor_type: 'human',
    created_by_actor_id: ownerId,
    updated_by_actor_type: 'human',
    updated_by_actor_id: ownerId,
  }]);

  const linkedTaskIds = Array.from({ length: 102 }, () => randomUUID());
  const restrictedTaskId = randomUUID();
  await db.insert(tasks).values([
    ...linkedTaskIds.map((id, index) => ({
      id,
      org_id: orgId,
      project_id: projectId,
      number: index + 2,
      title: `Paged task ${index + 1}`,
      created_by: ownerId,
    })),
    {
      id: restrictedTaskId,
      org_id: orgId,
      project_id: projectId,
      number: 104,
      title: 'Never disclose restricted task',
      created_by: ownerId,
      metadata: { visibility: 'restricted', visible_user_ids: [ownerId] },
    },
  ]);

  const start = Date.parse('2026-09-15T00:00:00.000Z');
  await db.insert(crossReferences).values([
    {
      id: randomUUID(), org_id: orgId, source_type: 'module_record', source_id: hiddenRecord.resource_id,
      target_type: 'task', target_id: hubTaskId, created_by: ownerId, created_at: new Date(start), updated_at: new Date(start),
    },
    {
      id: randomUUID(), org_id: orgId, source_type: 'module_record', source_id: `module_record:${retiredCollectionRecordId}`,
      target_type: 'task', target_id: hubTaskId, created_by: ownerId, created_at: new Date(start + 1), updated_at: new Date(start + 1),
    },
    ...recordIds.map((id, index) => ({
      id: randomUUID(), org_id: orgId, source_type: 'module_record', source_id: `module_record:${id}`,
      target_type: 'task', target_id: hubTaskId, created_by: ownerId,
      created_at: new Date(start + index + 2), updated_at: new Date(start + index + 2),
    })),
    {
      id: randomUUID(), org_id: orgId, source_type: 'module_record', source_id: hubRecord.resource_id,
      target_type: 'task', target_id: restrictedTaskId, created_by: ownerId,
    },
    ...linkedTaskIds.map((id) => ({
      id: randomUUID(), org_id: orgId, source_type: 'module_record', source_id: hubRecord.resource_id,
      target_type: 'task', target_id: id, created_by: ownerId,
    })),
  ]);

  const app = new Hono();
  app.use('*', async (context, next) => {
    context.set('user', { id: memberId, org_id: orgId, role: 'member', email: `${memberId}@example.test` });
    await next();
  });
  app.route('/api', moduleTaskLinkRoutes);

  const recordPageOneResponse = await app.request(`/api/tasks/${hubTaskId}/module-records?limit=100&offset=0`);
  assert.equal(recordPageOneResponse.status, 200);
  const recordPageOne = await recordPageOneResponse.json() as { links: Array<{ title: string }>; next_offset: number | null };
  assert.equal(recordPageOne.links.length, 100);
  assert.equal(recordPageOne.next_offset, 100);
  assert.ok(recordPageOne.links.every((link) => !link.title.includes('Never disclose')));

  const recordPageTwo = await (await app.request(`/api/tasks/${hubTaskId}/module-records?limit=100&offset=100`)).json() as { links: Array<{ record_id: string }>; next_offset: number | null };
  assert.equal(recordPageTwo.links.length, 2);
  assert.equal(recordPageTwo.next_offset, null);
  assert.equal(new Set([...recordPageOne.links, ...recordPageTwo.links].map((link: any) => link.record_id)).size, 102);

  const taskPageOneResponse = await app.request(`/api/modules/${contacts.slug}/records/${hubRecord.id}/tasks?limit=100&offset=0`);
  assert.equal(taskPageOneResponse.status, 200);
  const taskPageOne = await taskPageOneResponse.json() as { links: Array<{ title: string; task_id: string }>; next_offset: number | null };
  assert.equal(taskPageOne.links.length, 100);
  assert.equal(taskPageOne.next_offset, 100);
  assert.ok(taskPageOne.links.every((link) => !link.title.includes('Never disclose')));

  const taskPageTwo = await (await app.request(`/api/modules/${contacts.slug}/records/${hubRecord.id}/tasks?limit=100&offset=100`)).json() as { links: Array<{ task_id: string }>; next_offset: number | null };
  assert.equal(taskPageTwo.links.length, 2);
  assert.equal(taskPageTwo.next_offset, null);
  assert.equal(new Set([...taskPageOne.links, ...taskPageTwo.links].map((link) => link.task_id)).size, 102);
});
