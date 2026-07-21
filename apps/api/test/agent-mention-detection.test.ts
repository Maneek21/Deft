/**
 * Agent mention detection — verifies dispatch routes by Defty identity.
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
import { users, orgs, orgMembers, spaces, spaceMembers, jobQueue, messages, notifications, agentEmployees, agentActions } from '@deft/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { ensureDeftyEmployee, ensureDeftyMembership, DEFTY_EMAIL } from '../src/lib/ensure-defty-membership.js';

let testOrgId: string;
let humanUserId: string;
let deftyUserId: string;
let deftyEmployeeId: string;
let byoaAgentUserId: string;
let byoaAgentEmployeeId: string;
let spaceId: string;
let app: Hono;
// Whether Defty already existed before this test run — used in cleanup.
let deftyExistedBefore = false;

// Track created message IDs so we can clean up job_queue + messages after each test
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const slug = `amd-${ts}`;

  // Detect whether Defty already exists (from prior test runs or dev usage).
  // If it does, we must NOT delete the Defty user row in cleanup.
  const [existingDefty] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEFTY_EMAIL))
    .limit(1);
  deftyExistedBefore = !!existingDefty;

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

  // Defty — the real system agent. ensureDeftyMembership creates-or-reuses
  // the canonical Defty user and adds it as a member of testOrgId.
  deftyUserId = await ensureDeftyMembership(testOrgId);
  deftyEmployeeId = (await ensureDeftyEmployee(testOrgId)).employeeId;

  // BYOA agent — kind='agent' but NOT Defty. Simulates an arbitrary BYOA
  // employee. agent-reply must NOT fire for mentions of this user.
  const [byoaAgent] = await db.insert(users).values({
    name: 'AMD BYOA Agent',
    kind: 'agent',
    is_agent: true,
    email_verified: true,
  }).returning();
  byoaAgentUserId = byoaAgent!.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
    { org_id: testOrgId, user_id: byoaAgentUserId, role: 'member' },
    // Defty's org_members row is handled by ensureDeftyMembership above.
  ]);

  const [byoaEmployee] = await db.insert(agentEmployees).values({
    org_id: testOrgId,
    user_id: byoaAgentUserId,
    name: 'AMD BYOA Agent',
    slug: `amd-byoa-agent-${ts}`,
    role: 'custom',
    system_prompt: 'Test BYOA agent.',
    expertise_description: 'Test employee for mention routing.',
    starter_prompts: [],
    disabled_tools: [],
    space_ids: [],
    project_ids: [],
    trust_level: 'conservative',
    is_active: true,
    is_byoa: true,
    runtime_kind: 'custom_mcp',
    wake_mode: 'manual',
    certification_status: 'token_issued',
    created_by: humanUserId,
  }).returning({ id: agentEmployees.id });
  byoaAgentEmployeeId = byoaEmployee!.id;

  const [space] = await db.insert(spaces).values({
    org_id: testOrgId,
    name: 'amd-general',
    type: 'public',
    created_by: humanUserId,
  }).returning();
  spaceId = space!.id;

  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: deftyUserId },
    { space_id: spaceId, user_id: byoaAgentUserId },
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
    const userIdsToClean = [humanUserId, byoaAgentUserId, deftyUserId];
    await db.delete(notifications).where(inArray(notifications.user_id, userIdsToClean));
    await db.delete(agentActions).where(eq(agentActions.org_id, testOrgId));
    await db.delete(messages).where(eq(messages.space_id, spaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(agentEmployees).where(inArray(agentEmployees.id, [byoaAgentEmployeeId, deftyEmployeeId]));
    // Remove only the org_members rows we created for testOrgId.
    await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
    await db.delete(users).where(inArray(users.id, [humanUserId, byoaAgentUserId]));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
    // Only delete Defty user if it didn't pre-exist before this test run.
    if (!deftyExistedBefore) {
      await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
    }
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

async function findAgentEmployeeMessageJob(messageId: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const rows = await db
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.name, 'agent-employee-message'),
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

test('structured mention of Defty user triggers agent-reply dispatch', async () => {
  // The autocomplete produces <@<deftyId>|Deft> — the new Phase-1 format.
  const content = `Hello <@${deftyUserId}|Deft>, can you summarise today?`;

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201, 'route should return 201 Created');
  const body = await res.json() as { id?: string };
  assert.ok(body.id, 'response should include message id');
  createdMessageIds.push(body.id!);

  const [mentionNotification] = await db
    .select({ link: notifications.link })
    .from(notifications)
    .where(and(
      eq(notifications.user_id, deftyUserId),
      eq(notifications.type, 'mention'),
      eq(notifications.link, `/chat?space=${spaceId}&message=${body.id}`),
    ))
    .limit(1);
  assert.equal(
    mentionNotification?.link,
    `/chat?space=${spaceId}&message=${body.id}`,
    'mention notification should deep-link to the message on the chat surface',
  );

  const dispatched = await findAgentReplyJob(body.id!);
  assert.ok(dispatched, 'agent-reply job should be enqueued for Defty mention');
  const employeeQueued = await findAgentEmployeeMessageJob(body.id!);
  assert.equal(
    employeeQueued,
    false,
    'Defty mention should not also enqueue the external agent-employee message path',
  );
});

test('structured mention of BYOA agent (kind=agent, not Defty) does NOT trigger agent-reply dispatch', async () => {
  // Mentioning a non-Defty kind=agent user must NOT trigger agent-reply.
  // BYOA mentions are handled via the agent-employee-message path instead.
  const content = `Hey <@${byoaAgentUserId}|AMD BYOA Agent>, can you help?`;

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
  assert.ok(!dispatched, 'agent-reply job should NOT be enqueued for BYOA agent mention');
  const employeeQueued = await findAgentEmployeeMessageJob(body.id!);
  assert.ok(employeeQueued, 'BYOA agent mention should enqueue agent-employee-message');
});

test('plain-text BYOA agent name is normalized and dispatches to the employee', async () => {
  const content = 'Hey @AMD BYOA Agent, can you help?';

  const res = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  assert.equal(res.status, 201);
  const body = await res.json() as { id: string; content: string };
  createdMessageIds.push(body.id);
  assert.match(body.content, new RegExp(`<@${byoaAgentUserId}\\|AMD BYOA Agent>`));
  assert.ok(
    await findAgentEmployeeMessageJob(body.id),
    'typed agent name should enqueue agent-employee-message',
  );
  assert.equal(
    await findAgentReplyJob(body.id),
    false,
    'typed BYOA name should not wake Defty',
  );
});

test('TipTap HTML mention in a thread reply dispatches to a BYOA employee', async () => {
  const parentRes = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Thread parent for employee dispatch' }),
  });
  assert.equal(parentRes.status, 201);
  const parent = await parentRes.json() as { id: string };
  createdMessageIds.push(parent.id);

  const content = `<p><span data-type="mention" data-mention-uuid="${byoaAgentUserId}" data-mention-name="AMD BYOA Agent">@AMD BYOA Agent</span> please inspect this thread.</p>`;
  const replyRes = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, parent_id: parent.id }),
  });
  assert.equal(replyRes.status, 201);
  const reply = await replyRes.json() as { id: string };
  createdMessageIds.push(reply.id);

  assert.ok(
    await findAgentEmployeeMessageJob(reply.id),
    'TipTap mention in a thread reply should enqueue agent-employee-message',
  );
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
