/**
 * Scheduled-item caps on a hosted workspace (apps/api/src/lib/workspace-limits.ts, launch check 6.6), and what an emergency stop's
 * restart and lift (check 6.8) do to items that fell due meanwhile: each is sent once, late, never twice.
 *
 * Run: pnpm --filter @deft/api test test/workspace-limits-db.test.ts
 */
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { jobQueue, messages, orgMembers, orgs, reminders, scheduledMessages, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { reminderRoutes } from '../src/routes/reminders.js';
import { scheduledRoutes } from '../src/routes/scheduled.js';
import { DEFAULT_WORKSPACE_LIMITS, _setWorkspaceLimitsForTest } from '../src/lib/workspace-limits.js';
import { rehydratePendingScheduledMessages, sendScheduledMessage } from '../src/workers/handlers/scheduled-message-send.js';

const marker = `workspace-limits-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let orgId: string;
let userId: string;
let spaceId: string;

before(async () => {
  const [org] = await db.insert(orgs).values({ name: 'Workspace limits', slug: marker }).returning();
  const [user] = await db.insert(users).values({ email: `${marker}@test.local`, name: 'Limits Test User', email_verified: true }).returning();
  if (!org || !user) throw new Error('Failed to seed the workspace-limits fixture');
  orgId = org.id;
  userId = user.id;
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'owner' });
  const [space] = await db.insert(spaces).values({ org_id: orgId, name: 'Limits Test Space', created_by: userId }).returning();
  if (!space) throw new Error('Failed to seed the workspace-limits space');
  spaceId = space.id;
  await db.insert(spaceMembers).values({ space_id: spaceId, user_id: userId });
});

afterEach(async () => {
  _setWorkspaceLimitsForTest(undefined);
  await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
  await db.delete(scheduledMessages).where(eq(scheduledMessages.org_id, orgId));
  await db.delete(reminders).where(eq(reminders.org_id, orgId));
  await db.delete(messages).where(eq(messages.org_id, orgId));
});

after(async () => {
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId)));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

function app(): Hono {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: orgId });
    await next();
  });
  hono.route('/scheduled', scheduledRoutes);
  hono.route('/reminders', reminderRoutes);
  return hono;
}

const post = (hono: Hono, path: string, body: unknown) => hono.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const later = () => new Date(Date.now() + 60 * 60_000).toISOString();

test('scheduled messages: refused past the workspace limit with the reason; sending or cancelling frees a place', async () => {
  _setWorkspaceLimitsForTest({ ...DEFAULT_WORKSPACE_LIMITS, scheduledMessages: 2 });
  const hono = app();
  for (let i = 0; i < 2; i += 1) assert.equal((await post(hono, '/scheduled', { space_id: spaceId, content: `${marker}-${i}`, scheduled_for: later() })).status, 201);
  const refused = await post(hono, '/scheduled', { space_id: spaceId, content: `${marker}-3`, scheduled_for: later() });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: 'This workspace already has 2 scheduled messages waiting to be sent, its limit. Send or cancel some before scheduling more.',
    code: 'WORKSPACE_SCHEDULE_LIMIT',
  });
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.org_id, orgId))).length, 2, 'nothing was created');
  await db.update(scheduledMessages).set({ status: 'cancelled' }).where(and(eq(scheduledMessages.org_id, orgId), eq(scheduledMessages.content, `${marker}-0`)));
  assert.equal((await post(hono, '/scheduled', { space_id: spaceId, content: `${marker}-4`, scheduled_for: later() })).status, 201);
});

test('scheduled messages: requests at the same moment cannot pass the limit together', async () => {
  _setWorkspaceLimitsForTest({ ...DEFAULT_WORKSPACE_LIMITS, scheduledMessages: 3 });
  const hono = app();
  const statuses = await Promise.all(Array.from({ length: 8 }, (_, i) => post(hono, '/scheduled', { space_id: spaceId, content: `${marker}-race-${i}`, scheduled_for: later() }).then((r) => r.status)));
  assert.equal(statuses.filter((status) => status === 201).length, 3, statuses.join(','));
  assert.equal(statuses.filter((status) => status === 409).length, 5);
});

test('reminders: refused past the workspace limit with the reason', async () => {
  _setWorkspaceLimitsForTest({ ...DEFAULT_WORKSPACE_LIMITS, reminders: 1 });
  const hono = app();
  assert.equal((await post(hono, '/reminders', { content: 'first', remind_at: later() })).status, 201);
  const refused = await post(hono, '/reminders', { content: 'second', remind_at: later() });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: 'This workspace already has 1 reminders waiting, its limit. Remove some before adding more.',
    code: 'WORKSPACE_SCHEDULE_LIMIT',
  });
  // A reminder already sent does not count.
  await db.update(reminders).set({ is_sent: true }).where(eq(reminders.org_id, orgId));
  assert.equal((await post(hono, '/reminders', { content: 'third', remind_at: later() })).status, 201);
});

test('a self-hosted install has no scheduled-item limit', async () => {
  _setWorkspaceLimitsForTest(null);
  const hono = app();
  for (let i = 0; i < 3; i += 1) assert.equal((await post(hono, '/reminders', { content: `r${i}`, remind_at: later() })).status, 201);
});

test('after a stop and its lift (two restarts), a message that fell due meanwhile is sent once, late, never twice', async () => {
  const content = `${marker}-due-during-stop`;
  const [scheduled] = await db.insert(scheduledMessages).values({ org_id: orgId, user_id: userId, space_id: spaceId, content, scheduled_for: new Date(Date.now() - 10 * 60_000) }).returning();
  if (!scheduled) throw new Error('Failed to seed a scheduled message');
  // The stop's restart (paused: nothing claimed) and the lift's restart each queue the pending items again.
  await rehydratePendingScheduledMessages();
  await rehydratePendingScheduledMessages();
  const jobs = await db.select({ id: jobQueue.id }).from(jobQueue).where(and(eq(jobQueue.org_id, orgId), eq(jobQueue.dedupe_key, `scheduled-message:${scheduled.id}`), sql`${jobQueue.status} IN ('pending', 'running')`));
  assert.equal(jobs.length, 1, 'one delivery job however many restarts');
  // Delivered, and a repeat (a job retried after a lost acknowledgement) sends nothing.
  assert.equal(await sendScheduledMessage(scheduled.id), true);
  assert.equal(await sendScheduledMessage(scheduled.id), false);
  assert.equal((await db.select({ id: messages.id }).from(messages).where(and(eq(messages.org_id, orgId), eq(messages.content, content)))).length, 1);
});
