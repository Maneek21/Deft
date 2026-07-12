import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskNudgeDigest } from './notification-digests.js';

test('keeps a single task nudge directly actionable', () => {
  const digest = buildTaskNudgeDigest({
    nudgeType: 'overdue',
    taskId: 'task-1',
    taskIdentifier: 'MKT-1',
  });

  assert.equal(digest.title, 'Overdue task');
  assert.equal(digest.body, 'MKT-1 needs your attention.');
  assert.equal(digest.link, '/tasks?task=MKT-1');
  assert.deepEqual(digest.metadata.task_ids, ['task-1']);
});

test('bundles repeated task nudges into one compact digest', () => {
  const digest = buildTaskNudgeDigest({
    nudgeType: 'overdue',
    taskId: 'task-3',
    taskIdentifier: 'OPS-3',
    existingMetadata: {
      task_ids: ['task-1', 'task-2'],
      task_identifiers: ['MKT-1', 'BUY-2'],
    },
  });

  assert.equal(digest.title, '3 overdue tasks');
  assert.equal(digest.body, 'MKT-1, BUY-2, OPS-3 need your attention.');
  assert.equal(digest.link, '/tasks?view=list');
  assert.equal(digest.metadata.bundled_count, 3);
});

test('deduplicates a repeated task in the same digest', () => {
  const digest = buildTaskNudgeDigest({
    nudgeType: 'stalled',
    taskId: 'task-1',
    taskIdentifier: 'MKT-1',
    existingMetadata: {
      task_id: 'task-1',
      task_identifier: 'MKT-1',
      task_ids: ['task-1'],
      task_identifiers: ['MKT-1'],
    },
  });

  assert.equal(digest.title, 'Stalled task');
  assert.equal(digest.metadata.bundled_count, 1);
});
