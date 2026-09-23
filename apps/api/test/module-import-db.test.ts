import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { orgs, users, orgMembers, moduleRecords, moduleMutationReceipts } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { humanModuleActor, installModuleFromManifest, createModuleRecord, previewModuleImport, commitModuleImport, archiveModuleRecord } from '../src/lib/module-service.js';
import { ModuleError } from '../src/lib/module-errors.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
const url = safeTestDatabaseUrl();
const canRun = Boolean(url);
after(closeDb);

test('Module import previews, skips duplicates, commits atomically and replays native receipts', { skip: !canRun }, async () => {
  const orgId = randomUUID(), userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Import test', slug: `import-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Import owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const installation = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  const create = (name: string, email: string) => createModuleRecord(actor, { module_id: installation.module_id, collection_key: 'contacts',
    data: { name, email }, relations: {}, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() });
  const existing = (await create('Keep existing', 'existing@example.test')).record!;
  const archived = (await create('Recover me', 'archived@example.test')).record!;
  await archiveModuleRecord(actor, { record_id: archived.id, expected_revision: archived.revision, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() });
  const input = { module_id: installation.module_id, collection_key: 'contacts', match_field: 'email', expected_manifest_digest: installation.manifest_digest,
    rows: [{ name: 'Do not overwrite', email: 'EXISTING@example.test' }, { name: 'New contact', email: 'new@example.test' },
      { name: 'Repeated row', email: 'NEW@example.test' }, { name: 'Archived match', email: 'archived@example.test' }] };
  const preview = await previewModuleImport(actor, input);
  assert.deepEqual(preview.rows.map((row) => row.state), ['existing', 'new', 'duplicate_in_file', 'existing']);
  assert.equal(preview.rows[3]!.matches[0]!.archived, true);
  assert.equal((await db.select().from(moduleRecords).where(eq(moduleRecords.installation_id, installation.id))).length, 2, 'preview writes nothing');
  const request = { ...input, expected_preview_digest: preview.preview_digest, idempotency_key: randomUUID() };
  const result = await commitModuleImport(actor, request);
  assert.equal(result.results.length, 1); assert.equal(result.skipped_count, 3);
  const replay = await commitModuleImport(actor, request);
  assert.equal(replay.results[0]!.record_id, result.results[0]!.record_id);
  assert.equal(replay.results[0]!.replayed, true);
  assert.equal((await db.select().from(moduleRecords).where(eq(moduleRecords.installation_id, installation.id))).length, 3);
  assert.deepEqual((await db.select().from(moduleRecords).where(eq(moduleRecords.id, existing.id)))[0]!.data, existing.data);
  const rerun = await previewModuleImport(actor, input);
  assert.equal(rerun.new_count, 0);
  const invalid = { ...input, rows: [{ name: 'Good row', email: 'good@example.test' }, { name: '', email: 'invalid' }] };
  const invalidPreview = await previewModuleImport(actor, invalid);
  assert.equal(invalidPreview.invalid_count, 1);
  await assert.rejects(commitModuleImport(actor, { ...invalid, expected_preview_digest: invalidPreview.preview_digest, idempotency_key: randomUUID() }), (error: unknown) => error instanceof ModuleError && error.status === 400);
  assert.equal((await db.select().from(moduleMutationReceipts).where(and(eq(moduleMutationReceipts.org_id, orgId), eq(moduleMutationReceipts.operation, 'create')))).length, 3);
  await assert.rejects(commitModuleImport(actor, { ...request, rows: [{ ...input.rows[0]!, name: 'Changed input' }, ...input.rows.slice(1)] }), /Idempotency key/);
  const staleInput = { ...input, rows: [{ name: 'Race', email: 'race@example.test' }] };
  const stale = await previewModuleImport(actor, staleInput);
  await create('Created after review', 'race@example.test');
  await assert.rejects(commitModuleImport(actor, { ...staleInput, expected_preview_digest: stale.preview_digest, idempotency_key: randomUUID() }), (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_REVISION_CONFLICT');
  const atomicInput = { ...input, rows: [{ name: 'Must roll back', email: 'rollback@example.test' }, { name: 'Keep existing', email: 'different@example.test' }] };
  const atomicPreview = await previewModuleImport(actor, atomicInput);
  const indexName = `import_test_${orgId.replaceAll('-', '')}`;
  await db.execute(sql.raw(`CREATE UNIQUE INDEX ${indexName} ON module_records ((data->>'name')) WHERE org_id='${orgId}'`));
  try {
    await assert.rejects(commitModuleImport(actor, { ...atomicInput, expected_preview_digest: atomicPreview.preview_digest, idempotency_key: randomUUID() }));
    const rolledBack = await db.select().from(moduleRecords).where(and(eq(moduleRecords.org_id, orgId), sql`${moduleRecords.data}->>'email' = 'rollback@example.test'`));
    assert.equal(rolledBack.length, 0, 'late native create failure rolls back earlier imported rows');
  } finally { await db.execute(sql.raw(`DROP INDEX ${indexName}`)); }
  const concurrentInput = { ...input, rows: [{ name: 'Concurrent import', email: 'concurrent@example.test' }] };
  const concurrentPreview = await previewModuleImport(actor, concurrentInput);
  const concurrentRequest = { ...concurrentInput, expected_preview_digest: concurrentPreview.preview_digest, idempotency_key: randomUUID() };
  const concurrent = await Promise.all([commitModuleImport(actor, concurrentRequest), commitModuleImport(actor, concurrentRequest)]);
  assert.equal(concurrent[0]!.results[0]!.record_id, concurrent[1]!.results[0]!.record_id);
  const missing = await previewModuleImport(actor, { ...input, rows: [{ name: 'Missing email' }] });
  assert.equal(missing.invalid_count, 1);
  await assert.rejects(previewModuleImport(humanModuleActor({ orgId, userId, role: 'guest', source: 'rest' }), input), /access|denied/i);
  const foreignActor = humanModuleActor({ orgId: randomUUID(), userId, role: 'owner', source: 'rest' });
  await assert.rejects(previewModuleImport(foreignActor, input), /not found|access|denied/i);
});
