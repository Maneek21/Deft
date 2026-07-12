/**
 * Agent Channel API v1.
 *
 * Run:
 *   cd apps/api && pnpm exec tsx --env-file=../../.env --test test/agent-channel.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  agentChannelConnections,
  agentChannelCursors,
  agentChannelDeliveryAttempts,
  agentChannelEvents,
  agentChannelTokens,
  agentEmployees,
  agentActions,
  actionReceipts,
  messages,
  notifications,
  orgMembers,
  orgs,
  jobQueue,
  projects,
  spaceMembers,
  spaces,
  taskActivity,
  tasks,
  users,
} from '@deft/db';
import { agentChannelRoutes } from '../src/routes/agent-channel.js';
import { publishAgentChannelEvent } from '../src/lib/agent-channel.js';
import { projectRoutes } from '../src/routes/projects.js';

const app = new Hono();
app.route('/api/agent-channel/v1', agentChannelRoutes);

let orgId: string;
let humanUserId: string;
let agentUserId: string;
let employeeId: string;
let employeeSlug: string;
let spaceId: string;
let sourceMessageId: string;
let bearer: string;
let projectId: string;

before(async () => {
  const ts = Date.now();
  orgId = crypto.randomUUID();
  humanUserId = crypto.randomUUID();
  agentUserId = crypto.randomUUID();
  employeeId = crypto.randomUUID();
  employeeSlug = `channel-agent-${ts}`;
  spaceId = crypto.randomUUID();
  bearer = `deft-channel-test-${crypto.randomUUID()}`;
  const hash = await bcrypt.hash(bearer, 10);

  await db.insert(orgs).values({ id: orgId, name: 'Agent Channel Test', slug: `agent-channel-${ts}` });
  await db.insert(users).values([
    {
      id: humanUserId,
      email: `agent-channel-human-${ts}@test.local`,
      name: 'Channel Human',
      kind: 'human',
      is_agent: false,
      email_verified: true,
    },
    {
      id: agentUserId,
      name: 'Channel Agent',
      kind: 'agent',
      is_agent: true,
      agent_employee_id: employeeId,
      email_verified: true,
    },
  ]);
  await db.insert(orgMembers).values([
    { id: crypto.randomUUID(), org_id: orgId, user_id: humanUserId, role: 'owner' },
    { id: crypto.randomUUID(), org_id: orgId, user_id: agentUserId, role: 'member' },
  ]);
  await db.insert(agentEmployees).values({
    id: employeeId,
    org_id: orgId,
    user_id: agentUserId,
    name: 'Channel Agent',
    slug: employeeSlug,
    role: 'custom',
    system_prompt: 'test',
    trust_level: 'autonomous',
    is_byoa: true,
    runtime_kind: 'hermes',
    wake_mode: 'external_chat',
    created_by: humanUserId,
  });
  await db.insert(agentChannelTokens).values({
    id: crypto.randomUUID(),
    org_id: orgId,
    agent_employee_id: employeeId,
    name: 'Channel Agent Channel Token',
    token_hash: hash,
    token_prefix: bearer.slice(0, 18),
    created_by: humanUserId,
  });
  await db.insert(spaces).values({
    id: spaceId,
    org_id: orgId,
    name: 'channel-test-space',
    type: 'public',
    created_by: humanUserId,
  });
  await db.insert(spaceMembers).values([
    { id: crypto.randomUUID(), space_id: spaceId, user_id: humanUserId },
    { id: crypto.randomUUID(), space_id: spaceId, user_id: agentUserId },
  ]);
  const [source] = await db.insert(messages).values({
    id: crypto.randomUUID(),
    org_id: orgId,
    space_id: spaceId,
    user_id: humanUserId,
    content: 'hello channel agent',
  }).returning({ id: messages.id });
  sourceMessageId = source!.id;
  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    id: projectId,
    org_id: orgId,
    name: 'Agent Channel Project',
    prefix: `ACP${String(ts).slice(-5)}`,
  });
});

after(async () => {
  try {
    await db.delete(agentChannelDeliveryAttempts).where(eq(agentChannelDeliveryAttempts.agent_employee_id, employeeId));
    await db.delete(agentChannelTokens).where(eq(agentChannelTokens.agent_employee_id, employeeId));
    await db.delete(agentChannelCursors).where(eq(agentChannelCursors.agent_employee_id, employeeId));
    await db.delete(agentChannelConnections).where(eq(agentChannelConnections.agent_employee_id, employeeId));
    await db.delete(agentChannelEvents).where(eq(agentChannelEvents.agent_employee_id, employeeId));
    await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, employeeId));
    await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.delete(taskActivity).where(eq(taskActivity.org_id, orgId));
    await db.delete(tasks).where(eq(tasks.org_id, orgId));
    await db.execute(sql`DELETE FROM job_queue WHERE data->>'orgId' = ${orgId}`);
    await db.delete(messages).where(eq(messages.org_id, orgId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanUserId, agentUserId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch (err) {
    console.error('[agent-channel-test] cleanup failed:', err);
  }
});

test('project-scoped UI task creation wakes an assigned agent employee', async () => {
  const projectApp = new Hono();
  projectApp.use('*', async (c, next) => {
    c.set('user', {
      id: humanUserId,
      org_id: orgId,
      email: 'channel-human@test.local',
      name: 'Channel Human',
    });
    await next();
  });
  projectApp.route('/api/projects', projectRoutes);

  const response = await projectApp.request(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Inspect the live handoff',
      description: 'Reply with a task comment and move this to in review.',
      assignee_id: agentUserId,
      metadata: { source: 'agent-channel-route-test' },
    }),
  });
  const body = await response.json() as any;
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.assignee_id, agentUserId);
  assert.equal(body.metadata.source, 'agent-channel-route-test');

  const queued = await db.execute(sql`
    SELECT name, data
    FROM job_queue
    WHERE name = 'agent-employee-task'
      AND data->>'taskId' = ${body.id}
    LIMIT 1
  `);
  const row = (queued as any).rows?.[0] ?? (queued as any)[0];
  assert.equal(row?.name, 'agent-employee-task');
  assert.equal(row?.data?.employeeId, employeeId);
});

async function publishMessageEvent(
  idempotencyKey = `message:${sourceMessageId}:employee:${employeeId}`,
  pendingActionId: string | null = null,
) {
  const { event } = await publishAgentChannelEvent({
    orgId,
    employeeId,
    kind: 'message.created',
    sourceKind: 'message',
    sourceId: sourceMessageId,
    spaceId,
    threadId: sourceMessageId,
    actorUserId: humanUserId,
    idempotencyKey,
    payload: {
      message_id: sourceMessageId,
      content: 'hello channel agent',
      reply_thread_id: sourceMessageId,
      pending_action_id: pendingActionId,
    },
  });
  return event!;
}

test('GET /connect requires a bearer token', async () => {
  const res = await app.request('/api/agent-channel/v1/connect');
  assert.equal(res.status, 401);
});

test('GET /connect authenticates an agent bearer and records connection', async () => {
  const res = await app.request('/api/agent-channel/v1/connect', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.employee.slug, employeeSlug);
  assert.equal(body.connection.status, 'connected');

  const [connection] = await db
    .select()
    .from(agentChannelConnections)
    .where(eq(agentChannelConnections.agent_employee_id, employeeId))
    .limit(1);
  assert.ok(connection?.last_seen_at);
});

test('GET /events returns pending events once and marks them delivered', async () => {
  const first = await publishMessageEvent('agent-channel-events-once');
  await publishMessageEvent('agent-channel-events-once');

  const res = await app.request('/api/agent-channel/v1/events?limit=10', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.events.some((event: any) => event.id === first.id));
  assert.equal(
    body.events.filter((event: any) => event.idempotency_key === 'agent-channel-events-once').length,
    1,
    'idempotency should keep duplicate publish to one event',
  );

  const [updated] = await db
    .select()
    .from(agentChannelEvents)
    .where(eq(agentChannelEvents.id, first.id))
    .limit(1);
  assert.equal(updated?.status, 'delivered');
  assert.equal(updated?.delivery_count, 1);
});

test('POST /ack records received/completed state and cursor', async () => {
  const [fallbackAction] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: humanUserId,
    agent_employee_id: employeeId,
    source: 'mention',
    action: 'chat_mention',
    params: { message_id: sourceMessageId },
    approval_tier: 'auto',
    approval_status: 'pending',
  }).returning({ id: agentActions.id });
  const { event } = await publishAgentChannelEvent({
    orgId,
    employeeId,
    kind: 'message.created',
    sourceKind: 'message',
    sourceId: sourceMessageId,
    spaceId,
    threadId: sourceMessageId,
    actorUserId: humanUserId,
    idempotencyKey: 'agent-channel-ack',
    payload: {
      message_id: sourceMessageId,
      content: 'hello channel agent',
      pending_action_id: fallbackAction!.id,
    },
  });
  const res = await app.request('/api/agent-channel/v1/ack', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: event.id, state: 'completed', runtime_session_key: 'hermes:deft:test' }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.event.status, 'completed');
  assert.ok(body.event.acked_at);
  assert.ok(body.event.completed_at);

  const [cursor] = await db
    .select()
    .from(agentChannelCursors)
    .where(eq(agentChannelCursors.agent_employee_id, employeeId))
    .limit(1);
  assert.equal(cursor?.last_acked_event_id, event.id);

  const [closedFallback] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, fallbackAction!.id))
    .limit(1);
  assert.equal(closedFallback?.approval_status, 'approved');
  assert.ok(closedFallback?.executed_at);
  assert.equal((closedFallback?.result as any)?.channel_event_id, event.id);
});

test('POST /reply posts as the agent and is idempotent', async () => {
  const [fallbackAction] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: humanUserId,
    agent_employee_id: employeeId,
    source: 'mention',
    action: 'chat_mention',
    params: { message_id: sourceMessageId },
    approval_tier: 'auto',
    approval_status: 'pending',
  }).returning({ id: agentActions.id });
  const event = await publishMessageEvent('agent-channel-reply', fallbackAction!.id);
  const request = {
    event_id: event.id,
    content: 'I am replying through the channel.',
    idempotency_key: 'reply-once',
  };

  const first = await app.request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const firstBody = await first.json() as any;
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  assert.equal(firstBody.ok, true);
  assert.ok(firstBody.result.message_id);

  const second = await app.request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const secondBody = await second.json() as any;
  assert.equal(second.status, 200, JSON.stringify(secondBody));
  assert.equal(secondBody.idempotent, true);
  assert.equal(secondBody.result.message_id, firstBody.result.message_id);

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.org_id, orgId),
        eq(messages.user_id, agentUserId),
        eq(messages.content, request.content),
      ),
    );
  assert.equal(rows[0]?.count, 1, 'reply should be written once');

  const [closedFallback] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, fallbackAction!.id))
    .limit(1);
  assert.equal(closedFallback?.approval_status, 'approved');
  assert.ok(closedFallback?.executed_at);
  assert.equal((closedFallback?.result as any)?.channel_event_id, event.id);
});

test('POST /reply keeps a top-level DM response inline', async () => {
  const { event } = await publishAgentChannelEvent({
    orgId,
    employeeId,
    kind: 'message.created',
    sourceKind: 'message',
    sourceId: sourceMessageId,
    spaceId,
    threadId: sourceMessageId,
    actorUserId: humanUserId,
    idempotencyKey: 'agent-channel-inline-dm-reply',
    payload: {
      message_id: sourceMessageId,
      content: 'hello in a top-level DM',
      is_dm: true,
      parent_id: null,
    },
  });
  const content = 'Inline employee reply';
  const res = await app.request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: event.id,
      content,
      idempotency_key: 'inline-dm-reply-once',
    }),
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));

  const [reply] = await db
    .select({ parent_id: messages.parent_id })
    .from(messages)
    .where(and(eq(messages.org_id, orgId), eq(messages.content, content)))
    .limit(1);
  assert.equal(reply?.parent_id, null);
});
