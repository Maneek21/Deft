import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModuleSavedViewConfig,
  moduleFieldFilterToQuery,
  modulePersonalViewHref,
  moduleQueryFilterToFieldFilter,
  moduleSavedViewToView,
  normalizeModuleSavedViewsResponse,
} from './module-saved-views';
import type { ModuleCollection } from './modules';

const collection: ModuleCollection = {
  key: 'entries',
  name: 'Entries',
  singularName: 'Entry',
  description: null,
  titleField: 'name',
  subtitleFields: [],
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, description: null, options: [], multiple: false, targetCollection: null },
    { key: 'active', label: 'Active', type: 'boolean', required: false, description: null, options: [], multiple: false, targetCollection: null },
    {
      key: 'status', label: 'Status', type: 'single_select', required: false, description: null, multiple: false, targetCollection: null,
      options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }],
    },
    { key: 'owner', label: 'Owner', type: 'member', required: false, description: null, options: [], multiple: false, targetCollection: null },
    { key: 'starts_at', label: 'Starts at', type: 'datetime', required: false, description: null, options: [], multiple: false, targetCollection: null },
  ],
  views: [],
};

test('normalizes only complete personal saved-view envelopes', () => {
  const views = normalizeModuleSavedViewsResponse({ views: [{
    id: 'view-1',
    installation_id: 'installation-1',
    module_id: 'community.example',
    collection_key: 'entries',
    owner_user_id: 'user-1',
    name: 'Open entries',
    config: {
      type: 'board',
      fields: ['name', 'status'],
      filters: [{ field: 'status', operator: 'eq', value: 'open' }],
      group_by: 'status',
    },
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
  }, { id: 'broken' }] });
  assert.equal(views.length, 1);
  assert.equal(views[0]?.ownerUserId, 'user-1');
  assert.deepEqual(moduleSavedViewToView(views[0]!), {
    key: 'personal:view-1',
    name: 'Open entries',
    type: 'board',
    fields: ['name', 'status'],
    groupBy: 'status',
    startField: null,
    endField: null,
  });
});

test('converts supported field controls to typed server filters', () => {
  assert.deepEqual(moduleFieldFilterToQuery(collection, { fieldKey: 'active', value: 'false' }), [
    { field: 'active', operator: 'eq', value: false },
  ]);
  assert.deepEqual(moduleFieldFilterToQuery(collection, { fieldKey: 'status', value: 'open' }), [
    { field: 'status', operator: 'eq', value: 'open' },
  ]);
  assert.deepEqual(moduleFieldFilterToQuery(collection, { fieldKey: 'status', value: 'unknown' }), []);
  assert.deepEqual(
    moduleQueryFilterToFieldFilter(collection, [{ field: 'active', operator: 'eq', value: true }]),
    { fieldKey: 'active', value: 'true' },
  );
});

test('captures current board and timeline state as valid personal configs', () => {
  const board = buildModuleSavedViewConfig({
    collection,
    view: { key: 'board', name: 'Board', type: 'board', fields: ['name', 'status'], groupBy: 'status', startField: null, endField: null },
    filter: { fieldKey: 'status', value: 'open' },
    sort: { fieldKey: 'name', direction: 'asc' },
  });
  assert.deepEqual(board, {
    type: 'board',
    fields: ['name', 'status'],
    filters: [{ field: 'status', operator: 'eq', value: 'open' }],
    sort: { field: 'name', direction: 'asc' },
    group_by: 'status',
  });

  const timeline = buildModuleSavedViewConfig({
    collection,
    view: { key: 'timeline', name: 'Timeline', type: 'timeline', fields: ['name', 'starts_at'], groupBy: null, startField: 'starts_at', endField: null },
    filter: null,
    sort: null,
  });
  assert.deepEqual(timeline, {
    type: 'timeline',
    fields: ['name', 'starts_at'],
    filters: [],
    start_field: 'starts_at',
  });
});

test('builds canonical encoded personal-view URLs', () => {
  assert.equal(
    modulePersonalViewHref('example module', 'open/items', 'mine & active'),
    '/modules/example%20module/open%2Fitems?saved=mine%20%26%20active',
  );
});
