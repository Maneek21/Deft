/**
 * A08 — a human posting through MCP (`message_post`, `send_message`) must wake
 * Defty exactly when the same post through the web route would, through the
 * same deduplicated `agent-reply` job. No model request is made: the org has a
 * dummy provider key and no worker runs in this process.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  jobQueue, messages, nativeCreateRequests, notifications, orgMembers, orgs, spaceMembers, spaces, users,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { DEFTY_EMAIL, ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { setOrgAPIKey } from '../src/lib/org-ai-config.js';
import { humanMessagePost, humanSendMessage, type HumanToolContext } from '../src/lib/mcp-tools/human.js';

const orgId = randomUUID();
const humanId = randomUUID();
const peerId = randomUUID();
const channelId = randomUUID();
const deftyDmId = randomUUID();
let deftyUserId = '';
let deftyExistedBefore = false;
let app: Hono;

const ctx = (): HumanToolContext => ({
  org_id: orgId, user_id: humanId, role: 'owner', principal_kind: 'human',
  scopes: ['read:workspace', 'read:messages', 'write:messages'],
});

before(async () => {
  const [existingDefty] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEFTY_EMAIL)).limit(1);
  deftyExistedBefore = Boolean(existingDefty);
  await db.insert(orgs).values({ id: orgId, name: 'A08 MCP wake', slug: `a08-${orgId}` });
  await setOrgAPIKey(orgId, 'anthropic', 'sk-ant-a08-test-not-real');
  for (const [id, name] of [[humanId, 'A08 Human'], [peerId, 'A08 Peer']]) {
    await db.insert(users).values({ id, name, email: `a08-${id}@test.local`, kind: 'human', is_agent: false, email_verified: true });
    await db.insert(orgMembers).values({ org_id: orgId, user_id: id, role: 'owner' });
  }
  deftyUserId = await ensureDeftyMembership(orgId);
  await db.insert(spaces).values([
    { id: channelId, org_id: orgId, name: 'a08-general', type: 'public', created_by: humanId },
    { id: deftyDmId, org_id: orgId, name: 'a08-defty-dm', type: 'dm', created_by: humanId },
  ]);
  await db.insert(spaceMembers).values([
    { space_id: channelId, user_id: humanId }, { space_id: channelId, user_id: peerId }, { space_id: channelId, user_id: deftyUserId },
    { space_id: deftyDmId, user_id: humanId }, { space_id: deftyDmId, user_id: deftyUserId },
  ]);
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `a08-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
});

after(async () => {
  try {
    await db.delete(jobQueue).where(eq(jobQueue.org_id, orgId));
    await db.delete(nativeCreateRequests).where(eq(nativeCreateRequests.org_id, orgId));
    await db.delete(notifications).where(eq(notifications.org_id, orgId));
    await db.execute(sql`DELETE FROM oauth_audit_events WHERE org_id = ${orgId}`).catch(() => undefined);
    await db.delete(messages).where(inArray(messages.space_id, [channelId, deftyDmId]));
    await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, [channelId, deftyDmId]));
    await db.delete(spaces).where(inArray(spaces.id, [channelId, deftyDmId]));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [humanId, peerId]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    if (!deftyExistedBefore) await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
  } catch (err) {
    console.error('A08 cleanup error:', err);
  }
});

function toolMessage(result: { content: Array<{ text?: string }>; isError?: boolean }) {
  assert.ok(!result.isError, result.content[0]?.text);
  return JSON.parse(result.content[0]!.text!) as { id: string };
}

async function agentReplyJobs(messageId: string) {
  return db.select({ dedupe: jobQueue.dedupe_key, data: jobQueue.data }).from(jobQueue).where(and(
    eq(jobQueue.org_id, orgId), eq(jobQueue.name, 'agent-reply'), sql`${jobQueue.data}->>'messageId' = ${messageId}`,
  ));
}

async function webPost(spaceId: string, content: string, parentId?: string) {
  const response = await app.request(`/messages/${spaceId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parentId ? { content, parent_id: parentId } : { content }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { id: string }).id;
}

const cases: Array<{ name: string; space: () => string; content: () => string; wakes: boolean }> = [
  { name: 'structured Defty mention in a channel', space: () => channelId, content: () => `<@${deftyUserId}|Defty> summarise ${randomUUID()}`, wakes: true },
  { name: 'plain @defty in a channel', space: () => channelId, content: () => `@defty what changed? ${randomUUID()}`, wakes: true },
  { name: 'unaddressed post in a DM with Defty', space: () => deftyDmId, content: () => `what is on my plate ${randomUUID()}`, wakes: true },
  { name: 'unaddressed channel post', space: () => channelId, content: () => `lunch at noon ${randomUUID()}`, wakes: false },
];

for (const item of cases) {
  test(`A08: message_post wakes Defty exactly like the web route — ${item.name}`, async () => {
    const webId = await webPost(item.space(), item.content());
    const mcp = toolMessage(await humanMessagePost({ space_id: item.space(), content: item.content(), idempotency_key: randomUUID() }, ctx()) as any);
    const webJobs = await agentReplyJobs(webId);
    const mcpJobs = await agentReplyJobs(mcp.id);
    assert.equal(webJobs.length, item.wakes ? 1 : 0, 'web route baseline');
    assert.equal(mcpJobs.length, webJobs.length, 'MCP post must match the web route');
    if (item.wakes) assert.equal(mcpJobs[0]!.dedupe, `agent-reply:${mcp.id}`);
  });
}

test('A08: send_message (space target) wakes Defty on a mention', async () => {
  const mcp = toolMessage(await humanSendMessage({ target: { space_id: channelId }, content: `<@${deftyUserId}|Defty> hi ${randomUUID()}`, idempotency_key: randomUUID() }, ctx()) as any);
  const jobs = await agentReplyJobs(mcp.id);
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!.data as any).userId, humanId);
});

test('A08: send_message into a thread Defty is engaged in follows like the web route', async () => {
  const rootId = await webPost(channelId, `planning thread ${randomUUID()}`);
  await db.insert(messages).values({ org_id: orgId, space_id: channelId, user_id: deftyUserId, parent_id: rootId, content: 'Which day works?' });
  const mcp = toolMessage(await humanSendMessage({ thread_id: rootId, content: 'Monday works for me.', idempotency_key: randomUUID() }, ctx()) as any);
  const jobs = await agentReplyJobs(mcp.id);
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!.data as any).followed, true);
});
