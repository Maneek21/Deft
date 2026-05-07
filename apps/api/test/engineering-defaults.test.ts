import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINEERING_STATUSES,
  ENGINEERING_TRANSITIONS,
  ENGINEERING_PRIORITY_VOCAB,
  ENGINEERING_DEFAULTS,
  isValidTransition,
} from '../src/lib/task-status-machine.js';

test('ENGINEERING_STATUSES has the 6 expected ids in order', () => {
  const ids = ENGINEERING_STATUSES.map((s) => s.id);
  assert.deepEqual(ids, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
});

test('ENGINEERING_PRIORITY_VOCAB is p0..p3 numbered', () => {
  assert.equal(ENGINEERING_PRIORITY_VOCAB.kind, 'numbered');
  assert.deepEqual(ENGINEERING_PRIORITY_VOCAB.labels, ['p0', 'p1', 'p2', 'p3']);
});

test('isValidTransition still accepts legal engineering transitions', () => {
  assert.equal(isValidTransition('backlog', 'todo', ENGINEERING_DEFAULTS), true);
  assert.equal(isValidTransition('todo', 'in_progress', ENGINEERING_DEFAULTS), true);
  assert.equal(isValidTransition('in_progress', 'done', ENGINEERING_DEFAULTS), true);
  assert.equal(isValidTransition('done', 'backlog', ENGINEERING_DEFAULTS), true);
});

test('isValidTransition rejects illegal transitions', () => {
  // done -> todo isn't in the allowed list
  assert.equal(isValidTransition('done', 'todo', ENGINEERING_DEFAULTS), false);
  // backlog -> in_review skips stages
  assert.equal(isValidTransition('backlog', 'in_review', ENGINEERING_DEFAULTS), false);
});
