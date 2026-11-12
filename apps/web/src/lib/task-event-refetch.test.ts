import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescedRefetch, taskEventConcernsList, taskEventIds } from './task-event-refetch';

const scope = (overrides: Partial<Parameters<typeof taskEventConcernsList>[1]> = {}) => ({
  projectId: 'project-a',
  dependsOnTaskFields: false,
  shownIds: new Set(['shown']),
  ...overrides,
});

test('task event ids are read from id, task_id and task_ids only', () => {
  assert.deepEqual(taskEventIds({ id: 'a', task_ids: ['b', 3, 'c'] }), ['a', 'b', 'c']);
  assert.deepEqual(taskEventIds(null), []);
});

test('an event concerns the list when it names a shown task or the shown project', () => {
  assert.equal(taskEventConcernsList({ id: 'shown', project_id: 'project-b' }, scope()), true);
  assert.equal(taskEventConcernsList({ id: 'new', project_id: 'project-a' }, scope()), true);
  assert.equal(taskEventConcernsList({ id: 'new', project_id: 'project-b' }, scope()), false);
});

test('an event without a project id, or a list that depends on task fields, reloads', () => {
  assert.equal(taskEventConcernsList({ id: 'new' }, scope()), true);
  assert.equal(taskEventConcernsList({ task_ids: ['x'] }, scope()), true);
  assert.equal(taskEventConcernsList({ id: 'new', project_id: 'project-b' }, scope({ dependsOnTaskFields: true })), true);
  assert.equal(taskEventConcernsList({ id: 'new', project_id: 'project-b' }, scope({ projectId: null })), false);
});

test('a burst of events triggers a single reload', async () => {
  let runs = 0;
  const refetch = createCoalescedRefetch(() => { runs += 1; }, 20);
  for (let i = 0; i < 200; i += 1) refetch.schedule();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runs, 1);
  refetch.schedule();
  refetch.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, 1, 'a cancelled reload does not run');
});
