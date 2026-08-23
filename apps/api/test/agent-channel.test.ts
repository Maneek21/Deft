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
import { loadAgentActivity } from '../src/lib/agent-activity.js';
import { projectRoutes } from '../src/routes/projects.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';
import {
  humanMessagePost,
  humanTaskCreate,
  type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';
import { memoryWrite } from '../src/lib/mcp-tools/memory.js';
import { handleAgentEmployeeMessage } from '../src/workers/handlers/agent-employee-message.js';

const app = new Hono();
app.route('/api/agent-channel/v1', agentChannelRoutes);
const operatorApp = new Hono();
operatorApp.use('*', async (c, next) => {
  c.set('user', { id: humanUserId, org_id: orgId, email: 'channel-human@test.local', name: 'Channel Human' });
  await next();
});
operatorApp.route('/api/agent-employees', agentEmployeeRoutes);

let orgId: string;
let humanUserId: string;
let agentUserId: string;
let employeeId: string;
let employeeSlug: string;
let spaceId: string;
let sourceMessageId: string;
let bearer: string;
let projectId: string;

const humanMcpContext = (): HumanToolContext => ({
  org_id: orgId,
  user_id: humanUserId,
  role: 'owner',
  scopes: ['read:workspace', 'read:messages', 'write:messages', 'read:tasks', 'write:tasks'],
  principal_kind: 'human',
});

function parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const text = result.content.find((item) => item.type === 'text')?.text;
  assert.ok(text, JSON.stringify(result));
  return JSON.parse(text);
}

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

test('human MCP task creation wakes an assigned agent employee', async () => {
  const result = await humanTaskCreate({
    title: 'MCP task wake parity',
    project_id: projectId,
    assignee_id: agentUserId,
    idempotency_key: crypto.randomUUID(),
  }, humanMcpContext());
  const task = parseToolResult(result as any);

  const queued = await db.execute(sql`
    SELECT name, data
    FROM job_queue
    WHERE name = 'agent-employee-task'
      AND data->>'taskId' = ${task.id}
    LIMIT 1
  `);
  const row = (queued as any).rows?.[0] ?? (queued as any)[0];
  assert.equal(row?.name, 'agent-employee-task');
  assert.equal(row?.data?.employeeId, employeeId);
});

test('human MCP message post wakes a mentioned agent employee', async () => {
  const result = await humanMessagePost({
    space_id: spaceId,
    content: `@${employeeSlug} please review the MCP wake path`,
    idempotency_key: crypto.randomUUID(),
  }, humanMcpContext());
  const message = parseToolResult(result as any);

  const queued = await db.execute(sql`
    SELECT name, data
    FROM job_queue
    WHERE name = 'agent-employee-message'
      AND data->>'messageId' = ${message.id}
    LIMIT 1
  `);
  const row = (queued as any).rows?.[0] ?? (queued as any)[0];
  assert.equal(row?.name, 'agent-employee-message');
  assert.equal(row?.data?.employeeId, employeeId);
});

test('private-space mentions do not wake an agent employee without membership', async () => {
  const privateSpaceId = crypto.randomUUID();
  await db.insert(spaces).values({
    id: privateSpaceId,
    org_id: orgId,
    name: `private-channel-${Date.now()}`,
    type: 'private',
    created_by: humanUserId,
  });
  await db.insert(spaceMembers).values({
    id: crypto.randomUUID(),
    space_id: privateSpaceId,
    user_id: humanUserId,
  });

  try {
    const result = await humanMessagePost({
      space_id: privateSpaceId,
      content: `@${employeeSlug} this private message must stay private`,
      idempotency_key: crypto.randomUUID(),
    }, humanMcpContext());
    const message = parseToolResult(result as any);
    const queued = await db.execute(sql`
      SELECT id
      FROM job_queue
      WHERE name = 'agent-employee-message'
        AND data->>'messageId' = ${message.id}
      LIMIT 1
    `);
    const row = (queued as any).rows?.[0] ?? (queued as any)[0];
    assert.equal(row, undefined);

    await handleAgentEmployeeMessage({
      id: crypto.randomUUID(),
      name: 'agent-employee-message',
      data: {
        messageId: message.id,
        spaceId: privateSpaceId,
        orgId,
        employeeId,
        isDM: false,
      },
    } as any);
    const leaked = await db.execute(sql`
      SELECT id FROM agent_channel_events
      WHERE org_id = ${orgId}
        AND agent_employee_id = ${employeeId}
        AND source_id = ${message.id}
      UNION ALL
      SELECT id FROM agent_actions
      WHERE org_id = ${orgId}
        AND agent_employee_id = ${employeeId}
        AND params->>'message_id' = ${message.id}
    `);
    assert.equal(((leaked as any).rows ?? leaked as any[]).length, 0);
  } finally {
    await db.delete(messages).where(and(eq(messages.org_id, orgId), eq(messages.space_id, privateSpaceId)));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, privateSpaceId));
    await db.delete(spaces).where(eq(spaces.id, privateSpaceId));
  }
});

test('Hermes memory sync is idempotent, versioned, and fences human corrections', async () => {
  const key = `session:${crypto.randomUUID()}:fact:1`;
  const context = {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: employeeSlug,
    trust_level: 'autonomous' as const,
  };
  const first = parseToolResult(await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Qualified lead definition',
    body: 'A qualified lead has at least 100 employees.',
    type: 'fact',
    idempotency_key: key,
    runtime_session_id: 'hermes-session-1',
    source_refs: [{ kind: 'session', id: 'hermes-session-1' }],
  }, context) as any);
  const replay = parseToolResult(await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Qualified lead definition',
    body: 'A qualified lead has at least 100 employees.',
    type: 'fact',
    idempotency_key: key,
    runtime_session_id: 'hermes-session-1',
    source_refs: [{ kind: 'session', id: 'hermes-session-1' }],
  }, context) as any);
  assert.equal(replay.page_id, first.page_id);
  assert.equal(replay.replayed, true);

  const concurrentKey = `session:${crypto.randomUUID()}:fact:2`;
  const concurrentArgs = {
    caller_employee_slug: employeeSlug,
    title: 'Concurrent memory fact',
    body: 'This fact must create one canonical page.',
    type: 'fact',
    idempotency_key: concurrentKey,
  };
  const concurrent = await Promise.all([
    memoryWrite(concurrentArgs, context),
    memoryWrite(concurrentArgs, context),
  ]);
  const concurrentPages = concurrent.map((item) => parseToolResult(item as any));
  assert.equal(concurrentPages[0].page_id, concurrentPages[1].page_id);

  const changed = parseToolResult(await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Qualified lead definition',
    body: 'A qualified lead has at least 150 employees.',
    type: 'fact',
    idempotency_key: key,
    runtime_session_id: 'hermes-session-1',
    source_refs: [{ kind: 'session', id: 'hermes-session-1' }],
  }, context) as any);
  assert.equal(changed.page_id, first.page_id);
  assert.equal(changed.version, 2);
  assert.equal(changed.updated, true);

  await db.execute(sql`UPDATE wiki_pages SET content = 'Human correction', version = 3 WHERE id = ${first.page_id}`);
  const conflicted = await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Qualified lead definition',
    body: 'A qualified lead has at least 200 employees.',
    type: 'fact',
    idempotency_key: key,
  }, context);
  assert.equal(conflicted.isError, true);
  assert.match(conflicted.content[0]!.text, /human review/i);

  const secret = await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Do not persist this',
    body: 'api_key=super-secret-value-123456789',
    type: 'fact',
    idempotency_key: crypto.randomUUID(),
  }, context);
  assert.equal(secret.isError, true);
  assert.match(secret.content[0]!.text, /credential or secret/i);

  const sourced = parseToolResult(await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Message-backed memory',
    body: 'This memory retains a validated link to its source message.',
    type: 'fact',
    idempotency_key: crypto.randomUUID(),
    source_refs: [{ kind: 'message', id: sourceMessageId, excerpt: 'hello channel agent' }],
  }, context) as any);
  const citationRows = await db.execute(sql`
    SELECT source_space_id, source_user_id
    FROM wiki_citations
    WHERE page_id = ${sourced.page_id} AND source_id = ${sourceMessageId}
  `);
  const citation = (citationRows as any).rows?.[0] ?? (citationRows as any)[0];
  assert.equal(citation?.source_space_id, spaceId);
  assert.equal(citation?.source_user_id, humanUserId);

  const unavailableSource = await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Unscoped source',
    body: 'This must not create a citation to an unavailable record.',
    type: 'fact',
    idempotency_key: crypto.randomUUID(),
    source_refs: [{ kind: 'message', id: crypto.randomUUID() }],
  }, context);
  assert.equal(unavailableSource.isError, true);
  assert.match(unavailableSource.content[0]!.text, /unavailable to this employee/i);

  const invalidUrlSource = await memoryWrite({
    caller_employee_slug: employeeSlug,
    title: 'Invalid URL source',
    body: 'Only absolute web URLs are accepted as external provenance.',
    type: 'fact',
    idempotency_key: crypto.randomUUID(),
    source_refs: [{ kind: 'url', id: 'file:///private/runtime-data' }],
  }, context);
  assert.equal(invalidUrlSource.isError, true);
  assert.match(invalidUrlSource.content[0]!.text, /absolute HTTP\(S\) URL/i);
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

async function claimChannelEvent(eventId: string, workerId = `worker-${crypto.randomUUID()}`) {
  const res = await app.request(`/api/agent-channel/v1/events?limit=100&worker_id=${encodeURIComponent(workerId)}&lease_ms=120000&${channelCompatibilityQuery()}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  const claimed = body.events.find((candidate: any) => candidate.id === eventId);
  assert.ok(claimed, `expected event ${eventId} to be claimed`);
  assert.ok(claimed.claim_token);
  return claimed;
}

function channelCompatibilityQuery() {
  return new URLSearchParams({
    protocol_version: 'deft.agent_channel.v2',
    adapter_version: '0.2.0-test',
    capabilities: 'single_flight_claims,renewable_leases,fencing_tokens,terminal_outcomes,identity_bound_mcp,wiki_memory_sync_v1',
  }).toString();
}

test('GET /connect requires a bearer token', async () => {
  const res = await app.request('/api/agent-channel/v1/connect');
  assert.equal(res.status, 401);
});

test('GET /connect authenticates a compatible agent bearer and records connection', async () => {
  const res = await app.request(`/api/agent-channel/v1/connect?${channelCompatibilityQuery()}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.protocol_version, 'deft.agent_channel.v2');
  assert.ok(body.capabilities.includes('fencing_tokens'));
  assert.equal(body.employee.slug, employeeSlug);
  assert.equal(body.connection.status, 'connected');

  const [connection] = await db
    .select()
    .from(agentChannelConnections)
    .where(eq(agentChannelConnections.agent_employee_id, employeeId))
    .limit(1);
  assert.ok(connection?.last_seen_at);
});

test('GET /contract advertises the lease-safe public compatibility contract', async () => {
  const res = await app.request('/api/agent-channel/v1/contract');
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(body.protocol_version, 'deft.agent_channel.v2');
  assert.ok(body.capabilities.includes('fencing_tokens'));
  assert.ok(body.required_runtime_capabilities.includes('terminal_outcomes'));
});

test('GET /connect rejects a legacy runtime before recording it as connected', async () => {
  const res = await app.request('/api/agent-channel/v1/connect?protocol_version=deft.agent_channel.v1&adapter_version=0.1.0&capabilities=terminal_outcomes', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 426, JSON.stringify(body));
  assert.equal(body.code, 'INCOMPATIBLE_CHANNEL');
  assert.equal(body.protocol_version, 'deft.agent_channel.v2');
  assert.ok(body.capabilities.includes('fencing_tokens'));
});

test('GET /events returns pending events once and marks them delivered', async () => {
  const first = await publishMessageEvent('agent-channel-events-once');
  await publishMessageEvent('agent-channel-events-once');

  const res = await app.request(`/api/agent-channel/v1/events?limit=10&worker_id=events-once&lease_ms=120000&${channelCompatibilityQuery()}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.events.some((event: any) => event.id === first.id));
  assert.ok(body.events.find((event: any) => event.id === first.id)?.claim_token);
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

test('concurrent bridge polls grant one active claim per event', async () => {
  const event = await publishMessageEvent(`agent-channel-single-flight-${crypto.randomUUID()}`);
  const poll = (workerId: string) => app.request(
    `/api/agent-channel/v1/events?limit=100&worker_id=${workerId}&lease_ms=120000&${channelCompatibilityQuery()}`,
    { headers: { authorization: `Bearer ${bearer}` } },
  ).then(async (response) => ({ response, body: await response.json() as any }));

  const [left, right] = await Promise.all([poll('single-flight-left'), poll('single-flight-right')]);
  assert.equal(left.response.status, 200, JSON.stringify(left.body));
  assert.equal(right.response.status, 200, JSON.stringify(right.body));
  const claims = [...left.body.events, ...right.body.events].filter((candidate: any) => candidate.id === event.id);
  assert.equal(claims.length, 1, 'one event must not be leased to two bridge workers');
  assert.ok(claims[0].claim_token);
});

test('expired owners are fenced after another worker reclaims the event', async () => {
  const event = await publishMessageEvent(`agent-channel-fencing-${crypto.randomUUID()}`);
  const first = await claimChannelEvent(event.id, 'fencing-first');
  await db.update(agentChannelEvents)
    .set({ lease_expires_at: new Date(Date.now() - 1_000) })
    .where(eq(agentChannelEvents.id, event.id));
  const second = await claimChannelEvent(event.id, 'fencing-second');
  assert.notEqual(second.claim_token, first.claim_token);

  const stale = await app.request('/api/agent-channel/v1/ack', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: event.id,
      state: 'completed',
      claim_token: first.claim_token,
    }),
  });
  assert.equal(stale.status, 409);

  const current = await app.request('/api/agent-channel/v1/ack', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: event.id,
      state: 'needs_human',
      claim_token: second.claim_token,
      detail: 'Need the account owner to approve the recipient list.',
    }),
  });
  assert.equal(current.status, 200, await current.text());

  const [recorded] = await db.select().from(agentChannelEvents).where(eq(agentChannelEvents.id, event.id)).limit(1);
  assert.equal(recorded?.status, 'completed', 'delivery is settled even though work awaits a human');
  assert.equal(recorded?.work_outcome, 'needs_human');
  assert.match(recorded?.outcome_detail ?? '', /account owner/);
  assert.ok(recorded?.outcome_at);
  assert.equal(recorded?.claim_token, second.claim_token);
  assert.equal(recorded?.lease_expires_at, null);
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
  const claimed = await claimChannelEvent(event.id, 'ack-worker');
  const res = await app.request('/api/agent-channel/v1/ack', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: event.id,
      state: 'completed',
      claim_token: claimed.claim_token,
      runtime_session_key: 'hermes:deft:test',
    }),
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

test('channel lifecycle records acknowledgement, work, and approval without regressing terminal state', async () => {
  const event = await publishMessageEvent('agent-channel-lifecycle-route');
  const claimed = await claimChannelEvent(event.id, 'lifecycle-worker');

  const acknowledge = await app.request('/api/agent-channel/v1/ack', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: event.id, state: 'received', claim_token: claimed.claim_token }),
  });
  assert.equal(acknowledge.status, 200);

  for (const state of ['working', 'approval_pending']) {
    const response = await app.request('/api/agent-channel/v1/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: event.id, state, claim_token: claimed.claim_token }),
    });
    assert.equal(response.status, 200, `status ${state} should be accepted`);
  }

  const complete = await app.request('/api/agent-channel/v1/ack', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: event.id, state: 'completed', claim_token: claimed.claim_token }),
  });
  assert.equal(complete.status, 200);

  const lateWork = await app.request('/api/agent-channel/v1/status', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: event.id, state: 'working', claim_token: claimed.claim_token }),
  });
  assert.equal(lateWork.status, 409, 'terminal work cannot renew a released claim');

  const [recorded] = await db
    .select()
    .from(agentChannelEvents)
    .where(eq(agentChannelEvents.id, event.id))
    .limit(1);
  assert.equal(recorded?.status, 'completed');
  assert.ok(recorded?.delivered_at);
  assert.ok(recorded?.acked_at);
  assert.ok(recorded?.completed_at);
});

test('agent activity merges delivery and action records into one ordered stream', async () => {
  const event = await publishMessageEvent('agent-channel-activity-stream');
  const [action] = await db.insert(agentActions).values({
    org_id: orgId,
    user_id: humanUserId,
    agent_employee_id: employeeId,
    conversation_id: spaceId,
    source: 'test',
    action: 'create_task',
    params: { title: 'Activity test' },
    approval_tier: 'quick',
    approval_status: 'pending',
  }).returning({ id: agentActions.id });

  const activity = await loadAgentActivity({ orgId, employeeId, limit: 20 });
  const delivery = activity.find((item) => item.id === `delivery:${event.id}`);
  const proposedAction = activity.find((item) => item.id === `action:${action!.id}`);

  assert.equal(delivery?.kind, 'delivery');
  assert.equal(delivery?.status, 'queued');
  assert.equal(delivery?.target_url, `/chat?space=${spaceId}&thread=${sourceMessageId}`);
  assert.equal(proposedAction?.kind, 'action');
  assert.equal(proposedAction?.status, 'approval_pending');
  assert.equal(proposedAction?.target_url, `/chat?space=${spaceId}`);
});

test('operators can cancel and retry a live channel delivery', async () => {
  const event = await publishMessageEvent('agent-channel-operator-control');
  const cancel = await operatorApp.request(`/api/agent-employees/${employeeId}/channel-events/${event.id}/cancel`, {
    method: 'POST',
  });
  assert.equal(cancel.status, 200, await cancel.text());

  let [recorded] = await db.select().from(agentChannelEvents).where(eq(agentChannelEvents.id, event.id)).limit(1);
  assert.equal(recorded?.status, 'cancelled');

  const retry = await operatorApp.request(`/api/agent-employees/${employeeId}/channel-events/${event.id}/retry`, {
    method: 'POST',
  });
  assert.equal(retry.status, 200, await retry.text());

  [recorded] = await db.select().from(agentChannelEvents).where(eq(agentChannelEvents.id, event.id)).limit(1);
  assert.equal(recorded?.status, 'pending');
  assert.equal(recorded?.error, null);
});

test('regular members cannot pause or resume an agent employee', async () => {
  await db.update(orgMembers)
    .set({ role: 'member' })
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, humanUserId)));

  try {
    const pause = await operatorApp.request(`/api/agent-employees/${employeeId}/pause`, { method: 'POST' });
    assert.equal(pause.status, 403, await pause.text());

    const resume = await operatorApp.request(`/api/agent-employees/${employeeId}/resume`, { method: 'POST' });
    assert.equal(resume.status, 403, await resume.text());
  } finally {
    await db.update(orgMembers)
      .set({ role: 'owner' })
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, humanUserId)));
  }
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
  const claimed = await claimChannelEvent(event.id, 'reply-worker');
  const request = {
    event_id: event.id,
    content: 'I am replying through the channel.',
    idempotency_key: 'reply-once',
    claim_token: claimed.claim_token,
    outcome: 'completed',
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
  const claimed = await claimChannelEvent(event.id, 'dm-reply-worker');
  const res = await app.request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: event.id,
      content,
      idempotency_key: 'inline-dm-reply-once',
      claim_token: claimed.claim_token,
      outcome: 'completed',
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
