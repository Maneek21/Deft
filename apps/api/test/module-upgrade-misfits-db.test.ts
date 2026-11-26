import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { orgMembers, orgs, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  upgradeModuleInstallationToManifest,
} from '../src/lib/module-service.js';
import { ModuleError } from '../src/lib/module-errors.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

type Field = { key: string; label: string; type: string; required?: boolean; options?: Array<{ value: string; label: string }> };

function hiring(version: string, candidateFields: Field[]) {
  return {
    schema_version: '1',
    id: 'com.example.misfits',
    slug: 'misfits',
    version,
    name: 'Hiring',
    collections: [{
      key: 'candidates',
      name: 'Candidates',
      fields: candidateFields,
      search: { title_field: 'name', fields: ['name'] },
    }],
  };
}

const baseFields: Field[] = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'notes', label: 'Notes', type: 'long_text' },
];

async function seed(names: Array<{ name: string; email?: string; notes?: string }>) {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Misfits', slug: `misfits-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Owner', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const installed = await installModuleFromManifest(actor, hiring('1.0.0', baseFields), { source: 'sideloaded' });
  for (const data of names) {
    await createModuleRecord(actor, {
      module_id: installed.module_id,
      collection_key: 'candidates',
      data,
      relations: {},
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: randomUUID(),
    });
  }
  return { actor, installed };
}

async function refusal(promise: Promise<unknown>): Promise<ModuleError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ModuleError, String(error));
    return error;
  }
  assert.fail('expected the update to be refused');
}

test('making a field required names the records that lack it', { skip: !canRun }, async () => {
  const { actor, installed } = await seed([
    { name: 'Dana Example' },
    { name: 'Sam Sample' },
    { name: 'Riley Ready', email: 'riley@example.com' },
  ]);
  const next = hiring('1.1.0', baseFields.map((field) => (field.key === 'email' ? { ...field, required: true } : field)));
  const error = await refusal(upgradeModuleInstallationToManifest(actor, 'misfits', next, {
    source: 'sideloaded',
    expected_active_manifest_digest: installed.manifest_digest,
  }));
  assert.equal(error.status, 400);
  assert.equal(error.code, 'MODULE_VALIDATION_ERROR');
  assert.equal(error.message, 'Candidates → Email: now required, but empty in "Dana Example" and "Sam Sample"');
  const records = error.details?.records as Array<{ title: string; field: string }>;
  assert.deepEqual(records.map((record) => record.title).sort(), ['Dana Example', 'Sam Sample']);
  assert.equal(error.details?.record_count, 2);
});

test('removing a field that still holds data names the records, up to five', { skip: !canRun }, async () => {
  const names = Array.from({ length: 7 }, (_, index) => ({ name: `Person ${index + 1}`, notes: 'keep me' }));
  const { actor, installed } = await seed(names);
  const next = hiring('1.1.0', baseFields.filter((field) => field.key !== 'notes'));
  const error = await refusal(upgradeModuleInstallationToManifest(actor, 'misfits', next, {
    source: 'sideloaded',
    expected_active_manifest_digest: installed.manifest_digest,
  }));
  assert.match(
    error.message,
    /^Candidates → Notes: removed, but still has a value in "Person \d", "Person \d", "Person \d", "Person \d", "Person \d" and 2 more$/,
  );
  assert.equal(error.details?.record_count, 7);
});

test('record titles from people never bring markup or hidden characters into the message', { skip: !canRun }, async () => {
  const { actor, installed } = await seed([{ name: `<img src=x onerror=alert(1)>${String.fromCodePoint(0x202e)}"Eve"` }]);
  const next = hiring('1.1.0', baseFields.map((field) => (field.key === 'email' ? { ...field, required: true } : field)));
  const error = await refusal(upgradeModuleInstallationToManifest(actor, 'misfits', next, {
    source: 'sideloaded',
    expected_active_manifest_digest: installed.manifest_digest,
  }));
  assert.doesNotMatch(error.message, /[<>]/);
  assert.ok(!error.message.includes(String.fromCodePoint(0x202e)));
  assert.match(error.message, /^Candidates → Email: now required, but empty in "img src=x onerror=alert\(1\) Eve"$/);
});

test('five records are named in all, across lines, and details stay at 20 records with their problems', { skip: !canRun }, async () => {
  const names = Array.from({ length: 25 }, (_, index) => ({ name: `Person ${index + 1}` }));
  const { actor, installed } = await seed(names);
  const next = hiring('1.1.0', [
    ...baseFields.map((field) => (field.key === 'email' ? { ...field, required: true } : field)),
    { key: 'phone', label: 'Phone', type: 'text', required: true },
  ]);
  const error = await refusal(upgradeModuleInstallationToManifest(actor, 'misfits', next, {
    source: 'sideloaded',
    expected_active_manifest_digest: installed.manifest_digest,
  }));
  const lines = error.message.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^Candidates → Email: now required, but empty in ("Person \d+", ){4}"Person \d+" and 20 more$/);
  assert.equal(lines[1], 'Candidates → Phone: now required, but empty in 25 records');
  assert.equal((error.message.match(/"Person/g) ?? []).length, 5);
  assert.equal(error.details?.record_count, 25);
  const records = error.details?.records as Array<{ problems: unknown[] }>;
  assert.equal(records.length, 20);
  assert.ok(records.every((record) => record.problems.length === 2));
});
