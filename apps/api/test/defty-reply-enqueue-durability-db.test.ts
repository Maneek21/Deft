/**
 * A07 — a chat message that wakes Defty must be committed together with its
 * `agent-reply` job, or the request must fail as a whole so the client can
 * retry. A post-commit, best-effort enqueue leaves the user with a committed
 * message and no reply, and an idempotent replay used to return before any
 * dispatch, so it could not repair the loss.
 *
 * The enqueue failure is forced with a test-only Postgres trigger on
 * `job_queue` scoped to this test's org; it is dropped in `after`. No model
 * request is made: the org carries a dummy provider key so dispatch is gated
 * open, and no worker runs in this process.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agentActions, jobQueue, messages, nativeCreateRequests, notifications, orgMembers, orgs,
  spaceMembers, spaces, users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { enqueue, QUEUE_NAMES } from '../src/lib/queues.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { setOrgAPIKey } from '../src/lib/org-ai-config.js';

const orgId = randomUUID();
const humanId = randomUUID();
const spaceId = randomUUID();
const failFn = `a07_fail_agent_reply_${orgId.replace(/-/g, '')}`;
let deftyUserId = '';
let deftyExistedBefore = false;
let app: Hono;

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'A07 enqueue durability', slug: `a07-${orgId}` });
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-a07-test-not-real');
  await db.insert(users).values({ id: humanId, name: 'A07 Human', email: `a07-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'a07-general', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values([{ space_id: spaceId, user_id: humanId }, { space_id: spaceId, user_id: deftyUserId }]);

  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `a07-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);

  // Test-only fault injection: while armed, any agent-reply insert for this
  // org raises. Other orgs (and other test files) are unaffected.
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${failFn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.name = 'agent-reply' AND NEW.org_id = '${orgId}' THEN
        RAISE EXCEPTION 'A07 injected agent-reply enqueue failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `));
});

after(async () => {
  try {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failFn} ON job_queue`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${failFn}()`));
    await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
    await db.delete(nativeCreateRequests).where(eq(nativeCreateRequests.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
    await db.delete(messages).where(eq(messages.space_id, spaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('A07 cleanup error:', err);
  }
});

async function setEnqueueFailure(on: boolean) {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failFn} ON job_queue`));
  if (on) await db.execute(sql.raw(`CREATE TRIGGER ${failFn} BEFORE INSERT ON job_queue FOR EACH ROW EXECUTE FUNCTION ${failFn}()`));
}

async function post(content: string, key?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const response = await app.request(`/messages/${spaceId}`, { method: 'POST', headers, body: JSON.stringify({ content }) });
  return { status: response.status, body: await response.json() as { id?: string; code?: string } };
}

async function committedMessagesWith(marker: string) {
  return db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.space_id, spaceId), eq(messages.user_id, humanId), sql`${messages.content} LIKE ${`%${marker}%`}`,
  ));
}

async function agentReplyJobsFor(messageId: string) {
  return db.select({ id: jobQueue.id, dedupe_key: jobQueue.dedupe_key }).from(jobQueue).where(and(
    eq(jobQueue.org_id, orgId), eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${messageId}`,
  ));
}

test('A07: a committed Defty-waking message always has an agent-reply job', async () => {
  const marker = `a07-commit-${randomUUID()}`;
  await setEnqueueFailure(true);
  let result;
  try {
    result = await post(`<@${deftyUserId}|Defty> please summarise ${marker}`);
  } finally {
    await setEnqueueFailure(false);
  }
  const committed = await committedMessagesWith(marker);
  for (const message of committed) {
    const jobs = await agentReplyJobsFor(message.id);
    assert.equal(jobs.length, 1, `message ${message.id} was committed (HTTP ${result.status}) without an agent-reply job`);
  }
  if (committed.length === 0) {
    assert.ok(result.status >= 500, 'a request that commits nothing must report failure so the client retries');
  }
});

test('A07: idempotent replay does not leave a message without a job', async () => {
  const marker = `a07-replay-${randomUUID()}`;
  const key = `a07-${randomUUID()}`;
  const content = `<@${deftyUserId}|Defty> follow up on ${marker}`;
  await setEnqueueFailure(true);
  try {
    await post(content, key);
  } finally {
    await setEnqueueFailure(false);
  }
  const retry = await post(content, key);
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  const committed = await committedMessagesWith(marker);
  assert.equal(committed.length, 1, 'exactly one message for one idempotency key');
  assert.equal(committed[0]!.id, retry.body.id);
  const jobs = await agentReplyJobsFor(retry.body.id!);
  assert.equal(jobs.length, 1, 'the message returned by the retry must have its agent-reply job');
});

test('A07: replays and repeated enqueues never double-enqueue agent-reply', async () => {
  const marker = `a07-dedupe-${randomUUID()}`;
  const key = `a07-${randomUUID()}`;
  const content = `<@${deftyUserId}|Defty> dedupe check ${marker}`;
  const first = await post(content, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const replays = await Promise.all(Array.from({ length: 4 }, () => post(content, key)));
  for (const replay of replays) {
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
  }
  const jobs = await agentReplyJobsFor(first.body.id!);
  assert.equal(jobs.length, 1, 'one agent-reply job per message');
  assert.equal(jobs[0]!.dedupe_key, `agent-reply:${first.body.id}`, 'job is keyed by message id so a re-enqueue is a no-op');

  // A second enqueue with the same derived key is absorbed by the queue's
  // unique (org_id, dedupe_key) index.
  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-reply', { orgId, messageId: first.body.id, spaceId }, { dedupeKey: `agent-reply:${first.body.id}` });
  assert.equal((await agentReplyJobsFor(first.body.id!)).length, 1);
});

test('A07: a DM with Defty (no mention) commits its agent-reply job with the message', async () => {
  const dmId = randomUUID();
  await db.insert(spaces).values({ id: dmId, org_id: orgId, name: 'a07-dm', type: 'dm', created_by: humanId });
  await db.insert(spaceMembers).values([{ space_id: dmId, user_id: humanId }, { space_id: dmId, user_id: deftyUserId }]);
  try {
    const response = await app.request(`/messages/${dmId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'what is on my plate today?' }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { id: string };
    const jobs = await agentReplyJobsFor(body.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.dedupe_key, `agent-reply:${body.id}`);
  } finally {
    await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
    await db.delete(messages).where(eq(messages.space_id, dmId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, dmId));
    await db.delete(spaces).where(eq(spaces.id, dmId));
  }
});
