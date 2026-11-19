import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { orgMembers, spaceMembers, spaces } from '@deft/db/schema';

/**
 * True when the space is public and `userId` may see it without being a
 * member: everyone except a human guest of the space's own workspace (agent
 * users keep their own rules). A guest sees a space only through a
 * space_members row. The role is read from org_members
 * for the space's org, never from the caller's session or context.
 *
 * Use it as the public branch of a space visibility check:
 * `publicSpaceVisibleSql(type, org_id, viewer) OR <viewer is a member>`.
 */
export function publicSpaceVisibleSql(spaceType: SQLWrapper, spaceOrgId: SQLWrapper, userId: SQLWrapper | string): SQL {
  return sql`(${spaceType} = 'public' AND NOT EXISTS (
    SELECT 1 FROM org_members public_space_guest
    JOIN users public_space_guest_user ON public_space_guest_user.id = public_space_guest.user_id
    WHERE public_space_guest.org_id = ${spaceOrgId}
      AND public_space_guest.user_id = ${userId}
      AND public_space_guest.role = 'guest'
      AND public_space_guest_user.kind = 'human'))`;
}

/**
 * For a query that selects from `spaces`: true when `userId` may read the
 * space without having joined it. The space is public and not archived, and
 * the reader is an active member of the space's workspace who is not a guest
 * (publicSpaceVisibleSql, the check the assistant's and outside agents' tools
 * use). Combine it with the membership check: `<is a member> OR this`.
 */
export function unjoinedPublicSpaceReadableSql(userId: string | SQL): SQL {
  return sql`(${spaces.is_archived} = false
    AND ${publicSpaceVisibleSql(spaces.type, spaces.org_id, userId)}
    AND EXISTS (SELECT 1 FROM ${orgMembers}
      WHERE ${orgMembers.org_id} = ${spaces.org_id} AND ${orgMembers.user_id} = ${userId} AND ${orgMembers.is_active} = true))`;
}

/**
 * `canReadSpace` as a condition for any query: the space `spaceId` of `orgId`
 * is one `userId` can read today. They are in it (archived or not), or it is
 * a public, unarchived space and they are a member of the workspace who is
 * not a guest.
 */
export function readableSpaceSql(userId: string | SQL, spaceId: SQLWrapper, orgId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM ${spaces} WHERE ${spaces.id} = ${spaceId} AND ${spaces.org_id} = ${orgId}
    AND (EXISTS (SELECT 1 FROM ${spaceMembers}
        WHERE ${spaceMembers.space_id} = ${spaces.id} AND ${spaceMembers.user_id} = ${userId})
      OR ${unjoinedPublicSpaceReadableSql(userId)}))`;
}
