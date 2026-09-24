import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { agentEmployees, connectedAccounts, events, orgMembers } from '@deft/db/schema';
import { canonicalDeftyEmployeeCondition } from './defty-identity.js';

/** Events belong to their direct user or to the owner of the connected account.
 * The connected account must be in the event's organization as well. */
function ownerCondition(viewerUserId: string | typeof agentEmployees.user_id): SQL {
  return sql`(${events.user_id} = ${viewerUserId} OR EXISTS (
    SELECT 1 FROM ${connectedAccounts}
    WHERE ${connectedAccounts.id} = ${events.connected_account_id}
      AND ${connectedAccounts.org_id} = ${events.org_id}
      AND ${connectedAccounts.user_id} = ${viewerUserId}
  ))`;
}

/** Use for a host-authenticated human or native Defty caller. A stale or
 * removed organization membership cannot read private calendar content. */
export function liveHumanCalendarEventCondition(orgId: string, userId: string): SQL {
  return and(
    eq(events.org_id, orgId),
    ownerCondition(userId),
    sql`EXISTS (SELECT 1 FROM ${orgMembers}
      WHERE ${orgMembers.org_id} = ${orgId}
        AND ${orgMembers.user_id} = ${userId}
        AND ${orgMembers.is_active} = true)`,
  )!;
}

/** Employee credentials identify only the current employee's own shadow
 * member. A triggering user's id is never a delegated calendar credential. */
export function liveEmployeeCalendarEventCondition(orgId: string, employeeId: string): SQL {
  return and(
    eq(events.org_id, orgId),
    sql`EXISTS (SELECT 1 FROM ${agentEmployees}
      INNER JOIN ${orgMembers}
        ON ${orgMembers.org_id} = ${agentEmployees.org_id}
       AND ${orgMembers.user_id} = ${agentEmployees.user_id}
      WHERE ${agentEmployees.id} = ${employeeId}
        AND ${agentEmployees.org_id} = ${orgId}
        AND ${agentEmployees.is_active} = true
        AND ${orgMembers.is_active} = true
        AND ${or(eq(agentEmployees.is_deleted, false), canonicalDeftyEmployeeCondition())}
        AND ${ownerCondition(agentEmployees.user_id)})`,
  )!;
}
