/**
 * Round 2 / P1 — the in-transaction Defty wake must not use a second pooled
 * connection while the message transaction holds one. With a pool of four,
 * four concurrent engaged-thread posts that each hold a transaction and wait
 * for another connection never commit.
 *
 * A spy on the ordinary pool records any pool checkout or pool query issued
 * while a pooled transaction is open (between BEGIN and COMMIT/ROLLBACK).
 * Requests run one at a time, so any such call is the request's own.
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
import { humanSendMessage, type HumanToolContext } from '../src/lib/mcp-tools/human.js';

const orgId = randomUUID();
const humanId = randomUUID();
const spaceId = randomUUID();
let deftyUserId = '';
let deftyExistedBefore = false;
let app: Hono;

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'Wake pool', slug: `wake-pool-${orgId}` });
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-pool-test-not-real');
  await db.insert(users).values({ id: humanId, name: 'Pool Human', email: `pool-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'pool-room', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values([{ space_id: spaceId, user_id: humanId }, { space_id: spaceId, user_id: deftyUserId }]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `pool-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
});

after(async () => {
  try {
    await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.execute(sql`DELETE FROM oauth_audit_events WHERE org_id = ${orgId}`).catch(() => undefined);
    await db.delete(messages).where(eq(messages.space_id, spaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('wake pool cleanup error:', err);
  }
});

/** Records pool use while any pooled transaction is open. Pooled clients keep
 * their wrapper across checkouts, so the counter is module-level. */
let openTransactions = 0;
let violations: string[] = [];
function spyOnPool() {
  const pool = (db as any).$client;
  openTransactions = 0;
  violations = [];
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = function (this: unknown, ...args: any[]) {
    if (openTransactions > 0) violations.push(`pool.query: ${String(args[0]?.text ?? args[0]).slice(0, 120)}`);
    return originalQuery.apply(this, args);
  };
  pool.connect = function (this: unknown, ...args: any[]) {
    if (openTransactions > 0) violations.push('pool.connect');
    const result = originalConnect.apply(this, args);
    return Promise.resolve(result).then((client: any) => {
      if (!client || client.__wakeSpy) return client;
      const clientQuery = client.query;
      client.query = function (this: unknown, ...queryArgs: any[]) {
        const text = String(queryArgs[0]?.text ?? queryArgs[0]).trim().toLowerCase();
        if (text === 'begin' || text.startsWith('begin ')) openTransactions += 1;
        const settle = () => { if (text === 'commit' || text === 'rollback') openTransactions = Math.max(0, openTransactions - 1); };
        const out = clientQuery.apply(this, queryArgs);
        if (out && typeof out.then === 'function') return out.finally(settle);
        settle();
        return out;
      };
      client.__wakeSpy = true;
      return client;
    });
  };
  return {
    get violations() { return violations; },
    restore() { pool.query = originalQuery; pool.connect = originalConnect; },
  };
}

async function engagedThread() {
  const rootId = randomUUID();
  await db.insert(messages).values({ id: rootId, org_id: orgId, space_id: spaceId, user_id: humanId, content: 'Planning the launch', created_at: new Date(Date.now() - 60_000) });
  await db.insert(messages).values({ org_id: orgId, space_id: spaceId, user_id: deftyUserId, parent_id: rootId, content: 'Which day works?', created_at: new Date(Date.now() - 30_000) });
  return rootId;
}

async function followJobFor(messageId: string) {
  return db.select({ id: jobQueue.id }).from(jobQueue).where(and(
    eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${messageId}`, sql`(${jobQueue.data}->>'followed')::boolean`));
}

test('P1: the web thread-follow wake uses no second pooled connection inside the message transaction', async () => {
  const rootId = await engagedThread();
  const spy = spyOnPool();
  let response: Response;
  try {
    response = await app.request(`/messages/${spaceId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `Monday works ${randomUUID()}`, parent_id: rootId }),
    });
  } finally {
    spy.restore();
  }
  assert.equal(response.status, 201);
  const body = await response.json() as { id: string };
  assert.equal((await followJobFor(body.id)).length, 1, 'the follow wake still commits');
  assert.deepEqual(spy.violations, []);
});

test('P1: the MCP thread-follow wake uses no second pooled connection inside the message transaction', async () => {
  const rootId = await engagedThread();
  const ctx: HumanToolContext = { org_id: orgId, user_id: humanId, role: 'owner', principal_kind: 'human', scopes: ['read:workspace', 'read:messages', 'write:messages'] };
  const spy = spyOnPool();
  let result: any;
  try {
    result = await humanSendMessage({ thread_id: rootId, content: `Tuesday works ${randomUUID()}`, idempotency_key: randomUUID() }, ctx);
  } finally {
    spy.restore();
  }
  assert.ok(!result.isError, result.content?.[0]?.text);
  const id = JSON.parse(result.content[0].text).id as string;
  assert.equal((await followJobFor(id)).length, 1, 'the follow wake still commits');
  assert.deepEqual(spy.violations, []);
});

test('P1: concurrent engaged-thread posts all commit with the ordinary pool', async () => {
  const roots = await Promise.all(Array.from({ length: 6 }, () => engagedThread()));
  const posts = roots.map((rootId) => app.request(`/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `Works for me ${randomUUID()}`, parent_id: rootId }),
  }).then((r) => r.status));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const statuses = await Promise.race([
    Promise.all(posts),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('posts did not commit within 30s (pool exhausted)')), 30_000); }),
  ]).finally(() => clearTimeout(timer));
  assert.deepEqual(statuses, roots.map(() => 201));
});
