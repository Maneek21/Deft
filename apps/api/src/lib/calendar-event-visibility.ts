import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { agentEmployees, connectedAccounts, events, orgMembers, users } from '@deft/db/schema';
import { canonicalDeftyEmployeeCondition } from './defty-identity.js';

/** Who sees a calendar event. This is the one rule for every calendar read;
 * changing or cancelling an event stays with its own user (events.user_id).
 *
 * Events belong to their direct user or to the owner of the connected account.
 * The connected account must be in the event's organization as well. A native
 * Deft event is also seen, read-only, by each attendee (metadata.attendees,
 * matched by email, ignoring case) who is an active owner, admin or member of
 * the event's organization. A guest, a deactivated member and anyone outside
 * the organization see nothing; an imported event stays its owner's. */
function ownerCondition(viewerUserId: string | typeof agentEmployees.user_id): SQL {
  return sql`(${events.user_id} = ${viewerUserId} OR EXISTS (
    SELECT 1 FROM ${connectedAccounts}
    WHERE ${connectedAccounts.id} = ${events.connected_account_id}
      AND ${connectedAccounts.org_id} = ${events.org_id}
      AND ${connectedAccounts.user_id} = ${viewerUserId}
  ) OR (${events.source} = 'native' AND ${events.event_type} = 'calendar_event' AND EXISTS (
    SELECT 1 FROM ${orgMembers} attendee_member
    INNER JOIN ${users} attendee_user ON attendee_user.id = attendee_member.user_id
    WHERE attendee_member.org_id = ${events.org_id}
      AND attendee_member.user_id = ${viewerUserId}
      AND attendee_member.is_active = true
      AND attendee_member.role IN ('owner', 'admin', 'member')
      AND lower(attendee_user.email) IN (
        SELECT lower(attendee ->> 'email') FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(${events.metadata} -> 'attendees') = 'array' THEN ${events.metadata} -> 'attendees'
          ELSE '[]'::jsonb END) AS attendee)
  )))`;
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
