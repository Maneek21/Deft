/**
 * Plain-text `@token` mentions resolve to an agent only on an exact, unique
 * handle (the employee slug) or one-token display name, case-insensitively.
 * A first word, a prefix, a multi-word name typed with spaces, or a token with
 * more than one owner (two agents, or an agent and a one-token human name)
 * resolves to nobody and stays plain text. Explicit mentions and legacy
 * `@deft` are unchanged.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentEmployees, jobQueue, messages, notifications, orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { setOrgAPIKey } from '../src/lib/org-ai-config.js';
import { humanSendMessage, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { normalizePlainAgentMentions } from '../src/lib/agent-mention-normalization.js';

const orgId = randomUUID();
const ownerId = randomUUID();
const spaceId = randomUUID();
const sfx = orgId.slice(0, 8);
const rcRunner = randomUUID();
const rita = randomUUID();
const patA = randomUUID();
const patB = randomUUID();
const twinA = randomUUID();
const twinB = randomUUID();
const samAgent = randomUUID();
const samHuman = randomUUID();
const rcMember = randomUUID();
const nova = randomUUID();
const clash = randomUUID();
const inactiveRita = randomUUID();
const foreignOrgId = randomUUID();
const foreignRita = randomUUID();
const agentUserIds = [rcRunner, rita, patA, patB, twinA, twinB, samAgent, nova, clash];
const humanIds = [ownerId, samHuman, rcMember, inactiveRita];
let deftyUserId = '';
let deftyExistedBefore = false;
let app: Hono;

const ctx = (): HumanToolContext => ({
  org_id: orgId, user_id: ownerId, role: 'owner', principal_kind: 'human',
  scopes: ['read:workspace', 'read:messages', 'write:messages'],
});

async function human(id: string, name: string, role: 'owner' | 'member') {
  await db.insert(users).values({ id, name, email: `h-${id}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: id, role });
}

async function agent(userId: string, name: string, slug: string) {
  await db.insert(users).values({ id: userId, name, email: `${userId}@agents.test.local`, kind: 'agent', is_agent: true, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'member' });
  await db.insert(agentEmployees).values({
    org_id: orgId, user_id: userId, name, slug, role: 'custom', system_prompt: 'Test.', expertise_description: 'Test.',
    starter_prompts: [], disabled_tools: [], space_ids: [], project_ids: [], trust_level: 'conservative', is_active: true,
    is_byoa: true, runtime_kind: 'custom_mcp', wake_mode: 'manual', certification_status: 'token_issued', created_by: ownerId,
  });
}

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'Exact mentions', slug: `exact-mentions-${orgId}` });
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-exact-test-not-real');
  await human(ownerId, 'RC Owner', 'owner');
  await human(rcMember, 'RC Member', 'member');
  await human(samHuman, 'Sam', 'member');
  await human(inactiveRita, 'Rita', 'member');
  await db.update(orgMembers).set({ is_active: false }).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, inactiveRita)));
  await db.insert(orgs).values({ id: foreignOrgId, name: 'Foreign', slug: `foreign-${foreignOrgId}` });
  await db.insert(users).values({ id: foreignRita, name: 'Rita', email: `h-${foreignRita}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: foreignOrgId, user_id: foreignRita, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
  await agent(rcRunner, 'RC Runner', `rc-runner-${sfx}`);
  await agent(rita, 'Rita', `research-${sfx}`);
  await agent(patA, 'Pat Alpha', `pat-alpha-${sfx}`);
  await agent(patB, 'Pat Beta', `pat-beta-${sfx}`);
  await agent(twinA, 'Twin', `twin-a-${sfx}`);
  await agent(twinB, 'Twin', `twin-b-${sfx}`);
  await agent(samAgent, 'Sam', `sam-bot-${sfx}`);
  await agent(nova, `nova-${sfx}`, `nova-${sfx}`);
  await agent(clash, `pat-alpha-${sfx}`, `clash-${sfx}`);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'exact-room', type: 'public', created_by: ownerId });
  await db.insert(spaceMembers).values([...humanIds, deftyUserId, ...agentUserIds].map((user_id) => ({ space_id: spaceId, user_id })));
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: ownerId, org_id: orgId, email: `h-${ownerId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
});

after(async () => {
  try {
    await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.execute(sql`DELETE FROM oauth_audit_events WHERE org_id = ${orgId}`).catch(() => undefined);
    await db.execute(sql`DELETE FROM agent_actions WHERE org_id = ${orgId}`).catch(() => undefined);
    await db.delete(messages).where(eq(messages.space_id, spaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(agentEmployees).where(eq(agentEmployees.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, foreignOrgId));
    await db.delete(users).where(inArray(users.id, [...humanIds, ...agentUserIds, foreignRita]));
    await db.delete(orgs).where(inArray(orgs.id, [orgId, foreignOrgId]));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('exact mention cleanup error:', err);
  }
});

async function webPost(content: string) {
  const response = await app.request(`/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
  });
  return { status: response.status, body: await response.json() as { id?: string; code?: string; content?: string } };
}

/** Agent user ids that an `agent-employee-message` job was queued for. */
async function wokenAgents(messageId: string): Promise<string[]> {
  const rows = await db.select({ user_id: agentEmployees.user_id })
    .from(jobQueue)
    .innerJoin(agentEmployees, sql`${agentEmployees.id}::text = ${jobQueue.data}->>'employeeId'`)
    .where(and(eq(jobQueue.org_id, orgId), eq(jobQueue.name, 'agent-employee-message'), sql`${jobQueue.data}->>'messageId' = ${messageId}`));
  return rows.map((row) => row.user_id).sort();
}

async function deftyJobs(messageId: string) {
  return db.select({ id: jobQueue.id }).from(jobQueue).where(and(
    eq(jobQueue.org_id, orgId), eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${messageId}`));
}

async function expectPlain(content: string) {
  const res = await webPost(content);
  assert.equal(res.status, 201, `${content}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.content, content, `${content} stays plain text`);
  assert.deepEqual(await wokenAgents(res.body.id!), [], `${content} wakes no agent`);
}

async function expectResolved(content: string, agentUserId: string, name: string) {
  const res = await webPost(content);
  assert.equal(res.status, 201, `${content}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.content!, new RegExp(`<@${agentUserId}\\|${name}>`), `${content} becomes a structured mention`);
  assert.deepEqual(await wokenAgents(res.body.id!), [agentUserId], `${content} wakes exactly that agent`);
}

test('the first word of a multi-word agent name stays plain text and wakes nobody', async () => {
  await expectPlain(`@RC please run the checks ${randomUUID()}`);
  await expectPlain(`@rc please run the checks ${randomUUID()}`);
});

test('a multi-word agent name typed with spaces is not a handle', async () => {
  await expectPlain(`@RC Runner please run the checks ${randomUUID()}`);
});

test('an exact handle (slug) resolves, case-insensitively', async () => {
  await expectResolved(`@rc-runner-${sfx} please run the checks ${randomUUID()}`, rcRunner, 'RC Runner');
  await expectResolved(`@RC-RUNNER-${sfx.toUpperCase()} please ${randomUUID()}`, rcRunner, 'RC Runner');
});

test('an exact one-token display name resolves, case-insensitively', async () => {
  await expectResolved(`@Rita review this ${randomUUID()}`, rita, 'Rita');
  await expectResolved(`@RITA review this ${randomUUID()}`, rita, 'Rita');
  await expectPlain(`@Rit review this ${randomUUID()}`);
});

test('a token shared by two participants resolves to nobody and the post is accepted', async () => {
  await expectPlain(`@pat take this ${randomUUID()}`);
  await expectPlain(`@twin take this ${randomUUID()}`);
  await expectPlain(`@sam take this ${randomUUID()}`);
  // One agent's name equal to another agent's slug.
  await expectPlain(`@pat-alpha-${sfx} take this ${randomUUID()}`);
});

test('a lone non-canonical <@handle> still resolves through the chat path', async () => {
  const res = await webPost(`<@rc-runner-${sfx}>`);
  assert.equal(res.status, 201);
  assert.deepEqual(await wokenAgents(res.body.id!), [rcRunner]);
});

test('only active humans of the same org compete; an agent whose name is its own slug is one owner', async () => {
  // "Rita" is also an inactive member here and a human in another org.
  await expectResolved(`@rita take this ${randomUUID()}`, rita, 'Rita');
  await expectResolved(`@nova-${sfx} take this ${randomUUID()}`, nova, `nova-${sfx}`);
});

test('explicit markers are never rewritten and still dispatch beside unresolved plain tokens', async () => {
  const res = await webPost(`<@${rcRunner}|RC Runner> and @twin ${randomUUID()}`);
  assert.equal(res.status, 201);
  assert.ok(res.body.content!.startsWith(`<@${rcRunner}|RC Runner> and @twin `), res.body.content);
  assert.deepEqual(await wokenAgents(res.body.id!), [rcRunner]);

  const agents = [{ userId: 'rita-user', name: 'Rita', slug: 'rita' }];
  const marker = '<@old-user|@Rita> and <span data-mention-uuid="old-user">@Rita</span>';
  assert.equal(normalizePlainAgentMentions(`${marker} @RC`, agents).content, `${marker} @RC`);
});

test('token boundaries and look-alike markup do not hide an exact handle', () => {
  const agents = [{ userId: 'rita-user', name: 'Rita', slug: 'rita' }];
  const resolve = (content: string) => normalizePlainAgentMentions(content, agents).content;
  assert.equal(resolve('@unknown-@Rita'), '@unknown-<@rita-user|Rita>');
  assert.equal(resolve('<@Rita> @unknown'), '<<@rita-user|Rita>> @unknown');
  assert.equal(resolve('<span title="data-mention-uuid">@Rita</span>'), '<span title="data-mention-uuid"><@rita-user|Rita></span>');
});

test('legacy @deft still reaches Defty', async () => {
  const res = await webPost(`@deft status? ${randomUUID()}`);
  assert.equal(res.status, 201);
  assert.match(res.body.content!, new RegExp(`<@${deftyUserId}\\|Defty>`));
  assert.equal((await deftyJobs(res.body.id!)).length, 1);
});

test('an explicit mention node still dispatches, even for a multi-word name', async () => {
  const res = await webPost(`<@${rcRunner}|RC Runner> please ${randomUUID()}`);
  assert.equal(res.status, 201);
  assert.deepEqual(await wokenAgents(res.body.id!), [rcRunner]);
});

test('an API client posting plain text with an exact handle still wakes that agent', async () => {
  const result = await humanSendMessage({ target: { space_id: spaceId }, content: `@rc-runner-${sfx} run it ${randomUUID()}`, idempotency_key: randomUUID() }, ctx()) as any;
  assert.equal(Boolean(result.isError), false, String(result.content?.[0]?.text));
  const row = JSON.parse(String(result.content[0].text)) as { id: string; content: string };
  assert.match(row.content, new RegExp(`<@${rcRunner}\\|RC Runner>`));
  assert.deepEqual(await wokenAgents(row.id), [rcRunner]);

  const plain = await humanSendMessage({ target: { space_id: spaceId }, content: `@RC run it ${randomUUID()}`, idempotency_key: randomUUID() }, ctx()) as any;
  assert.equal(Boolean(plain.isError), false, String(plain.content?.[0]?.text));
  assert.deepEqual(await wokenAgents(JSON.parse(String(plain.content[0].text)).id), []);
});
