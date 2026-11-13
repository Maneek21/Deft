import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * True when the space is public and `userId` may see it without being a
 * member: everyone except a guest of the space's own workspace. A guest sees a
 * space only through a space_members row. The role is read from org_members
 * for the space's org, never from the caller's session or context.
 *
 * Use it as the public branch of a space visibility check:
 * `publicSpaceVisibleSql(type, org_id, viewer) OR <viewer is a member>`.
 */
export function publicSpaceVisibleSql(spaceType: SQLWrapper, spaceOrgId: SQLWrapper, userId: SQLWrapper | string): SQL {
  return sql`(${spaceType} = 'public' AND NOT EXISTS (
    SELECT 1 FROM org_members public_space_guest
    WHERE public_space_guest.org_id = ${spaceOrgId}
      AND public_space_guest.user_id = ${userId}
      AND public_space_guest.role = 'guest'))`;
}
