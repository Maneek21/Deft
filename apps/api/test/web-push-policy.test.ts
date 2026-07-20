import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionItems,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@deft/db/schema';
import { webPushPolicy } from '../src/lib/web-push.js';

type AttentionItem = typeof attentionItems.$inferSelect;

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  const now = new Date('2026-07-20T12:00:00.000Z');
  return {
    id: 'attention-test', org_id: 'org-test', user_id: 'user-test', kind: 'mention',
    lane: 'needs_you', priority: 'normal', state: 'open_unseen', dedupe_key: 'test',
    source_type: 'message', source_id: 'message-test', source_event_id: 'event-test',
    title: 'Review requested', body: null, link: '/inbox', metadata: {}, due_at: null,
    urgent_at: null, snoozed_until: null, seen_at: null, acknowledged_at: null,
    resolved_at: null, resolution: null, first_event_at: now, last_event_at: now,
    event_count: 1, version: 1, created_at: now, updated_at: now,
    ...overrides,
  };
}

test('push categories and preference toggles are deterministic', () => {
  assert.equal(webPushPolicy.pushCategory(item()), 'chat');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'approval', source_type: 'agent_action' })), 'approvals');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'task_assigned', source_type: 'task' })), 'tasks');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'reminder', source_type: 'calendar' })), 'calendar');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'agent_failure', source_type: 'agent' })), 'agents');

  const enabled = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
  enabled.push.enabled = true;
  enabled.push.chat = true;
  assert.equal(webPushPolicy.preferenceAllows(item(), enabled), true);
  enabled.push.chat = false;
  assert.equal(webPushPolicy.preferenceAllows(item(), enabled), false);
});

test('quiet hours defer non-critical pushes across midnight', () => {
  const during = new Date('2026-07-20T23:30:00.000Z');
  const outside = new Date('2026-07-20T08:00:00.000Z');
  assert.equal(webPushPolicy.quietHoursDelay(outside, 'UTC', '22:00', '07:00'), 0);
  assert.equal(webPushPolicy.quietHoursDelay(during, 'UTC', '22:00', '07:00'), 7.5 * 60 * 60_000);
  assert.equal(webPushPolicy.baseDelay(item({ priority: 'critical' })), 0);
  assert.equal(webPushPolicy.baseDelay(item({ priority: 'high' })), 2 * 60_000);
  assert.equal(webPushPolicy.failureStatus(1), 'queued');
  assert.equal(webPushPolicy.failureStatus(3), 'queued');
  assert.equal(webPushPolicy.failureStatus(4), 'failed');
});
