/**
 * Who requested an agent action, and who reviews it.
 *
 * An action's requester is its own `user_id`, except for Defty capture
 * actions (`source = 'defty_capture'`): the server writes those for a chat
 * message and stores the message author as `params.source_user_id` (or
 * `origin_user_id`), so that author is the requester. Every reader of the
 * requester goes through this module, in its TypeScript or SQL form; both
 * give the same answer for the same row.
 *
 * An action's reviewers are its requester when the requester is an active
 * human member of the action's workspace, and otherwise the workspace's
 * active owners and admins. An approver assignment
 * (`agent_action_approvers`) counts only when it names one of them.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { agentActionApprovers, agentActions, orgMembers, users } from '@deft/db/schema';
import { db } from './db.js';

/** The only action source whose params name the requester. */
export const CAPTURE_ACTION_SOURCE = 'defty_capture';

/** A user id counts when it has a character other than ASCII whitespace (same set in SQL below). */
const HAS_NON_SPACE = /[^ \t\n\v\f\r]/;

export type RequesterActionRow = { user_id: string; source: string | null; params: unknown };

/** The source message author of a capture action, or null for any other action. */
export function captureSourceUserId(row: RequesterActionRow): string | null {
  if (row.source !== CAPTURE_ACTION_SOURCE) return null;
  if (!row.params || typeof row.params !== 'object' || Array.isArray(row.params)) return null;
  const params = row.params as Record<string, unknown>;
  const claimed = params.source_user_id ?? params.origin_user_id;
  return typeof claimed === 'string' && HAS_NON_SPACE.test(claimed) ? claimed : null;
}

/** The requester of an action: the capture source author, or the action's own user. */
export function actionRequesterId(row: RequesterActionRow): string {
  return captureSourceUserId(row) ?? row.user_id;
}

function actionColumns(alias?: string) {
  if (!alias) {
    return {
      source: sql`${agentActions.source}`,
      params: sql`${agentActions.params}`,
      user_id: sql`${agentActions.user_id}`,
      org_id: sql`${agentActions.org_id}`,
    };
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`invalid agent_actions alias: ${alias}`);
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  return { source: column('source'), params: column('params'), user_id: column('user_id'), org_id: column('org_id') };
}

/**
 * SQL form of `actionRequesterId` over `agent_actions` (or the given alias of
 * it in the surrounding query).
 */
export function actionRequesterIdSql(alias?: string): SQL<string> {
  const c = actionColumns(alias);
  const claimed = sql`(CASE
    WHEN coalesce(jsonb_typeof(${c.params}->'source_user_id'), 'null') <> 'null' THEN ${c.params}->'source_user_id'
    ELSE ${c.params}->'origin_user_id'
  END)`;
  return sql<string>`(CASE
    WHEN ${c.source} = ${CAPTURE_ACTION_SOURCE}
      AND jsonb_typeof(${claimed}) = 'string'
      AND btrim(${claimed} #>> '{}', ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13)) <> ''
    THEN ${claimed} #>> '{}'
    ELSE ${c.user_id}
  END)`;
}

/**
 * True when the user (an SQL expression) is a reviewer of the action: its
 * requester when that is an active human member of the action's workspace,
 * otherwise an active owner/admin of that workspace.
 */
export function actionReviewerSql(userId: SQL, alias?: string): SQL<boolean> {
  const c = actionColumns(alias);
  const requester = actionRequesterIdSql(alias);
  return sql<boolean>`(CASE
    WHEN EXISTS (
      SELECT 1 FROM users requester_u
      INNER JOIN org_members requester_m ON requester_m.user_id = requester_u.id
      WHERE requester_u.id = ${requester}
        AND requester_m.org_id = ${c.org_id}
        AND requester_m.is_active = true
        AND requester_u.is_agent = false
        AND requester_u.kind = 'human'
    ) THEN ${userId} = ${requester}
    ELSE EXISTS (
      SELECT 1 FROM org_members reviewer_m
      WHERE reviewer_m.org_id = ${c.org_id}
        AND reviewer_m.user_id = ${userId}
        AND reviewer_m.is_active = true
        AND reviewer_m.role IN ('owner', 'admin')
    )
  END)`;
}

/**
 * True when `userId` reviews the `agent_actions` row: a reviewer of it who,
 * when the action has assignments naming its reviewers, holds one of them.
 * `pendingOnly` limits the user's own assignment to an undecided one.
 */
export function actionReviewAssignmentSql(userId: string, options: { pendingOnly?: boolean } = {}): SQL<boolean> {
  return sql<boolean>`(${actionReviewerSql(sql`${userId}`)} AND (
    EXISTS (
      SELECT 1 FROM ${agentActionApprovers} own_ap
      WHERE own_ap.action_id = ${agentActions.id}
        AND own_ap.org_id = ${agentActions.org_id}
        AND own_ap.user_id = ${userId}
        ${options.pendingOnly ? sql`AND own_ap.decision = 'pending'` : sql``}
    )
    OR NOT EXISTS (
      SELECT 1 FROM ${agentActionApprovers} any_ap
      WHERE any_ap.action_id = ${agentActions.id}
        AND any_ap.org_id = ${agentActions.org_id}
        AND ${actionReviewerSql(sql`any_ap.user_id`)}
    )
  ))`;
}

export type ReviewerActionRow = RequesterActionRow & { id: string; org_id: string };

/**
 * The reviewers of each action, by action id, in two queries whatever the
 * number of actions.
 */
export async function loadActionReviewers(actions: readonly ReviewerActionRow[]): Promise<Map<string, string[]>> {
  const reviewers = new Map<string, string[]>();
  if (actions.length === 0) return reviewers;
  const orgIds = [...new Set(actions.map((action) => action.org_id))];
  const requesterIds = [...new Set(actions.map(actionRequesterId))];
  const activeHumans = new Set((await db
    .select({ user_id: users.id, org_id: orgMembers.org_id })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
    .where(and(
      inArray(users.id, requesterIds),
      inArray(orgMembers.org_id, orgIds),
      eq(orgMembers.is_active, true),
      eq(users.is_agent, false),
      eq(users.kind, 'human'),
    ))).map((row) => `${row.org_id}\u0000${row.user_id}`));
  const fallbackOrgIds = [...new Set(actions
    .filter((action) => !activeHumans.has(`${action.org_id}\u0000${actionRequesterId(action)}`))
    .map((action) => action.org_id))];
  const adminsByOrg = new Map<string, string[]>();
  if (fallbackOrgIds.length > 0) {
    for (const row of await db
      .select({ user_id: orgMembers.user_id, org_id: orgMembers.org_id })
      .from(orgMembers)
      .where(and(
        inArray(orgMembers.org_id, fallbackOrgIds),
        eq(orgMembers.is_active, true),
        inArray(orgMembers.role, ['owner', 'admin']),
      ))) {
      const admins = adminsByOrg.get(row.org_id) ?? [];
      if (!admins.includes(row.user_id)) admins.push(row.user_id);
      adminsByOrg.set(row.org_id, admins);
    }
  }
  for (const action of actions) {
    const requesterId = actionRequesterId(action);
    reviewers.set(action.id, activeHumans.has(`${action.org_id}\u0000${requesterId}`)
      ? [requesterId]
      : [...(adminsByOrg.get(action.org_id) ?? [])]);
  }
  return reviewers;
}
