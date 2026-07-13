import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTaskViewConfig,
  parseTaskSurfaceView,
  shouldApplyProjectDefaultView,
} from './task-view-config';

test('normalizes legacy filter-only saved views into TaskViewConfigV1', () => {
  const config = normalizeTaskViewConfig({
    assigneeIds: ['user-1'],
    priorities: ['p1'],
    status: ['in_progress'],
    labels: ['launch'],
    dueDate: 'overdue',
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    projectId: 'project-1',
  });

  assert.equal(config.version, 1);
  assert.equal(config.view, 'board');
  assert.deepEqual(config.filters.assigneeIds, ['user-1']);
  assert.deepEqual(config.filters.status, ['in_progress']);
  assert.equal(config.filters.projectId, 'project-1');
  assert.deepEqual(config.sort, []);
  assert.deepEqual(config.columns, []);
});

test('normalizes list to the canonical table view and bounds unsafe layout values', () => {
  const config = normalizeTaskViewConfig({
    version: 1,
    view: 'list',
    filters: {},
    sort: [
      { field: 'priority', direction: 'desc', nulls: 'first' },
      { field: 'due_date', direction: 'sideways' },
      { nope: true },
    ],
    columns: [
      { id: 'title', visible: true, position: 0, width: 5000, frozen: true },
      { id: 'status', position: 1, width: 12 },
      { missing: 'id' },
    ],
    density: 'compact',
    showSubtasks: true,
  });

  assert.equal(config.view, 'table');
  assert.deepEqual(config.sort, [
    { field: 'priority', direction: 'desc', nulls: 'first' },
    { field: 'due_date', direction: 'asc', nulls: 'last' },
  ]);
  assert.equal(config.columns[0]?.width, 800);
  assert.equal(config.columns[1]?.width, 64);
  assert.equal(config.density, 'compact');
  assert.equal(config.showSubtasks, true);
});

test('recognizes only currently rendered task surface views', () => {
  assert.equal(parseTaskSurfaceView('calendar'), 'calendar');
  assert.equal(parseTaskSurfaceView('table'), 'table');
  assert.equal(parseTaskSurfaceView('list'), 'table');
  assert.equal(parseTaskSurfaceView('my'), null);
  assert.equal(parseTaskSurfaceView('made-up'), null);
  assert.equal(parseTaskSurfaceView(null), null);
});

test('project default never overwrites an explicit valid or invalid view request', () => {
  assert.equal(shouldApplyProjectDefaultView({ requestedView: 'calendar', userSelectedView: false, isMyTasksView: false }), false);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: 'made-up', userSelectedView: false, isMyTasksView: false }), false);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: null, userSelectedView: false, isMyTasksView: false }), true);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: null, userSelectedView: true, isMyTasksView: false }), false);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: null, userSelectedView: false, isMyTasksView: true }), false);
});
