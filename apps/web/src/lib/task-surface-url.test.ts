import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCurrentTaskRoute, taskFiltersFromSearch, taskProjectHref, taskSurfaceHref } from './task-surface-url';

const searchOf = (href: string) => new URL(href, 'https://deft.invalid').searchParams;

test('resolved task project survives close, view changes and reload', () => {
  let search = new URLSearchParams('task=LN2619-9&assignee=noah&context=keep');
  search = searchOf(taskSurfaceHref(search, { task: null, module_return: null }, 'expanded'));
  for (const view of ['table', 'timeline', 'calendar', 'board']) {
    search = searchOf(taskSurfaceHref(search, { view }, 'expanded'));
    assert.equal(search.get('project'), 'expanded');
    assert.equal(search.get('assignee'), 'noah');
    assert.equal(search.get('context'), 'keep');
    assert.equal(search.get('task'), null);
    assert.deepEqual(taskFiltersFromSearch(search).assigneeIds, ['noah']);
  }
});

test('project navigation retains view and filters while clearing old detail context', () => {
  const before = new URLSearchParams('project=old&view=timeline&assignee=noah&priority=p1&task=OLD-2&module_return=%2Fmodules%2Fcontacts&filterProject=old&context=keep');
  const after = searchOf(taskProjectHref(before, 'expanded'));
  assert.equal(after.get('project'), 'expanded');
  assert.equal(after.get('view'), 'timeline');
  assert.equal(after.get('assignee'), 'noah');
  assert.equal(after.get('priority'), 'p1');
  assert.equal(after.get('context'), 'keep');
  for (const key of ['task', 'module_return', 'filterProject']) assert.equal(after.get(key), null);
});

test('Back and Forward reconstruct filters from each URL without sticky state', () => {
  const past = new URLSearchParams('assignee=amina&priority=p2');
  const future = new URLSearchParams('assignee=noah&priority=p1&status=in_review');
  assert.deepEqual(taskFiltersFromSearch(past).assigneeIds, ['amina']);
  assert.deepEqual(taskFiltersFromSearch(future).assigneeIds, ['noah']);
  assert.deepEqual(taskFiltersFromSearch(past).status, []);
  assert.deepEqual(taskFiltersFromSearch(new URLSearchParams()).assigneeIds, []);
});

test('late task response for a previous route is ignored', async () => {
  const request = 'task=OLD-1';
  let current = request, applied = false;
  const response = Promise.resolve().then(() => { if (isCurrentTaskRoute(request, current)) applied = true; });
  current = 'task=LN2619-9&project=expanded';
  await response;
  assert.equal(applied, false);
});

test('unresolved task and My Tasks routes never invent a project', () => {
  assert.equal(searchOf(taskSurfaceHref(new URLSearchParams('task=unavailable'), { view: 'calendar' })).get('project'), null);
  assert.equal(searchOf(taskSurfaceHref(new URLSearchParams('view=my'), { task: null }, 'expanded')).get('project'), null);
  const project = searchOf(taskProjectHref(new URLSearchParams('view=my&assignee=noah&filterProject=old'), 'expanded'));
  assert.equal(project.get('view'), null);
  assert.equal(project.get('assignee'), 'noah');
  assert.equal(project.get('filterProject'), null);
});
