import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModuleRelationReplacePayload,
  diffModuleRecordUpdate,
  filterAndSortModuleRecords,
  findModuleCollection,
  formatModuleRecordFieldValue,
  getDefaultModuleCollection,
  getModuleBoardGroupField,
  getModuleCollectionFields,
  getModuleCollectionViews,
  getModuleRecordTitle,
  getModuleTimelineFields,
  moduleCollectionHref,
  moduleRecordHref,
  moduleRecordPayload,
  normalizeBundledModulesResponse,
  normalizeModuleActivityResponse,
  normalizeInstalledModulesResponse,
  normalizeModuleManifest,
  normalizeModuleRecordPage,
  normalizeModuleRelationsResponse,
  previewModuleManifestJson,
  resolveModuleManifestUpload,
  resolveModuleView,
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

test('previews a local strict manifest with canonical digest and collection metadata', async () => {
  const preview = await previewModuleManifestJson(JSON.stringify(rawManifest));
  assert.equal(preview.moduleId, rawManifest.id);
  assert.equal(preview.slug, rawManifest.slug);
  assert.equal(preview.version, rawManifest.version);
  assert.deepEqual(preview.collections, [{ key: 'entries', name: 'Entries' }]);
  assert.match(preview.digest, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(
    () => previewModuleManifestJson(JSON.stringify({ ...rawManifest, script_url: 'https://bad.test/x.js' })),
    /Unrecognized key/,
  );
});

test('normalizes bundled update metadata and installation provenance', () => {
  assert.deepEqual(normalizeBundledModulesResponse({ modules: [{
    slug: 'example-directory',
    module_id: rawManifest.id,
    name: rawManifest.name,
    version: '1.1.0',
    installed: true,
    installed_version: '1.0.0',
    update_available: true,
  }] })[0], {
    slug: 'example-directory',
    moduleId: rawManifest.id,
    name: rawManifest.name,
    description: null,
    version: '1.1.0',
    icon: null,
    installed: true,
    installedVersion: '1.0.0',
    updateAvailable: true,
  });
  assert.equal(normalizeInstalledModulesResponse({ modules: [{
    id: 'install-1',
    slug: rawManifest.slug,
    module_id: rawManifest.id,
    source: 'sideloaded',
    manifest: rawManifest,
  }] })[0]?.source, 'sideloaded');
});

test('resolves local installs and sideload upgrades without crossing module identity', async () => {
  const preview = await previewModuleManifestJson(JSON.stringify(rawManifest));
  assert.deepEqual(resolveModuleManifestUpload(preview, []), { mode: 'install', target: null });
  const installed = normalizeInstalledModulesResponse({ modules: [{
    id: 'install-1',
    slug: rawManifest.slug,
    module_id: rawManifest.id,
    source: 'sideloaded',
    manifest_digest: `sha256:${'a'.repeat(64)}`,
    manifest: rawManifest,
  }] });
  assert.equal(resolveModuleManifestUpload(preview, installed).mode, 'upgrade');
  assert.throws(
    () => resolveModuleManifestUpload(
      { ...preview, moduleId: 'ing.deft.different' },
      installed,
      installed[0]?.id,
    ),
    /conflicts|does not match/,
  );
  assert.throws(
    () => resolveModuleManifestUpload(preview, [{ ...installed[0], source: 'bundled' }]),
    /Bundled modules/,
  );
});

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

test('omits empty optional multi-selects and rejects empty required arrays', () => {
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
  assert.deepEqual(validateModuleRecordValues(collection, { name: 'Acme', regions: [] }), {
    regions: 'Regions is required.',
  });
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
  assert.equal(
    moduleCollectionHref('example directory', 'people/list', 'by stage'),
    '/modules/example%20directory/people%2Flist?view=by%20stage',
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

test('normalizes generic navigation and resolves table, board, and timeline metadata', () => {
  const manifest = normalizeModuleManifest({
    schema_version: '1',
    id: 'ing.deft.example.pipeline',
    slug: 'example-pipeline',
    version: '1.1.0',
    name: 'Example pipeline',
    navigation: { default_collection: 'deals', default_view: 'pipeline' },
    collections: [{
      key: 'deals',
      name: 'Deals',
      singular_name: 'Deal',
      search: { title_field: 'name', subtitle_fields: ['stage'], fields: ['name', 'stage'] },
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        {
          key: 'stage',
          label: 'Stage',
          type: 'single_select',
          options: [{ value: 'new', label: 'New' }, { value: 'won', label: 'Won' }],
        },
        { key: 'owner', label: 'Owner', type: 'member' },
        { key: 'labels', label: 'Labels', type: 'tags' },
        { key: 'close_date', label: 'Close date', type: 'date' },
      ],
      views: [
        { key: 'all', name: 'All deals', type: 'table', fields: ['name', 'stage', 'owner'] },
        { key: 'pipeline', name: 'Pipeline', type: 'board', fields: ['name', 'stage'], group_by: 'stage' },
        { key: 'schedule', name: 'Schedule', type: 'timeline', fields: ['name', 'close_date'], start_field: 'close_date' },
      ],
    }],
  });
  const collection = getDefaultModuleCollection(manifest);
  assert.ok(collection);
  assert.equal(collection.key, 'deals');
  assert.deepEqual(getModuleCollectionViews(collection).map((view) => view.type), ['table', 'board', 'timeline']);
  const board = resolveModuleView(manifest, collection, null);
  assert.equal(board.key, 'pipeline');
  assert.equal(getModuleBoardGroupField(collection, board)?.key, 'stage');
  const timeline = resolveModuleView(manifest, collection, 'schedule');
  assert.equal(getModuleTimelineFields(collection, timeline).start?.key, 'close_date');
});

test('falls back to a table view for older manifests without browsable views', () => {
  const manifest = normalizeModuleManifest({
    ...rawManifest,
    collections: [{ ...rawManifest.collections[0], views: rawManifest.collections[0].views.filter((view) => view.type === 'form') }],
  });
  const views = getModuleCollectionViews(manifest.collections[0]);
  assert.equal(views.length, 1);
  assert.equal(views[0].type, 'table');
  assert.equal(views[0].key, 'table');
});

test('filters and sorts loaded records with select filters and stable empty ordering', () => {
  const collection = normalizeModuleManifest(rawManifest).collections[0];
  const page = normalizeModuleRecordPage({ records: [
    { id: '3', collection_key: 'entries', data: { name: 'No email', groups: ['customer'] }, revision: 1 },
    { id: '2', collection_key: 'entries', data: { name: 'Grace', email: 'grace@example.com', groups: ['partner'] }, revision: 1 },
    { id: '1', collection_key: 'entries', data: { name: 'Ada', email: 'ada@example.com', groups: ['partner'] }, revision: 1 },
  ] });
  const filtered = filterAndSortModuleRecords(
    page.records,
    collection,
    'example.com',
    { fieldKey: 'name', direction: 'desc' },
    null,
  );
  assert.deepEqual(filtered.map((record) => record.data.name), ['Grace', 'Ada']);
  const partners = filterAndSortModuleRecords(page.records, collection, '', null, { fieldKey: 'groups', value: 'partner' });
  assert.deepEqual(partners.map((record) => record.id), ['2', '1']);
});

test('normalizes relation and audit envelopes for record side panels', () => {
  assert.deepEqual(normalizeModuleRelationsResponse({
    relations: [{
      field_key: 'company',
      records: [{ id: 'company-1', collection_key: 'companies', label: 'Acme' }],
    }],
  }), [{ fieldKey: 'company', records: [{ id: 'company-1', collectionKey: 'companies', label: 'Acme' }] }]);

  assert.deepEqual(normalizeModuleActivityResponse([{
    id: 'audit-1',
    action: 'module_record.update',
    actor_type: 'user',
    actor_id: 'user-1',
    actor_name: 'Lina Ortega',
    metadata: { changed_fields: ['email'] },
    created_at: '2026-01-02T00:00:00.000Z',
  }]), [{
    id: 'audit-1',
    action: 'module_record.update',
    actorType: 'user',
    actorId: 'user-1',
    actorName: 'Lina Ortega',
    metadata: { changed_fields: ['email'] },
    createdAt: '2026-01-02T00:00:00.000Z',
  }]);
});

test('keeps batched relation and member labels on list records', () => {
  const [record] = normalizeModuleRecordPage({ records: [{
    id: 'contact-1',
    collection_key: 'contacts',
    data: { name: 'Ada', owner: 'member-1' },
    revision: 1,
    relations: [{
      field_key: 'company',
      records: [{ id: 'company-1', collection_key: 'companies', label: 'Analytical Engines' }],
    }],
    members: [{ field_key: 'owner', members: [{ id: 'member-1', label: 'Grace Hopper' }] }],
  }] }).records;
  assert.ok(record);
  assert.deepEqual(record.relations[0], {
    fieldKey: 'company',
    records: [{ id: 'company-1', collectionKey: 'companies', label: 'Analytical Engines' }],
  });
  assert.deepEqual(record.members[0], {
    fieldKey: 'owner',
    members: [{ id: 'member-1', label: 'Grace Hopper' }],
  });
  const hydratedCollection = normalizeModuleManifest({
    schema_version: '1',
    id: 'community.example.hydration',
    slug: 'hydration',
    version: '1.0.0',
    name: 'Hydration',
    collections: [
      {
        key: 'contacts',
        name: 'Contacts',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'company', label: 'Company', type: 'relation', target_collection: 'companies' },
          { key: 'owner', label: 'Owner', type: 'member' },
        ],
      },
      {
        key: 'companies',
        name: 'Companies',
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      },
    ],
  }).collections[0]!;
  assert.equal(formatModuleRecordFieldValue(record, hydratedCollection.fields[1]!), 'Analytical Engines');
  assert.equal(formatModuleRecordFieldValue(record, hydratedCollection.fields[2]!), 'Grace Hopper');
});

test('builds a retry-safe relation replacement from the live record CAS', () => {
  const recordIds = ['company-1'];
  const payload = buildModuleRelationReplacePayload({
    recordIds,
    expectedRevision: 7,
    expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: 'relation-edit-1',
  });
  assert.deepEqual(payload, {
    record_ids: ['company-1'],
    expected_revision: 7,
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    idempotency_key: 'relation-edit-1',
  });
  assert.notEqual(payload.record_ids, recordIds);
});

test('coerces comma-separated tag input and never persists relation fields in record data', () => {
  const manifest = normalizeModuleManifest({
    schema_version: '1',
    id: 'ing.deft.example.related',
    slug: 'example-related',
    version: '1.0.0',
    name: 'Related example',
    collections: [
      {
        key: 'companies',
        name: 'Companies',
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      },
      {
        key: 'people',
        name: 'People',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'labels', label: 'Labels', type: 'tags' },
          { key: 'company', label: 'Company', type: 'relation', target_collection: 'companies' },
        ],
      },
    ],
  });
  assert.deepEqual(moduleRecordPayload(manifest.collections[1], {
    name: 'Ada',
    labels: ' customer, champion, customer ',
    company: 'company-1',
  }), {
    name: 'Ada',
    labels: ['customer', 'champion'],
  });
});
