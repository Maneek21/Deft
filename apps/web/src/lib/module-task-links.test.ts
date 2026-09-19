import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModuleRecordTaskLinks,
  normalizeModuleRecordTaskLinkPage,
  normalizeTaskModuleRecordLinks,
  normalizeTaskModuleRecordLinkPage,
  moduleTaskDueLabel,
  isModuleTaskClosed,
  normalizeModuleTaskQueue,
  moduleTaskCalendarDay,
} from './module-task-links';

const recordLink = (index: number) => ({
  edge_id: `edge-${index}`,
  resource_id: `module_record:record-${index}`,
  record_id: `record-${index}`,
  module_slug: 'equipment',
  module_name: 'Equipment register',
  collection_key: 'assets',
  collection_name: 'Assets',
  title: `Camera ${index}`,
  url: `/modules/equipment/assets/record-${index}`,
  created_at: '2026-08-18T10:00:00.000Z',
});

const taskLink = (index: number) => ({
  edge_id: `edge-${index}`,
  task_id: `task-${index}`,
  title: `Inspect camera ${index}`,
  identifier: `OPS-${index}`,
  status: 'todo',
  priority: 'p1',
  due_date: null,
  assignee_id: null,
  assignee_name: null,
  project_id: 'project-1',
  project_name: 'Operations',
  url: `/tasks?task=OPS-${index}`,
  created_at: '2026-08-18T10:00:00.000Z',
});

test('normalizes explicit pages beyond the first 100 linked resources', () => {
  const records = normalizeTaskModuleRecordLinkPage({
    links: Array.from({ length: 25 }, (_, index) => recordLink(index + 100)),
    next_offset: 125,
  });
  assert.equal(records.links.length, 25);
  assert.equal(records.links[0]?.recordId, 'record-100');
  assert.equal(records.nextOffset, 125);

  const tasks = normalizeModuleRecordTaskLinkPage({
    links: Array.from({ length: 2 }, (_, index) => taskLink(index + 100)),
    next_offset: null,
  });
  assert.equal(tasks.links.length, 2);
  assert.equal(tasks.links[1]?.taskId, 'task-101');
  assert.equal(tasks.nextOffset, null);

  assert.throws(() => normalizeTaskModuleRecordLinkPage({ links: [] }));
  assert.throws(() => normalizeTaskModuleRecordLinkPage({ links: 'invalid', next_offset: null }));
  assert.throws(() => normalizeTaskModuleRecordLinkPage({ links: [{ ...recordLink(1), url: '//unsafe.test' }], next_offset: null }));
  assert.throws(() => normalizeModuleRecordTaskLinkPage({ links: [taskLink(1)], next_offset: -1 }));
});

test('normalizes canonical module record links and rejects unsafe paths', () => {
  const links = normalizeTaskModuleRecordLinks({ links: [
    {
      edge_id: 'edge-1',
      resource_id: 'module_record:record-1',
      record_id: 'record-1',
      module_slug: 'equipment',
      module_name: 'Equipment register',
      collection_key: 'assets',
      collection_name: 'Assets',
      title: 'Camera 12',
      url: '/modules/equipment/assets/record-1',
      created_at: '2026-08-18T10:00:00.000Z',
    },
    {
      edge_id: 'edge-2',
      resource_id: 'module_record:record-2',
      record_id: 'record-2',
      module_slug: 'equipment',
      module_name: 'Equipment register',
      collection_key: 'assets',
      collection_name: 'Assets',
      title: 'Unsafe',
      url: '//evil.example',
      created_at: '2026-08-18T10:00:00.000Z',
    },
  ] });
  assert.equal(links.length, 1);
  assert.equal(links[0]?.resourceId, 'module_record:record-1');
  assert.equal(links[0]?.title, 'Camera 12');
});

test('normalizes linked tasks with stable task deep links', () => {
  const links = normalizeModuleRecordTaskLinks({ links: [{
    edge_id: 'edge-1',
    task_id: 'task-1',
    title: 'Inspect camera',
    identifier: 'OPS-12',
    status: 'todo',
    priority: 'p1',
    due_date: '2026-09-09T00:00:00.000Z',
    assignee_id: 'person-1',
    assignee_name: 'Ada',
    project_id: 'project-1',
    project_name: 'Operations',
    url: '/tasks?task=OPS-12',
    created_at: '2026-08-18T10:00:00.000Z',
  }] });
  assert.deepEqual(links.map((link) => ({ id: link.taskId, identifier: link.identifier })), [
    { id: 'task-1', identifier: 'OPS-12' },
  ]);
  assert.equal(links[0]?.assigneeName, 'Ada');
  assert.equal(links[0]?.dueDate, '2026-09-09T00:00:00.000Z');
});

test('follow-up date labels use calendar days and never mark closed work overdue', () => {
  const now = new Date(2026, 8, 9, 23, 59);
  assert.equal(moduleTaskDueLabel({ status: 'todo', dueDate: '2026-09-09T00:00:00.000Z' }, now), 'Due today');
  assert.equal(moduleTaskDueLabel({ status: 'todo', dueDate: '2026-09-08T00:00:00.000Z' }, now), 'Overdue · 2026-09-08');
  assert.equal(moduleTaskDueLabel({ status: 'done', dueDate: '2026-09-08T00:00:00.000Z' }, now), 'Due 2026-09-08');
  assert.equal(moduleTaskDueLabel({ status: 'todo', dueDate: null }, now), 'No due date');
  for (const status of ['done', 'cancelled', 'won', 'lost']) assert.equal(isModuleTaskClosed(status), true);
  assert.equal(isModuleTaskClosed('in_progress'), false);
});

test('queue normalizes bounded pagination and rejects unsafe task and record links', () => {
  const task = { task_id: 'task-1', title: 'Call Ada', status: 'todo', priority: 'p2', project_id: 'p1', project_name: 'CRM', url: '/tasks?task=CRM-1', record_count: 4,
    records: [{ id: 'r1', title: 'Ada', collection_key: 'contacts', url: '/modules/contacts/contacts/r1' }, { id: 'r2', title: 'Unsafe', collection_key: 'contacts', url: '//evil.test' }] };
  const page = normalizeModuleTaskQueue({ tasks: [task, { ...task, url: '//evil.test' }], next_offset: 25 });
  assert.equal(page.tasks.length, 1);
  assert.equal(page.tasks[0]?.records.length, 1);
  assert.equal(page.tasks[0]?.recordCount, 4);
  assert.equal(page.nextOffset, 25);
  assert.equal(normalizeModuleTaskQueue({ next_offset: -1 }).nextOffset, null);
  assert.equal(moduleTaskCalendarDay(new Date(2026, 8, 9, 0, 1)), '2026-09-09');
});

test('next-task batches distinguish unavailable records from empty task lists and reject malformed projections', async () => {
  const { normalizeModuleRecordNextTasks } = await import('./module-task-links');
  assert.deepEqual(normalizeModuleRecordNextTasks({ record_ids: ['live'], links: [] }, ['live', 'missing']), {
    live: { state: 'available', task: null }, missing: { state: 'unavailable' },
  });
  assert.throws(() => normalizeModuleRecordNextTasks({}, ['live']));
  assert.throws(() => normalizeModuleRecordNextTasks({ record_ids: ['foreign'], links: [] }, ['live']));
  assert.throws(() => normalizeModuleRecordNextTasks({ record_ids: ['live'], links: [{ record_id: 'live', url: '//unsafe.test' }] }, ['live']));
});
