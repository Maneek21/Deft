import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { orgs, users, orgMembers, moduleRecords, moduleRecordMerges, projects, tasks, crossReferences } from '@deft/db/schema';
import { formatModuleRecordResourceId } from '@deft/shared/modules';
import { db, closeDb } from '../src/lib/db.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { humanModuleActor, installModuleFromManifest, createModuleRecord, updateModuleRecord, previewModuleMerge, commitModuleMerge, listModuleMergeHistory, getModuleRecord, getModuleRecordRelations, listIncomingModuleRecords } from '../src/lib/module-service.js';
import { linkModuleRecordToTask, listModuleRecordTaskLinks } from '../src/lib/module-task-links.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
const url = safeTestDatabaseUrl();
const canRun = Boolean(url);
after(closeDb);

test('reviewed merge preserves original values and linked work atomically with scoped retry', { skip: !canRun }, async () => {
  const orgId = randomUUID(), userId = randomUUID(), projectId = randomUUID(), taskId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Merge test', slug: `merge-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Merge owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const installation = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  const create = async (collection: string, data: Record<string, string>, relations: Record<string, string[]> = {}) => (await createModuleRecord(actor, {
    module_id: installation.module_id, collection_key: collection, data, relations, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID(),
  })).record!;
  const a = await create('companies', { name: 'Original company' }), b = await create('companies', { name: 'Retained company' });
  const source = await create('contacts', { name: 'Imported person', email: 'merge@example.test', role: 'Founder' }, { company_id: [a.id] });
  const target = await create('contacts', { name: 'Curated person', email: 'merge@example.test' }, { company_id: [b.id] });
  const activity = await create('activities', { subject: 'Original call', kind: 'call', outcome: 'completed', occurred_at: '2000-01-01T12:00:00Z' }, { contact_id: [source.id] });
  const outreach = await create('outreach', { name: 'Existing audience', subject: 'Review me' }, { contacts: [source.id, target.id] });
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'Merge tasks', prefix: 'MRG' });
  await db.insert(tasks).values({ id: taskId, org_id: orgId, project_id: projectId, number: 1, title: 'Retain this task', created_by: userId, status: 'todo' });
  await linkModuleRecordToTask(actor, taskId, source.resource_id);
  const input = { source_record_id: source.id, target_record_id: target.id, expected_manifest_digest: installation.manifest_digest, field_choices: {}, relation_choices: {} };
  const unresolved = await previewModuleMerge(actor, installation.id, input);
  assert.equal(unresolved.ready, false); assert.equal(unresolved.task_count, 1); assert.equal(unresolved.incoming_record_count, 2);
  await assert.rejects(commitModuleMerge(actor, installation.id, { ...input, expected_preview_digest: unresolved.preview_digest, idempotency_key: randomUUID() }), /Choose.*conflict/i);
  const chosen = { ...input, field_choices: { name: 'target' }, relation_choices: { company_id: 'source' } };
  const stale = await previewModuleMerge(actor, installation.id, chosen);
  await updateModuleRecord(actor, { record_id: target.id, expected_revision: target.revision, expected_manifest_digest: installation.manifest_digest, patch: { phone: '+1 555 0100' } });
  await assert.rejects(commitModuleMerge(actor, installation.id, { ...chosen, expected_preview_digest: stale.preview_digest, idempotency_key: randomUUID() }), /changed/i);
  const preview = await previewModuleMerge(actor, installation.id, chosen);
  assert.equal(preview.ready, true);
  const request = { ...chosen, expected_preview_digest: preview.preview_digest, idempotency_key: randomUUID() };
  const [first, retry] = await Promise.all([commitModuleMerge(actor, installation.id, request), commitModuleMerge(actor, installation.id, request)]);
  assert.equal(first.mutation.record_id, target.id); assert.equal(retry.mutation.record_id, target.id);
  assert.equal(Number(first.replayed) + Number(retry.replayed), 1);
  await assert.rejects(commitModuleMerge(actor, installation.id, { ...request, field_choices: { name: 'source' } }), /different module mutation/i);
  await assert.rejects(getModuleRecord(actor, source.id), /not found/i);
  const current = await getModuleRecord(actor, target.id);
  assert.equal(current.data.name, 'Curated person'); assert.equal(current.data.role, 'Founder'); assert.equal(current.data.phone, '+1 555 0100');
  assert.equal((await getModuleRecordRelations(actor, target.id))[0]!.records[0]!.id, a.id);
  assert.equal((await listIncomingModuleRecords(actor, target.id, { expectedInstallationId: installation.id, collection_key: 'activities', field_key: 'contact_id' })).records[0]!.id, activity.id);
  assert.deepEqual((await getModuleRecordRelations(actor, outreach.id)).find((group) => group.field_key === 'contacts')!.records.map((row) => row.id), [target.id]);
  assert.equal((await getModuleRecord(actor, activity.id)).revision, activity.revision + 1);
  assert.equal((await getModuleRecord(actor, outreach.id)).revision, outreach.revision + 1);
  assert.equal((await listModuleRecordTaskLinks(actor, installation.slug, target.id))[0]!.task_id, taskId);
  const history = await listModuleMergeHistory(actor, installation.id, target.id);
  assert.equal(history.merges.length, 1); assert.deepEqual(history.merges[0]!.source_data, source.data);
  assert.equal(history.merges[0]!.target_data.name, 'Curated person'); assert.ok(!('link_snapshot' in history.merges[0]!));
  const archived = (await db.select().from(moduleRecords).where(eq(moduleRecords.id, source.id)))[0]!;
  assert.deepEqual(archived.data, source.data);
  assert.equal((await db.select().from(crossReferences).where(and(eq(crossReferences.org_id, orgId), eq(crossReferences.source_id, source.resource_id)))).length, 1);
  await assert.rejects(listModuleMergeHistory(humanModuleActor({ orgId: randomUUID(), userId, role: 'owner', source: 'rest' }), installation.id, target.id));
  await assert.rejects(previewModuleMerge(humanModuleActor({ orgId, userId, role: 'guest', source: 'rest' }), installation.id, chosen));

  // A restricted task blocks the entire review without returning its title or references.
  const otherUser = randomUUID(); await db.insert(users).values({ id: otherUser, name: 'Private owner', email: `${otherUser}@example.test` });
  const privateSource = await create('contacts', { name: 'Private-linked source' }), privateTarget = await create('contacts', { name: 'Private-linked target' });
  const privateTask = randomUUID(); await db.insert(tasks).values({ id: privateTask, org_id: orgId, project_id: projectId, number: 2, title: 'Never disclose this', created_by: otherUser, metadata: { visibility: 'restricted' } });
  await db.insert(crossReferences).values({ org_id: orgId, source_type: 'module_record', source_id: privateSource.resource_id, target_type: 'task', target_id: privateTask, created_by: otherUser });
  await assert.rejects(previewModuleMerge(actor, installation.id, { ...chosen, source_record_id: privateSource.id, target_record_id: privateTarget.id }), (error: unknown) => error instanceof Error && /inaccessible/i.test(error.message) && !error.message.includes('Never disclose'));

  // Task visibility is rechecked after a reviewed preview, before any merge effect.
  const revSource = await create('contacts', { name: 'Revocation source' }), revTarget = await create('contacts', { name: 'Revocation target' });
  const revTask = randomUUID(); await db.insert(tasks).values({ id: revTask, org_id: orgId, project_id: projectId, number: 3, title: 'Revoke before commit', created_by: otherUser });
  await linkModuleRecordToTask(actor, revTask, revSource.resource_id);
  const revInput = { ...input, source_record_id: revSource.id, target_record_id: revTarget.id, field_choices: { name: 'target' } };
  const revPreview = await previewModuleMerge(actor, installation.id, revInput);
  await db.update(tasks).set({ metadata: { visibility: 'restricted' } }).where(eq(tasks.id, revTask));
  await assert.rejects(commitModuleMerge(actor, installation.id, { ...revInput, expected_preview_digest: revPreview.preview_digest, idempotency_key: randomUUID() }), /inaccessible/i);
  assert.equal((await getModuleRecord(actor, revSource.id)).revision, revSource.revision);

  // Force a late survivor update failure after edge/history writes; every effect must roll back.
  const rollbackSource = await create('contacts', { name: 'Collision name' }), rollbackTarget = await create('contacts', { name: 'Different name' });
  const rollbackActivity = await create('activities', { subject: 'Rollback call' }, { contact_id: [rollbackSource.id] });
  const rollbackInput = { ...input, source_record_id: rollbackSource.id, target_record_id: rollbackTarget.id, field_choices: { name: 'source' } };
  const rollbackPreview = await previewModuleMerge(actor, installation.id, rollbackInput);
  const index = `merge_failure_${randomUUID().replaceAll('-', '')}`;
  await db.execute(sql.raw(`CREATE UNIQUE INDEX ${index} ON module_records(search_title) WHERE org_id = '${orgId}' AND collection_key = 'contacts' AND is_deleted = false`));
  try {
    await assert.rejects(commitModuleMerge(actor, installation.id, { ...rollbackInput, expected_preview_digest: rollbackPreview.preview_digest, idempotency_key: randomUUID() }));
    assert.equal((await getModuleRecord(actor, rollbackTarget.id)).data.name, 'Different name');
    assert.equal((await getModuleRecord(actor, rollbackSource.id)).revision, rollbackSource.revision);
    assert.equal((await getModuleRecordRelations(actor, rollbackActivity.id))[0]!.records[0]!.id, rollbackSource.id);
    assert.equal((await db.select().from(moduleRecordMerges).where(eq(moduleRecordMerges.source_record_id, rollbackSource.id))).length, 0);
  } finally { await db.execute(sql.raw(`DROP INDEX ${index}`)); }
});
