import assert from 'node:assert/strict';
import test from 'node:test';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { planModuleRecordMerge, type MergeEdge } from '../src/lib/module-merge-plan.js';
const fields = getBundledModule('contacts')!.collections.find((collection) => collection.key === 'contacts')!.fields;
const edge = (id: string, source: string, target: string, field = 'contact_id'): MergeEdge => ({ id, source_record_id: source, target_record_id: target, field_key: field, position: 0 });
test('merge plan requires explicit conflicting choices and preserves zero, false and empty values', () => {
  const source = { id: 'source', data: { name: 'Imported', email: 'same@example.test', role: 'Founder', note: 'from import' } };
  const target = { id: 'target', data: { name: 'Curated', email: 'same@example.test', role: '', score: 0, enabled: false } };
  const edges = [edge('company-source', 'source', 'company-a', 'company_id'), edge('company-target', 'target', 'company-b', 'company_id')];
  const preview = planModuleRecordMerge(source, target, fields, edges, { field_choices: {}, relation_choices: {} });
  assert.equal(preview.ready, false); assert.deepEqual(preview.conflicts.map((item) => item.key), ['name', 'role', 'company_id']);
  assert.equal(preview.data.score, 0); assert.equal(preview.data.enabled, false); assert.equal(preview.data.role, '');
  const chosen = planModuleRecordMerge(source, target, fields, edges, { field_choices: { name: 'target', role: 'source' }, relation_choices: { company_id: 'source' } });
  assert.equal(chosen.ready, true); assert.equal(chosen.data.role, 'Founder'); assert.equal(chosen.data.note, 'from import');
  assert.deepEqual(chosen.remove_edge_ids, ['company-target']); assert.equal(chosen.add_edges[0]!.target_record_id, 'company-a');
  assert.deepEqual(source.data, { name: 'Imported', email: 'same@example.test', role: 'Founder', note: 'from import' });
});
test('incoming activities and audiences converge without deleting absorbed outgoing history', () => {
  const edges = [edge('activity', 'activity', 'source'), edge('audience-source', 'outreach', 'source', 'contacts'), edge('audience-target', 'outreach', 'target', 'contacts'), edge('company', 'source', 'company', 'company_id')];
  const plan = planModuleRecordMerge({ id: 'source', data: { name: 'Same' } }, { id: 'target', data: { name: 'Same' } }, fields, edges, { field_choices: {}, relation_choices: {} });
  assert.equal(plan.ready, true); assert.deepEqual(plan.remove_edge_ids, ['activity', 'audience-source']);
  assert.equal(plan.add_edges.filter((item) => item.source_record_id === 'outreach').length, 0);
  assert.ok(plan.add_edges.some((item) => item.source_record_id === 'activity' && item.target_record_id === 'target'));
  assert.ok(plan.add_edges.some((item) => item.source_record_id === 'target' && item.target_record_id === 'company'));
  assert.deepEqual(plan.affected_record_ids, ['activity', 'outreach', 'target']);
});
test('merge rejects same identity and invented field choices', () => {
  const source = { id: 'source', data: { name: 'Same' } }, target = { id: 'target', data: { name: 'Same' } };
  assert.throws(() => planModuleRecordMerge(source, source, fields, [], { field_choices: {}, relation_choices: {} }), /different/);
  assert.throws(() => planModuleRecordMerge(source, target, fields, [], { field_choices: { invented: 'source' }, relation_choices: {} }), /Unknown/);
});
