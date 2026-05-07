// apps/api/test/defty-storm-enforcement.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import {
  users, orgs, orgMembers, spaces, spaceMembers, messages, agentActions,
} from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { executeActionDirect } from '../src/lib/agent-actions.js';

let testOrgId: string;
let deftyUserId: string;
let humanUserId: string;
let spaceId: string;
let threadRootId: string;
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `defty-storm-${ts}`, slug: `defty-storm-${ts}` }).returning();
  testOrgId = org.id;

  const [defty] = await db.insert(users).values({
    email: `defty-storm-${ts}@test.com`, name: 'Defty', org_id: testOrgId, kind: 'agent',
  }).returning();
  deftyUserId = defty.id;

  const [human] = await db.insert(users).values({
    email: `defty-storm-h-${ts}@test.com`, name: 'Human', org_id: testOrgId, kind: 'human',
  }).returning();
  humanUserId = human.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: deftyUserId, role: 'member' },
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
  ]);

  const [space] = await db.insert(spaces).values({
    name: 'defty-storm-space', type: 'public', org_id: testOrgId, created_by: humanUserId,
  }).returning();
  spaceId = space.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: deftyUserId },
  ]);

  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root',
  }).returning();
  threadRootId = root.id;
  createdMessageIds.push(root.id);
});

after(async () => {
  await db.delete(messages).where(eq(messages.space_id, spaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));

  // Delete agent_actions that reference these users (FK constraint)
  await db.delete(agentActions).where(eq(agentActions.org_id, testOrgId));

  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [deftyUserId, humanUserId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

test('Defty post_thread_reply with 5 prior agent replies → STORM_DETECTED', async () => {
  // Seed 5 agent replies in this thread.
  for (let i = 0; i < 5; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: deftyUserId,
      content: `seed ${i}`, parent_id: threadRootId,
    }).returning();
    createdMessageIds.push(m.id);
  }

  const r = await executeActionDirect(
    'post_thread_reply',
    { parent_message_id: threadRootId, content: 'one more' },
    testOrgId,
    deftyUserId,
    null,
    'full',
  );
  assert.equal(r.success, false);
  assert.match(String(r.error), /STORM_DETECTED/);
});

test('Defty post_thread_reply with 4 prior agent replies → succeeds', async () => {
  // Fresh thread root.
  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'fresh thread',
  }).returning();
  createdMessageIds.push(root.id);

  for (let i = 0; i < 4; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: deftyUserId,
      content: `seed ${i}`, parent_id: root.id,
    }).returning();
    createdMessageIds.push(m.id);
  }

  const r = await executeActionDirect(
    'post_thread_reply',
    { parent_message_id: root.id, content: 'fifth' },
    testOrgId,
    deftyUserId,
    null,
    'full',
  );
  assert.equal(r.success, true, JSON.stringify(r));
});
