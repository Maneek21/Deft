import { db } from './db.js';
import { orgMembers, spaceMembers, spaces, users } from '@deft/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * True when `userId` may find and join the public spaces of `orgId`: an active
 * member of that org with role owner, admin or member, and a human user.
 * Guests and agent users are added to spaces by a member instead. The role is
 * read from the database, not from the session.
 */
export async function canSelfJoinPublicSpaces(userId: string, orgId: string): Promise<boolean> {
  const [row] = await db.select({ id: orgMembers.id })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.user_id))
    .where(and(
      eq(orgMembers.org_id, orgId),
      eq(orgMembers.user_id, userId),
      eq(orgMembers.is_active, true),
      inArray(orgMembers.role, ['owner', 'admin', 'member']),
      eq(users.kind, 'human'),
    ))
    .limit(1);
  return !!row;
}

/**
 * True when `userId` is a member of `spaceId` AND that space belongs to
 * `orgId` (the caller's active org). One user can be an active member of
 * several orgs; without the org binding a session for org A passed this check
 * for an org-B space the user belongs to. A space outside the active org is
 * indistinguishable from a space the user is not a member of.
 */
export async function requireSpaceMembership(spaceId: string, userId: string, orgId: string): Promise<boolean> {
  const [member] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.space_id))
    .where(and(
      eq(spaceMembers.space_id, spaceId),
      eq(spaceMembers.user_id, userId),
      eq(spaces.org_id, orgId),
    ))
    .limit(1);
  return !!member;
}
