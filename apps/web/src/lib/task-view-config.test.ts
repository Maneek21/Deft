import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TASK_VIEW_CONFIG,
  isTaskTableColumnVisible,
  normalizeTaskViewConfig,
  moveTaskTableColumn,
  parseTaskSurfaceView,
  setTaskTableColumnVisibility,
  setTaskTableColumnWidth,
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
  assert.equal(parseTaskSurfaceView('board'), 'board');
  assert.equal(parseTaskSurfaceView('calendar'), 'calendar');
  assert.equal(parseTaskSurfaceView('timeline'), 'timeline');
  assert.equal(parseTaskSurfaceView('pipeline'), 'pipeline');
  assert.equal(parseTaskSurfaceView('table'), 'table');
  assert.equal(parseTaskSurfaceView('list'), 'table');
  assert.equal(parseTaskSurfaceView('my'), null);
  assert.equal(parseTaskSurfaceView('made-up'), null);
  assert.equal(parseTaskSurfaceView(null), null);
});

test('preserves pipeline in saved view configuration', () => {
  const config = normalizeTaskViewConfig({ version: 1, view: 'pipeline', filters: {} });
  assert.equal(config.view, 'pipeline');
});

test('project default never overwrites an explicit valid or invalid view request', () => {
  assert.equal(shouldApplyProjectDefaultView({ requestedView: 'calendar', userSelectedView: false, isMyTasksView: false }), false);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: 'made-up', userSelectedView: false, isMyTasksView: false }), false);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: null, userSelectedView: false, isMyTasksView: false }), true);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: null, userSelectedView: true, isMyTasksView: false }), false);
  assert.equal(shouldApplyProjectDefaultView({ requestedView: null, userSelectedView: false, isMyTasksView: true }), false);
});

test('column visibility defaults on and changes immutably', () => {
  assert.equal(isTaskTableColumnVisible(DEFAULT_TASK_VIEW_CONFIG, 'labels'), true);
  const next = setTaskTableColumnVisibility(DEFAULT_TASK_VIEW_CONFIG, 'labels', false);
  assert.equal(isTaskTableColumnVisible(next, 'labels'), false);
  assert.equal(DEFAULT_TASK_VIEW_CONFIG.columns.length, 0);
});

test('column layout helpers bound widths and preserve frozen columns', () => {
  const wide = setTaskTableColumnWidth(DEFAULT_TASK_VIEW_CONFIG, 'status', 5000);
  assert.equal(wide.columns.find((column) => column.id === 'status')?.width, 800);
  const frozen = moveTaskTableColumn(wide, 'status', -1);
  assert.equal(frozen, wide);
  const moved = moveTaskTableColumn(wide, 'assignee', -1);
  const assignee = moved.columns.find((column) => column.id === 'assignee')!;
  const priority = moved.columns.find((column) => column.id === 'priority')!;
  const status = moved.columns.find((column) => column.id === 'status')!;
  const title = moved.columns.find((column) => column.id === 'title')!;
  assert.equal(title.position, 1);
  assert.equal(status.position, 2);
  assert.equal(assignee.position < priority.position, true);
});
