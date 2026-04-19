/**
 * Block 3.8 — agent trace export tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/trace-export.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import {
  db, agentConversations, agentMessages, agentActions,
  orgs, users, orgMembers,
} from '@deft/db';
import { agentRoutes } from '../src/routes/agent.js';
import { Hono } from 'hono';

let testOrgId: string;
let testUserId: string;
let convoId: string;
let msgId1: string;
let msgId2: string;
const actionIds: string[] = [];

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: testUserId, org_id: testOrgId, email: 'test@test.local' });
  await next();
});
app.route('/api/agent', agentRoutes);

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b38', slug: 'b38' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b38-${Date.now()}@t.local`, name: 'b38' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  convoId = crypto.randomUUID();
  await db.insert(agentConversations).values({
    id: convoId,
    org_id: testOrgId,
    user_id: testUserId,
    title: 'B3.8 trace export',
  });

  msgId1 = crypto.randomUUID();
  await db.insert(agentMessages).values({
    id: msgId1, conversation_id: convoId,
    role: 'user', content: 'What are my tasks?',
  });
  msgId2 = crypto.randomUUID();
  await db.insert(agentMessages).values({
    id: msgId2, conversation_id: convoId,
    role: 'assistant', content: 'Let me check.',
    tool_calls: [{ tool: 'list_my_tasks', params: {}, result: { count: 3 }, status: 'ok' }] as any,
    model: 'claude-sonnet-4-6', tokens_in: 100, tokens_out: 40,
  });

  // Attach an action to the assistant message
  const actionId = crypto.randomUUID();
  await db.insert(agentActions).values({
    id: actionId,
    org_id: testOrgId,
    user_id: testUserId,
    conversation_id: convoId,
    message_id: msgId2,
    action: 'list_my_tasks',
    params: {} as any,
    result: { count: 3 } as any,
    approval_tier: 'auto',
    approval_status: 'approved',
    executed_at: new Date(),
  });
  actionIds.push(actionId);
});

after(async () => {
  if (actionIds.length > 0) {
    await db.delete(agentActions).where(inArray(agentActions.id, actionIds));
  }
  await db.delete(agentMessages).where(eq(agentMessages.conversation_id, convoId));
  await db.delete(agentConversations).where(eq(agentConversations.id, convoId));
});

test('GET /conversations/:id/trace.json returns the full export', async () => {
  const res = await app.request(`/api/agent/conversations/${convoId}/trace.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(res.headers.get('content-disposition') ?? '', /\.json/);

  const trace = await res.json() as any;
  assert.equal(trace.format, 'deft.agent_trace.v1');
  assert.equal(trace.conversation.id, convoId);
  assert.equal(trace.messages.length, 2);
  // User message + assistant
  const userMsg = trace.messages.find((m: any) => m.role === 'user');
  const asst = trace.messages.find((m: any) => m.role === 'assistant');
  assert.ok(userMsg && asst);
  assert.equal(asst.tool_calls[0].tool, 'list_my_tasks');
  assert.equal(asst.model, 'claude-sonnet-4-6');

  // Actions included
  assert.equal(trace.actions.length, 1);
  assert.equal(trace.actions[0].action, 'list_my_tasks');
  assert.equal(trace.actions[0].approval_status, 'approved');
});

test('GET /conversations/:id/trace.json returns 404 for unknown id', async () => {
  const res = await app.request(`/api/agent/conversations/${crypto.randomUUID()}/trace.json`);
  assert.equal(res.status, 404);
});

test('trace export Content-Disposition carries a safe filename', async () => {
  const res = await app.request(`/api/agent/conversations/${convoId}/trace.json`);
  const cd = res.headers.get('content-disposition') ?? '';
  assert.match(cd, /agent-trace-[a-f0-9]{8}\.json/);
});
