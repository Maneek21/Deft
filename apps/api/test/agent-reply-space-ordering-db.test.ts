/**
 * A15: two assistant replies in one space never run at the same time.
 *
 * dequeueJob skips an `agent-reply` while another `agent-reply` for the same
 * org and space holds a live lease, or is older and due. Replies in different
 * spaces still run in parallel, and an expired lease never blocks a space.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-reply-space-ordering-db.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray, sql } from 'drizzle-orm';
import { jobQueue } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { completeJob, dequeueJob, enqueue, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';

const orgIds: string[] = [];

after(async () => {
  if (orgIds.length) await db.delete(jobQueue).where(inArray(jobQueue.org_id, orgIds));
});

function newOrg(): string {
  const id = crypto.randomUUID();
  orgIds.push(id);
  return id;
}

async function enqueueReply(orgId: string, spaceId: string): Promise<string> {
  const messageId = crypto.randomUUID();
  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-reply', {
    orgId, spaceId, messageId, userId: 'u', orgName: 'Org', content: 'hi',
  }, { orgId, dedupeKey: `agent-reply:${messageId}` });
  return messageId;
}

const claim = (orgId: string) => dequeueJob(QUEUE_NAMES.AGENT_JOBS, { orgId, leaseMs: 30_000 });

test('two triggers in one space run one after the other', async () => {
  const orgId = newOrg();
  const spaceId = crypto.randomUUID();
  const first = await enqueueReply(orgId, spaceId);
  const second = await enqueueReply(orgId, spaceId);

  const a = await claim(orgId);
  assert.equal(a?.data.messageId, first, 'the older trigger runs first');
  assert.equal(await claim(orgId), null, 'the second waits while the first runs');

  assert.equal(await completeJob(a!.id, a!.lockToken), true);
  const b = await claim(orgId);
  assert.equal(b?.data.messageId, second, 'the second runs once the first has finished');
  assert.equal(await completeJob(b!.id, b!.lockToken), true);
});

test('triggers in different spaces still run in parallel', async () => {
  const orgId = newOrg();
  const one = await enqueueReply(orgId, crypto.randomUUID());
  const two = await enqueueReply(orgId, crypto.randomUUID());

  const a = await claim(orgId);
  const b = await claim(orgId);
  assert.deepEqual(new Set([a?.data.messageId, b?.data.messageId]), new Set([one, two]));
  await completeJob(a!.id, a!.lockToken);
  await completeJob(b!.id, b!.lockToken);
});

test('the same space id in another org does not block', async () => {
  const orgA = newOrg();
  const orgB = newOrg();
  const spaceId = crypto.randomUUID();
  await enqueueReply(orgA, spaceId);
  const inB = await enqueueReply(orgB, spaceId);
  const a = await claim(orgA);
  assert.ok(a);
  const b = await claim(orgB);
  assert.equal(b?.data.messageId, inB);
  await completeJob(a!.id, a!.lockToken);
  await completeJob(b!.id, b!.lockToken);
});

test('a running job whose lease expired does not block the space', async () => {
  const orgId = newOrg();
  const spaceId = crypto.randomUUID();
  await enqueueReply(orgId, spaceId);
  const second = await enqueueReply(orgId, spaceId);

  const stuck = await claim(orgId);
  assert.ok(stuck);
  assert.equal(await claim(orgId), null);
  await db.execute(sql`UPDATE job_queue SET lock_expires_at = now() - interval '1 second' WHERE id = ${stuck!.id}`);

  const next = await claim(orgId);
  assert.equal(next?.data.messageId, second, 'an expired lease stops blocking');
  await completeJob(next!.id, next!.lockToken);
});

test('a reply has a finite timeout even when the global job timeout is disabled', async (t) => {
  const orgId = newOrg();
  const spaceId = crypto.randomUUID();
  await enqueueReply(orgId, spaceId);
  const second = await enqueueReply(orgId, spaceId);
  const stuck = await claim(orgId);
  assert.ok(stuck);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let fireTimeout: (() => void) | undefined;
  const originalTimeout = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (delay === 120_000) fireTimeout = () => callback(...args);
    return originalTimeout(callback, delay, ...args);
  });
  const processing = _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, stuck, {
    timeoutMs: 0,
    resolveHandler: async () => async () => { entered(); await held; },
  });
  try {
    await started;
    assert.ok(fireTimeout, 'a disabled timeout must fall back to the finite reply default');
    assert.equal(await claim(orgId), null, 'the second reply waits before the timeout');
    fireTimeout();
    await processing;
    const [row] = await db.select().from(jobQueue).where(eq(jobQueue.id, stuck.id));
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /timed out after 120000ms/);
    const next = await claim(orgId);
    assert.equal(next?.data.messageId, second, 'the timed-out occurrence stops holding the space');
    await completeJob(next!.id, next!.lockToken);
  } finally {
    release();
    await processing;
    timer.mock.restore();
  }
});

test('an older pending reply that is not yet due does not block a due one', async () => {
  const orgId = newOrg();
  const spaceId = crypto.randomUUID();
  const delayed = await enqueueReply(orgId, spaceId);
  await db.execute(sql`UPDATE job_queue SET run_at = now() + interval '1 hour'
    WHERE org_id = ${orgId} AND data->>'messageId' = ${delayed}`);
  const due = await enqueueReply(orgId, spaceId);
  const job = await claim(orgId);
  assert.equal(job?.data.messageId, due);
  await completeJob(job!.id, job!.lockToken);
});

test('other job kinds in the same space are not held back', async () => {
  const orgId = newOrg();
  const spaceId = crypto.randomUUID();
  await enqueueReply(orgId, spaceId);
  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-message', { orgId, spaceId, marker: 'x' }, { orgId });
  const reply = await claim(orgId);
  assert.equal(reply?.name, 'agent-reply');
  const other = await claim(orgId);
  assert.equal(other?.name, 'agent-employee-message');
  await completeJob(reply!.id, reply!.lockToken);
  await completeJob(other!.id, other!.lockToken);
  const left = await db.select({ id: jobQueue.id }).from(jobQueue)
    .where(eq(jobQueue.org_id, orgId));
  assert.equal(left.length, 2);
});
