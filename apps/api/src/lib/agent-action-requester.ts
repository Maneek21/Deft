/**
 * Who requested an agent action, and who reviews it.
 *
 * An action's requester is its own `user_id`, except for Defty capture
 * actions (`source = 'defty_capture'`): the server writes those for a chat
 * message and stores the message author as `params.source_user_id` (or
 * `origin_user_id`), so that author is the requester. The rule is written
 * once, in SQL (`actionRequesterIdSql`); readers in TypeScript load it for a
 * batch of rows with `loadActionRequesterIds`, which runs that same SQL.
 *
 * An action's reviewers are its requester when the requester is an active
 * human member of the action's workspace, and otherwise the workspace's
 * active owners and admins. An approver assignment
 * (`agent_action_approvers`) counts only when it names one of them.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { agentActionApprovers, agentActions, orgMembers, users } from '@deft/db/schema';
import { db } from './db.js';
import { assigneeRoomSql } from './agent-action-review-gate.js';

/** The only action source whose params name the requester. */
export const CAPTURE_ACTION_SOURCE = 'defty_capture';

/** A user id counts when it has a character other than ASCII whitespace (same set in SQL below). */
const HAS_NON_SPACE = /[^ \t\n\v\f\r]/;

/** The columns of an `agent_actions` row the requester rule reads. */
export type RequesterActionRow = {
  id: string;
  org_id: string;
  user_id: string;
  source: string | null;
  params: unknown;
  message_id: string | null;
  agent_employee_id: string | null;
  conversation_id: string | null;
  created_at: Date | string;
};

/** A select of the columns in `RequesterActionRow`. */
export const requesterActionColumns = {
  id: agentActions.id,
  org_id: agentActions.org_id,
  user_id: agentActions.user_id,
  source: agentActions.source,
  params: agentActions.params,
  message_id: agentActions.message_id,
  agent_employee_id: agentActions.agent_employee_id,
  conversation_id: agentActions.conversation_id,
  created_at: agentActions.created_at,
};

/** The source message author of a capture action, or null for any other action. */
export function captureSourceUserId(row: Pick<RequesterActionRow, 'source' | 'params'>): string | null {
  if (row.source !== CAPTURE_ACTION_SOURCE) return null;
  if (!row.params || typeof row.params !== 'object' || Array.isArray(row.params)) return null;
  const params = row.params as Record<string, unknown>;
  const claimed = params.source_user_id ?? params.origin_user_id;
  return typeof claimed === 'string' && HAS_NON_SPACE.test(claimed) ? claimed : null;
}

function timestampText(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * The requester of each row, by action id: `actionRequesterIdSql` evaluated
 * over the given rows in one query, whatever their number. The rows need not
 * be committed.
 */
export async function loadActionRequesterIds(rows: readonly RequesterActionRow[]): Promise<Map<string, string>> {
  const requesters = new Map<string, string>();
  if (rows.length === 0) return requesters;
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const input = JSON.stringify(unique.map((row) => ({
    id: row.id,
    org_id: row.org_id,
    user_id: row.user_id,
    source: row.source,
    params: row.params ?? null,
    message_id: row.message_id,
    agent_employee_id: row.agent_employee_id,
    conversation_id: row.conversation_id,
    created_at: timestampText(row.created_at),
  })));
  const result = await db.execute(sql`SELECT requester_row.id, ${actionRequesterIdSql('requester_row')} AS requester_id
    FROM jsonb_to_recordset(${input}::jsonb) AS requester_row(
      id text, org_id text, user_id text, source text, params jsonb,
      message_id text, agent_employee_id text, conversation_id text, created_at timestamp
    )`);
  for (const row of result.rows as Array<{ id: string; requester_id: string }>) requesters.set(row.id, row.requester_id);
  return requesters;
}

/** The requester of one row (see `loadActionRequesterIds`). */
export async function loadActionRequesterId(row: RequesterActionRow): Promise<string> {
  return (await loadActionRequesterIds([row])).get(row.id) ?? row.user_id;
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
 * The requester of an `agent_actions` row (or of the given alias of it in the
 * surrounding query): the one statement of the rule.
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
 * when the action has assignments naming its reviewers who still pass its
 * room and source checks, holds one of them.
 * `pendingOnly` limits the user's own assignment to an undecided one.
 */
export function actionReviewAssignmentSql(userId: string | SQL, options: { pendingOnly?: boolean } = {}): SQL<boolean> {
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
        AND ${assigneeRoomSql(sql`any_ap.user_id`)}
    )
  ))`;
}

/**
 * The reviewers of each action, by action id, in three queries whatever the
 * number of actions.
 */
export async function loadActionReviewers(actions: readonly RequesterActionRow[]): Promise<Map<string, string[]>> {
  const reviewers = new Map<string, string[]>();
  if (actions.length === 0) return reviewers;
  const requesterOf = await loadActionRequesterIds(actions);
  const requesterId = (action: RequesterActionRow) => requesterOf.get(action.id) ?? action.user_id;
  const orgIds = [...new Set(actions.map((action) => action.org_id))];
  const requesterIds = [...new Set(actions.map(requesterId))];
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
    .filter((action) => !activeHumans.has(`${action.org_id}\u0000${requesterId(action)}`))
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
    const requester = requesterId(action);
    reviewers.set(action.id, activeHumans.has(`${action.org_id}\u0000${requester}`)
      ? [requester]
      : [...(adminsByOrg.get(action.org_id) ?? [])]);
  }
  return reviewers;
}
