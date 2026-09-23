import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModuleManifest, moduleRecordPayload, initialModuleRecordValues } from './modules';
import { incomingCreateRelations, incomingModuleFields, incomingTimelineDateField, initialModuleRelationValues, moduleFormRelationPatch } from './module-form-relations';

const manifest = normalizeModuleManifest({
  schema_version: '1', id: 'test.relationships', slug: 'relationships', version: '1.0.0', name: 'Relationships',
  collections: [
    { key: 'companies', name: 'Companies', fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    { key: 'contacts', name: 'Contacts', fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'company', label: 'Company', type: 'relation', target_collection: 'companies' },
      { key: 'peers', label: 'Peers', type: 'relation', target_collection: 'contacts', multiple: true },
    ] },
  ],
});
const contacts = manifest.collections[1]!;

test('incoming history follows the preferred view and requires a declared date field', () => {
  const collection = normalizeModuleManifest({ ...manifest.raw, collections: [{ key: 'events', name: 'Events', fields: [{ key: 'when', label: 'When', type: 'datetime' }], views: [{ key: 'history', name: 'History', type: 'timeline', fields: ['when'], start_field: 'when' }] }] }).collections[0]!;
  assert.equal(incomingTimelineDateField(collection)?.key, 'when');
  assert.equal(incomingTimelineDateField({ ...collection, views: [{ ...collection.views[0]!, type: 'board' }, ...collection.views] }), undefined);
  assert.equal(incomingTimelineDateField({ ...collection, fields: [] }), undefined);
});

test('contextual activity defaults round-trip local datetime and retain manifest defaults', () => {
  const collection = normalizeModuleManifest({ ...manifest.raw, collections: [{ key: 'events', name: 'Events', fields: [{ key: 'when', label: 'When', type: 'datetime' }, { key: 'kind', label: 'Kind', type: 'single_select', default: 'note', options: [{ value: 'note', label: 'Note' }, { value: 'call', label: 'Call' }] }] }] }).collections[0]!;
  const values = initialModuleRecordValues(collection, null, { when: '2026-09-09T08:00:00Z', kind: 'call' });
  assert.deepEqual(moduleRecordPayload(collection, values), { when: '2026-09-09T08:00:00.000Z', kind: 'call' });
  assert.equal(initialModuleRecordValues(collection).kind, 'note');
});

test('a contextual create saves relations separately from ordinary data', () => {
  const values = { name: 'Ada', ...initialModuleRelationValues(contacts, [{ fieldKey: 'company', records: [{ id: 'company-1', collectionKey: 'companies', label: 'Acme' }] }]) };
  assert.deepEqual(moduleRecordPayload(contacts, values), { name: 'Ada' });
  assert.deepEqual(moduleFormRelationPatch(contacts, values, new Set(), false), { company: ['company-1'] });
});

test('scalar edits never replace an untouched, potentially stale relationship projection', () => {
  assert.deepEqual(moduleFormRelationPatch(contacts, { name: 'Ada', company: ['old-company'], peers: [] }, new Set(['name']), true), {});
});

test('explicitly clearing a relation is preserved and multi-select replacement is deduplicated', () => {
  assert.deepEqual(moduleFormRelationPatch(contacts, { company: [], peers: ['a', 'b', 'a'] }, new Set(['company', 'peers']), true), { company: [], peers: ['a', 'b'] });
});

test('reverse sections derive from exact declared targets, including self-relations', () => {
  assert.deepEqual(incomingModuleFields(manifest.collections, 'companies').map(({ collection, field }) => [collection.key, field.key]), [['contacts', 'company']]);
  assert.deepEqual(incomingModuleFields(manifest.collections, 'contacts').map(({ field }) => field.key), ['peers']);
  assert.deepEqual(incomingModuleFields(manifest.collections, 'unknown'), []);
});

test('incoming create suggests one matching visible single relation and preserves the direct relation', () => {
  const deals = { ...contacts, key: 'deals', name: 'Deals', fields: [
    { ...contacts.fields[1]!, key: 'contact', label: 'Contact', targetCollection: 'contacts' },
    contacts.fields[1]!,
  ] };
  const target = { id: 'contact-1', resourceId: 'module_record:contact-1', collectionKey: 'contacts', data: {}, revision: 1, createdAt: null, updatedAt: null, members: [], relations: [
    { fieldKey: 'company', records: [{ id: 'company-1', collectionKey: 'companies', label: 'Acme' }] },
  ] };
  const direct = { fieldKey: 'contact', records: [{ id: target.id, collectionKey: 'contacts', label: 'Ada' }] };

  assert.deepEqual(incomingCreateRelations(deals, contacts, target, direct), [direct, target.relations[0]]);
  assert.deepEqual(incomingCreateRelations(deals, contacts, { ...target, relations: [] }, direct), [direct]);
});

test('incoming relation suggestions reject ambiguity, collection mismatch, multiple fields, and direct overrides', () => {
  const source = { ...contacts, key: 'deals', name: 'Deals', fields: [contacts.fields[1]!, { ...contacts.fields[2]!, multiple: false }] };
  const target = { id: 'contact-1', resourceId: 'module_record:contact-1', collectionKey: 'contacts', data: {}, revision: 1, createdAt: null, updatedAt: null, members: [], relations: [
    { fieldKey: 'company', records: [
      { id: 'company-1', collectionKey: 'companies', label: 'Acme' },
      { id: 'company-2', collectionKey: 'companies', label: 'Other' },
    ] },
    { fieldKey: 'peers', records: [{ id: 'contact-2', collectionKey: 'contacts', label: 'Grace' }] },
  ] };
  const direct = { fieldKey: 'company', records: [{ id: 'chosen', collectionKey: 'companies', label: 'Chosen' }] };

  assert.deepEqual(incomingCreateRelations(source, contacts, target, direct), [direct]);
  assert.deepEqual(incomingCreateRelations(source, contacts, { ...target, relations: [{ fieldKey: 'company', records: [{ id: 'wrong', collectionKey: 'contacts', label: 'Wrong' }] }] }, { fieldKey: 'contact', records: [] }), [{ fieldKey: 'contact', records: [] }]);
});

test('contextual create carries an unambiguous visible relation across different field names', () => {
  const personField = { ...contacts.fields[1]!, key: 'primary_person', targetCollection: 'contacts' };
  const targetCollection = { ...contacts, key: 'projects', fields: [personField] };
  const sourceCollection = { ...contacts, key: 'events', fields: [{ ...personField, key: 'person' }] };
  const person = { id: 'person-1', collectionKey: 'contacts', label: 'Ada' };
  const target = { id: 'project-1', resourceId: 'module_record:project-1', collectionKey: 'projects', data: {}, revision: 1, createdAt: null, updatedAt: null, members: [], relations: [{ fieldKey: 'primary_person', records: [person] }] };
  const direct = { fieldKey: 'project', records: [{ id: target.id, collectionKey: 'projects', label: 'Launch' }] };

  assert.deepEqual(incomingCreateRelations(sourceCollection, targetCollection, target, direct), [direct, { fieldKey: 'person', records: [person] }]);
  assert.deepEqual(incomingCreateRelations(sourceCollection, targetCollection, { ...target, relations: [] }, direct), [direct]);
  assert.deepEqual(incomingCreateRelations(sourceCollection, { ...targetCollection, fields: [personField, { ...personField, key: 'reviewer' }] }, target, direct), [direct]);
  assert.deepEqual(incomingCreateRelations({ ...sourceCollection, fields: [...sourceCollection.fields, { ...personField, key: 'reviewer' }] }, targetCollection, target, direct), [direct]);
  assert.deepEqual(incomingCreateRelations(sourceCollection, { ...targetCollection, fields: [{ ...personField, multiple: true }] }, target, direct), [direct]);
});
