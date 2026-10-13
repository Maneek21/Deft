import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailTimerJobHandler } from '../src/lib/email-timer-job.js';
import { EMAIL_TIMER_JOB, type EmailTimerJob } from '../src/lib/email-timer-types.js';
import type { JobData } from '../src/workers/types.js';

const payload: EmailTimerJob = { org_id: 'org', owner_user_id: 'owner', account_id: 'account',
  timer_id: '11111111-1111-4111-8111-111111111111', revision: 1, authority_revision: 3 };
function job(overrides: Partial<JobData> = {}): JobData {
  return { id: 'job', name: EMAIL_TIMER_JOB, data: payload, attempts: 0, lockToken: 'lock',
    leaseExpiresAt: new Date(Date.now() + 60_000), ...overrides };
}

test('timer job processes one scope and defers until due without provider payload', async () => {
  const calls: unknown[][] = [];
  const handler = createEmailTimerJobHandler({ enabled: () => true,
    run: async (...args) => { calls.push(args); return { state: 'waiting', delay_ms: 5000 }; },
    defer: (_message, delay) => Object.assign(new Error('deferred'), { delay }),
  });
  await assert.rejects(handler(job()), error => (error as Error & { delay?: number }).delay === 5000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0] && (calls[0][0] as { account_id: string }).account_id, 'account');
  assert.equal((calls[0]?.[4] as { timer_id: string }).timer_id, payload.timer_id);
});

test('timer job denies absent leases, malformed scope, and disabled processing', async () => {
  let runs = 0;
  const handler = createEmailTimerJobHandler({ enabled: () => false,
    run: async () => { runs++; return { state: 'completed' }; }, defer: (_message, delay) => Object.assign(new Error(), { delay }),
  });
  await assert.rejects(handler(job({ lockToken: undefined })), /LEASE_REQUIRED/);
  await assert.rejects(handler(job({ data: { ...payload, account_id: 'bad\naccount' } })), /INVALID/);
  await assert.rejects(handler(job()), error => (error as Error & { delay?: number }).delay === 60_000);
  assert.equal(runs, 0);
});
