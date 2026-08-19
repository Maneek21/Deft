import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModuleRecordTaskLinks,
  normalizeTaskModuleRecordLinks,
} from './module-task-links';

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
    project_id: 'project-1',
    project_name: 'Operations',
    url: '/tasks?task=OPS-12',
    created_at: '2026-08-18T10:00:00.000Z',
  }] });
  assert.deepEqual(links.map((link) => ({ id: link.taskId, identifier: link.identifier })), [
    { id: 'task-1', identifier: 'OPS-12' },
  ]);
});
