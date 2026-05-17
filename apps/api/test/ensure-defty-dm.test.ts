/**
 * Verifies ensureDeftyDm is idempotent and creates the correct DM space.
 * Companion to ensure-defty-membership.test.ts.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/ensure-defty-dm.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers } from '@deft/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { ensureDeftyDm, DEFTY_EMAIL } from '../src/lib/ensure-defty-membership.js';

let orgId: string;
let humanUserId: string;
let deftyExistedBefore = false;
let createdSpaceIds: string[] = [];

before(async () => {
  const [existing] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEFTY_EMAIL))
    .limit(1);
  if (existing) deftyExistedBefore = true;

  const [o] = await db.insert(orgs).values({
    name: 'Defty DM Test',
    slug: `dt-dm-${Date.now()}`,
  }).returning();
  orgId = o!.id;

  const [u] = await db.insert(users).values({
    name: 'Test Human',
    email: `dt-dm-human-${Date.now()}@test.local`,
    kind: 'human',
    is_agent: false,
    email_verified: true,
  }).returning();
  humanUserId = u!.id;

  await db.insert(orgMembers).values({
    org_id: orgId,
    user_id: humanUserId,
    role: 'owner',
  });
});

after(async () => {
  try {
    // Clean up: delete space_members + spaces we created.
    if (createdSpaceIds.length > 0) {
      await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, createdSpaceIds));
      await db.delete(spaces).where(inArray(spaces.id, createdSpaceIds));
    }
    // Clean up any DM rows in this org we might have missed.
    const remainingDms = await db.select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.org_id, orgId), eq(spaces.type, 'dm')));
    if (remainingDms.length > 0) {
      const ids = remainingDms.map((r) => r.id);
      await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, ids));
      await db.delete(spaces).where(inArray(spaces.id, ids));
    }
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(eq(users.id, humanUserId));
    if (!deftyExistedBefore) {
      await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
    }
  } catch (err) {
    console.error('cleanup error', err);
  }
});

test('ensureDeftyDm creates a DM space with exactly two members (user + Defty)', async () => {
  const spaceId = await ensureDeftyDm(orgId, humanUserId);
  createdSpaceIds.push(spaceId);
  assert.ok(spaceId, 'should return a non-empty space id');

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  assert.ok(space, 'space row should exist');
  assert.equal(space?.type, 'dm');
  assert.equal(space?.org_id, orgId);

  const members = await db.select({ user_id: spaceMembers.user_id })
    .from(spaceMembers)
    .where(eq(spaceMembers.space_id, spaceId));
  assert.equal(members.length, 2, 'DM should have exactly 2 members');

  const memberSet = new Set(members.map((m) => m.user_id));
  assert.ok(memberSet.has(humanUserId), 'human user should be a member');

  // Defty's user id is whichever one is not the human.
  const deftyUserId = members.find((m) => m.user_id !== humanUserId)?.user_id;
  assert.ok(deftyUserId, 'Defty should be a member');

  const [defty] = await db.select().from(users).where(eq(users.id, deftyUserId!)).limit(1);
  assert.equal(defty?.email, DEFTY_EMAIL);
  assert.equal(defty?.kind, 'agent');
});

test('ensureDeftyDm is idempotent — second call returns the same space id', async () => {
  const id1 = await ensureDeftyDm(orgId, humanUserId);
  const id2 = await ensureDeftyDm(orgId, humanUserId);
  assert.equal(id1, id2, 'second call should return the same space id');

  // Verify only one DM exists for this user in this org.
  const dmsForUser = await db.select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(
      eq(spaceMembers.user_id, humanUserId),
      eq(spaces.org_id, orgId),
      eq(spaces.type, 'dm'),
    ));
  assert.equal(dmsForUser.length, 1, 'exactly one DM should exist for the user');
});
