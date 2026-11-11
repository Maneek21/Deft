/**
 * Round 2 / P2 — human MCP posts must normalise plain employee aliases exactly
 * like the web route before the Defty wake decision. In an engaged Defty
 * thread, `@rita …` is addressed to Rita, so Defty must not follow it on
 * either path; an ambiguous alias is refused on both; plain `@defty` wakes
 * Defty on both.
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
import { humanMessagePost, humanSendMessage, type HumanToolContext } from '../src/lib/mcp-tools/human.js';

const orgId = randomUUID();
const humanId = randomUUID();
const spaceId = randomUUID();
const ritaUserId = randomUUID();
const twinAUserId = randomUUID();
const twinBUserId = randomUUID();
const suffix = orgId.slice(0, 8);
let deftyUserId = '';
let deftyExistedBefore = false;
let app: Hono;

const ctx = (): HumanToolContext => ({
  org_id: orgId, user_id: humanId, role: 'owner', principal_kind: 'human',
  scopes: ['read:workspace', 'read:messages', 'write:messages'],
});

async function employee(userId: string, name: string, slug: string) {
  await db.insert(users).values({ id: userId, name, email: `${userId}@agents.test.local`, kind: 'agent', is_agent: true, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'member' });
  await db.insert(agentEmployees).values({
    org_id: orgId, user_id: userId, name, slug, role: 'custom', system_prompt: 'Test.', expertise_description: 'Test.',
    starter_prompts: [], disabled_tools: [], space_ids: [], project_ids: [], trust_level: 'conservative', is_active: true,
    is_byoa: true, runtime_kind: 'custom_mcp', wake_mode: 'manual', certification_status: 'token_issued', created_by: humanId,
  });
}

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'Alias parity', slug: `alias-parity-${orgId}` });
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-alias-test-not-real');
  await db.insert(users).values({ id: humanId, name: 'Alias Human', email: `alias-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  deftyUserId = await ensureDeftyMembership(orgId);
  await employee(ritaUserId, 'Rita', `rita-${suffix}`);
  await employee(twinAUserId, 'Twin', `twin-a-${suffix}`);
  await employee(twinBUserId, 'Twin', `twin-b-${suffix}`);
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'alias-room', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values([humanId, deftyUserId, ritaUserId, twinAUserId, twinBUserId].map((user_id) => ({ space_id: spaceId, user_id })));
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `alias-${humanId}@test.local`, role: 'owner' } as any);
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
    await db.delete(agentEmployees).where(eq(agentEmployees.org_id, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanId, ritaUserId, twinAUserId, twinBUserId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('alias parity cleanup error:', err);
  }
});

async function engagedThread() {
  const rootId = randomUUID();
  await db.insert(messages).values({ id: rootId, org_id: orgId, space_id: spaceId, user_id: humanId, content: 'Planning the launch', created_at: new Date(Date.now() - 60_000) });
  await db.insert(messages).values({ org_id: orgId, space_id: spaceId, user_id: deftyUserId, parent_id: rootId, content: 'Which day works?', created_at: new Date(Date.now() - 30_000) });
  return rootId;
}

async function webPost(content: string, parentId?: string) {
  const response = await app.request(`/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parentId ? { content, parent_id: parentId } : { content }),
  });
  return { status: response.status, body: await response.json() as { id?: string; code?: string; content?: string } };
}

function tool(result: any) {
  return { isError: Boolean(result.isError), text: String(result.content?.[0]?.text ?? '') };
}

async function deftyJobs(messageId: string) {
  return db.select({ id: jobQueue.id }).from(jobQueue).where(and(
    eq(jobQueue.org_id, orgId), eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${messageId}`));
}

test('P2 parity: a plain employee alias in an engaged Defty thread does not wake Defty on either path', async () => {
  const web = await webPost(`@rita please handle this ${randomUUID()}`, await engagedThread());
  assert.equal(web.status, 201);
  assert.equal((await deftyJobs(web.body.id!)).length, 0, 'web route baseline');

  const post = tool(await humanMessagePost({ space_id: spaceId, parent_id: await engagedThread(), content: `@rita please handle this ${randomUUID()}`, idempotency_key: randomUUID() }, ctx()));
  assert.equal(post.isError, false, post.text);
  const postRow = JSON.parse(post.text) as { id: string; content: string };
  assert.equal((await deftyJobs(postRow.id)).length, 0, 'message_post must not wake Defty');
  assert.match(postRow.content, new RegExp(`<@${ritaUserId}\\|`), 'the alias is stored as a structured mention, like the web route');

  const send = tool(await humanSendMessage({ thread_id: await engagedThread(), content: `@rita please handle this ${randomUUID()}`, idempotency_key: randomUUID() }, ctx()));
  assert.equal(send.isError, false, send.text);
  assert.equal((await deftyJobs(JSON.parse(send.text).id)).length, 0, 'send_message must not wake Defty');
});

test('P2 parity: an ambiguous employee alias is refused on both paths', async () => {
  const content = `@twin can you take this ${randomUUID()}`;
  const web = await webPost(content);
  assert.equal(web.status, 409);
  assert.equal(web.body.code, 'AMBIGUOUS_AGENT_MENTION');
  const post = tool(await humanMessagePost({ space_id: spaceId, content, idempotency_key: randomUUID() }, ctx()));
  assert.equal(post.isError, true);
  assert.match(post.text, /@twin matches more than one active agent/);
  const send = tool(await humanSendMessage({ target: { space_id: spaceId }, content, idempotency_key: randomUUID() }, ctx()));
  assert.equal(send.isError, true);
  assert.match(send.text, /@twin matches more than one active agent/);
  const stored = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.space_id, spaceId), sql`${messages.content} LIKE ${'%' + content.slice(-36) + '%'}`));
  assert.equal(stored.length, 0, 'no path stores the ambiguous message');
});

test('P2 parity: plain @defty wakes Defty on both paths and is stored as a structured mention', async () => {
  const web = await webPost(`@defty status? ${randomUUID()}`);
  assert.equal(web.status, 201);
  assert.equal((await deftyJobs(web.body.id!)).length, 1);
  const post = tool(await humanMessagePost({ space_id: spaceId, content: `@defty status? ${randomUUID()}`, idempotency_key: randomUUID() }, ctx()));
  const row = JSON.parse(post.text) as { id: string; content: string };
  assert.equal((await deftyJobs(row.id)).length, 1);
  assert.match(row.content, new RegExp(`<@${deftyUserId}\\|Defty>`));
});
