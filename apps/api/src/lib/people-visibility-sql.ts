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

/**
 * `peopleViewer` (people-visibility.ts) as SQL, for a query that does not
 * know the workspace up front: true when `userId` reads the workspace
 * `orgId` as an active owner, admin or member, or is an agent with no active
 * membership there (an agent user, or an agent employee of that workspace).
 * False for a guest and for anyone else.
 *
 * Written as lookups by key (scalar subqueries), never IN or EXISTS: those
 * are planned twice (per row and hashed), and this condition sits inside
 * checks PostgreSQL plans on every Inbox read (lib/attention.ts). For an
 * owner, admin or member it costs one index lookup on org_members.
 */
export function fullWorkspaceViewSql(userId: string | SQLWrapper, orgId: SQLWrapper): SQL {
  return sql`COALESCE(
    (SELECT full_view_member.role IN ('owner', 'admin', 'member') FROM org_members full_view_member
      WHERE full_view_member.org_id = ${orgId} AND full_view_member.user_id = ${userId} AND full_view_member.is_active = true),
    (SELECT full_view_user.kind = 'agent' OR COALESCE((SELECT true FROM agent_employees full_view_employee
        WHERE full_view_employee.user_id = full_view_user.id AND full_view_employee.org_id = ${orgId} LIMIT 1), false)
      FROM users full_view_user WHERE full_view_user.id = ${userId}),
    false)`;
}

/** The ids of everyone who shares a space with the viewer, the viewer included (when they are in any space). */
export function sharedSpacePeopleSql(viewer: PeopleViewer): SQL {
  return sql`SELECT DISTINCT shared_person.user_id
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
