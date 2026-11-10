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
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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

// ─── Round 2 (review of PR #443): one effective target, claim-then-charge ──
//
// S1-R2-a: the storm guard checks the target the reply will actually post to
//          (a reclaimed autonomous attempt posts to its STORED thread).
// S1-R2-b: losing claimants and replays never consume a daily action slot;
//          a refused charge leaves no dangling claim.
// S1-R2-c: legacy space-name resolution only considers accessible spaces.
// S1-R2-d: an invalid reply thread is a structured 4xx at the HTTP boundary,
//          before any slot is charged or attempt claimed.

const otherOrgId = `s1-org2-${run}`;
const otherOwnerId = `s1-owner2-${run}`;
const otherOrgSpaceId = `s1-org2-space-${run}`;

before(async () => {
  await db.insert(orgs).values({ id: otherOrgId, name: 'S1 other org', slug: `s1-other-${run}` });
  await db.insert(users).values({ id: otherOwnerId, email: `s1-owner2-${run}@test.local`, name: 'S1 Owner2', kind: 'human', email_verified: true });
  await db.insert(orgMembers).values({ org_id: otherOrgId, user_id: otherOwnerId, role: 'owner' });
  await db.insert(spaces).values({ id: otherOrgSpaceId, org_id: otherOrgId, name: `s1-org2-${run}`, type: 'public', created_by: otherOwnerId });
});

after(async () => {
  try {
    await db.delete(messages).where(eq(messages.org_id, otherOrgId));
    await db.delete(spaces).where(eq(spaces.org_id, otherOrgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, otherOrgId));
    await db.delete(users).where(eq(users.id, otherOwnerId));
    await db.delete(orgs).where(eq(orgs.id, otherOrgId));
  } catch (err) {
    console.error('[S1-R2] cleanup error', err);
  }
});

function autonomousCompatibilityQuery(workerId: string) {
  return new URLSearchParams({
    protocol_version: 'deft.agent_channel.v2',
    adapter_version: '0.2.0-test',
    capabilities: 'autonomous_platform_adapter_v1,accepted_event_rehydration_v1',
    worker_id: workerId,
  }).toString();
}

/** Publish a message event and take it through the real autonomous
 * connect, poll, accept flow so autonomous replies are permitted. */
async function acceptedAutonomousEvent(trust: Trust) {
  const workerId = `s1-auto-${randomUUID()}`;
  const connect = await app.request(`/api/agent-channel/v1/connect?${autonomousCompatibilityQuery(workerId)}`, {
    headers: { authorization: `Bearer ${employees[trust].channelBearer}` },
  });
  assert.equal(connect.status, 200, await connect.text());
  const [source] = await db.insert(messages).values({
    org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `s1 r2 auto source ${randomUUID()}`,
  }).returning();
  const { event } = await publishAgentChannelEvent({
    orgId,
    employeeId: employees[trust].id,
    kind: 'message.created',
    sourceKind: 'message',
    sourceId: source!.id,
    spaceId: publicSpaceId,
    threadId: source!.id,
    actorUserId: ownerId,
    idempotencyKey: `s1-r2-auto-${randomUUID()}`,
    payload: { message_id: source!.id, content: source!.content, reply_thread_id: source!.id },
  });
  const poll = await app.request(
    `/api/agent-channel/v1/events?limit=100&lease_ms=120000&${autonomousCompatibilityQuery(workerId)}`,
    { headers: { authorization: `Bearer ${employees[trust].channelBearer}` } },
  );
  const delivery = await poll.json() as any;
  assert.equal(poll.status, 200, JSON.stringify(delivery));
  const claimed = delivery.events.find((candidate: any) => candidate.id === event!.id);
  assert.ok(claimed?.claim_token, 'autonomous claim');
  const accept = await app.request('/api/agent-channel/v1/accept', {
    method: 'POST',
    headers: { authorization: `Bearer ${employees[trust].channelBearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: event!.id, claim_token: claimed.claim_token }),
  });
  assert.equal(accept.status, 200, await accept.text());
  return { event: event!, threadId: source!.id };
}

async function insertFailedAutonomousAttempt(trust: Trust, eventId: string, key: string, content: string, threadId: string | null) {
  const effectId = `agent-channel-autonomous-reply:${createHash('sha256')
    .update([orgId, employees[trust].id, eventId, key].join('\0'))
    .digest('hex')}`;
  const [row] = await db.insert(agentChannelDeliveryAttempts).values({
    org_id: orgId,
    agent_employee_id: employees[trust].id,
    event_id: eventId,
    direction: 'inbound_reply',
    idempotency_key: key,
    status: 'failed',
    request_json: {
      event_id: eventId,
      content,
      thread_id: threadId,
      outcome: null,
      adapter_mode: 'autonomous_platform',
      reply_target: 'chat_message',
      summary: null,
      runtime_session_key: null,
      runtime_request_key: null,
      runtime_response_id: null,
      durable_effect_id: effectId,
    },
    response_json: { error: 'simulated transport failure' },
    error: 'simulated transport failure',
  }).returning();
  return row!;
}

async function autonomousReply(trust: Trust, eventId: string, key: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await app.request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${employees[trust].channelBearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: eventId, content, idempotency_key: key, adapter_mode: 'autonomous_platform', ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function attemptsFor(eventId: string) {
  return db.select().from(agentChannelDeliveryAttempts).where(eq(agentChannelDeliveryAttempts.event_id, eventId));
}

/** The bundled bridge retries 429 and every 5xx (scripts/hermes-agent-channel-bridge.mjs `request`). */
function bridgeRetries(status: number) {
  return status === 429 || status >= 500;
}

test('S1-R2-a: a reclaimed autonomous reply is storm-checked on its stored thread, not the incoming thread_id', async () => {
  const { event, threadId } = await acceptedAutonomousEvent('standard');
  const key = `s1-r2a-${randomUUID()}`;
  const content = `s1 r2a stored thread ${randomUUID()}`;
  await insertFailedAutonomousAttempt('standard', event.id, key, content, threadId);
  await seedStorm('standard', publicSpaceId, threadId);
  const before = await dailyCount('standard');
  const res = await autonomousReply('standard', event.id, key, content, { thread_id: null });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'STORM_DETECTED');
  assert.equal((await messagesWithContent(content)).length, 0, 'nothing posted into the stormed stored thread');
  assert.equal(await dailyCount('standard'), before, 'a refused reclaim consumes no slot');
  const [attempt] = await attemptsFor(event.id);
  assert.equal(attempt!.status, 'failed', 'the stored attempt was not reclaimed');
});

test('S1-R2-a: a reclaimed top-level autonomous reply is not refused because of an unrelated incoming thread_id', async () => {
  const { event } = await acceptedAutonomousEvent('standard');
  const key = `s1-r2a-inverse-${randomUUID()}`;
  const content = `s1 r2a stored top-level ${randomUUID()}`;
  await insertFailedAutonomousAttempt('standard', event.id, key, content, null);
  const [stormRoot] = await db.insert(messages).values({
    org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `s1 r2a unrelated root ${randomUUID()}`,
  }).returning();
  await seedStorm('standard', publicSpaceId, stormRoot!.id);
  const before = await dailyCount('standard');
  const res = await autonomousReply('standard', event.id, key, content, { thread_id: stormRoot!.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.parent_id, null, 'executed against the stored top-level target');
  assert.equal(await dailyCount('standard'), before + 1);
});

test('S1-R2-b: two concurrent replies with the same idempotency key consume exactly one slot', async () => {
  const { event } = await claimedMessageEvent('conservative');
  const key = `s1-r2b-${randomUUID()}`;
  const content = `s1 r2b concurrent ${randomUUID()}`;
  const before = await dailyCount('conservative');
  const results = await Promise.all(Array.from({ length: 4 }, () => (
    channelReply('conservative', event, content, { idempotency_key: key })
  )));
  assert.equal((await messagesWithContent(content)).length, 1, 'one post');
  assert.equal(await dailyCount('conservative'), before + 1, `exactly one slot: ${JSON.stringify(results)}`);
  assert.ok(results.some((r) => r.status === 200 && r.body.idempotent !== true), JSON.stringify(results));
  for (const r of results) {
    assert.ok(r.status === 200 || (r.status === 409 && r.body.code === 'IDEMPOTENCY_IN_PROGRESS'), JSON.stringify(r));
  }
});

test('S1-R2-b: with one slot remaining, the duplicate gets the idempotency response, never DAILY_ACTION_LIMIT', async () => {
  const { event } = await claimedMessageEvent('conservative');
  const key = `s1-r2b-last-${randomUUID()}`;
  const content = `s1 r2b last slot ${randomUUID()}`;
  const count = await dailyCount('conservative');
  const results = await withEmployee('conservative', { max_daily_actions: count + 1 }, { max_daily_actions: 500 }, () => Promise.all([
    channelReply('conservative', event, content, { idempotency_key: key }),
    channelReply('conservative', event, content, { idempotency_key: key }),
  ]));
  for (const r of results) assert.notEqual(r.body.code, 'DAILY_ACTION_LIMIT', JSON.stringify(results));
  assert.equal((await messagesWithContent(content)).length, 1, JSON.stringify(results));
  assert.equal(await dailyCount('conservative'), count + 1);
});

test('S1-R2-b: a replay of a completed reply consumes no slot', async () => {
  const { event } = await claimedMessageEvent('conservative');
  const key = `s1-r2b-replay-${randomUUID()}`;
  const content = `s1 r2b replay ${randomUUID()}`;
  const first = await channelReply('conservative', event, content, { idempotency_key: key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const afterFirst = await dailyCount('conservative');
  const replay = await channelReply('conservative', event, content, { idempotency_key: key });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.idempotent, true);
  assert.equal(await dailyCount('conservative'), afterFirst, 'replay is free');
  assert.equal((await messagesWithContent(content)).length, 1);
});

test('S1-R2-b: a reply refused at the cap leaves no claim; the same key posts once the cap is raised', async () => {
  const { event } = await claimedMessageEvent('conservative');
  const key = `s1-r2b-cap-${randomUUID()}`;
  const content = `s1 r2b cap ${randomUUID()}`;
  const count = await dailyCount('conservative');
  const refused = await withEmployee('conservative', { max_daily_actions: count }, { max_daily_actions: 500 },
    () => channelReply('conservative', event, content, { idempotency_key: key }));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'DAILY_ACTION_LIMIT');
  assert.equal((await attemptsFor(event.id)).length, 0, 'no dangling claim');
  const retried = await channelReply('conservative', event, content, { idempotency_key: key });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal((await messagesWithContent(content)).length, 1);
});

test('S1-R2-b: an autonomous reclaim refused at the cap restores the failed attempt', async () => {
  const { event, threadId } = await acceptedAutonomousEvent('standard');
  const key = `s1-r2b-reclaim-cap-${randomUUID()}`;
  const content = `s1 r2b reclaim cap ${randomUUID()}`;
  const stored = await insertFailedAutonomousAttempt('standard', event.id, key, content, threadId);
  const count = await dailyCount('standard');
  const refused = await withEmployee('standard', { max_daily_actions: count }, { max_daily_actions: 500 },
    () => autonomousReply('standard', event.id, key, content));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'DAILY_ACTION_LIMIT');
  const [attempt] = await attemptsFor(event.id);
  assert.equal(attempt!.status, 'failed');
  assert.deepEqual(attempt!.request_json, stored.request_json, 'the stored request is unchanged');
  const retried = await autonomousReply('standard', event.id, key, content);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.parent_id, threadId);
});

test('S1-R2-c: a space name unique among accessible spaces resolves even when an inaccessible private space also matches', async () => {
  const stem = `s1r2c-shared-${run}`;
  const pub = `s1-r2c-pub-${run}`;
  const priv = `s1-r2c-priv-${run}`;
  await db.insert(spaces).values([
    { id: pub, org_id: orgId, name: `${stem}-pub`, type: 'public', created_by: ownerId },
    { id: priv, org_id: orgId, name: `${stem}-priv`, type: 'private', created_by: ownerId },
  ]);
  await db.insert(spaceMembers).values([
    { space_id: pub, user_id: ownerId },
    { space_id: priv, user_id: ownerId },
  ]);
  const content = `s1 r2c shared ${randomUUID()}`;
  const res = await legacyCall('standard', { space_name: stem, content });
  assert.equal(res.body.status, 'ok', JSON.stringify(res.body));
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.space_id, pub);
});

test('S1-R2-c: a name matching only inaccessible private spaces is indistinguishable from a nonexistent one', async () => {
  const stem = `s1r2c-solo-${run}`;
  await db.insert(spaces).values([
    { id: `s1-r2c-solo1-${run}`, org_id: orgId, name: `${stem}-one`, type: 'private', created_by: ownerId },
    { id: `s1-r2c-solo2-${run}`, org_id: orgId, name: `${stem}-two`, type: 'private', created_by: ownerId },
  ]);
  const content = `s1 r2c solo ${randomUUID()}`;
  const before = await dailyCount('standard');
  const hidden = await legacyCall('standard', { space_name: stem, content });
  const missing = await legacyCall('standard', { space_name: `s1r2c-nothing-${run}`, content });
  assert.equal(hidden.status, missing.status);
  assert.deepEqual(hidden.body, missing.body, 'same response for inaccessible and nonexistent');
  assert.doesNotMatch(JSON.stringify(hidden.body), /More than one/);
  assert.equal(await dailyCount('standard'), before, 'an unresolvable target consumes no slot');
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('S1-R2-d: a foreign-space, foreign-org or nonexistent reply thread is a structured 4xx that charges and claims nothing', async () => {
  const [foreignSpaceRoot] = await db.insert(messages).values({
    org_id: orgId, space_id: otherPublicSpaceId, user_id: ownerId, content: `s1 r2d other space root ${randomUUID()}`,
  }).returning();
  const [foreignOrgRoot] = await db.insert(messages).values({
    org_id: otherOrgId, space_id: otherOrgSpaceId, user_id: otherOwnerId, content: `s1 r2d other org root ${randomUUID()}`,
  }).returning();
  const cases: Array<[string, string]> = [
    ['foreign space', foreignSpaceRoot!.id],
    ['foreign org', foreignOrgRoot!.id],
    ['nonexistent', `s1-r2d-missing-${randomUUID()}`],
  ];
  for (const [label, threadId] of cases) {
    const { event } = await claimedMessageEvent('autonomous');
    const content = `s1 r2d ${label} ${randomUUID()}`;
    const before = await dailyCount('autonomous');
    const res = await channelReply('autonomous', event, content, { thread_id: threadId });
    assert.ok(res.status >= 400 && res.status < 500, `${label}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(bridgeRetries(res.status), false, `${label}: the bridge must not retry`);
    assert.equal(typeof res.body.error, 'string', `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(typeof res.body.code, 'string', `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(await dailyCount('autonomous'), before, `${label}: no slot consumed`);
    assert.equal((await attemptsFor(event.id)).length, 0, `${label}: no attempt claimed`);
    assert.equal((await messagesWithContent(content)).length, 0);
  }
});

// ─── Round 3 (second review of 1ce237a2) ───────────────────────────────────
//
// S1-R3-1: reclaimability is decided once per request (one clock reading), so
//          a lease that expires mid-request cannot skip the guard and then
//          reclaim anyway.
// S1-R3-2: one attempt is charged at most one daily action slot, even when a
//          later generation reclaims it.
// S1-R3-4: an MCP send_message thread target the employee cannot access is
//          indistinguishable from a nonexistent one.

const LEASE_MS = 120_000;

async function insertStartedAutonomousAttempt(trust: Trust, eventId: string, key: string, content: string, threadId: string | null, opts: { updatedAt: Date; generation: string; charged?: boolean }) {
  const effectId = `agent-channel-autonomous-reply:${createHash('sha256')
    .update([orgId, employees[trust].id, eventId, key].join('\0'))
    .digest('hex')}`;
  const [row] = await db.insert(agentChannelDeliveryAttempts).values({
    org_id: orgId,
    agent_employee_id: employees[trust].id,
    event_id: eventId,
    direction: 'inbound_reply',
    idempotency_key: key,
    status: 'started',
    request_json: {
      event_id: eventId,
      content,
      thread_id: threadId,
      outcome: null,
      adapter_mode: 'autonomous_platform',
      reply_target: 'chat_message',
      summary: null,
      runtime_session_key: null,
      runtime_request_key: null,
      runtime_response_id: null,
      durable_effect_id: effectId,
      attempt_generation: opts.generation,
      ...(opts.charged ? { daily_action_charged: true } : {}),
    },
    updated_at: opts.updatedAt,
  }).returning();
  return row!;
}

test('S1-R3-1: a lease that expires mid-request cannot skip the storm guard and still reclaim', async () => {
  const { event, threadId } = await acceptedAutonomousEvent('standard');
  const key = `s1-r3-1-${randomUUID()}`;
  const content = `s1 r3-1 lease race ${randomUUID()}`;
  const base = Date.now();
  // Not expired at `base`; expired once the clock jumps by two leases.
  await insertStartedAutonomousAttempt('standard', event.id, key, content, threadId, {
    updatedAt: new Date(base - LEASE_MS + 30_000),
    generation: `gen-${randomUUID()}`,
  });
  await seedStorm('standard', publicSpaceId, threadId);
  const before = await dailyCount('standard');
  // The clock reads `base` until the reclaimability predicate has read it
  // three times (pre-reconcile check, guard eligibility, effective target),
  // then jumps past the lease. Code that re-reads the clock for each decision
  // skips the guard but still reclaims; code that decides once does not.
  let predicateReads = 0;
  let jumped = false;
  const clock = mock.method(Date, 'now', () => {
    if (!jumped && /attemptCanReconcile/.test(new Error().stack ?? '')) {
      predicateReads += 1;
      if (predicateReads > 3) jumped = true;
    }
    return jumped ? base + 2 * LEASE_MS : base;
  });
  let res;
  try {
    res = await autonomousReply('standard', event.id, key, content);
  } finally {
    clock.mock.restore();
  }
  assert.equal((await messagesWithContent(content)).length, 0, `nothing posted into the stormed thread: ${JSON.stringify(res)}`);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(await dailyCount('standard'), before, 'no slot consumed');
});

test('S1-R3-2: reclaiming an attempt whose earlier generation was charged does not charge again', async () => {
  const { event, threadId } = await acceptedAutonomousEvent('standard');
  const key = `s1-r3-2-${randomUUID()}`;
  const content = `s1 r3-2 charged once ${randomUUID()}`;
  await insertStartedAutonomousAttempt('standard', event.id, key, content, threadId, {
    updatedAt: new Date(Date.now() - 2 * LEASE_MS),
    generation: `gen-n-${randomUUID()}`,
    charged: true,
  });
  const before = await dailyCount('standard');
  const res = await autonomousReply('standard', event.id, key, content);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await messagesWithContent(content)).length, 1);
  assert.equal(await dailyCount('standard'), before, 'generation N+1 is not charged a second slot');
});

test('S1-R3-2: a charged reply attempt records that its slot was charged', async () => {
  const { event } = await claimedMessageEvent('conservative');
  const key = `s1-r3-2-mark-${randomUUID()}`;
  const content = `s1 r3-2 marker ${randomUUID()}`;
  const before = await dailyCount('conservative');
  const res = await channelReply('conservative', event, content, { idempotency_key: key });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await dailyCount('conservative'), before + 1);
  const [attempt] = await attemptsFor(event.id);
  assert.equal((attempt!.request_json as Record<string, unknown>).daily_action_charged, true);
});

test('S1-R3-4: send_message to an inaccessible thread is indistinguishable from a nonexistent thread', async () => {
  const [hiddenRoot] = await db.insert(messages).values({
    org_id: orgId, space_id: hiddenSpaceId, user_id: ownerId, content: `s1 r3-4 hidden root ${randomUUID()}`,
  }).returning();
  const content = `s1 r3-4 ${randomUUID()}`;
  const hidden = await mcpCall('standard', 'send_message', { target: { thread_id: hiddenRoot!.id }, content });
  const missing = await mcpCall('standard', 'send_message', { target: { thread_id: `s1-r3-4-missing-${randomUUID()}` }, content });
  assert.equal(hidden.body.isError, true, hidden.text);
  assert.equal(hidden.text, missing.text, 'same error for inaccessible and nonexistent threads');
  assert.doesNotMatch(hidden.text, new RegExp(hiddenSpaceId));
  assert.equal((await messagesWithContent(content)).length, 0);
});
