import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import {
  evictActiveHuddleParticipants,
  getAccessibleHuddleSpaceIds,
  getAuthorizedHuddleRecipientIds,
  getHuddleSpaceAccess,
} from '../src/socket.js';
import { addParticipant, createRoom, destroyRoom, getParticipantList, getRoom } from '../src/huddle-rooms.js';

let orgAId = '';
let orgBId = '';
let memberId = '';
let nonmemberId = '';
let foreignMemberId = '';
let activeSpaceId = '';
let archivedSpaceId = '';
let crossOrgSpaceId = '';

before(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createdOrgs = await db.insert(orgs).values([
    { name: `Huddle Access A ${stamp}`, slug: `huddle-access-a-${stamp}` },
    { name: `Huddle Access B ${stamp}`, slug: `huddle-access-b-${stamp}` },
  ]).returning();
  orgAId = createdOrgs[0]!.id;
  orgBId = createdOrgs[1]!.id;

  const createdUsers = await db.insert(users).values([
    { email: `huddle-member-${stamp}@test.local`, name: 'Huddle Member', kind: 'human' },
    { email: `huddle-nonmember-${stamp}@test.local`, name: 'Huddle Nonmember', kind: 'human' },
    { email: `huddle-foreign-${stamp}@test.local`, name: 'Huddle Foreign Member', kind: 'human' },
  ]).returning();
  memberId = createdUsers[0]!.id;
  nonmemberId = createdUsers[1]!.id;
  foreignMemberId = createdUsers[2]!.id;
  await db.insert(orgMembers).values([
    { org_id: orgAId, user_id: memberId, role: 'member' },
    { org_id: orgAId, user_id: nonmemberId, role: 'member' },
    { org_id: orgBId, user_id: foreignMemberId, role: 'member' },
  ]);

  const createdSpaces = await db.insert(spaces).values([
    { org_id: orgAId, name: `Active ${stamp}`, type: 'private', created_by: memberId },
    { org_id: orgAId, name: `Archived ${stamp}`, type: 'private', created_by: memberId, is_archived: true },
    { org_id: orgBId, name: `Cross org ${stamp}`, type: 'private', created_by: memberId },
  ]).returning();
  activeSpaceId = createdSpaces[0]!.id;
  archivedSpaceId = createdSpaces[1]!.id;
  crossOrgSpaceId = createdSpaces[2]!.id;

  // The cross-org row is deliberately malformed tenant data. The access query
  // must still reject it by checking the owning space's org_id.
  await db.insert(spaceMembers).values([
    { space_id: activeSpaceId, user_id: memberId },
    { space_id: archivedSpaceId, user_id: memberId },
    { space_id: crossOrgSpaceId, user_id: memberId },
    { space_id: activeSpaceId, user_id: foreignMemberId },
  ]);
});

after(async () => {
  const spaceIds = [activeSpaceId, archivedSpaceId, crossOrgSpaceId].filter(Boolean);
  if (spaceIds.length > 0) await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, spaceIds));
  if (orgAId) await db.delete(spaces).where(eq(spaces.org_id, orgAId));
  if (orgBId) await db.delete(spaces).where(eq(spaces.org_id, orgBId));
  const orgIds = [orgAId, orgBId].filter(Boolean);
  if (orgIds.length > 0) await db.delete(orgMembers).where(inArray(orgMembers.org_id, orgIds));
  const userIds = [memberId, nonmemberId, foreignMemberId].filter(Boolean);
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  if (orgIds.length > 0) await db.delete(orgs).where(inArray(orgs.id, orgIds));
});

test('huddle space access requires same-org active space membership', async () => {
  const member = { id: memberId, email: 'member@test.local', org_id: orgAId };
  const nonmember = { id: nonmemberId, email: 'nonmember@test.local', org_id: orgAId };

  const allowed = await getHuddleSpaceAccess(activeSpaceId, member);
  assert.equal(allowed?.space_id, activeSpaceId);
  assert.equal(allowed?.user_name, 'Huddle Member');
  assert.equal(await getHuddleSpaceAccess(activeSpaceId, nonmember), undefined);
  assert.equal(await getHuddleSpaceAccess(crossOrgSpaceId, member), undefined);
  assert.equal(await getHuddleSpaceAccess(archivedSpaceId, member), undefined);

  const accessibleIds = await getAccessibleHuddleSpaceIds(member);
  assert.deepEqual([...accessibleIds], [activeSpaceId]);
  assert.deepEqual(
    await getAuthorizedHuddleRecipientIds(activeSpaceId, orgAId, 'not-a-user'),
    [memberId],
  );
  assert.deepEqual(await getAuthorizedHuddleRecipientIds(activeSpaceId, orgAId, memberId), []);
  assert.deepEqual(
    await getAuthorizedHuddleRecipientIds(crossOrgSpaceId, orgAId, 'not-a-user'),
    [],
  );

  await db.update(orgMembers).set({ is_active: false }).where(and(
    eq(orgMembers.org_id, orgAId),
    eq(orgMembers.user_id, memberId),
  ));
  assert.equal(await getHuddleSpaceAccess(activeSpaceId, member), undefined);
  assert.deepEqual([...await getAccessibleHuddleSpaceIds(member)], []);
});

test('realtime eviction removes revoked users and ends an emptied room', async () => {
  const roomId = '44444444-4444-4444-8444-444444444444';
  createRoom(roomId, activeSpaceId, orgAId, memberId);
  try {
    addParticipant(roomId, {
      user_id: memberId,
      user_name: 'Huddle Member',
      muted: false,
      socket_id: 'socket-member',
    });
    addParticipant(roomId, {
      user_id: nonmemberId,
      user_name: 'Huddle Nonmember',
      muted: false,
      socket_id: 'socket-nonmember',
    });

    assert.equal(await evictActiveHuddleParticipants({
      orgId: orgAId,
      spaceId: activeSpaceId,
      userId: memberId,
      reason: 'space_membership_revoked',
    }), 1);
    assert.deepEqual(getParticipantList(roomId), [{
      user_id: nonmemberId,
      user_name: 'Huddle Nonmember',
      muted: false,
    }]);

    assert.equal(await evictActiveHuddleParticipants({
      orgId: orgAId,
      spaceId: activeSpaceId,
      reason: 'space_archived',
    }), 1);
    assert.equal(getRoom(roomId), undefined);
  } finally {
    destroyRoom(roomId);
  }
});
