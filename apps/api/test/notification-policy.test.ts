import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationChannelForType } from '../src/lib/notification-policy.js';

test('notification policy maps common events to user-facing preference channels', () => {
  assert.equal(notificationChannelForType('mention'), 'chat');
  assert.equal(notificationChannelForType('message'), 'chat');
  assert.equal(notificationChannelForType('huddle_started'), 'chat');

  assert.equal(notificationChannelForType('task'), 'tasks');
  assert.equal(notificationChannelForType('task_assigned'), 'tasks');
  assert.equal(notificationChannelForType('task_updated'), 'tasks');
  assert.equal(notificationChannelForType('blocked'), 'tasks');
  assert.equal(notificationChannelForType('workload_imbalance'), 'tasks');

  assert.equal(notificationChannelForType('reminder'), 'calendar');

  assert.equal(notificationChannelForType('agent_suggestion'), 'agents');
  assert.equal(notificationChannelForType('skill_update_available'), 'agents');
});

test('notification policy leaves legacy or uncategorized events to explicit callers', () => {
  assert.equal(notificationChannelForType('system'), null);
  assert.equal(notificationChannelForType('wiki_update'), null);
  assert.equal(notificationChannelForType('unknown_future_type'), null);
});
