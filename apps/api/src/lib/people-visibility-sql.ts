// Who a caller may see in a workspace's people lists and lookups: the rule as
// SQL and plain functions, with no database access of its own, so the
// workspace export (which reads through its own snapshot) can use it too.
// people-visibility.ts adds the lookups that read the database.
//
// Owners, admins and members see every active person in their workspace, as
// before. A guest sees only themselves and the people who share at least one
// space with them (a room, DM or agent conversation both belong to, archived
// or not), and no email address but their own. This matches the live member
// channel, which a guest never joins (socket.ts, `org-members:<org>`).
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { spaceMembers, spaces } from '@deft/db/schema';

/** `guest` must come from org_members for this workspace, never from a session or token claim. */
export type PeopleViewer = Readonly<{ orgId: string; userId: string; guest: boolean }>;

/** A guest is anyone who is not an active owner, admin or member: the narrowest view is the default. */
export function isGuestRole(role: string | null | undefined): boolean {
  return role !== 'owner' && role !== 'admin' && role !== 'member';
}

/** The ids of everyone who shares a space with the viewer, the viewer included (when they are in any space). */
export function sharedSpacePeopleSql(viewer: PeopleViewer): SQL {
  return sql`SELECT shared_person.user_id
    FROM ${spaceMembers} viewer_membership
    JOIN ${spaces} shared_space ON shared_space.id = viewer_membership.space_id
    JOIN ${spaceMembers} shared_person ON shared_person.space_id = viewer_membership.space_id
    WHERE viewer_membership.user_id = ${viewer.userId}
      AND shared_space.org_id = ${viewer.orgId}`;
}

/** True for a person the viewer may see. `personId` is the person's users.id in the outer query. */
export function personVisibleSql(viewer: PeopleViewer, personId: SQLWrapper): SQL {
  if (!viewer.guest) return sql`true`;
  return sql`(${personId} = ${viewer.userId} OR ${personId} IN (${sharedSpacePeopleSql(viewer)}))`;
}

/** The email a viewer may see, as SQL: a guest sees only their own. */
export function visibleEmailSql(viewer: PeopleViewer, personId: SQLWrapper, email: SQLWrapper): SQL {
  if (!viewer.guest) return sql`${email}`;
  return sql`CASE WHEN ${personId} = ${viewer.userId} THEN ${email} END`;
}

export function canSeePerson(visible: ReadonlySet<string> | null, personId: string | null | undefined): boolean {
  return visible === null || (typeof personId === 'string' && visible.has(personId));
}

/** A guest sees only their own email address; everyone else sees what is stored. */
export function emailFor(viewer: PeopleViewer, personId: string | null | undefined, email: string | null): string | null {
  return viewer.guest && personId !== viewer.userId ? null : email;
}

/** Rows with every email the viewer may not see set to null. */
export function withoutHiddenEmails<T extends { email?: string | null }>(
  viewer: PeopleViewer,
  rows: readonly T[],
  idOf: (row: T) => string | null | undefined,
): T[] {
  if (!viewer.guest) return [...rows];
  return rows.map((row) => ('email' in row ? { ...row, email: emailFor(viewer, idOf(row), row.email ?? null) } : row));
}
