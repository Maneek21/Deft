import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxEmptyText, inboxStatusText, normalizeInboxTab, TAB_TO_KINDS } from './inbox-view-model';

test('normalizes legacy and unsupported inbox tabs to the quieter model', () => {
  assert.equal(normalizeInboxTab('approvals'), 'approvals');
  assert.equal(normalizeInboxTab('mentions'), 'messages');
  assert.equal(normalizeInboxTab('dms'), 'messages');
  assert.equal(normalizeInboxTab('captures'), 'activity');
  assert.equal(normalizeInboxTab('made-up'), 'attention');
  assert.equal(normalizeInboxTab(null), 'attention');
});

test('attention excludes background activity while tasks retain blockers', () => {
  assert.deepEqual(TAB_TO_KINDS.tasks, ['task_assigned', 'task_updated', 'blocked']);
  assert.equal(TAB_TO_KINDS.attention.includes('system'), false);
  assert.equal(TAB_TO_KINDS.attention.includes('work_capture'), false);
  assert.equal(TAB_TO_KINDS.activity.includes('system'), true);
  assert.equal(TAB_TO_KINDS.activity.includes('work_capture'), true);
});

test('status copy describes the selected attention type', () => {
  assert.equal(inboxStatusText('approvals', 2, false), '2 approvals waiting');
  assert.equal(inboxStatusText('tasks', 0, false), 'No unread task updates.');
  assert.equal(inboxStatusText('attention', 1, false), '1 item needs attention');
  assert.equal(inboxStatusText('attention', 0, true), 'Checking what needs your attention...');
  assert.equal(inboxStatusText('activity', 12, false), 'Automation, capture, and delivery history.');
  assert.equal(inboxEmptyText('messages'), 'No unread messages or mentions.');
  assert.equal(inboxEmptyText('activity'), 'No background activity to show.');
});
