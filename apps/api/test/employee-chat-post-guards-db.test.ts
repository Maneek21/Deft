/**
 * Wave 2 lane S1 — one set of guard rails on every path by which a BYOA
 * agent employee posts a chat message (owner decision 2026-11-10: the
 * employee's own plain chat post needs no approval at any trust level, but
 * membership/visibility, the reply-storm detector, the daily action cap and
 * the circuit breaker still apply).
 *
 * Paths exercised against the real handlers:
 *   - MCP v1 `send_message` (space / thread / DM) and `message_post`
 *   - Agent Channel `POST /api/agent-channel/v1/reply`
 *   - legacy `/mcp/call` tool `deft_post_message`
 *
 * Test names carry the brief's item ids (S1-a … S1-c).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  actionReceipts,
  agentActions,
  agentChannelConnections,
  agentChannelCursors,
  agentChannelDeliveryAttempts,
  agentChannelEvents,
  agentChannelTokens,
  agentEmployees,
  apiKeys,
  messages,
  notifications,
  orgMembers,
  orgs,
  spaceMembers,
  spaces,
  users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { issueEmployeeToken } from '../src/lib/mcp-token.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { agentChannelRoutes } from '../src/routes/agent-channel.js';
import { mcpServerRoutes } from '../src/routes/mcp-server.js';
import { publishAgentChannelEvent } from '../src/lib/agent-channel.js';

type Trust = 'conservative' | 'standard' | 'autonomous';
const TRUSTS: Trust[] = ['conservative', 'standard', 'autonomous'];

const run = randomUUID().slice(0, 8);
const orgId = `s1-org-${run}`;
const ownerId = `s1-owner-${run}`;
const peerId = `s1-peer-${run}`;
const publicSpaceId = `s1-public-${run}`;
const otherPublicSpaceId = `s1-public2-${run}`;
const hiddenSpaceId = `s1-hidden-${run}`;
const privateMemberSpaceId = `s1-private-member-${run}`;

type Employee = {
  id: string;
  userId: string;
  slug: string;
  mcpToken: string;
  channelBearer: string;
  legacyKey: string;
};
const employees = Object.fromEntries(TRUSTS.map((t) => [t, {
  id: `s1-emp-${t}-${run}`,
  userId: `s1-u-${t}-${run}`,
  slug: `s1-${t}-${run}`,
  mcpToken: '',
  channelBearer: `deft-channel-s1-${t}-${randomUUID()}`,
  legacyKey: `deft_${randomUUID().replace(/-/g, '')}`,
}])) as Record<Trust, Employee>;
const employeeIds = () => TRUSTS.map((t) => employees[t].id);

const app = new Hono();
app.route('/api/mcp/v1', mcpServerV1Routes);
app.route('/api/agent-channel/v1', agentChannelRoutes);
app.route('/mcp', mcpServerRoutes);

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'S1 org', slug: `s1-${run}` });
  await db.insert(users).values([
    { id: ownerId, email: `s1-owner-${run}@test.local`, name: 'S1 Owner', kind: 'human', email_verified: true },
    { id: peerId, email: `s1-peer-${run}@test.local`, name: 'S1 Peer', kind: 'human', email_verified: true },
    ...TRUSTS.map((t) => ({
      id: employees[t].userId,
      name: `S1 ${t}`,
      kind: 'agent' as const,
      is_agent: true,
      agent_employee_id: employees[t].id,
      email_verified: true,
    })),
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: ownerId, role: 'owner' },
    { org_id: orgId, user_id: peerId, role: 'member' },
    ...TRUSTS.map((t) => ({ org_id: orgId, user_id: employees[t].userId, role: 'member' as const })),
  ]);
  for (const t of TRUSTS) {
    const e = employees[t];
    await db.insert(agentEmployees).values({
      id: e.id,
      org_id: orgId,
      user_id: e.userId,
      name: `S1 ${t}`,
      slug: e.slug,
      role: 'custom',
      system_prompt: 'S1 test employee',
      trust_level: t,
      is_byoa: true,
      runtime_kind: 'hermes',
      wake_mode: 'external_chat',
      is_active: true,
      max_daily_actions: 500,
      created_by: ownerId,
    });
    e.mcpToken = await issueEmployeeToken(orgId, e.id);
    await db.insert(agentChannelTokens).values({
      org_id: orgId,
      agent_employee_id: e.id,
      name: `S1 ${t} channel token`,
      token_hash: await bcrypt.hash(e.channelBearer, 4),
      token_prefix: e.channelBearer.slice(0, 18),
      created_by: ownerId,
    });
    // Legacy /mcp key with write permission (an admin opt-in: the default
    // employee key is read-only).
    await db.insert(apiKeys).values({
      org_id: orgId,
      agent_employee_id: e.id,
      name: `S1 ${t} legacy key`,
      key_hash: await bcrypt.hash(e.legacyKey, 4),
      key_prefix: e.legacyKey.slice(0, 12),
      permissions: ['read', 'write'],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 100000,
      created_by: ownerId,
    });
  }
  await db.insert(spaces).values([
    { id: publicSpaceId, org_id: orgId, name: `s1-general-${run}`, type: 'public', created_by: ownerId },
    { id: otherPublicSpaceId, org_id: orgId, name: `s1-other-${run}`, type: 'public', created_by: ownerId },
    { id: hiddenSpaceId, org_id: orgId, name: `s1-hidden-${run}`, type: 'private', created_by: ownerId },
    { id: privateMemberSpaceId, org_id: orgId, name: `s1-privmember-${run}`, type: 'private', created_by: ownerId },
  ]);
  await db.insert(spaceMembers).values([
    { space_id: publicSpaceId, user_id: ownerId },
    { space_id: otherPublicSpaceId, user_id: ownerId },
    { space_id: hiddenSpaceId, user_id: ownerId },
    { space_id: privateMemberSpaceId, user_id: ownerId },
    ...TRUSTS.map((t) => ({ space_id: publicSpaceId, user_id: employees[t].userId })),
    ...TRUSTS.map((t) => ({ space_id: privateMemberSpaceId, user_id: employees[t].userId })),
  ]);
});

after(async () => {
  try {
    const ids = employeeIds();
    await db.delete(agentChannelDeliveryAttempts).where(inArray(agentChannelDeliveryAttempts.agent_employee_id, ids));
    await db.delete(agentChannelTokens).where(inArray(agentChannelTokens.agent_employee_id, ids));
    await db.delete(agentChannelCursors).where(inArray(agentChannelCursors.agent_employee_id, ids));
    await db.delete(agentChannelConnections).where(inArray(agentChannelConnections.agent_employee_id, ids));
    await db.delete(agentChannelEvents).where(inArray(agentChannelEvents.agent_employee_id, ids));
    await db.delete(actionReceipts).where(inArray(actionReceipts.employee_id, ids));
    await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.execute(sql`DELETE FROM job_queue WHERE data->>'orgId' = ${orgId}`);
    await db.delete(messages).where(eq(messages.org_id, orgId));
    const orgSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.org_id, orgId));
    if (orgSpaces.length > 0) {
      await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, orgSpaces.map((s) => s.id)));
    }
    await db.delete(spaces).where(eq(spaces.org_id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.org_id, orgId));
    await db.execute(sql`DELETE FROM mcp_tokens WHERE org_id = ${orgId}`);
    await db.delete(agentEmployees).where(inArray(agentEmployees.id, ids));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [ownerId, peerId, ...TRUSTS.map((t) => employees[t].userId)]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch (err) {
    console.error('[S1] cleanup error', err);
  }
});

// ─── helpers ──────────────────────────────────────────────────────────────

async function mcpCall(trust: Trust, tool: string, args: Record<string, unknown>) {
  const res = await app.request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${employees[trust].mcpToken}` },
    body: JSON.stringify({ name: tool, arguments: { caller_employee_slug: employees[trust].slug, ...args } }),
  });
  const body = (await res.json()) as any;
  const text = typeof body?.content?.[0]?.text === 'string' ? body.content[0].text as string : '';
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body, parsed, text };
}

async function legacyCall(trust: Trust, params: Record<string, unknown>) {
  const res = await app.request('/mcp/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${employees[trust].legacyKey}` },
    body: JSON.stringify({ tool: 'deft_post_message', params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function compatibilityQuery(workerId: string) {
  return new URLSearchParams({
    protocol_version: 'deft.agent_channel.v2',
    adapter_version: '0.2.0-test',
    capabilities: 'single_flight_claims,renewable_leases,fencing_tokens,terminal_outcomes,identity_bound_mcp,wiki_memory_sync_v1,runtime_reconciliation_v1,runtime_attestation_v1',
    worker_id: workerId,
  }).toString();
}

/** Publish a fresh message event for the employee and claim it. */
async function claimedMessageEvent(trust: Trust, opts: { spaceId?: string; threadId?: string | null } = {}) {
  const spaceId = opts.spaceId ?? publicSpaceId;
  const [source] = await db.insert(messages).values({
    org_id: orgId, space_id: spaceId, user_id: ownerId, content: `s1 source ${randomUUID()}`,
  }).returning();
  const threadId = opts.threadId === undefined ? source!.id : opts.threadId;
  const { event } = await publishAgentChannelEvent({
    orgId,
    employeeId: employees[trust].id,
    kind: 'message.created',
    sourceKind: 'message',
    sourceId: source!.id,
    spaceId,
    threadId,
    actorUserId: ownerId,
    idempotencyKey: `s1-event-${randomUUID()}`,
    payload: { message_id: source!.id, content: source!.content, reply_thread_id: threadId },
  });
  assert.ok(event, 'event published');
  const workerId = `s1-worker-${randomUUID()}`;
  const res = await app.request(`/api/agent-channel/v1/events?limit=100&lease_ms=120000&${compatibilityQuery(workerId)}`, {
    headers: { authorization: `Bearer ${employees[trust].channelBearer}` },
  });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  const claimed = body.events.find((candidate: any) => candidate.id === event!.id);
  assert.ok(claimed?.claim_token, `expected event ${event!.id} to be claimed`);
  return { event: claimed, sourceId: source!.id, threadId };
}

async function channelReply(trust: Trust, event: any, content: string, extra: Record<string, unknown> = {}) {
  const res = await app.request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${employees[trust].channelBearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: event.id,
      content,
      idempotency_key: `s1-reply-${randomUUID()}`,
      claim_token: event.claim_token,
      outcome: 'completed',
      ...extra,
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function messagesWithContent(content: string) {
  return db.select().from(messages).where(and(eq(messages.org_id, orgId), eq(messages.content, content)));
}

async function pendingWithContent(employeeId: string, content: string) {
  const rows = await db.select().from(agentActions).where(and(
    eq(agentActions.agent_employee_id, employeeId),
    eq(agentActions.approval_status, 'pending'),
  ));
  return rows.filter((row) => (row.params as Record<string, unknown> | null)?.content === content);
}

async function dailyCount(trust: Trust) {
  const [row] = await db.select({ count: agentEmployees.daily_action_count })
    .from(agentEmployees).where(eq(agentEmployees.id, employees[trust].id));
  return row!.count;
}

async function withEmployee<T>(trust: Trust, patch: Partial<typeof agentEmployees.$inferInsert>, reset: Partial<typeof agentEmployees.$inferInsert>, fn: () => Promise<T>) {
  await db.update(agentEmployees).set(patch).where(eq(agentEmployees.id, employees[trust].id));
  try {
    return await fn();
  } finally {
    await db.update(agentEmployees).set(reset).where(eq(agentEmployees.id, employees[trust].id));
  }
}

async function seedStorm(trust: Trust, spaceId: string, rootId: string) {
  for (let i = 0; i < 5; i++) {
    await db.insert(messages).values({
      org_id: orgId, space_id: spaceId, user_id: employees[trust].userId,
      content: `s1 storm seed ${i} ${randomUUID()}`, parent_id: rootId,
    });
  }
}

const UNHEALTHY = { unhealthy: true, unhealthy_reason: 's1 test breaker' };
const HEALTHY = { unhealthy: false, unhealthy_reason: null };

// ─── baseline: healthy employees post on every path ───────────────────────

test('S1 baseline: a healthy Conservative employee replies through the Agent Channel', async () => {
  const { event, threadId } = await claimedMessageEvent('conservative');
  const content = `s1 channel ok ${randomUUID()}`;
  const before = await dailyCount('conservative');
  const res = await channelReply('conservative', event, content);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.user_id, employees.conservative.userId);
  assert.equal(rows[0]!.parent_id, threadId);
  assert.equal(await dailyCount('conservative'), before + 1, 'S1-a: the reply consumed one daily action slot');
});

// ─── S1-a: Agent Channel reply guard rails ────────────────────────────────

for (const trust of TRUSTS) {
  test(`S1-a: an unhealthy ${trust} employee's Agent Channel reply is refused with EMPLOYEE_UNHEALTHY`, async () => {
    const { event } = await claimedMessageEvent(trust);
    const content = `s1 channel unhealthy ${trust} ${randomUUID()}`;
    const before = await dailyCount(trust);
    const res = await withEmployee(trust, UNHEALTHY, HEALTHY, () => channelReply(trust, event, content));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'EMPLOYEE_UNHEALTHY');
    assert.equal(typeof res.body.error, 'string');
    assert.equal((await messagesWithContent(content)).length, 0, 'nothing was posted');
    assert.equal(await dailyCount(trust), before, 'a refused reply does not consume a slot');
    const attempts = await db.select().from(agentChannelDeliveryAttempts)
      .where(eq(agentChannelDeliveryAttempts.event_id, event.id));
    assert.equal(attempts.length, 0, 'no delivery attempt was recorded');
  });
}

test('S1-a: the reply-storm detector refuses an Agent Channel thread reply with STORM_DETECTED', async () => {
  const { event, threadId } = await claimedMessageEvent('autonomous');
  await seedStorm('autonomous', publicSpaceId, threadId!);
  const content = `s1 channel storm ${randomUUID()}`;
  const res = await channelReply('autonomous', event, content);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'STORM_DETECTED');
  assert.match(res.body.error, /exceeded 5 replies/);
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('S1-a: an Agent Channel top-level reply is not storm-limited', async () => {
  const { event, threadId } = await claimedMessageEvent('autonomous');
  await seedStorm('autonomous', publicSpaceId, threadId!);
  const content = `s1 channel top-level ${randomUUID()}`;
  const res = await channelReply('autonomous', event, content, { thread_id: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.parent_id, null);
});

test('S1-a: at the daily action cap an Agent Channel reply is refused with the cap error', async () => {
  const { event } = await claimedMessageEvent('standard');
  const content = `s1 channel cap ${randomUUID()}`;
  const count = await dailyCount('standard');
  const res = await withEmployee('standard', { max_daily_actions: count }, { max_daily_actions: 500 }, () => channelReply('standard', event, content));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'DAILY_ACTION_LIMIT');
  assert.match(res.body.error, /Daily action limit reached/);
  assert.equal((await messagesWithContent(content)).length, 0);
  assert.equal(await dailyCount('standard'), count);
});

test('S1-a: an Agent Channel reply into a private space the employee has left is refused and nothing is written', async () => {
  const { event } = await claimedMessageEvent('autonomous', { spaceId: privateMemberSpaceId });
  await db.delete(spaceMembers).where(and(
    eq(spaceMembers.space_id, privateMemberSpaceId),
    eq(spaceMembers.user_id, employees.autonomous.userId),
  ));
  try {
    const content = `s1 channel left space ${randomUUID()}`;
    const res = await channelReply('autonomous', event, content);
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.equal((await messagesWithContent(content)).length, 0);
  } finally {
    await db.insert(spaceMembers).values({ space_id: privateMemberSpaceId, user_id: employees.autonomous.userId });
  }
});

test('S1-a: an Agent Channel reply cannot attach itself to a thread in a space it cannot see', async () => {
  const { event } = await claimedMessageEvent('autonomous');
  const [hiddenRoot] = await db.insert(messages).values({
    org_id: orgId, space_id: hiddenSpaceId, user_id: ownerId, content: `s1 hidden root ${randomUUID()}`,
  }).returning();
  const content = `s1 channel cross-space thread ${randomUUID()}`;
  const res = await channelReply('autonomous', event, content, { thread_id: hiddenRoot!.id });
  assert.ok(res.status >= 400, JSON.stringify(res.body));
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('S1-a: a deactivated or deleted employee cannot reply through the Agent Channel', async () => {
  const { event } = await claimedMessageEvent('standard');
  const content = `s1 channel inactive ${randomUUID()}`;
  const paused = await withEmployee('standard', { is_active: false }, { is_active: true }, () => channelReply('standard', event, content));
  assert.equal(paused.status, 403, JSON.stringify(paused.body));
  const deleted = await withEmployee('standard', { is_deleted: true }, { is_deleted: false }, () => channelReply('standard', event, content));
  assert.equal(deleted.status, 403, JSON.stringify(deleted.body));
  assert.equal((await messagesWithContent(content)).length, 0);
});

// ─── S1-b: unhealthy Autonomous employee over MCP ─────────────────────────

test('S1-b: an unhealthy Autonomous employee falls back to the approval queue on every MCP message path', async () => {
  const [root] = await db.insert(messages).values({
    org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `s1 b root ${randomUUID()}`,
  }).returning();
  await withEmployee('autonomous', UNHEALTHY, HEALTHY, async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['send_message', { target: { space_id: publicSpaceId } }],
      ['send_message', { target: { thread_id: root!.id } }],
      ['send_message', { target: { user_id: peerId } }],
      ['message_post', { space_id: publicSpaceId }],
      ['message_post', { space_id: publicSpaceId, parent_id: root!.id }],
    ];
    for (const [tool, args] of cases) {
      const content = `s1 b ${tool} ${JSON.stringify(args)} ${randomUUID()}`;
      const res = await mcpCall('autonomous', tool, { ...args, content });
      assert.equal(res.parsed?.status, 'queued_for_approval', `${tool} ${JSON.stringify(args)}: ${res.text}`);
      assert.equal((await messagesWithContent(content)).length, 0, `${tool} must not post`);
      assert.equal((await pendingWithContent(employees.autonomous.id, content)).length, 1, `${tool} queued once`);
    }
  });
});

test('S1-b: a healthy Autonomous employee still posts on every MCP message path', async () => {
  const [root] = await db.insert(messages).values({
    org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `s1 b healthy root ${randomUUID()}`,
  }).returning();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['send_message', { target: { space_id: publicSpaceId } }],
    ['send_message', { target: { thread_id: root!.id } }],
    ['send_message', { target: { user_id: peerId } }],
    ['message_post', { space_id: publicSpaceId }],
    ['message_post', { space_id: publicSpaceId, parent_id: root!.id }],
  ];
  for (const [tool, args] of cases) {
    const content = `s1 b healthy ${tool} ${randomUUID()}`;
    const res = await mcpCall('autonomous', tool, { ...args, content });
    assert.notEqual(res.body.isError, true, res.text);
    assert.equal((await messagesWithContent(content)).length, 1, `${tool} posts`);
  }
});

test('S1-b: the reply-storm detector applies to Autonomous MCP thread replies', async () => {
  const [root] = await db.insert(messages).values({
    org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `s1 b storm root ${randomUUID()}`,
  }).returning();
  await seedStorm('autonomous', publicSpaceId, root!.id);
  const content = `s1 b storm ${randomUUID()}`;
  const viaSend = await mcpCall('autonomous', 'send_message', { target: { thread_id: root!.id }, content });
  assert.match(viaSend.text, /^STORM_DETECTED: /);
  const viaPost = await mcpCall('autonomous', 'message_post', { space_id: publicSpaceId, parent_id: root!.id, content });
  assert.match(viaPost.text, /^STORM_DETECTED: /);
  assert.equal((await messagesWithContent(content)).length, 0);
});

// ─── S1-c: legacy /mcp/call deft_post_message ─────────────────────────────

for (const trust of TRUSTS) {
  test(`S1-c: a healthy ${trust} employee's legacy deft_post_message posts like MCP v1`, async () => {
    const content = `s1 c ${trust} ${randomUUID()}`;
    const before = await dailyCount(trust);
    const res = await legacyCall(trust, { space_name: `s1-general-${run}`, content });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ok', JSON.stringify(res.body));
    const rows = await messagesWithContent(content);
    assert.equal(rows.length, 1, JSON.stringify(res.body));
    assert.equal(rows[0]!.user_id, employees[trust].userId);
    assert.equal(rows[0]!.space_id, publicSpaceId);
    assert.equal((await pendingWithContent(employees[trust].id, content)).length, 0);
    assert.equal(await dailyCount(trust), before + 1, 'one daily action slot');
  });
}

test('S1-c: legacy deft_post_message cannot post into a private space the employee has not joined', async () => {
  for (const params of [{ space_id: hiddenSpaceId }, { space_name: `s1-hidden-${run}` }]) {
    const content = `s1 c hidden ${randomUUID()}`;
    const res = await legacyCall('autonomous', { ...params, content });
    assert.notEqual(res.body.status, 'pending_approval', JSON.stringify(res.body));
    assert.equal(res.body.result?.success, false, JSON.stringify(res.body));
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(hiddenSpaceId), 'the private space id is not revealed');
    assert.equal((await messagesWithContent(content)).length, 0);
    assert.equal((await pendingWithContent(employees.autonomous.id, content)).length, 0);
  }
});

test('S1-c: an unhealthy Autonomous employee\'s legacy deft_post_message queues for approval', async () => {
  const content = `s1 c unhealthy ${randomUUID()}`;
  const res = await withEmployee('autonomous', UNHEALTHY, HEALTHY, () => legacyCall('autonomous', { space_id: publicSpaceId, content }));
  assert.equal(res.body.status, 'pending_approval', JSON.stringify(res.body));
  assert.ok(res.body.action_id);
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('S1-c: at the daily action cap legacy deft_post_message is refused', async () => {
  const content = `s1 c cap ${randomUUID()}`;
  const count = await dailyCount('conservative');
  const res = await withEmployee('conservative', { max_daily_actions: count }, { max_daily_actions: 500 },
    () => legacyCall('conservative', { space_id: publicSpaceId, content }));
  assert.equal(res.body.result?.success, false, JSON.stringify(res.body));
  assert.match(res.body.result?.error ?? '', /Daily action limit reached/);
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('S1-c: a deactivated employee cannot use legacy deft_post_message', async () => {
  const content = `s1 c inactive ${randomUUID()}`;
  const res = await withEmployee('conservative', { is_active: false }, { is_active: true },
    () => legacyCall('conservative', { space_id: publicSpaceId, content }));
  assert.equal(res.status, 403);
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('S1-c: a different public space by name still resolves on the legacy path', async () => {
  const content = `s1 c other ${randomUUID()}`;
  const res = await legacyCall('standard', { space_name: `s1-other-${run}`, content });
  assert.equal(res.body.status, 'ok', JSON.stringify(res.body));
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.space_id, otherPublicSpaceId);
});
