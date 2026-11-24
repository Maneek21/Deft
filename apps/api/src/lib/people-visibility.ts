// Who a caller may see in a workspace's people lists and lookups.
//
// Owners, admins and members see every active person in their workspace, as
// before. A guest sees only themselves and the people who share at least one
// space with them (a room, DM or agent conversation both belong to, archived
// or not), and no email address but their own. This matches the live member
// channel, which a guest never joins (socket.ts, `org-members:<org>`).
//
// The caller's role is read from org_members for this workspace, never from a
// session or token claim. A caller without an active membership gets the
// guest view.
//
// Use `peopleViewer` once per request, then:
// - `personVisibleSql(viewer, <person id column>)` in a query that lists or
//   looks up people;
// - `visiblePersonIds(viewer)` to filter rows already loaded (null: no filter);
// - `emailFor(viewer, personId, email)` / `withoutHiddenEmails` on every email
//   returned.
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { orgMembers, spaceMembers, spaces } from '@deft/db/schema';
import { db } from './db.js';

export type PeopleViewer = Readonly<{ orgId: string; userId: string; guest: boolean }>;

export async function peopleViewer(orgId: string, userId: string): Promise<PeopleViewer> {
  const [membership] = await db.select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)))
    .limit(1);
  const role = membership?.role;
  return { orgId, userId, guest: role !== 'owner' && role !== 'admin' && role !== 'member' };
}

/** The ids of everyone who shares a space with the viewer, the viewer included (when they are in any space). */
function sharedSpacePeopleSql(viewer: PeopleViewer): SQL {
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

/** The people a guest may see, for rows already loaded; null when the viewer sees everyone. */
export async function visiblePersonIds(viewer: PeopleViewer): Promise<ReadonlySet<string> | null> {
  if (!viewer.guest) return null;
  const rows = await db.execute(sharedSpacePeopleSql(viewer));
  const ids = new Set(((rows as unknown as { rows?: Array<{ user_id: string }> }).rows ?? []).map((row) => row.user_id));
  ids.add(viewer.userId);
  return ids;
}

export function canSeePerson(visible: ReadonlySet<string> | null, personId: string | null | undefined): boolean {
  return visible === null || (typeof personId === 'string' && visible.has(personId));
}

/** A guest sees only their own email address; everyone else sees what is stored. */
export function emailFor(viewer: PeopleViewer, personId: string | null | undefined, email: string | null): string | null {
  return viewer.guest && personId !== viewer.userId ? null : email;
}

/** Rows with every email the viewer may not see set to null. `email` and the id key are read from each row. */
export function withoutHiddenEmails<T extends { email?: string | null }>(
  viewer: PeopleViewer,
  rows: readonly T[],
  idOf: (row: T) => string | null | undefined,
): T[] {
  if (!viewer.guest) return [...rows];
  return rows.map((row) => ('email' in row ? { ...row, email: emailFor(viewer, idOf(row), row.email ?? null) } : row));
}
