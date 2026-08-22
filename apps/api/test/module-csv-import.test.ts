import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeftModuleManifest } from '@deft/shared/modules';
import { compileCsvRows, parseCsv } from '../src/lib/module-csv-import.js';
import {
  ModuleRecordBulkCreateParamsSchema,
  moduleBulkCreateInputDigest,
  sanitizeModuleBulkCreateParamsForHistory,
} from '../src/lib/module-record-bulk-create.js';

const manifest = parseDeftModuleManifest({
  schema_version: '1',
  id: 'com.example.people',
  slug: 'people',
  version: '1.0.0',
  name: 'People',
  collections: [{
    key: 'contacts',
    name: 'Contacts',
    singular_name: 'Contact',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'company', label: 'Company', type: 'text', required: false },
      { key: 'company_id', label: 'Company', type: 'relation', target_collection: 'companies', multiple: false, required: false },
      { key: 'email', label: 'Email', type: 'email', required: false },
      { key: 'status', label: 'Status', type: 'single_select', required: false, default: 'active', options: [
        { value: 'lead', label: 'Lead' },
        { value: 'active', label: 'Active' },
      ] },
      { key: 'tags', label: 'Tags', type: 'tags', required: false },
      { key: 'score', label: 'Score', type: 'number', required: false },
      { key: 'subscribed', label: 'Subscribed', type: 'boolean', required: false },
      { key: 'notes', label: 'Notes', type: 'long_text', required: false },
    ],
  }, {
    key: 'companies',
    name: 'Companies',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  }],
});

test('RFC-style CSV parsing preserves quoted commas, newlines, and escaped quotes', () => {
  const parsed = parseCsv([
    '\uFEFFName,Email,Notes',
    '"Ada, Countess",ada@example.test,"First line',
    'Second ""quoted"" line"',
  ].join('\r\n'));
  assert.deepEqual(parsed.headers, ['Name', 'Email', 'Notes']);
  assert.deepEqual(parsed.rows, [[
    'Ada, Countess',
    'ada@example.test',
    'First line\r\nSecond "quoted" line',
  ]]);
});

test('manifest compilation prefers an exact field key over an ambiguous label and coerces declared types', () => {
  const parsed = parseCsv([
    'name,company,email,status,tags,score,subscribed',
    'Ada,Analytical Engines,ada@example.test,Lead,math;engines,42,yes',
  ].join('\n'));
  const rows = compileCsvRows(parsed, manifest, 'contacts');
  assert.deepEqual(rows, [{
    name: 'Ada',
    company: 'Analytical Engines',
    email: 'ada@example.test',
    status: 'lead',
    tags: ['math', 'engines'],
    score: 42,
    subscribed: true,
  }]);
  assert.equal(Object.hasOwn(rows[0]!, 'company_id'), false);
});

test('CSV validation reports a row and field without echoing cell PII', () => {
  const secret = 'private-invalid-address';
  assert.throws(
    () => compileCsvRows(parseCsv(`name,email\nAda,${secret}`), manifest, 'contacts'),
    (error: unknown) => {
      assert.match(String(error), /row 2.*email/i);
      assert.doesNotMatch(String(error), new RegExp(secret));
      return true;
    },
  );
});

test('bulk terminal history keeps provenance and field names but removes row values and retry key', () => {
  const input = ModuleRecordBulkCreateParamsSchema.parse({
    module_id: 'com.example.people',
    module_name: 'People',
    collection_key: 'contacts',
    collection_name: 'Contacts',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    source_file_name: 'contacts.csv',
    rows: [{ data: { name: 'Private Person', email: 'private@example.test' } }],
    idempotency_key: 'stable-batch-key',
  });
  const sanitized = sanitizeModuleBulkCreateParamsForHistory(input);
  assert.equal(sanitized.row_count, 1);
  assert.deepEqual(sanitized.changed_fields, ['email', 'name']);
  assert.equal(sanitized.input_digest, moduleBulkCreateInputDigest(input));
  const encoded = JSON.stringify(sanitized);
  assert.doesNotMatch(encoded, /Private Person|private@example\.test|stable-batch-key/);
});

test('CSV and batch contracts reject more than 100 rows', () => {
  const csv = ['name', ...Array.from({ length: 101 }, (_, index) => `Person ${index}`)].join('\n');
  assert.throws(() => parseCsv(csv), /limit is 100/i);
  assert.equal(ModuleRecordBulkCreateParamsSchema.safeParse({
    module_id: 'com.example.people',
    module_name: 'People',
    collection_key: 'contacts',
    collection_name: 'Contacts',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    source_file_name: 'contacts.csv',
    rows: Array.from({ length: 101 }, () => ({ data: { name: 'Person' } })),
    idempotency_key: 'stable-batch-key',
  }).success, false);
});
