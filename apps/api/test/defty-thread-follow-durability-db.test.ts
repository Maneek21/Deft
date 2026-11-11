/**
 * Thread-follow wake durability: a reply in a thread Defty is engaged in must
 * commit together with its agent-reply job, so a crash right after the
 * message commits cannot lose the wake. A test-only DEFERRABLE constraint
 * trigger on `messages` (scoped to this org) checks at COMMIT time that every
 * thread reply in the follow space already has its job; a post-commit enqueue
 * fails that check. A failed follow enqueue must still not fail the human's
 * message (the follow is best-effort; the user did not address Defty).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { jobQueue, messages, notifications, orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { setOrgAPIKey } from '../src/lib/org-ai-config.js';

const orgId = randomUUID();
const humanId = randomUUID();
const spaceId = randomUUID();
const tag = orgId.replace(/-/g, '');
const commitCheckFn = `follow_commit_check_${tag}`;
const failEnqueueFn = `follow_fail_enqueue_${tag}`;
let deftyUserId = '';
let deftyExistedBefore = false;
let app: Hono;

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'Follow durability', slug: `follow-durable-${orgId}` });
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-follow-test-not-real');
  await db.insert(users).values({ id: humanId, name: 'Follow Human', email: `follow-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'follow-room', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values([{ space_id: spaceId, user_id: humanId }, { space_id: spaceId, user_id: deftyUserId }]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `follow-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${commitCheckFn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.space_id = '${spaceId}' AND NEW.user_id = '${humanId}' AND NEW.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM job_queue WHERE name = 'agent-reply' AND data->>'messageId' = NEW.id) THEN
        RAISE EXCEPTION 'follow-up message committed without its agent-reply job';
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql;
    CREATE OR REPLACE FUNCTION ${failEnqueueFn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.name = 'agent-reply' AND NEW.org_id = '${orgId}' THEN
        RAISE EXCEPTION 'injected agent-reply enqueue failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `));
});

after(async () => {
  try {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${commitCheckFn} ON messages`));
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failEnqueueFn} ON job_queue`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${commitCheckFn}()`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${failEnqueueFn}()`));
    await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.delete(messages).where(eq(messages.space_id, spaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('follow durability cleanup error:', err);
  }
});

async function engagedThread() {
  const rootId = randomUUID();
  await db.insert(messages).values({ id: rootId, org_id: orgId, space_id: spaceId, user_id: humanId, content: 'Planning the launch', created_at: new Date(Date.now() - 60_000) });
  await db.insert(messages).values({ org_id: orgId, space_id: spaceId, user_id: deftyUserId, parent_id: rootId, content: 'Which day works?', created_at: new Date(Date.now() - 30_000) });
  return rootId;
}

async function reply(rootId: string, content: string) {
  const response = await app.request(`/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, parent_id: rootId }),
  });
  return { status: response.status, body: await response.json() as { id?: string } };
}

test('thread-follow: the follow wake commits in the same transaction as the reply', async () => {
  const rootId = await engagedThread();
  await db.execute(sql.raw(`CREATE CONSTRAINT TRIGGER ${commitCheckFn} AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${commitCheckFn}()`));
  let result;
  try {
    result = await reply(rootId, `Monday works ${randomUUID()}`);
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${commitCheckFn} ON messages`));
  }
  assert.equal(result.status, 201, 'the reply and its follow job must commit together');
  const jobs = await db.select({ data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${result.body.id!}`));
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!.data as any).followed, true);
});

test('thread-follow: a failed follow enqueue does not fail the human message', async () => {
  const rootId = await engagedThread();
  await db.execute(sql.raw(`CREATE TRIGGER ${failEnqueueFn} BEFORE INSERT ON job_queue FOR EACH ROW EXECUTE FUNCTION ${failEnqueueFn}()`));
  let result;
  try {
    result = await reply(rootId, `Tuesday instead ${randomUUID()}`);
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failEnqueueFn} ON job_queue`));
  }
  assert.equal(result.status, 201);
  const [stored] = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, result.body.id!));
  assert.ok(stored, 'the human message is committed');
});
