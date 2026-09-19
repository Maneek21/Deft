import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSupportedDeftModuleManifestJson, validateModuleRecordData } from '../packages/shared/src/modules.js';
import { normalizeModuleManifest } from '../apps/web/src/lib/modules.js';
import { parseModuleCsv, mapModuleImportRows } from '../apps/web/src/lib/module-import.js';

test('fictional CRM CSVs remain importable against the canonical manifest', async () => {
  const manifest = parseSupportedDeftModuleManifestJson(await readFile(new URL('../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8'));
  const normalized = normalizeModuleManifest(manifest);
  for (const [key, count] of [['contacts', 60], ['companies', 8], ['deals', 12], ['activities', 6], ['outreach', 2]] as const) {
    const parsed = parseModuleCsv(await readFile(new URL(`../modules/bundled/contacts/examples/${key}.csv`, import.meta.url), 'utf8'));
    assert.equal(parsed.rows.length, count);
    const collection = normalized.collections.find(item => item.key === key)!;
    const rows = mapModuleImportRows(collection, parsed.headers, parsed.rows);
    const matchField = key === 'contacts' ? 'email' : key === 'activities' ? 'subject' : 'name';
    assert.equal(new Set(rows.map(row => row[matchField])).size, rows.length);
    for (const row of rows) {
      const result = validateModuleRecordData(manifest, key, row);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.ok(!('company' in row) && !('owner_id' in row));
      if (row.email) assert.match(String(row.email), /@[^@]+\.test$/);
      if (key === 'outreach') assert.equal(row.status, 'draft');
    }
  }
});

test('repair practice has one deliberate invalid email and one existing sample email', async () => {
  const manifest = parseSupportedDeftModuleManifestJson(await readFile(new URL('../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8'));
  const collection = normalizeModuleManifest(manifest).collections.find(item => item.key === 'contacts')!;
  const parsed = parseModuleCsv(await readFile(new URL('../modules/bundled/contacts/examples/repair-practice.csv', import.meta.url), 'utf8'));
  const rows = mapModuleImportRows(collection, parsed.headers, parsed.rows);
  assert.equal(validateModuleRecordData(manifest, 'contacts', rows[0]).success, false);
  assert.equal(validateModuleRecordData(manifest, 'contacts', rows[1]).success, true);
  assert.equal(rows[1]?.email, 'person01@crm-demo.example.test');
});

test('compact flagship demo fixture is bounded and valid', async () => {
  const manifest = parseSupportedDeftModuleManifestJson(await readFile(new URL('../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8'));
  const normalized = normalizeModuleManifest(manifest);
  const expected = { companies: 2, contacts: 3, deals: 3, activities: 2, outreach: 1 } as const;
  for (const [key, count] of Object.entries(expected) as Array<[keyof typeof expected, number]>) {
    const parsed = parseModuleCsv(await readFile(new URL(`../modules/bundled/contacts/examples/flagship-demo/${key}.csv`, import.meta.url), 'utf8'));
    assert.equal(parsed.rows.length, count);
    const collection = normalized.collections.find(item => item.key === key)!;
    const rows = mapModuleImportRows(collection, parsed.headers, parsed.rows);
    const matchField = key === 'contacts' ? 'email' : key === 'activities' ? 'subject' : 'name';
    assert.equal(new Set(rows.map(row => row[matchField])).size, rows.length);
    for (const row of rows) assert.equal(validateModuleRecordData(manifest, key, row).success, true, `${key} row failed validation`);
    if (key === 'contacts') for (const row of rows) assert.match(String(row.email), /@[^@]+\.test$/);
    if (key === 'outreach') assert.equal(rows[0]?.status, 'draft');
  }
});
