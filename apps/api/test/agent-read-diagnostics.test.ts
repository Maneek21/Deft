import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAgentReadDiagnostics } from '../src/lib/agent-read-diagnostics.js';

const read = (action: string, params: unknown, result: unknown, success: unknown = true) => ({ action, params, result, success, readOnly: true });
test('ordinary read diagnostics preserve actual wiki counts and omit sensitive values', () => {
  const rows = [read('wiki_search', { query: 'private query', limit: 5, Authorization: 'secret' }, { pages: [{ title: 'Private title', slug: 'private-slug' }] }),
    read('wiki_read', { slug: 'private-slug' }, { title: 'Private title', slug: 'private-slug', content: 'secret body', version: 3 }),
    read('wiki_search', { query: 'empty' }, { pages: [] }), read('wiki_read', { slug: 'missing' }, { error: 'private error' }, false),
    read('wiki_search', {}, { count: 0 }), read('wiki_read', {}, {}, null)];
  const out = projectAgentReadDiagnostics(rows);
  assert.deepEqual(out.entries.map((entry) => entry.result_count), [1, 1, 0, null, null, null]);
  assert.deepEqual(out.entries[0]!.input_fields, ['limit', 'query']);
  assert.equal(out.entries[3]!.status, 'failed');
  assert.equal(out.entries[5]!.status, 'unknown');
  for (const secret of ['private query', 'private-slug', 'Private title', 'secret body', 'secret', 'Authorization', 'private error']) assert.ok(!JSON.stringify(out).includes(secret));
  const first = projectAgentReadDiagnostics([read('wiki_search', { query: 'x', limit: 5 }, {})]).entries[0]!;
  const reordered = projectAgentReadDiagnostics([read('wiki_search', { limit: 5, query: 'x' }, {})]).entries[0]!;
  assert.equal(first.input_sha256, reordered.input_sha256);
});

test('ordinary read diagnostics validate module shapes and bound entries and input hashing', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const record = { id, resource_id: 'module_record:' + id, installation_id: id, module_id: 'com.deft.contacts', collection_key: 'contacts', manifest_digest: 'sha256:' + 'a'.repeat(64), data: { name: 'Private record' }, relations: [], members: [], revision: 2, created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z', archived_at: null };
  const cycle: any = {}; cycle.self = cycle;
  const out = projectAgentReadDiagnostics([read('module_record_get', { record_id: id }, { record }), read('module_record_query', { module_id: 'com.deft.contacts', collection_key: 'contacts' }, { items: [record], next_cursor: null }),
    read('module_record_search', { search: 'private' }, { items: [], next_cursor: null }), read('module_record_get', {}, { record: {} }), read('wiki_search', cycle, {}), read('wiki_search', { query: 'x'.repeat(16385) }, {}),
    read('unknown_tool', { password: 'hidden' }, {}), { ...read('wiki_write', {}, {}), readOnly: false }]);
  assert.deepEqual(out.entries.map((entry) => entry.result_count), [1, 1, 0, null, null, null]);
  assert.equal(out.entries[4]!.input_hash_status, 'unavailable');
  assert.equal(out.entries[5]!.input_sha256, null);
  assert.ok(!JSON.stringify(out).includes(id));
  assert.ok(!JSON.stringify(out).includes('Private record'));
  const capped = projectAgentReadDiagnostics(Array.from({ length: 25 }, () => read('wiki_search', {}, { pages: [] })));
  assert.equal(capped.entries.length, 20); assert.equal(capped.omitted_count, 5);
});
