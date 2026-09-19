/**
 * Verifies ensureDeftyDm is idempotent and creates the correct DM space.
 * Companion to ensure-defty-membership.test.ts.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/ensure-defty-dm.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, spaces, spaceMembers, messages } from '@deft/db/schema';
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
      await db.delete(messages).where(inArray(messages.space_id, createdSpaceIds));
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

test('explicit Defty ensure and DM open prefer active duplicates and restore one archived conversation in-org', async () => {
  const spaceId = await ensureDeftyDm(orgId, humanUserId);
  const [defty] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEFTY_EMAIL))
    .limit(1);
  assert.ok(defty);

  const sentinel = `preserved-${Date.now()}`;
  const [message] = await db.insert(messages).values({
    org_id: orgId,
    space_id: spaceId,
    user_id: humanUserId,
    content: sentinel,
  }).returning({ id: messages.id });
  assert.ok(message);

  const [archivedDuplicate] = await db.insert(spaces).values({
    org_id: orgId,
    name: 'Archived duplicate',
    type: 'dm',
    created_by: humanUserId,
    is_archived: true,
  }).returning({ id: spaces.id });
  assert.ok(archivedDuplicate);
  createdSpaceIds.push(archivedDuplicate.id);
  await db.insert(spaceMembers).values([
    { space_id: archivedDuplicate.id, user_id: humanUserId },
    { space_id: archivedDuplicate.id, user_id: defty.id },
  ]);

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanUserId, org_id: orgId, email: 'human@test.local', name: 'Test Human' });
    await next();
  });
  app.route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);

  const activePreferred = await ensureDeftyDm(orgId, humanUserId);
  assert.equal(activePreferred, spaceId, 'an active exact-member DM must win over an archived duplicate');
  const activeOpen = await app.request('/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Human, Defty', type: 'dm', user_ids: [defty.id] }),
  });
  assert.equal(activeOpen.status, 200);
  const activeOpenBody = await activeOpen.json() as { id: string; is_archived: boolean };
  assert.equal(activeOpenBody.id, spaceId, 'explicit open must prefer the active exact-member DM');
  assert.equal(activeOpenBody.is_archived, false);
  let [duplicateState] = await db.select({ is_archived: spaces.is_archived })
    .from(spaces)
    .where(eq(spaces.id, archivedDuplicate.id));
  assert.equal(duplicateState?.is_archived, true, 'the archived duplicate must stay archived');

  const [otherOrg] = await db.insert(orgs).values({
    name: 'Other Defty DM Test',
    slug: `dt-dm-other-${Date.now()}`,
  }).returning({ id: orgs.id });
  assert.ok(otherOrg);
  await db.insert(orgMembers).values([
    { org_id: otherOrg.id, user_id: humanUserId, role: 'owner' },
    { org_id: otherOrg.id, user_id: defty.id, role: 'member' },
  ]);
  const [crossOrgDm] = await db.insert(spaces).values({
    org_id: otherOrg.id,
    name: 'Cross-org archived DM',
    type: 'dm',
    created_by: humanUserId,
    is_archived: true,
  }).returning({ id: spaces.id });
  assert.ok(crossOrgDm);
  await db.insert(spaceMembers).values([
    { space_id: crossOrgDm.id, user_id: humanUserId },
    { space_id: crossOrgDm.id, user_id: defty.id },
  ]);

  try {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, archivedDuplicate.id));
    await db.delete(spaces).where(eq(spaces.id, archivedDuplicate.id));
    createdSpaceIds = createdSpaceIds.filter((id) => id !== archivedDuplicate.id);
    await db.update(spaces).set({ is_archived: true }).where(eq(spaces.id, spaceId));

    const ensuredId = await ensureDeftyDm(orgId, humanUserId);
    assert.equal(ensuredId, spaceId, 'ensure should preserve the existing conversation identity');
    let [restored] = await db.select({ is_archived: spaces.is_archived })
      .from(spaces)
      .where(eq(spaces.id, spaceId));
    assert.equal(restored?.is_archived, false, 'ensure should restore the archived conversation');
    let [preserved] = await db.select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(eq(messages.id, message.id));
    assert.deepEqual(preserved, { id: message.id, content: sentinel });
    let [crossOrgState] = await db.select({ is_archived: spaces.is_archived })
      .from(spaces)
      .where(eq(spaces.id, crossOrgDm.id));
    assert.equal(crossOrgState?.is_archived, true, 'ensure must not restore an exact-member DM in another org');

    await db.update(spaces).set({ is_archived: true }).where(eq(spaces.id, spaceId));

    const response = await app.request('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Human, Defty', type: 'dm', user_ids: [defty.id] }),
    });
    assert.equal(response.status, 200);
    const responseBody = await response.json() as { id: string; is_archived: boolean };
    assert.equal(responseBody.id, spaceId);
    assert.equal(responseBody.is_archived, false);

    [restored] = await db.select({ is_archived: spaces.is_archived })
      .from(spaces)
      .where(eq(spaces.id, spaceId));
    assert.equal(restored?.is_archived, false, 'explicit DM open should restore the archived conversation');
    [preserved] = await db.select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(eq(messages.id, message.id));
    assert.deepEqual(preserved, { id: message.id, content: sentinel });
    [crossOrgState] = await db.select({ is_archived: spaces.is_archived })
      .from(spaces)
      .where(eq(spaces.id, crossOrgDm.id));
    assert.equal(crossOrgState?.is_archived, true, 'explicit open must not restore an exact-member DM in another org');
  } finally {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, crossOrgDm.id));
    await db.delete(spaces).where(eq(spaces.id, crossOrgDm.id));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, otherOrg.id));
    await db.delete(orgs).where(eq(orgs.id, otherOrg.id));
  }
});
