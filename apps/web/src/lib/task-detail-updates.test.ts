import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnsavedDescription, saveSubtaskStatus, taskActivitySummary } from './task-detail-updates';

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
