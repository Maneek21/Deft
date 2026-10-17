import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmailMailboxScheduler, EMAIL_MAILBOX_QUEUE, EMAIL_MAILBOX_SYNC_JOB,
  type EmailMailboxScheduleScope, type EmailMailboxSchedulerDependencies,
} from '../src/lib/email-mailbox-scheduler.js';

const account = (account_id: string, authority_revision = 4): EmailMailboxScheduleScope => ({
  org_id: 'org-a', owner_user_id: 'owner-a', account_id, authority_revision,
});

function fixture(overrides: Partial<EmailMailboxSchedulerDependencies> = {}) {
  const enqueued: unknown[][] = [];
  const rearmed: unknown[][] = [];
  const scans: unknown[][] = [];
  const dependencies: EmailMailboxSchedulerDependencies = {
    enqueue: async (...args) => { enqueued.push(args); },
    rearmFailed: async (...args) => { rearmed.push(args); return 'active'; },
    scanActive: async (after, limit) => { scans.push([after, limit]); return []; },
    ...overrides,
  };
  return { scheduler: createEmailMailboxScheduler(dependencies), enqueued, rearmed, scans };
}

test('adoption enqueues exact scope with token-free revision-specific dedupe', async () => {
  const f = fixture();
  await f.scheduler.scheduleActiveAccount(account('acct-1'));
  const [queue, name, payload, options] = f.enqueued[0] as [string, string, EmailMailboxScheduleScope, Record<string, unknown>];
  assert.equal(queue, EMAIL_MAILBOX_QUEUE);
  assert.equal(name, EMAIL_MAILBOX_SYNC_JOB);
  assert.deepEqual(payload, account('acct-1'));
  assert.deepEqual(Object.keys(payload).sort(), ['account_id', 'authority_revision', 'org_id', 'owner_user_id']);
  assert.equal(options.orgId, 'org-a');
  assert.equal(options.maxAttempts, 5);
  assert.match(String(options.dedupeKey), /^[a-f0-9]{64}$/u);
  const firstKey = options.dedupeKey;
  await f.scheduler.scheduleActiveAccount(account('acct-1'));
  await f.scheduler.scheduleActiveAccount(account('acct-1', 5));
  assert.equal(f.enqueued.length, 3);
  assert.equal((f.enqueued[1]![3] as Record<string, unknown>).dedupeKey, firstKey);
  assert.notEqual((f.enqueued[2]![3] as Record<string, unknown>).dedupeKey, firstKey);
  assert.equal(f.rearmed.length, 0);
});

test('invalid account authority is rejected before queue mutation', async () => {
  const f = fixture();
  await assert.rejects(f.scheduler.scheduleActiveAccount({ ...account('acct-1'), authority_revision: 0 }), /SCOPE_INVALID/);
  await assert.rejects(f.scheduler.scheduleActiveAccount({ ...account('acct-1'), account_id: 'bad\nvalue' }), /SCOPE_INVALID/);
  assert.equal(f.enqueued.length, 0);
});

test('repair scans a bounded ordered page and rearms only selected active revisions', async () => {
  const rows = [account('acct-a'), account('acct-b', 8)];
  const f = fixture({
    scanActive: async (after, limit) => { f.scans.push([after, limit]); return rows; },
    rearmFailed: async (...args) => { f.rearmed.push(args); return args[2].account_id === 'acct-a' ? 'rearmed' : 'active'; },
  });
  const result = await f.scheduler.repairBatch(null, 2);
  assert.deepEqual(result, { scanned: 2, rearmed: 1, next: { org_id: 'org-a', owner_user_id: 'owner-a', account_id: 'acct-b' }, done: false });
  assert.deepEqual(f.scans, [[null, 2]]);
  assert.equal(f.rearmed.length, 2);
  assert.equal(f.enqueued.length, 0);
  for (const [queue, name, payload, options] of f.rearmed as Array<[string, string, EmailMailboxScheduleScope, Record<string, unknown>]>) {
    assert.equal(queue, EMAIL_MAILBOX_QUEUE);
    assert.equal(name, EMAIL_MAILBOX_SYNC_JOB);
    assert.equal(options.orgId, payload.org_id);
    assert.equal(options.dedupeKey instanceof String, false);
  }
});

test('repair bounds page size and rejects non-keyset scanner output', async () => {
  const bad = fixture({ scanActive: async () => [account('same'), account('same')] });
  await assert.rejects(bad.scheduler.repairBatch(null, 101), /LIMIT_INVALID/);
  await assert.rejects(bad.scheduler.repairBatch(null, 2), /SCAN_INVALID/);
  assert.equal(bad.rearmed.length, 0);
});
