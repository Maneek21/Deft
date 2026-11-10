/**
 * A07b — the BYOA sibling of A07. A chat message that wakes a BYOA agent
 * employee (mention, or any post in a dm / agent_conversation the employee
 * belongs to) must be committed together with its `agent-employee-message`
 * job, or the request must fail as a whole so the client can retry. A
 * post-commit, best-effort enqueue leaves a committed message the employee's
 * runtime never discovers, and an idempotent replay returns before any
 * dispatch, so it cannot repair the loss.
 *
 * The enqueue failure is forced with a test-only Postgres trigger on
 * `job_queue` scoped to this test's org; it is dropped in `after`. No worker
 * runs in this process and no model request is made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agentActions, agentEmployees, jobQueue, messages, nativeCreateRequests, notifications, orgMembers, orgs,
  spaceMembers, spaces, users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { enqueue, QUEUE_NAMES } from '../src/lib/queues.js';
import { DEFTY_EMAIL } from '../src/lib/ensure-defty-membership.js';

const orgId = randomUUID();
const humanId = randomUUID();
const agentUserId = randomUUID();
const spaceId = randomUUID();
const failFn = `a07b_fail_employee_msg_${orgId.replace(/-/g, '')}`;
let employeeId = '';
let deftyExistedBefore = false;
let app: Hono;

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'A07b enqueue durability', slug: `a07b-${orgId}` });
  await db.insert(users).values([
    { id: humanId, name: 'A07b Human', email: `a07b-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true },
    { id: agentUserId, name: 'A07b Runner', kind: 'agent', is_agent: true, email_verified: true },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: humanId, role: 'owner' },
    { org_id: orgId, user_id: agentUserId, role: 'member' },
  ]);
  const [employee] = await db.insert(agentEmployees).values({
    org_id: orgId,
    user_id: agentUserId,
    name: 'A07b Runner',
    slug: `a07b-runner-${orgId}`,
    role: 'custom',
    system_prompt: 'Test BYOA agent.',
    expertise_description: 'A07b durability fixture.',
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
    created_by: humanId,
  }).returning({ id: agentEmployees.id });
  employeeId = employee!.id;
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'a07b-general', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values([{ space_id: spaceId, user_id: humanId }, { space_id: spaceId, user_id: agentUserId }]);

  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `a07b-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);

  // Test-only fault injection: while armed, any agent-employee-message insert
  // for this org raises. Other orgs (and other test files) are unaffected.
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${failFn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.name = 'agent-employee-message' AND NEW.org_id = '${orgId}' THEN
        RAISE EXCEPTION 'A07b injected agent-employee-message enqueue failure';
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
    await db.delete(messages).where(eq(messages.org_id, orgId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.org_id, orgId));
    await db.delete(agentEmployees).where(eq(agentEmployees.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanId, agentUserId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('A07b cleanup error:', err);
  }
});

async function setEnqueueFailure(on: boolean) {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failFn} ON job_queue`));
  if (on) await db.execute(sql.raw(`CREATE TRIGGER ${failFn} BEFORE INSERT ON job_queue FOR EACH ROW EXECUTE FUNCTION ${failFn}()`));
}

async function post(content: string, key?: string, targetSpaceId = spaceId) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const response = await app.request(`/messages/${targetSpaceId}`, { method: 'POST', headers, body: JSON.stringify({ content }) });
  return { status: response.status, body: await response.json() as { id?: string; code?: string; error?: string } };
}

async function committedMessagesWith(marker: string) {
  return db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.org_id, orgId), eq(messages.user_id, humanId), sql`${messages.content} LIKE ${`%${marker}%`}`,
  ));
}

async function employeeJobsFor(messageId: string) {
  return db.select({ id: jobQueue.id, dedupe_key: jobQueue.dedupe_key, data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.org_id, orgId), eq(jobQueue.name, 'agent-employee-message'), sql`${jobQueue.data}->>'messageId' = ${messageId}`,
  ));
}

const mention = () => `<@${agentUserId}|A07b Runner>`;

test('A07b: a committed BYOA-waking message always has its agent-employee-message job', async () => {
  const marker = `a07b-commit-${randomUUID()}`;
  await setEnqueueFailure(true);
  let result;
  try {
    result = await post(`${mention()} please pick up ${marker}`);
  } finally {
    await setEnqueueFailure(false);
  }
  const committed = await committedMessagesWith(marker);
  for (const message of committed) {
    const jobs = await employeeJobsFor(message.id);
    assert.equal(jobs.length, 1, `message ${message.id} was committed (HTTP ${result.status}) without an agent-employee-message job`);
  }
  if (committed.length === 0) {
    assert.ok(result.status >= 500, 'a request that commits nothing must report failure so the client retries');
    assert.equal(typeof result.body.error, 'string');
    assert.equal(typeof result.body.code, 'string');
  }
});

test('A07b: idempotent replay does not leave a message without its employee job', async () => {
  const marker = `a07b-replay-${randomUUID()}`;
  const key = `a07b-${randomUUID()}`;
  const content = `${mention()} follow up on ${marker}`;
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
  const jobs = await employeeJobsFor(retry.body.id!);
  assert.equal(jobs.length, 1, 'the message returned by the retry must have its agent-employee-message job');
});

test('A07b: replays and repeated enqueues never double-enqueue agent-employee-message', async () => {
  const marker = `a07b-dedupe-${randomUUID()}`;
  const key = `a07b-${randomUUID()}`;
  const content = `${mention()} dedupe check ${marker}`;
  const first = await post(content, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const replays = await Promise.all(Array.from({ length: 4 }, () => post(content, key)));
  for (const replay of replays) {
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);
  }
  const jobs = await employeeJobsFor(first.body.id!);
  assert.equal(jobs.length, 1, 'one agent-employee-message job per (message, employee)');
  assert.equal(jobs[0]!.dedupe_key, `agent-employee-message:${first.body.id}:${employeeId}`);

  await enqueue(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-message', { orgId, messageId: first.body.id, spaceId, employeeId }, {
    dedupeKey: `agent-employee-message:${first.body.id}:${employeeId}`,
  });
  assert.equal((await employeeJobsFor(first.body.id!)).length, 1);
});

test('A07b: a post in a BYOA agent_conversation (no mention) wakes that employee durably', async () => {
  const convoId = randomUUID();
  await db.insert(spaces).values({ id: convoId, org_id: orgId, name: 'a07b-convo', type: 'agent_conversation', created_by: humanId });
  await db.insert(spaceMembers).values([{ space_id: convoId, user_id: humanId }, { space_id: convoId, user_id: agentUserId }]);
  try {
    const marker = `a07b-convo-${randomUUID()}`;
    await setEnqueueFailure(true);
    let failed;
    try {
      failed = await post(`what is on my plate today? ${marker}`, undefined, convoId);
    } finally {
      await setEnqueueFailure(false);
    }
    for (const message of await committedMessagesWith(marker)) {
      assert.equal((await employeeJobsFor(message.id)).length, 1,
        `agent_conversation message ${message.id} was committed (HTTP ${failed.status}) without its employee job`);
    }

    const ok = await post(`second try ${marker}`, undefined, convoId);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const jobs = await employeeJobsFor(ok.body.id!);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.dedupe_key, `agent-employee-message:${ok.body.id}:${employeeId}`);
    assert.equal((jobs[0]!.data as { employeeId?: string; isDM?: boolean }).employeeId, employeeId);
    assert.equal((jobs[0]!.data as { isDM?: boolean }).isDM, true);
  } finally {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, convoId));
  }
});
