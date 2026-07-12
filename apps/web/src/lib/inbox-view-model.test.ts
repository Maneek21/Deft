import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxEmptyText, inboxStatusText, normalizeInboxTab, TAB_TO_KINDS } from './inbox-view-model';

test('normalizes unsupported inbox tabs to all', () => {
  assert.equal(normalizeInboxTab('approvals'), 'approvals');
  assert.equal(normalizeInboxTab('made-up'), 'all');
  assert.equal(normalizeInboxTab(null), 'all');
});

test('tasks request both assignment and update kinds', () => {
  assert.deepEqual(TAB_TO_KINDS.tasks, ['task_assigned', 'task_updated']);
});

test('status copy describes the selected attention type', () => {
  assert.equal(inboxStatusText('approvals', 2, false), '2 approvals waiting');
  assert.equal(inboxStatusText('tasks', 0, false), 'No unread task updates.');
  assert.equal(inboxStatusText('all', 1, false), '1 item needs attention');
  assert.equal(inboxStatusText('all', 0, true), 'Checking what needs your attention...');
  assert.equal(inboxEmptyText('mentions'), 'No unread mentions.');
});
