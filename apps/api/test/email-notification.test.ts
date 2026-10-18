import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailNotificationJobHandler, EMAIL_NOTIFICATION_JOB, emailNotificationAttentionDraft, type EmailNotificationJobPorts } from '../src/lib/email-notification.js';
import type { JobHandler } from '../src/workers/types.js';

const payload = { org_id: 'org', owner_user_id: 'owner', account_id: 'account', notification_id: '3a21f803-213d-4c9a-b5f5-289c9b98110e', revision: 1, authority_revision: 4 };
const job = (data: Record<string, unknown> = payload) => ({ name: EMAIL_NOTIFICATION_JOB, id: 'job-id', data, attempts: 1,
  lockToken: 'lease-token', leaseExpiresAt: new Date(Date.now() + 60_000), signal: new AbortController().signal });

test('email attention draft is contentless and carries only exact scoped identifiers', () => {
  const logicalId = `mail_${'d'.repeat(64)}`;
  const draft = emailNotificationAttentionDraft({ org_id: 'org', owner_user_id: 'owner', account_id: 'account with space' }, {
    notification_id: payload.notification_id, logical_message_id: logicalId, revision: 2, authority_revision: 4,
    created_at: new Date('2026-10-04T00:00:00Z'),
  });
  assert.equal(draft.title, 'New email'); assert.equal(draft.body, null);
  assert.equal(draft.link, `/email?account=account%20with%20space&message=${logicalId}`);
  assert.deepEqual(draft.metadata, { account_id: 'account with space', notification_id: payload.notification_id,
    notification_revision: 2, authority_revision: 4 });
  assert.equal(JSON.stringify(draft).includes('subject'), false);
  assert.equal(JSON.stringify(draft).includes('@'), false);
});

test('notification job runs only a strict scoped leased payload', async () => {
  let seen: unknown;
  const ports: EmailNotificationJobPorts = { enabled: () => true, run: async (scope, value, lease) => { seen = { scope, value, lease }; }, defer: message => new Error(message) };
  const handler: JobHandler = createEmailNotificationJobHandler(ports);
  await handler(job());
  assert.deepEqual((seen as { scope: unknown }).scope, { org_id: 'org', owner_user_id: 'owner', account_id: 'account' });
  assert.equal((seen as { lease: { notification_id: string } }).lease.notification_id, payload.notification_id);
});

test('malformed scope, missing lease and unexpected payload fields fail closed', async () => {
  const handler = createEmailNotificationJobHandler({ enabled: () => true, run: async () => {}, defer: message => new Error(message) });
  await assert.rejects(handler(job({ ...payload, subject: 'must not be queued' })), /EMAIL_NOTIFICATION_JOB_INVALID/);
  await assert.rejects(handler({ ...job(), lockToken: '' }), /EMAIL_NOTIFICATION_JOB_LEASE_REQUIRED/);
  await assert.rejects(handler(job({ ...payload, account_id: '' })), /EMAIL_NOTIFICATION_JOB_INVALID/);
});

test('disabled native notifications defer, and provider errors are sanitized', async () => {
  const disabled = createEmailNotificationJobHandler({ enabled: () => false, run: async () => {}, defer: (message, delay) => new Error(`${message}:${delay}`) });
  await assert.rejects(disabled(job()), /disabled:60000/);
  const failing = createEmailNotificationJobHandler({ enabled: () => true, run: async () => { throw new Error('raw provider response payload'); }, defer: message => new Error(message) });
  await assert.rejects(failing(job()), /EMAIL_NOTIFICATION_UNAVAILABLE/);
});
