/**
 * Agent mention detection — verifies dispatch routes by users.kind.
 * Phase 1 of agent-chat unification, Task 8.
 *
 * Strategy: enqueue() writes to the `job_queue` Postgres table (not Redis).
 * After sending a message we query job_queue for an 'agent-reply' row whose
 * data->>'messageId' matches the just-inserted message. This is a clean
 * observable side-effect that doesn't require mocking.
 *
 * The enqueue is gated on env.ANTHROPIC_API_KEY. The dev .env sets it so
 * this runs in CI as well (assuming the same .env is available). If the key
 * is absent, the queue row is never written and the dispatch assertions will
 * fail — but the control-case assertions (no dispatch) still pass.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/agent-mention-detection.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, jobQueue, messages, notifications } from '@deft/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';

let testOrgId: string;
let humanUserId: string;
let agentUserId: string;
let spaceId: string;
let app: Hono;

// Track created message IDs so we can clean up job_queue + messages after each test
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const slug = `amd-${ts}`;

  const [org] = await db.insert(orgs).values({ name: 'Agent Mention Detection Test', slug }).returning();
  testOrgId = org!.id;

  const [human] = await db.insert(users).values({
    email: `amd-human-${ts}@test.local`,
    name: 'AMD Human',
    kind: 'human',
    is_agent: false,
    email_verified: true,
  }).returning();
  humanUserId = human!.id;

  // Agent user — kind='agent'. This is what Defty looks like post-Task-2.
  const [agentUser] = await db.insert(users).values({
    name: 'AMD Agent (Defty)',
    kind: 'agent',
    is_agent: true,
    email_verified: true,
  }).returning();
  agentUserId = agentUser!.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
  ]);

  const [space] = await db.insert(spaces).values({
    org_id: testOrgId,
    name: 'amd-general',
    type: 'public',
    created_by: humanUserId,
  }).returning();
  spaceId = space!.id;

  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: agentUserId },
  ]);

  // Mount messageRoutes with a shim that sets c.var.user — same pattern as
  // members-kind-field.test.ts and agent-actions-routes.test.ts.
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: humanUserId,
      email: `amd-human-${ts}@test.local`,
      org_id: testOrgId,
    } as any);
    await next();
  });
  app.route('/api/messages', messageRoutes);
});

after(async () => {
  try {
    // Clean up job_queue rows for our test messages
    if (createdMessageIds.length > 0) {
      await db.delete(jobQueue).where(
        sql`${jobQueue.data}->>'messageId' = ANY(ARRAY[${sql.join(
          createdMessageIds.map((id) => sql`${id}`),
          sql`, `,
        )}])`,
      );
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
    }
    // Delete notifications that reference our test users (FK: notifications.user_id → users.id).
    // The message route creates mention + space notifications, so clean these before users.
    await db.delete(notifications).where(inArray(notifications.user_id, [humanUserId, agentUserId]));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
    await db.delete(users).where(inArray(users.id, [humanUserId, agentUserId]));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  } catch (err) {
    console.error('cleanup error:', err);
  }
});

/**
 * Poll job_queue for an 'agent-reply' row for a given messageId.
 * We poll briefly (up to ~300ms) because the enqueue is async but near-instant
 * (it's a Postgres insert in the same request transaction chain).
 */
async function findAgentReplyJob(messageId: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const rows = await db
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.name, 'agent-reply'),
          sql`${jobQueue.data}->>'messageId' = ${messageId}`,
        ),
      )
      .limit(1);
    if (rows.length > 0) return true;
    if (i < 5) await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

test('structured mention of kind=agent user triggers agent-reply dispatch', async () => {
  // The autocomplete produces <@<agentUserId>|AMD Agent (Defty)> — the new Phase-1 format.
  const content = `Hello <@${agentUserId}|AMD Agent (Defty)>, can you summarise today?`;

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201, 'route should return 201 Created');
  const body = await res.json() as { id?: string };
  assert.ok(body.id, 'response should include message id');
  createdMessageIds.push(body.id!);

  const dispatched = await findAgentReplyJob(body.id!);
  assert.ok(dispatched, 'agent-reply job should be enqueued for kind=agent mention');
});

test('structured mention of kind=human user does NOT trigger agent-reply dispatch', async () => {
  // Same mention format but pointing at a human user — should NOT trigger.
  const content = `Hey <@${humanUserId}|AMD Human>, what do you think?`;

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201, 'route should return 201 Created');
  const body = await res.json() as { id?: string };
  assert.ok(body.id, 'response should include message id');
  createdMessageIds.push(body.id!);

  // Give the queue a moment to settle
  await new Promise((r) => setTimeout(r, 100));
  const dispatched = await findAgentReplyJob(body.id!);
  assert.ok(!dispatched, 'agent-reply job should NOT be enqueued for kind=human mention');
});

test('legacy @deft plain text triggers agent-reply dispatch (backwards compat fallback)', async () => {
  // Pre-Phase-1 style: freeform @deft without a structured user mention.
  const content = '@deft what are the open tasks this week?';

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201, 'route should return 201 Created');
  const body = await res.json() as { id?: string };
  assert.ok(body.id, 'response should include message id');
  createdMessageIds.push(body.id!);

  const dispatched = await findAgentReplyJob(body.id!);
  assert.ok(dispatched, 'agent-reply job should be enqueued for legacy @deft mention');
});

test('legacy <@agent|Deft> magic string triggers agent-reply dispatch (backwards compat)', async () => {
  // The exact pre-Phase-1 magic string that older clients may still send.
  const content = 'Hello <@agent|Deft>, summarise the project status.';

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201, 'route should return 201 Created');
  const body = await res.json() as { id?: string };
  assert.ok(body.id, 'response should include message id');
  createdMessageIds.push(body.id!);

  const dispatched = await findAgentReplyJob(body.id!);
  assert.ok(dispatched, 'agent-reply job should be enqueued for legacy <@agent|Deft> magic string');
});

test('message with no mention does NOT trigger agent-reply dispatch', async () => {
  const content = 'Just a plain message with no mention at all.';

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201, 'route should return 201 Created');
  const body = await res.json() as { id?: string };
  assert.ok(body.id, 'response should include message id');
  createdMessageIds.push(body.id!);

  await new Promise((r) => setTimeout(r, 100));
  const dispatched = await findAgentReplyJob(body.id!);
  assert.ok(!dispatched, 'agent-reply job should NOT be enqueued for a message with no mention');
});
