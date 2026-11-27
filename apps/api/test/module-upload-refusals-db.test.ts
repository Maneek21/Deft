import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { orgMembers, orgs, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { ModuleError } from '../src/lib/module-errors.js';
import {
  createModuleRecord, humanModuleActor, installModuleFromManifest, upgradeModuleInstallationToManifest,
} from '../src/lib/module-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
after(closeDb);

function collection(key: string, name: string) {
  return {
    key, name, fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
    search: { title_field: 'title', fields: ['title'] },
  };
}

function file(version: string, collections = [collection('items', 'Items')]) {
  return { schema_version: '1', id: 'org.example.inventory', slug: 'inventory', version, name: 'Inventory', collections };
}

async function seed(manifest: ReturnType<typeof file>) {
  const orgId = randomUUID();
  const userId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Independent tester', slug: `tester-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'Tester', email: `${userId}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true });
  const actor = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
  const installed = await installModuleFromManifest(actor, manifest, { source: 'sideloaded' });
  const update = (next: ReturnType<typeof file>) => upgradeModuleInstallationToManifest(actor, 'inventory', next, {
    source: 'sideloaded', expected_active_manifest_digest: installed.manifest_digest,
  });
  const add = (key: string, title: string) => createModuleRecord(actor, {
    module_id: installed.module_id, collection_key: key, data: { title }, relations: {},
    expected_manifest_digest: installed.manifest_digest, idempotency_key: randomUUID(),
  });
  return { update, add };
}

async function refusal(promise: Promise<unknown>, status: number, code: string) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ModuleError, String(error));
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail('update should have been refused');
}

for (const [label, installed, uploaded, patch, changed] of [
  ['older', '3.8.12', '2.99.99', '3.8.13', false],
  ['identical', '3.8.12', '3.8.12', '3.8.13', false],
  ['equal version with changed content', '3.8.12', '3.8.12', '3.8.13', true],
  ['equal precedence with build metadata', '3.8.12+installed', '3.8.12+uploaded', '3.8.13', false],
] as const) {
  test(`${label}: server keeps 409/code and recommends installed next patch`, { skip: !canRun }, async () => {
    const { update } = await seed(file(installed));
    const next = { ...file(uploaded), ...(changed ? { name: 'Inventory revised' } : {}) };
    const error = await refusal(update(next), 409, 'MODULE_UPDATE_NOT_AVAILABLE');
    assert.ok(error.message.includes(installed), error.message);
    assert.ok(error.message.includes(uploaded), error.message);
    assert.ok(error.message.includes(`such as ${patch}`), error.message);
  });
}

test('removed populated types share five names, overflow and count-only lines', { skip: !canRun }, async () => {
  const { update, add } = await seed(file('3.8.12', [
    collection('items', 'Items'), collection('warehouses', 'Warehouses'),
    collection('suppliers', 'Suppliers'), collection('keep', 'Retained type'),
  ]));
  const names: Record<string, string[]> = {
    items: Array.from({ length: 7 }, (_, i) => `Asset ${i + 1}`),
    warehouses: ['North depot', 'South depot'], suppliers: ['Solo supplier'],
  };
  for (const [key, titles] of Object.entries(names)) for (const title of titles) await add(key, title);
  const error = await refusal(update(file('3.8.13', [collection('keep', 'Retained type')])), 400, 'MODULE_VALIDATION_ERROR');
  const lines = error.message.split('\n');
  const expected = [['Items', names.items!], ['Warehouses', names.warehouses!], ['Suppliers', names.suppliers!]] as const;
  let named = 0;
  for (const [label, titles] of expected) {
    const line = lines.find((candidate) => candidate.startsWith(`${label}:`));
    assert.ok(line, error.message);
    assert.match(line, /still holds.*records?/i, line);
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(quoted.every((title) => titles.includes(title)), line);
    assert.ok(quoted.length <= 5 - named, error.message);
    named += quoted.length;
    if (quoted.length === 0) assert.match(line, new RegExp(`\\b${titles.length} records?\\b`), line);
    else if (quoted.length < titles.length) assert.ok(line.includes(`and ${titles.length - quoted.length} more`), line);
  }
  assert.equal(named, 5, error.message);
});
