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
import { and, eq, sql } from 'drizzle-orm';
import { agentEmployees, orgMembers, users } from '@deft/db/schema';
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

/**
 * The caller's view, from their active org_members role in this workspace.
 * A person with no active membership gets the guest view (the narrowest). An
 * agent (an agent employee of this workspace, or a user of kind agent) is a
 * guest only when its role says so: one without a membership row keeps the
 * view it had before this rule.
 */
export async function peopleViewer(orgId: string, userId: string): Promise<PeopleViewer> {
  const [row] = await db.select({
    role: orgMembers.role,
    kind: users.kind,
    employee: sql<boolean>`EXISTS (SELECT 1 FROM ${agentEmployees}
      WHERE ${agentEmployees.user_id} = ${users.id} AND ${agentEmployees.org_id} = ${orgId})`,
  })
    .from(users)
    .leftJoin(orgMembers, and(eq(orgMembers.user_id, users.id), eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true)))
    .where(eq(users.id, userId))
    .limit(1);
  const guest = row?.role ? isGuestRole(row.role) : !(row?.kind === 'agent' || row?.employee === true);
  return { orgId, userId, guest };
}

/** The people a guest may see, for rows already loaded; null when the viewer sees everyone. */
export async function visiblePersonIds(viewer: PeopleViewer): Promise<ReadonlySet<string> | null> {
  if (!viewer.guest) return null;
  const rows = await db.execute(sharedSpacePeopleSql(viewer));
  const ids = new Set(((rows as unknown as { rows?: Array<{ user_id: string }> }).rows ?? []).map((row) => row.user_id));
  ids.add(viewer.userId);
  return ids;
}
