import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionItems,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@deft/db/schema';
import {
  emailNotificationPushStillCurrent,
  messagePushPayload,
  PUSH_PAYLOAD_MAX_BYTES,
  pushPreviewText,
  safeAttentionPushPayload,
  webPushPolicy,
} from '../src/lib/web-push.js';

type AttentionItem = typeof attentionItems.$inferSelect;

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  const now = new Date('2026-07-20T12:00:00.000Z');
  return {
    id: 'attention-test', org_id: 'org-test', user_id: 'user-test', kind: 'mention',
    lane: 'needs_you', priority: 'normal', state: 'open_unseen', dedupe_key: 'test',
    source_type: 'message', source_id: 'message-test', source_event_id: 'event-test',
    title: 'Review requested', body: null, link: '/inbox', metadata: {}, due_at: null,
    urgent_at: null, snoozed_until: null, seen_at: null, acknowledged_at: null,
    resolved_at: null, resolution: null, last_event_at: now,
    event_count: 1, version: 1, created_at: now, updated_at: now,
    ...overrides,
  };
}

test('push categories and preference toggles are deterministic', async () => {
  assert.equal(webPushPolicy.pushCategory(item()), 'chat');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'approval', source_type: 'agent_action' })), 'approvals');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'task_assigned', source_type: 'task' })), 'tasks');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'reminder', source_type: 'calendar' })), 'calendar');
  assert.equal(webPushPolicy.pushCategory(item({ kind: 'agent_failure', source_type: 'agent' })), 'agents');
  const email = item({ kind: 'email_new_message', source_type: 'email', title: 'New email', body: null,
    link: '/email?account=mailbox&message=mail-id', metadata: { account_id: 'mailbox', subject: 'private subject', from: 'private@example.test' } });
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.push.email, false);
  assert.equal(webPushPolicy.pushCategory(email), 'email');
  const legacyPreferences = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
  legacyPreferences.push.enabled = true;
  delete (legacyPreferences.push as { email?: boolean }).email;
  assert.equal(webPushPolicy.preferenceAllows(email, legacyPreferences), false,
    'a legacy preference object without the new category must not opt in');
  const emailEnabled = structuredClone(DEFAULT_NOTIFICATION_PREFERENCES); emailEnabled.push.enabled = true; emailEnabled.push.email = true;
  assert.equal(webPushPolicy.preferenceAllows(email, emailEnabled), true);
  const payload = JSON.parse(safeAttentionPushPayload(email));
  assert.deepEqual(payload, { title: 'New email', body: 'Open Deft to review.', url: '/email?account=mailbox&message=mail-id',
    attention_id: 'attention-test', tag: 'deft-attention-attention-test' });
  assert.equal(JSON.stringify(payload).includes('private subject'), false);
  assert.equal(JSON.stringify(payload).includes('private@example.test'), false);
  assert.equal(await emailNotificationPushStillCurrent({ ...email, metadata: {} }), false,
    'an email push without exact event metadata cannot pass the delivery fence');

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

test('message previews strip markup and cut long text', () => {
  assert.equal(pushPreviewText('<p>Hello <strong>team</strong>, see <a href="https://x.test">the doc</a></p>'), 'Hello team, see the doc');
  assert.equal(pushPreviewText('## Ship **today** with `pnpm` and [notes](https://x.test)'), 'Ship today with pnpm and notes');
  assert.equal(pushPreviewText('Ask [[deft:person:abc123]] about it'), 'Ask about it');
  const long = JSON.parse(messagePushPayload(item(), { senderName: 'Alice', spaceName: null, content: 'x'.repeat(500) })!);
  assert.equal(Array.from(long.body).length, 100);
  assert.ok(long.body.endsWith('…'));
  const emoji = JSON.parse(messagePushPayload(item(), { senderName: 'Alice', spaceName: null, content: '🚀'.repeat(300) })!);
  assert.equal(Array.from(emoji.body).length, 100, 'cut by characters, never inside one');
});

test('message payloads stay within the push size limit', () => {
  const worst = messagePushPayload(item({ link: `/chat?space=${'s'.repeat(40)}&message=${'m'.repeat(40)}` }), {
    senderName: '名'.repeat(500), spaceName: '空'.repeat(500), content: '😀'.repeat(5000),
  });
  assert.ok(worst);
  assert.ok(Buffer.byteLength(worst!, 'utf8') <= PUSH_PAYLOAD_MAX_BYTES);
  const parsed = JSON.parse(worst!);
  assert.ok(Array.from(parsed.title).length <= 125);
  assert.equal(messagePushPayload(item(), { senderName: 'Alice', spaceName: null, content: '<p></p>' }), null,
    'an empty preview falls back to the generic payload');
  assert.equal(messagePushPayload(item({ link: `/x?${'a'.repeat(4000)}` }), { senderName: 'Alice', spaceName: null, content: 'hi' }), null,
    'an oversized payload falls back to the generic payload');
});
