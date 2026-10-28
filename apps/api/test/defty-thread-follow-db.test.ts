import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { messages, notifications, orgMembers, orgs, spaces, spaceMembers, users, jobQueue } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { setOrgAPIKey } from '../src/lib/org-ai-config.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const orgId = randomUUID();
const humanId = randomUUID();
const otherHumanId = randomUUID();
const otherAgentId = randomUUID();
const spaceId = randomUUID();
let deftyId: string;
let unavailable = databaseUrl ? '' : 'Set matching DEFT_TEST_DATABASE_URL and DATABASE_URL to a disposable test database';
let seeded = false;
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: humanId, org_id: orgId, email: `${humanId}@example.test` } as any);
  await next();
});

before(async () => {
  if (unavailable) return;
  const probe = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try { await probe.connect(); } catch (error) {
    unavailable = `Test database unavailable: ${String(error)}`;
    return;
  } finally { await probe.end(); }
  await db.insert(orgs).values({ id: orgId, name: 'Thread follow', slug: `thread-follow-${orgId}` });
  seeded = true;
  await db.insert(users).values([
    { id: humanId, email: `${humanId}@example.test`, name: 'Requester', kind: 'human', is_agent: false },
    { id: otherHumanId, email: `${otherHumanId}@example.test`, name: 'Rahul Rao', kind: 'human', is_agent: false },
    { id: otherAgentId, email: `${otherAgentId}@example.test`, name: 'Build Agent', kind: 'agent', is_agent: true },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: humanId, role: 'owner' },
    { org_id: orgId, user_id: otherHumanId, role: 'member' },
    { org_id: orgId, user_id: otherAgentId, role: 'member' },
  ]);
  deftyId = await ensureDeftyMembership(orgId);
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-thread-follow-not-real');
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'Thread follow', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanId },
    { space_id: spaceId, user_id: otherHumanId },
    { space_id: spaceId, user_id: otherAgentId },
    { space_id: spaceId, user_id: deftyId },
  ]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app.route('/api/messages', messageRoutes);
  seeded = true;
});

after(async () => {
  if (seeded) {
    await db.delete(jobQueue).where(sql`${jobQueue.data}->>'orgId' = ${orgId}`);
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.delete(messages).where(eq(messages.org_id, orgId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(sql`${users.id} IN (${humanId}, ${otherHumanId}, ${otherAgentId})`);
  }
  await closeDb();
});

async function thread(options: { age?: number; humanAfter?: boolean; humanBefore?: boolean; agentBefore?: boolean; pending?: boolean; resolved?: boolean } = {}) {
  const now = Date.now();
  const rootId = randomUUID();
  await db.insert(messages).values({ id: rootId, org_id: orgId, space_id: spaceId, user_id: humanId, content: 'Make a task for what Rahul said', created_at: new Date(now - 35 * 60_000) });
  const createdAt = new Date(now - (options.age ?? 5000));
  if (options.humanBefore) await db.insert(messages).values({ org_id: orgId, space_id: spaceId, user_id: otherHumanId, parent_id: rootId, content: 'I can pair on this.', created_at: new Date(now - 10_000) });
  if (options.agentBefore) await db.insert(messages).values({ org_id: orgId, space_id: spaceId, user_id: otherAgentId, parent_id: rootId, content: 'The deploy is green.', created_at: new Date(now - 9000) });
  await db.insert(messages).values({
    org_id: orgId, space_id: spaceId, user_id: deftyId, parent_id: rootId,
    content: options.pending ? 'Which project?' : 'Here is the answer.', created_at: createdAt,
    metadata: options.pending ? {
      defty_pending: { kind: 'action_draft', request_message_id: rootId, request_text: 'Make a task for what Rahul said', draft: {}, question: 'Which project?', created_at: createdAt.toISOString() },
      ...(options.resolved ? { defty_pending_resolved_at: new Date(now - 2000).toISOString() } : {}),
    } : {},
  });
  if (options.humanAfter) await db.insert(messages).values({ org_id: orgId, space_id: spaceId, user_id: otherHumanId, parent_id: rootId, content: 'I can take a look.', created_at: new Date(now - 1000) });
  return rootId;
}

async function sendReply(rootId: string, content = 'Deft v1') {
  const response = await app.request(`/api/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: rootId, content }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json() as { id: string };
  const jobs = await db.select({ id: jobQueue.id, data: jobQueue.data }).from(jobQueue).where(and(eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${result.id}`));
  return { messageId: result.id, jobs };
}

test('human reply directly after a Defty message in a channel thread dispatches agent-reply', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const result = await sendReply(await thread());
  assert.equal(result.jobs.length, 1);
  assert.equal((result.jobs[0]!.data as Record<string, unknown>).followed, true);
});

test('name-addressed reply to another participant does not dispatch', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread({ humanBefore: true }), 'Rahul, can you pair with me on that tomorrow?')).jobs.length, 0);
  assert.equal((await sendReply(await thread({ humanBefore: true, pending: true }), '<p>rahul: can you pair with me?</p>')).jobs.length, 0);
  assert.equal((await sendReply(await thread({ agentBefore: true }), 'Build, can you inspect the deploy tomorrow?')).jobs.length, 0);
});

test('an answer to Defty still dispatches when another participant is present', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread({ humanBefore: true, pending: true }), 'Deft v1; Rahul can take it')).jobs.length, 1);
});
test("human reply after another human's message in the same thread does not dispatch", async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread({ humanAfter: true }))).jobs.length, 0);
});
test('reply that @mentions another human does not dispatch', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread(), `<@${otherHumanId}|Rahul> what do you think?`)).jobs.length, 0);
  assert.equal((await sendReply(await thread(), `<p><span data-type="mention" data-mention-uuid="${otherHumanId}" data-mention-name="Rahul">@Rahul</span> what do you think?</p>`)).jobs.length, 0);
});
test('reply addressed to another agent does not dispatch Defty', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread(), `<@${otherAgentId}|Build Agent> please inspect this`)).jobs.length, 0);
});
test('reply after the 30-minute window does not dispatch', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread({ age: 31 * 60_000 }))).jobs.length, 0);
});
test('answer without a mention dispatches for an unresolved Defty clarification only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  assert.equal((await sendReply(await thread({ pending: true, humanAfter: true }))).jobs.length, 1);
  assert.equal((await sendReply(await thread({ pending: true, resolved: true, humanAfter: true }))).jobs.length, 0);
});
test('empty provider keys produce a configure-AI reply without retry advice', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_URL'] as const;
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const savedRuntime = new Map(keys.map(key => [key, runtimeEnv[key]]));
  try {
    for (const key of keys) { process.env[key] = '  '; runtimeEnv[key] = '  '; }
    await db.update(orgs).set({ ai_config: {} }).where(eq(orgs.id, orgId));
    const rootId = await thread();
    const result = await sendReply(rootId);
    assert.equal(result.jobs.length, 0);
    const replies = await db.select({ content: messages.content }).from(messages).where(and(eq(messages.org_id, orgId), eq(messages.space_id, spaceId), eq(messages.parent_id, rootId), eq(messages.user_id, deftyId)));
    const reply = replies.find(row => row.content.includes('Settings'));
    assert.ok(reply, 'Defty should explain where to configure a reasoning provider');
    assert.match(reply.content, /Settings\s*(?:>|\u2192)\s*AI/);
    assert.doesNotMatch(reply.content, /retry/i);
  } finally {
    for (const key of keys) {
      const runtimeValue = savedRuntime.get(key);
      if (runtimeValue === undefined) delete runtimeEnv[key]; else runtimeEnv[key] = runtimeValue;
      const value = saved.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-thread-follow-not-real');
  }
});
