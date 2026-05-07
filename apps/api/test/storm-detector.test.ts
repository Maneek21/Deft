// apps/api/test/storm-detector.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, messages } from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { checkReplyStorm, STORM_THRESHOLD, STORM_WINDOW_MS } from '../src/lib/storm-detector.js';

let testOrgId: string;
let agentUserId: string;
let humanUserId: string;
let spaceId: string;
let threadParentId: string;
let otherThreadParentId: string;
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `storm-${ts}`, slug: `storm-${ts}` }).returning();
  testOrgId = org.id;

  const [agent] = await db.insert(users).values({
    email: `storm-agent-${ts}@test.com`, name: 'Storm Agent', org_id: testOrgId, kind: 'agent',
  }).returning();
  agentUserId = agent.id;

  const [human] = await db.insert(users).values({
    email: `storm-human-${ts}@test.com`, name: 'Storm Human', org_id: testOrgId, kind: 'human',
  }).returning();
  humanUserId = human.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
  ]);

  const [space] = await db.insert(spaces).values({
    name: 'storm-space', type: 'public', org_id: testOrgId, created_by: humanUserId,
  }).returning();
  spaceId = space.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: agentUserId },
  ]);

  const [t1] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root 1',
  }).returning();
  threadParentId = t1.id;
  createdMessageIds.push(t1.id);

  const [t2] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root 2',
  }).returning();
  otherThreadParentId = t2.id;
  createdMessageIds.push(t2.id);
});

after(async () => {
  if (createdMessageIds.length) {
    await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  }
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [agentUserId, humanUserId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

async function insertReply(authorId: string, parentId: string, ageMs = 0): Promise<string> {
  const createdAt = new Date(Date.now() - ageMs);
  const [m] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: authorId,
    content: `reply ${ageMs}`, parent_id: parentId, created_at: createdAt,
  }).returning();
  createdMessageIds.push(m.id);
  return m.id;
}

test('0 replies in window → not tripped, count=0', async () => {
  const r = await checkReplyStorm(agentUserId, threadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 0);
  assert.equal(r.windowMs, STORM_WINDOW_MS);
});

test('4 replies in window → not tripped, count=4', async () => {
  for (let i = 0; i < 4; i++) await insertReply(agentUserId, threadParentId);
  const r = await checkReplyStorm(agentUserId, threadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 4);
});

test('5 replies in window → tripped, count=5', async () => {
  await insertReply(agentUserId, threadParentId);
  const r = await checkReplyStorm(agentUserId, threadParentId);
  assert.equal(r.tripped, true);
  assert.equal(r.count, STORM_THRESHOLD);
});

test('replies older than 10min are not counted', async () => {
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  await insertReply(agentUserId, otherThreadParentId, 11 * 60 * 1000);
  const r = await checkReplyStorm(agentUserId, otherThreadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 0);
});

test('different thread is not affected', async () => {
  const r = await checkReplyStorm(agentUserId, otherThreadParentId);
  assert.equal(r.tripped, false);
});

test('same thread, different agent → not tripped (per-agent scope)', async () => {
  for (let i = 0; i < 5; i++) await insertReply(humanUserId, threadParentId);
  const fakeAgentId = '00000000-0000-0000-0000-000000000000';
  const r = await checkReplyStorm(fakeAgentId, threadParentId);
  assert.equal(r.tripped, false);
  assert.equal(r.count, 0);
});
