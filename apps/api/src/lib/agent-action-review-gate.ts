import { and, eq, sql, type SQL } from 'drizzle-orm';
import { agentActionApprovers, agentActions, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { visibleCaptureActionSql } from './agent-action-visibility.js';
import { actionReviewerSql } from './agent-action-requester.js';
import { moduleRoleAudienceSql, sourceMessageRoomSql, visibleAgentActionSourceSql } from './module-action-visibility.js';

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
    reviewGateSql(user.id, moduleRoleAudienceSql(user.role, { userId: user.id, orgId: user.org_id })),
  )!;
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
 * The review gate on the `agent_actions` row in scope, for `userId` and the
 * module `audience` of their role: the user passes the action's capture,
 * source (`visibleAgentActionSourceSql`) and room (`sourceMessageRoomSql`)
 * checks and reviews it (`actionReviewAssignmentSql`: a reviewer of it who,
 * when an assignment names a reviewer who also passes those checks
 * (`assigneeRoomSql`), holds an assignment).
 *
 * Written so PostgreSQL plans each check once. The user and the action's
 * assignees are the rows of one small list and "reviews and passes the
 * checks" is one column of it; OFFSET 0 keeps the planner from copying that
 * column into each place it is read. Composed directly (the checks for the
 * user, then `actionReviewAssignmentSql`, which runs them again for the
 * assignees), the gate made a backend ~80 MB larger to plan (DBF3, release
 * 151), memory it kept until its connection closed: every Inbox item of an
 * approval, and every reviewer check of the approval routes, planned it.
 * test/attention-visibility-narrowing-db.test.ts proves this composition
 * answers as that one did.
 *
 * A positive filter, like the rule it replaces: it may be false where that
 * rule was NULL, so never negate it.
 */
function reviewGateSql(userId: UserRef, audience: SQL): SQL {
  const reader = sql.raw('gate_reader.user_id');
  const reviews = and(
    actionReviewerSql(reader),
    visibleCaptureActionSql({ id: reader, org_id: sql`${agentActions.org_id}` }),
    visibleAgentActionSourceSql({ userId: reader }),
    sourceMessageRoomSql(reader),
  )!;
  // The user's own row always exists, so each bool_or below is true or false.
  return sql`(${audience} AND COALESCE((
    SELECT bool_or(gate_check.is_viewer AND gate_check.reviews)
      AND (bool_or(NOT gate_check.is_viewer AND gate_check.user_id = ${userId})
        OR NOT bool_or(NOT gate_check.is_viewer AND gate_check.reviews))
    FROM (
      SELECT gate_reader.user_id, gate_reader.is_viewer, COALESCE(${reviews}, false) AS reviews
      FROM (
        SELECT (${userId})::text AS user_id, true AS is_viewer
        UNION ALL
        SELECT gate_ap.user_id, false FROM ${agentActionApprovers} gate_ap
        WHERE gate_ap.action_id = ${agentActions.id} AND gate_ap.org_id = ${agentActions.org_id}
      ) gate_reader
      OFFSET 0
    ) gate_check
  ), false))`;
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
  return reviewGateSql(userId, sql`(${hasRole(['owner', 'admin'])}
      OR (${hasRole(['member'])} AND ${moduleRoleAudienceSql('member', { userId, orgId })})
      OR (${hasRole(['guest'])} AND ${moduleRoleAudienceSql('guest', { userId, orgId })}))`);
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
