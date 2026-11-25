import { and, eq, sql, type SQL } from 'drizzle-orm';
import { agentActionApprovers, agentActions, orgMembers } from '@deft/db/schema';
import { db } from './db.js';
import { visibleCaptureActionSql } from './agent-action-visibility.js';
import { actionReviewerSql } from './agent-action-requester.js';
import { canonicalDeftyActionSql, moduleRoleAudienceSql, sourceMessageRoomSql, visibleAgentActionSourceSql } from './module-action-visibility.js';

type UserRef = string | SQL;

/**
 * Which actions a review gate must answer for, so a statement plans only the
 * checks its rows need (as `visibleAttentionCondition` does for item types).
 * `employeeActions`: actions of an outside agent (an employee other than the
 * Defty envelope, `employeeActionSql`), the only ones the source check
 * (`visibleAgentActionSourceSql`, the largest part of the gate) is not true
 * for outright. `captures`: Defty captures (`captureActionSql`), likewise for
 * the capture check (`visibleCaptureActionSql`). A gate without one of them
 * answers false on such an action (fail closed) and exactly as the whole gate
 * on every other: read the kinds of the rows first, in the snapshot the gate
 * runs on (`reviewGateScopeOf`).
 */
export type ReviewGateScope = Readonly<{ employeeActions: boolean; captures: boolean }>;

/** Every action: the whole gate. */
export const EVERY_REVIEW_GATE_ACTION: ReviewGateScope = Object.freeze({ employeeActions: true, captures: true });

function actionColumn(alias: string | undefined, name: string): SQL {
  if (alias && !/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`invalid agent_actions alias: ${alias}`);
  return sql.raw(`${alias ?? 'agent_actions'}.${name}`);
}

/**
 * The `agent_actions` row (or `alias`) is an outside agent's action: exactly
 * the rows `visibleAgentActionSourceSql` does not answer true for outright.
 * Never NULL.
 */
export function employeeActionSql(alias?: string): SQL<boolean> {
  const employee = actionColumn(alias, 'agent_employee_id');
  return sql<boolean>`(${employee} IS NOT NULL AND NOT ${canonicalDeftyActionSql(employee, actionColumn(alias, 'org_id'))})`;
}

/**
 * The `agent_actions` row (or `alias`) is a Defty capture: exactly the rows
 * `visibleCaptureActionSql` does not answer true for outright. Never NULL.
 */
export function captureActionSql(alias?: string): SQL<boolean> {
  return sql<boolean>`(${actionColumn(alias, 'source')} IS NOT DISTINCT FROM 'defty_capture')`;
}

/** The scope covering rows whose kinds were read with `employeeActionSql` and `captureActionSql`. */
export function reviewGateScopeOf(rows: ReadonlyArray<{ employee: unknown; capture: unknown }>): ReviewGateScope {
  return Object.freeze({
    employeeActions: rows.some((row) => row.employee !== false),
    captures: rows.some((row) => row.capture !== false),
  });
}

/**
 * The scope of the `agent_actions` rows (as `alias`) that `fromWhere` (a FROM
 * and WHERE clause) selects, read on `tx`. Run the gate on the same snapshot
 * (a REPEATABLE READ transaction) so it answers as the whole gate on them.
 */
export async function readReviewGateScope(
  tx: { execute(query: SQL): Promise<{ rows: unknown[] }> },
  fromWhere: SQL,
  alias = 'agent_actions',
): Promise<ReviewGateScope> {
  const kinds = await tx.execute(sql`SELECT DISTINCT ${employeeActionSql(alias)} AS employee, ${captureActionSql(alias)} AS capture ${fromWhere}`);
  return reviewGateScopeOf(kinds.rows as Array<{ employee: unknown; capture: unknown }>);
}

/**
 * The actions a web user may open for review through the approve and reject
 * routes: actions of the user's workspace that the user reviews (see
 * `actionReviewAssignmentSql`: the requester when an active human member,
 * otherwise an owner/admin; an assignment counts when it names one of
 * them). For the actions it owns, the approval resolver adds its own
 * reviewer rule on top (see `viewerReviewAuthority`).
 */
export function reviewableActionSql(user: { id: UserRef; org_id: UserRef; role?: string }, scope = EVERY_REVIEW_GATE_ACTION) {
  return and(
    sql`${agentActions.org_id} = ${user.org_id}`,
    reviewGateSql(user.id, moduleRoleAudienceSql(user.role, { userId: user.id, orgId: user.org_id }), scope),
  )!;
}

/**
 * The review gate without a module audience: the user passes the action's
 * capture, source and room checks and reviews it (`actionReviewAssignmentSql`).
 * For a caller that applies its own audience (a room's pending approvals).
 */
export function reviewsActionSql(userId: UserRef, scope = EVERY_REVIEW_GATE_ACTION): SQL {
  return reviewGateSql(userId, sql`true`, scope);
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
 * `scope` leaves out the checks of the actions it excludes, and answers false
 * on those actions; on every other action each left-out check is true by its
 * own first test, so the answer is the whole gate's (release 152).
 *
 * A positive filter, like the rule it replaces: it may be false where that
 * rule was NULL, so never negate it.
 */
function reviewGateSql(userId: UserRef, audience: SQL, scope: ReviewGateScope): SQL {
  const reader = sql.raw('gate_reader.user_id');
  const reviews = and(
    actionReviewerSql(reader),
    scope.captures ? visibleCaptureActionSql({ id: reader, org_id: sql`${agentActions.org_id}` }) : undefined,
    scope.employeeActions ? visibleAgentActionSourceSql({ userId: reader }) : undefined,
    sourceMessageRoomSql(reader),
  )!;
  const excluded = [
    ...(scope.captures ? [] : [captureActionSql()]),
    ...(scope.employeeActions ? [] : [employeeActionSql()]),
  ];
  const inScope = excluded.length ? sql` AND NOT (${sql.join(excluded, sql` OR `)})` : sql``;
  // The user's own row always exists, so each bool_or below is true or false.
  return sql`(${audience}${inScope} AND COALESCE((
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
export function currentRoleReviewableActionSql(userId: UserRef, scope = EVERY_REVIEW_GATE_ACTION): SQL {
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
      OR (${hasRole(['guest'])} AND ${moduleRoleAudienceSql('guest', { userId, orgId })}))`, scope);
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
