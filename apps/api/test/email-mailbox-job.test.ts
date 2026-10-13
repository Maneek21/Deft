import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobData } from '../src/workers/types.js';
import { EmailMailboxError, type EmailSyncResult } from '../src/lib/email-mailbox-service.js';
import { createEmailMailboxJobHandler, type EmailMailboxJobDependencies } from '../src/lib/email-mailbox-job.js';

const payload = { org_id: 'org-a', owner_user_id: 'owner-a', account_id: 'account-a', authority_revision: 7 };
const job = (data: Record<string, unknown> = payload, changes: Partial<JobData> = {}): JobData => ({ id: 'job-a', name: 'native-email-sync',
  data, attempts: 0, lockToken: 'lock-a', ...changes });
const result = (has_more = false): EmailSyncResult => ({ checkpoint_revision: 1, state: 'applied',
  observed_at: new Date(1000).toISOString(), complete: !has_more, has_more });
function fixture(options: Partial<EmailMailboxJobDependencies> & { result?: EmailSyncResult } = {}) {
  const calls: Array<{ scope: unknown; lease: unknown; signal?: AbortSignal }> = [];
  const deferrals: Array<{ message: string; delayMs: number }> = [];
  const deferError = (message: string, delayMs: number) => { deferrals.push({ message, delayMs }); return Object.assign(new Error(message), { delayMs }); };
  const dependencies: EmailMailboxJobDependencies = {
    enabled: options.enabled ?? (() => true),
    runPage: options.runPage ?? (async (scope, lease, signal) => { calls.push({ scope, lease, signal }); return options.result ?? result(); }),
    defer: options.defer ?? deferError,
  };
  return { handler: createEmailMailboxJobHandler(dependencies), calls, deferrals };
}

test('leased native sync invokes one durable page then idles briefly', async () => {
  const f = fixture();
  await assert.rejects(f.handler(job()), (error: unknown) => error instanceof Error && error.message === 'Native email sync is idle');
  assert.deepEqual(f.calls, [{ scope: payload, lease: { job_id: 'job-a', lock_token: 'lock-a' }, signal: undefined }]);
  assert.deepEqual(f.deferrals, [{ message: 'Native email sync is idle', delayMs: 10_000 }]);
});

test('has_more defers the same durable delivery promptly without consuming retry budget', async () => {
  const f = fixture({ result: result(true) });
  await assert.rejects(f.handler(job()), (error: unknown) => error instanceof Error && error.message.includes('another durable page'));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.deferrals, [{ message: 'Native email sync has another durable page', delayMs: 1_000 }]);
});

test('disabled, malformed-scope and unleased jobs do not invoke sync', async () => {
  const disabled = fixture({ enabled: () => false });
  await assert.rejects(disabled.handler(job()), /Native email sync is disabled/);
  assert.deepEqual(disabled.deferrals, [{ message: 'Native email sync is disabled', delayMs: 60_000 }]);
  const malformed = fixture();
  await assert.rejects(malformed.handler(job({ ...payload, bearer: 'private-token' })), /EMAIL_SYNC_JOB_INVALID/);
  await assert.rejects(malformed.handler(job(payload, { lockToken: undefined })), /EMAIL_SYNC_JOB_LEASE_REQUIRED/);
  assert.equal(malformed.calls.length, 0);
});

test('cancellation rejects before or during page work without deferring success', async () => {
  const before = fixture(); const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(before.handler(job(payload, { signal: cancelled.signal })), /EMAIL_SYNC_UNAVAILABLE/);
  assert.equal(before.calls.length, 0);
  const duringController = new AbortController();
  const during = fixture({ runPage: async (_scope, _lease, signal) => {
    assert.equal(signal, duringController.signal); duringController.abort(); throw new Error('private provider diagnostic');
  } });
  await assert.rejects(during.handler(job(payload, { signal: duringController.signal })), error =>
    error instanceof Error && error.message === 'EMAIL_SYNC_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(during.deferrals.length, 0);
});

test('known mailbox errors are sanitized and unexpected provider errors never leak payloads', async () => {
  const denied = fixture({ runPage: async () => { throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); } });
  await assert.rejects(denied.handler(job()), /EMAIL_ACCESS_DENIED/);
  const privateError = fixture({ runPage: async () => { throw new Error('provider response contained private-token'); } });
  await assert.rejects(privateError.handler(job()), error => error instanceof Error
    && error.message === 'EMAIL_SYNC_UNAVAILABLE' && !error.message.includes('private-token'));
  assert.equal(privateError.deferrals.length, 0);
});

test('a superseded read-only sync page defers fresh checkpoint work without consuming failure retries', async () => {
  const f=fixture({runPage:async()=>{throw new EmailMailboxError('EMAIL_CHECKPOINT_CONFLICT');}});
  await assert.rejects(f.handler(job()),error=>error instanceof Error&&error.message==='Native email sync checkpoint advanced');
  assert.deepEqual(f.deferrals,[{message:'Native email sync checkpoint advanced',delayMs:1000}]);
  for(const code of ['EMAIL_ACCESS_DENIED','EMAIL_SYNC_REPLAY_CONFLICT','EMAIL_PAGE_INVALID'] as const){
    const denied=fixture({runPage:async()=>{throw new EmailMailboxError(code);}});
    await assert.rejects(denied.handler(job()),error=>error instanceof Error&&error.message===code);
    assert.deepEqual(denied.deferrals,[]);
  }
});
