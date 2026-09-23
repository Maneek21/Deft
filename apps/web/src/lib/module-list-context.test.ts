import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatModuleRecordCount,
  moduleCollectionListHref,
  moduleListBackHref,
  moduleRecordReturnHrefFromTask,
  moduleRecordHrefWithListContext,
  moduleTaskHrefWithRecordReturn,
  parseModuleListContext,
} from './module-list-context';

const context = {
  viewKey: 'by_stage',
  savedViewId: null,
  search: 'Taylor Demo',
  filters: [{ field: 'stage', operator: 'eq' as const, value: 'qualified' }],
  sort: { field: 'last_contacted_at', direction: 'desc' as const },
  filtersExplicit: true,
};

test('round-trips generic list search, filter, sort, and view state', () => {
  const href = moduleCollectionListHref('people-module', 'contacts', context);
  const query = new URL(href, 'https://deft.invalid').searchParams;

  assert.deepEqual(parseModuleListContext(query), context);
  assert.equal(query.get('q'), 'Taylor Demo');
  assert.equal(query.get('view'), 'by_stage');
});

test('record links carry only an allowlisted collection return context', () => {
  const recordHref = moduleRecordHrefWithListContext('people-module', 'contacts', 'record-1', context);
  const recordUrl = new URL(recordHref, 'https://deft.invalid');

  assert.equal(recordUrl.pathname, '/modules/people-module/contacts/record-1');
  assert.equal(recordUrl.searchParams.get('from_q'), 'Taylor Demo');
  assert.equal(moduleListBackHref('people-module', 'contacts', recordUrl.searchParams), moduleCollectionListHref('people-module', 'contacts', context));
});

test('preserves a saved view whose filters were explicitly cleared', () => {
  const savedContext = {
    ...context,
    viewKey: null,
    savedViewId: 'saved-view-1',
    filters: [],
    sort: undefined,
  };
  const href = moduleCollectionListHref('people-module', 'contacts', savedContext);
  const query = new URL(href, 'https://deft.invalid').searchParams;

  assert.equal(query.get('saved'), 'saved-view-1');
  assert.equal(query.get('filters'), '[]');
  assert.deepEqual(parseModuleListContext(query), savedContext);
});

test('back links ignore arbitrary redirects and malformed return state', () => {
  const params = new URLSearchParams({
    return: 'https://attacker.invalid/steal',
    from_view: '../../settings',
    from_q: 'x'.repeat(501),
    from_filters: JSON.stringify([{ field: 'stage', operator: 'execute', value: 'x' }]),
    from_sort: 'constructor',
    from_direction: 'sideways',
  });

  assert.equal(moduleListBackHref('people-module', 'contacts', params), '/modules/people-module/contacts');
});

test('linked task navigation returns to the record with its collection context intact', () => {
  const recordHref = moduleRecordHrefWithListContext('people-module', 'contacts', 'record-1', context);
  const taskHref = moduleTaskHrefWithRecordReturn('/tasks?task=CRM-5', recordHref);
  const taskUrl = new URL(taskHref, 'https://deft.invalid');

  assert.equal(taskUrl.pathname, '/tasks');
  assert.equal(taskUrl.searchParams.get('task'), 'CRM-5');
  assert.equal(moduleRecordReturnHrefFromTask(taskUrl.searchParams), recordHref);
});

test('task return navigation rejects external, malformed, and over-broad record destinations', () => {
  for (const value of [
    'https://attacker.invalid/steal',
    '//attacker.invalid/steal',
    '/settings',
    '/modules/people-module/contacts/record-1?admin=true',
  ]) {
    assert.equal(moduleRecordReturnHrefFromTask(new URLSearchParams({ module_return: value })), null);
  }
});

test('formats singular and plural record counts', () => {
  assert.equal(formatModuleRecordCount(1, false, false), '1 record');
  assert.equal(formatModuleRecordCount(2, false, false), '2 records');
  assert.equal(formatModuleRecordCount(1, true, true), '1+ records · updating');
});
