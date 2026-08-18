import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffModuleRecordUpdate,
  findModuleCollection,
  getModuleCollectionFields,
  getModuleRecordTitle,
  moduleRecordHref,
  moduleRecordPayload,
  normalizeInstalledModulesResponse,
  normalizeModuleManifest,
  normalizeModuleRecordPage,
  validateModuleRecordValues,
} from './modules';

const rawManifest = {
  schema_version: '1',
  id: 'ing.deft.example.directory',
  slug: 'example-directory',
  version: '1.0.0',
  name: 'Example directory',
  collections: [
    {
      key: 'entries',
      name: 'Entries',
      singular_name: 'Entry',
      search: {
        title_field: 'name',
        subtitle_fields: ['email'],
        fields: ['name', 'email'],
      },
      views: [
        { key: 'main', name: 'Main', type: 'table', fields: ['name', 'email'] },
        { key: 'form', name: 'Form', type: 'form', fields: ['name', 'email', 'active'] },
      ],
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'active', label: 'Active', type: 'boolean', default: true },
        {
          key: 'groups',
          label: 'Groups',
          type: 'multi_select',
          options: [
            { value: 'customer', label: 'Customer' },
            { value: 'partner', label: 'Partner' },
          ],
        },
      ],
    },
  ],
};

test('normalizes the strict v1 manifest and preserves view field order', () => {
  const manifest = normalizeModuleManifest(rawManifest);
  assert.equal(manifest.moduleId, 'ing.deft.example.directory');
  assert.equal(manifest.collections[0].singularName, 'Entry');
  assert.equal(manifest.collections[0].titleField, 'name');
  assert.deepEqual(
    getModuleCollectionFields(manifest.collections[0], 'table').map((field) => field.key),
    ['name', 'email'],
  );
});

test('normalizes installed envelopes and record pages from the API contract', () => {
  const modules = normalizeInstalledModulesResponse({
    modules: [{
      id: 'installation-1',
      slug: 'example-directory',
      module_id: 'ing.deft.example.directory',
      enabled: true,
      agent_access: 'none',
      active_version_id: 'version-1',
      manifest_digest: 'sha256:abc',
      manifest: rawManifest,
    }],
  });
  assert.equal(modules.length, 1);
  assert.equal(modules[0].manifest.collections.length, 1);
  assert.equal(modules[0].enabled, true);

  const page = normalizeModuleRecordPage({
    records: [{
      id: 'record-1',
      collection_key: 'entries',
      data: { name: 'Ada', email: 'ada@example.com' },
      revision: 3,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }],
    next_cursor: 'cursor-2',
  });
  assert.equal(page.records[0].revision, 3);
  assert.equal(page.nextCursor, 'cursor-2');
});

test('validates required/email/url fields and coerces form payload types', () => {
  const manifest = normalizeModuleManifest({
    ...rawManifest,
    collections: [{
      ...rawManifest.collections[0],
      fields: [
        ...rawManifest.collections[0].fields,
        { key: 'score', label: 'Score', type: 'number' },
        { key: 'website', label: 'Website', type: 'url' },
        { key: 'met_at', label: 'Met at', type: 'datetime' },
      ],
    }],
  });
  const collection = manifest.collections[0];
  const errors = validateModuleRecordValues(collection, {
    name: '',
    email: 'broken',
    website: 'javascript:alert(1)',
  });
  assert.equal(errors.name, 'Name is required.');
  assert.match(errors.email, /valid email/);
  assert.match(errors.website, /http or https/);

  const payload = moduleRecordPayload(collection, {
    name: 'Ada',
    email: 'ada@example.com',
    active: true,
    groups: ['partner'],
    score: '42.5',
    website: 'https://example.com',
    met_at: '2026-01-02T10:30',
  });
  assert.equal(payload.score, 42.5);
  assert.equal(payload.active, true);
  assert.deepEqual(payload.groups, ['partner']);
  assert.equal(typeof payload.met_at, 'string');
});

test('omits empty optional multi-selects but preserves empty required arrays', () => {
  const manifest = normalizeModuleManifest({
    ...rawManifest,
    collections: [{
      ...rawManifest.collections[0],
      fields: [
        ...rawManifest.collections[0].fields,
        { key: 'labels', label: 'Labels', type: 'multi_select', options: [{ value: 'vip', label: 'VIP' }] },
        { key: 'regions', label: 'Regions', type: 'multi_select', required: true, options: [{ value: 'emea', label: 'EMEA' }] },
      ],
    }],
  });
  const collection = manifest.collections[0];

  assert.deepEqual(moduleRecordPayload(collection, {
    name: 'Acme',
    labels: [],
    regions: [],
  }), {
    name: 'Acme',
    regions: [],
  });
  assert.deepEqual(validateModuleRecordValues(collection, { name: 'Acme', regions: [] }), {});
});

test('builds minimal optimistic patches, explicit unsets, and stable encoded deep links', () => {
  const update = diffModuleRecordUpdate(
    { name: 'Ada', email: 'ada@example.com', active: true, groups: ['customer'] },
    { name: 'Ada', active: false, groups: ['customer', 'partner'] },
  );
  assert.deepEqual(update.patch, { active: false, groups: ['customer', 'partner'] });
  assert.deepEqual(update.unsetFields, ['email']);
  assert.deepEqual(
    diffModuleRecordUpdate(
      { name: 'Ada', met_at: '2026-01-02T10:30:00+05:30' },
      { name: 'Grace', met_at: '2026-01-02T05:00:00.000Z' },
      ['name'],
    ),
    { patch: { name: 'Grace' }, unsetFields: [] },
  );
  assert.equal(
    moduleRecordHref('example directory', 'people/list', 'record #1'),
    '/modules/example%20directory/people%2Flist/record%20%231',
  );
});

test('resolves a record title using collection search metadata', () => {
  const manifest = normalizeModuleManifest(rawManifest);
  const collection = findModuleCollection(manifest, 'entries');
  assert.ok(collection);
  const page = normalizeModuleRecordPage({
    records: [{ id: 'record-1', collection_key: 'entries', data: { name: 'Ada' }, revision: 1 }],
  });
  assert.equal(getModuleRecordTitle(page.records[0], collection), 'Ada');
});
