import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnsavedDescription, saveSubtaskStatus, taskActivitySummary, taskCommentIdentity, loadScopedTaskComments, taskCommentsNeedRefresh } from './task-detail-updates';

test('rejected workflow transition never returns an optimistic completed status', async () => {
  await assert.rejects(saveSubtaskStatus(async () => new Response(JSON.stringify({code:'INVALID_TRANSITION',allowed_next_statuses:['in_progress']}),{status:400})), /not saved/);
});
test('successful transition uses canonical persisted status', async () => {
  assert.equal(await saveSubtaskStatus(async () => Response.json({status:'in_progress'})), 'in_progress');
});
test('malformed success cannot claim completion', async () => {
  await assert.rejects(saveSubtaskStatus(async () => Response.json({})), /could not be confirmed/);
});
test('fieldless creation is an event rather than none to none', () => {
  assert.equal(taskActivitySummary('created',null), 'created this task');
  assert.equal(taskActivitySummary('comment_added',null), 'comment added');
  assert.equal(taskActivitySummary('status_changed','status'), null);
});
test('reload stays guarded during debounce, in-flight save, failed retry, and clearing the description', () => {
  assert.equal(hasUnsavedDescription('<p>New description</p>', false), true);
  assert.equal(hasUnsavedDescription(undefined, true), true);
  assert.equal(hasUnsavedDescription('', false), true);
  assert.equal(hasUnsavedDescription(undefined, false), false);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
test('task switch rejects late comments after new empty task loaded', async () => {
  const first = taskCommentIdentity(null, 'a', 's1'); let current = first;
  const old = deferred<Response>(); const values: unknown[] = [];
  const pending = loadScopedTaskComments(first, () => current, () => old.promise, rows => values.push(rows));
  current = taskCommentIdentity(current, 'b', 's1');
  assert.equal(await loadScopedTaskComments(current, () => current, async () => Response.json([]), rows => values.push(rows)), 'loaded');
  old.resolve(Response.json([{ id: 'old-comment' }]));
  assert.equal(await pending, 'stale'); assert.deepEqual(values, [[]]);
});
test('A to B to A creates a new comment generation', async () => {
  const first = taskCommentIdentity(null, 'a', 's1'); let current = first;
  const old = deferred<Response>(); const values: unknown[] = [];
  const pending = loadScopedTaskComments(first, () => current, () => old.promise, rows => values.push(rows));
  current = taskCommentIdentity(taskCommentIdentity(current, 'b', 's1'), 'a', 's1');
  assert.notEqual(current, first); old.resolve(Response.json([{ id: 'old-a' }]));
  assert.equal(await pending, 'stale'); assert.deepEqual(values, []);
});
test('session change during JSON decoding rejects old user comments', async () => {
  const first = taskCommentIdentity(null, 'a', 's1'); let current = first;
  const body = deferred<unknown>(); const values: unknown[] = [];
  const pending = loadScopedTaskComments(first, () => current, async () => ({ok:true,json:()=>body.promise} as Response), rows => values.push(rows));
  await Promise.resolve(); current = taskCommentIdentity(current, 'a', 's2'); body.resolve([{ id:'prior-session' }]);
  assert.equal(await pending, 'stale'); assert.deepEqual(values, []);
});
test('current comments publish once; failed read never claims empty count', async () => {
  const identity = taskCommentIdentity(null, 'a', 's1'); const values: unknown[] = [];
  assert.equal(taskCommentIdentity(identity, 'a', 's1'), identity);
  assert.equal(await loadScopedTaskComments(identity, () => identity, async () => Response.json([{id:'current'}]), rows => values.push(rows)), 'loaded');
  assert.equal(await loadScopedTaskComments(identity, () => identity, async () => new Response(null,{status:503}), rows => values.push(rows)), 'error');
  assert.deepEqual(values, [[{id:'current'}]]);
});

test('one initial fetch plus fresh Comments tab entry without duplicate identity fetch', () => {
  const identity = taskCommentIdentity(null, 'a', 's1');
  assert.equal(taskCommentsNeedRefresh(null, null, identity, 'comments'), true);
  assert.equal(taskCommentsNeedRefresh(identity, 'comments', identity, 'comments'), false);
  assert.equal(taskCommentsNeedRefresh(identity, 'overview', identity, 'comments'), true);
  assert.equal(taskCommentsNeedRefresh(identity, 'comments', identity, 'overview'), false);
  assert.equal(taskCommentsNeedRefresh(identity, 'comments', taskCommentIdentity(identity, 'b', 's1'), 'comments'), true);
});
