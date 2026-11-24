// Who a caller may see in a workspace's people lists and lookups. The rule
// itself is in people-visibility-sql.ts; this module adds the lookups that
// read the database.
//
// Use `peopleViewer` once per request, then:
// - `personVisibleSql(viewer, <person id column>)` in a query that lists or
//   looks up people;
// - `visiblePersonIds(viewer)` to filter rows already loaded (null: no filter);
// - `emailFor(viewer, personId, email)` / `withoutHiddenEmails` on every email
//   returned.
import { and, eq } from 'drizzle-orm';
import { orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { isGuestRole, sharedSpacePeopleSql, type PeopleViewer } from './people-visibility-sql.js';

export {
  canSeePerson,
  emailFor,
  isGuestRole,
  personVisibleSql,
  visibleEmailSql,
  withoutHiddenEmails,
  type PeopleViewer,
} from './people-visibility-sql.js';

/** The caller's view, from their active org_members role in this workspace (no membership: the guest view). */
export async function peopleViewer(orgId: string, userId: string): Promise<PeopleViewer> {
  const [membership] = await db.select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, userId), eq(orgMembers.is_active, true)))
    .limit(1);
  return { orgId, userId, guest: isGuestRole(membership?.role) };
}

/** The people a guest may see, for rows already loaded; null when the viewer sees everyone. */
export async function visiblePersonIds(viewer: PeopleViewer): Promise<ReadonlySet<string> | null> {
  if (!viewer.guest) return null;
  const rows = await db.execute(sharedSpacePeopleSql(viewer));
  const ids = new Set(((rows as unknown as { rows?: Array<{ user_id: string }> }).rows ?? []).map((row) => row.user_id));
  ids.add(viewer.userId);
  return ids;
}
