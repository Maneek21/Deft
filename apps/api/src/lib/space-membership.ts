import { db } from './db.js';
import { spaceMembers, spaces } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';

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
