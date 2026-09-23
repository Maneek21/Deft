import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { eq } from 'drizzle-orm';
import { orgs, users, orgMembers, moduleInstallations } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { humanModuleActor, installModuleFromManifest, createModuleRecord, archiveModuleRecord, listModuleDuplicateCandidates, getModuleRecord } from '../src/lib/module-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
const url = safeTestDatabaseUrl();
const canRun = Boolean(url);
after(closeDb);

test('duplicate candidates cover all live records with bounded group and record pages and no mutations', { skip: !canRun }, async () => {
  const orgId = randomUUID(), userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Duplicate review', slug: `duplicates-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Reviewer', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const installation = await installModuleFromManifest(actor, getBundledModule('contacts')!, { source: 'bundled' });
  const create = async (name: string, email?: string) => (await createModuleRecord(actor, {
    module_id: installation.module_id, collection_key: 'contacts', data: { name, ...(email ? { email } : {}) },
    expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID(),
  })).record!;
  const original = await create('Original', 'SHARED@example.test');
  for (let i = 0; i < 11; i++) await create(`Candidate ${i}`, 'shared@example.test');
  await create('Other first', 'other@example.test'); await create('Other second', 'other@example.test');
  await create('Wildcard first', 'literal%value@example.test'); await create('Wildcard second', 'literal%value@example.test');
  await create('  Shared Name  '); await create('shared name');
  const names = await listModuleDuplicateCandidates(actor, installation.id, { collection_key: 'contacts', match_field: 'name', search: 'shared name' });
  assert.equal(names.groups.length, 1); assert.equal(names.groups[0]!.count, 2);
  await create('Empty one'); await create('Empty two');
  const archived = await create('Archive-only match', 'archive@example.test');
  await create('Live unmatched', 'archive@example.test');
  await archiveModuleRecord(actor, { record_id: archived.id, expected_revision: archived.revision, expected_manifest_digest: installation.manifest_digest });
  const input = { collection_key: 'contacts', match_field: 'email' };
  const all = await listModuleDuplicateCandidates(actor, installation.id, input);
  assert.equal(all.groups.length, 3);
  const shared = all.groups.find((group) => group.value === 'shared@example.test')!;
  assert.equal(shared.count, 12); assert.equal(shared.records.length, 10); assert.equal(shared.next_record_offset, 10);
  const remaining = await listModuleDuplicateCandidates(actor, installation.id, { ...input, match_value: shared.value, record_offset: 10 });
  assert.equal(remaining.groups[0]!.records.length, 2); assert.equal(remaining.groups[0]!.next_record_offset, null);
  assert.equal(new Set([...shared.records, ...remaining.groups[0]!.records].map((row) => row.id)).size, 12);
  const first = await listModuleDuplicateCandidates(actor, installation.id, { ...input, limit: 1 });
  const second = await listModuleDuplicateCandidates(actor, installation.id, { ...input, limit: 1, offset: first.next_offset });
  assert.equal(first.next_offset, 1); assert.notEqual(first.groups[0]!.value, second.groups[0]!.value);
  const literal = await listModuleDuplicateCandidates(actor, installation.id, { ...input, search: '%' });
  assert.equal(literal.groups.length, 1); assert.equal(literal.groups[0]!.value, 'literal%value@example.test');
  assert.equal((await listModuleDuplicateCandidates(actor, installation.id, { collection_key: 'companies', match_field: 'name' })).groups.length, 0);
  assert.deepEqual((await getModuleRecord(actor, original.id)).data, original.data);
  assert.equal((await getModuleRecord(actor, original.id)).revision, original.revision);
  await assert.rejects(listModuleDuplicateCandidates(actor, installation.id, { ...input, match_field: 'company_id' }), /Choose a text/i);
  const guest = humanModuleActor({ orgId, userId, role: 'guest', source: 'rest' });
  await assert.rejects(listModuleDuplicateCandidates(guest, installation.id, input));
  const foreign = humanModuleActor({ orgId: randomUUID(), userId, role: 'owner', source: 'rest' });
  await assert.rejects(listModuleDuplicateCandidates(foreign, installation.id, input));
  await db.update(moduleInstallations).set({ is_enabled: false, disabled_at: new Date() }).where(eq(moduleInstallations.id, installation.id));
  await assert.rejects(listModuleDuplicateCandidates(actor, installation.id, input));
});
