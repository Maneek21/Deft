import { and, eq, sql, type SQL } from 'drizzle-orm';
import { agentActions, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { visibleCaptureActionSql } from './agent-action-visibility.js';
import { actionReviewAssignmentSql } from './agent-action-requester.js';
import { canonicalDeftyActionSql, moduleRoleAudienceSql, visibleAgentActionSourceSql, visibleModuleActionSql } from './module-action-visibility.js';
import { currentUserSpaceAuthoritySql } from './agent-channel-authority.js';

type UserRef = string | SQL;

/**
 * The actions a web user may open for review through the approve and reject
 * routes: actions of the user's workspace that the user reviews (see
 * `actionReviewAssignmentSql`: the requester when an active human member,
 * otherwise an owner/admin; an assignment counts when it names one of
 * them). For the actions it owns, the approval resolver adds its own
 * reviewer rule on top (see `viewerReviewAuthority`).
 */
export function reviewableActionSql(user: { id: UserRef; org_id: UserRef; role?: string }) {
  return and(
    sql`${agentActions.org_id} = ${user.org_id}`,
    visibleCaptureActionSql(user),
    visibleModuleActionSql(user.role, { userId: user.id, orgId: user.org_id }),
    sourceMessageRoomSql(user.id),
    actionReviewAssignmentSql(user.id),
  )!;
}

/**
 * A Defty action (no employee, or the Defty envelope) that names a chat
 * message of the workspace is reviewed only by a user who can still read
 * that message's room. Captures carry their room in params
 * (`visibleCaptureActionSql`); employee actions follow their own source rule.
 */
export function sourceMessageRoomSql(userId: UserRef): SQL {
  return sql`(${agentActions.message_id} IS NULL
    OR COALESCE(${agentActions.source} = 'defty_capture', false)
    OR NOT (${agentActions.agent_employee_id} IS NULL OR ${canonicalDeftyActionSql()})
    OR NOT EXISTS (
      SELECT 1 FROM messages review_source
      WHERE review_source.id = ${agentActions.message_id}
        AND review_source.org_id = ${agentActions.org_id}
        AND NOT ${currentUserSpaceAuthoritySql(sql`review_source.org_id`, sql`${userId}`, sql`review_source.space_id`)}
    ))`;
}

/**
 * True while an assigned user still passes the action's room and source
 * checks, so the assignment keeps narrowing who reviews the action.
 */
export function assigneeRoomSql(userId: SQL): SQL {
  return and(
    visibleCaptureActionSql({ id: userId, org_id: sql`${agentActions.org_id}` }),
    visibleAgentActionSourceSql({ userId }),
    sourceMessageRoomSql(userId),
  )!;
}

/**
 * `reviewableActionSql` for the user's current active role in the action's
 * workspace, read inside the statement that uses it (Attention items).
 */
export function currentRoleReviewableActionSql(userId: UserRef): SQL {
  const orgId = sql`${agentActions.org_id}`;
  const hasRole = (roles: string[]) => sql`EXISTS (
      SELECT 1 FROM org_members review_role
      WHERE review_role.org_id = ${agentActions.org_id} AND review_role.user_id = ${userId}
        AND review_role.is_active = true
        AND review_role.role IN (${sql.join(roles.map((value) => sql`${value}`), sql`, `)})
    )`;
  // reviewableActionSql with the role read here; only the module audience depends on it.
  return and(
    visibleCaptureActionSql({ id: userId, org_id: orgId }),
    visibleAgentActionSourceSql({ userId, orgId }),
    sql`(${hasRole(['owner', 'admin'])}
      OR (${hasRole(['member'])} AND ${moduleRoleAudienceSql('member', { userId, orgId })})
      OR (${hasRole(['guest'])} AND ${moduleRoleAudienceSql('guest', { userId, orgId })}))`,
    sourceMessageRoomSql(userId),
    actionReviewAssignmentSql(userId),
  )!;
}

/**
 * The user's review right as it stands now: `reviewableActionSql` for their
 * current active role, with that role re-read inside the statement that uses
 * it, so a role change after this read fails the statement instead of
 * applying the older role. Null when they are not an active member.
 */
export async function currentActionReviewerSql(user: { id: string; org_id: string }): Promise<SQL | null> {
  const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers).where(and(
    eq(orgMembers.org_id, user.org_id), eq(orgMembers.user_id, user.id), eq(orgMembers.is_active, true),
  )).limit(1);
  if (!membership) return null;
  return and(
    reviewableActionSql({ ...user, role: membership.role }),
    sql`EXISTS (
      SELECT 1 FROM ${orgMembers} reviewer_membership
      WHERE reviewer_membership.org_id = ${user.org_id}
        AND reviewer_membership.user_id = ${user.id}
        AND reviewer_membership.is_active = true
        AND reviewer_membership.role = ${membership.role}
    )`,
  )!;
}
