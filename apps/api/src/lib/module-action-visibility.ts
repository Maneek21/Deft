import { inArray, notInArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { agentActionApprovers, agentActions, attentionItems } from '@deft/db/schema';
import { currentAgentActionSourceAuthoritySql, currentUserSpaceAuthoritySql } from './agent-channel-authority.js';
import { actionRequesterIdSql, actionReviewerSql } from './agent-action-requester.js';
import { DEFTY_SYSTEM_EMPLOYEE_SLUG, DEFTY_SYSTEM_RUNTIME_KIND } from './defty-identity.js';
import { readableSpaceSql } from './space-visibility.js';
import { actionPlanRoomsReadableSql } from './plan-room-access.js';

/** The internal Defty action envelope has a different, established source contract. */
export function canonicalDeftyActionSql(
  employeeId: SQLWrapper = agentActions.agent_employee_id,
  orgId: SQLWrapper = agentActions.org_id,
): SQL {
  return sql`exists (select 1 from agent_employees internal_employee
    where internal_employee.id = ${employeeId} and internal_employee.org_id = ${orgId}
      and internal_employee.runtime_kind = ${DEFTY_SYSTEM_RUNTIME_KIND} and internal_employee.slug = ${DEFTY_SYSTEM_EMPLOYEE_SLUG}
      and internal_employee.is_byoa = false and internal_employee.is_active = true)`;
}

/**
 * The rooms a Defty action (no employee, or the Defty envelope) came from: the
 * conversation it was proposed in (`conversation_id`, a space id; plan steps
 * carry only this), the room of the chat message it is attached to
 * (`message_id`), and the room of the source message the worker verified for
 * it (`params.source_message_id`), which can be another room. Only a user who
 * can read every one of them now may review the action, and a member or guest
 * who is not an owner/admin sees it in any action list only while they can
 * (check 13, fix 1: nothing of a space a person lost stays visible to them).
 * A reference to no room of the workspace adds no room.
 *
 * `review` (the default) is the review gate's rule: the room is active and
 * the user a member, or it is public and they may read it unjoined.
 * `history` is the room's own read rule (`readableSpaceSql`): a member reads
 * it archived or not, so archiving a room does not empty its members'
 * action history. Captures carry their room in params
 * (`visibleCaptureActionSql`); employee actions follow their own source rule
 * (`currentAgentActionSourceAuthoritySql`).
 */
export function sourceMessageRoomSql(userId: string | SQL, rule: 'review' | 'history' = 'review'): SQL {
  // CASE keeps the order: rows without a room reference, captures and
  // employee actions never run the room lookups.
  return sql`(CASE
    WHEN ${agentActions.conversation_id} IS NULL AND ${agentActions.message_id} IS NULL
      AND (${agentActions.params}->>'source_message_id') IS NULL THEN true
    WHEN COALESCE(${agentActions.source} = 'defty_capture', false) THEN true
    WHEN ${agentActions.agent_employee_id} IS NOT NULL AND NOT ${canonicalDeftyActionSql()} THEN true
    ELSE ${referencedRoomsReadableSql(userId, rule)}
    END)`;
}

/**
 * The room lookups of `sourceMessageRoomSql`, for any action row: its
 * conversation room and the rooms of `message_id` and
 * `params.source_message_id` are each readable by `userId` under `rule`.
 */
function referencedRoomsReadableSql(userId: string | SQL, rule: 'review' | 'history'): SQL {
  const readable = (room: string) => rule === 'history'
    ? readableSpaceSql(userId, sql.raw(`${room}.id`), sql.raw(`${room}.org_id`))
    : currentUserSpaceAuthoritySql(sql.raw(`${room}.org_id`), sql`${userId}`, sql.raw(`${room}.id`));
  return sql`(NOT EXISTS (
        SELECT 1 FROM spaces conversation_room
        WHERE conversation_room.id = ${agentActions.conversation_id}
          AND conversation_room.org_id = ${agentActions.org_id}
          AND NOT ${readable('conversation_room')}
      )
      AND NOT EXISTS (
        SELECT 1 FROM messages room_message
        -- A message whose room is missing or in another workspace fails closed.
        LEFT JOIN spaces message_room
          ON message_room.id = room_message.space_id AND message_room.org_id = room_message.org_id
        WHERE room_message.id IN (${agentActions.message_id}, ${agentActions.params}->>'source_message_id')
          AND room_message.org_id = ${agentActions.org_id}
          AND NOT COALESCE(${readable('message_room')}, false)
      ))`;
}

/**
 * True while the action's requester (`actionRequesterIdSql`) can still read,
 * now, every room a Defty action came from (DFX1's history rule), and is an
 * active member of the workspace whenever the action names a room. For a
 * capture the rooms include its captured room (params). False once they lost
 * one: removed from it, left it, it was made private without them, they left
 * the workspace or became a guest of it (no unjoined public rooms). Employee
 * actions and actions that name no room are true. A reference to a room that
 * is not in the workspace adds no room. An archived room stays readable for
 * its members (an archived public room is not readable unjoined).
 *
 * DFX2: the pending-approval claims evaluate this in the claiming statement,
 * and the access changes that end a room close the pending ones in their own
 * transaction (lib/lost-room-action-cancellation.ts), with a sweep behind.
 */
export function requesterKeepsSourceRoomsSql(): SQL {
  const requester = actionRequesterIdSql();
  const isCapture = sql`COALESCE(${agentActions.source} = 'defty_capture', false)`;
  const captureRoom = sql`COALESCE(
    ${agentActions.params}->>'source_space_id',
    ${agentActions.params}->>'origin_space_id',
    ${agentActions.params}->>'space_id')`;
  const namesRoom = sql`(${agentActions.conversation_id} IS NOT NULL OR ${agentActions.message_id} IS NOT NULL
    OR (${agentActions.params}->>'source_message_id') IS NOT NULL)`;
  // A person who leaves the workspace loses its room memberships with it;
  // requiring the workspace membership too also covers a room membership
  // added concurrently with the removal.
  const activeMember = sql`EXISTS (SELECT 1 FROM org_members requester_membership
    WHERE requester_membership.org_id = ${agentActions.org_id}
      AND requester_membership.user_id = ${requester}
      AND requester_membership.is_active = true)`;
  const captureRoomReadable = sql`NOT EXISTS (
      SELECT 1 FROM spaces capture_room
      WHERE capture_room.id = ${captureRoom}
        AND capture_room.org_id = ${agentActions.org_id}
        AND NOT ${readableSpaceSql(requester, sql.raw('capture_room.id'), sql.raw('capture_room.org_id'))}
    )`;
  // A reference that resolves to no room of the workspace adds no room, so
  // the membership check applies only when one does resolve.
  const resolvesRoom = (withCapture: boolean) => sql`(EXISTS (SELECT 1 FROM spaces named_room
      WHERE named_room.org_id = ${agentActions.org_id}
        AND named_room.id IN (${agentActions.conversation_id}${withCapture ? sql`, ${captureRoom}` : sql``}))
    OR EXISTS (SELECT 1 FROM messages named_message
      WHERE named_message.org_id = ${agentActions.org_id}
        AND named_message.id IN (${agentActions.message_id}, ${agentActions.params}->>'source_message_id')))`;
  // A plan step also needs its plan's creator to keep the plan's rooms
  // (DFX3): its own row may name fewer rooms than the plan.
  const planRoomsKept = actionPlanRoomsReadableSql();
  return sql`(${planRoomsKept} AND (CASE
    WHEN ${agentActions.agent_employee_id} IS NOT NULL AND NOT ${canonicalDeftyActionSql()} AND NOT ${isCapture} THEN true
    WHEN ${isCapture} THEN (${captureRoom} IS NULL AND NOT ${namesRoom})
      OR ((NOT ${resolvesRoom(true)} OR ${activeMember}) AND ${captureRoomReadable} AND ${referencedRoomsReadableSql(requester, 'history')})
    WHEN NOT ${namesRoom} THEN true
    ELSE (NOT ${resolvesRoom(false)} OR ${activeMember}) AND ${referencedRoomsReadableSql(requester, 'history')}
  END))`;
}

/** Source snapshots remain governed by their canonical source's current audience. */
export function visibleAgentActionSourceSql(options?: { userId?: string | SQL; orgId?: string | SQL; agentEmployeeId?: string }): SQL {
  const reader = options?.userId ? sql`${options.userId}` : options?.agentEmployeeId ? sql`(
    select reader_employee.user_id from agent_employees reader_employee
    where reader_employee.id = ${options.agentEmployeeId}
      ${options.orgId ? sql`and reader_employee.org_id = ${options.orgId}` : sql``}
      and reader_employee.is_active = true and reader_employee.is_deleted = false
  )` : undefined;
  return sql`case when ${agentActions.agent_employee_id} is null or ${canonicalDeftyActionSql()}
    then true
    else ${currentAgentActionSourceAuthoritySql('agent_actions', reader)} end`;
}

export const MODULE_WRITE_ACTION_NAMES = [
  'module_record_create',
  'module_record_update',
  'module_record_archive',
] as const;

export type ModuleWriteActionName = (typeof MODULE_WRITE_ACTION_NAMES)[number];

export const MODULE_TASK_LINK_WRITE_ACTION_NAMES = [
  'module_record_task_link',
  'module_record_task_unlink',
] as const;

export const MODULE_BULK_WRITE_ACTION_NAMES = [
  'module_record_bulk_create',
] as const;

export const MODULE_GOVERNED_WRITE_ACTION_NAMES = [
  ...MODULE_WRITE_ACTION_NAMES,
  ...MODULE_BULK_WRITE_ACTION_NAMES,
  ...MODULE_TASK_LINK_WRITE_ACTION_NAMES,
] as const;

export type ModuleGovernedWriteActionName =
  (typeof MODULE_GOVERNED_WRITE_ACTION_NAMES)[number];

export function isModuleWriteActionName(action: string): action is ModuleWriteActionName {
  return (MODULE_WRITE_ACTION_NAMES as readonly string[]).includes(action);
}

export function isModuleGovernedWriteActionName(
  action: string,
): action is ModuleGovernedWriteActionName {
  return (MODULE_GOVERNED_WRITE_ACTION_NAMES as readonly string[]).includes(action);
}

/**
 * Current-role visibility guard for agent-action projections. Restricted task
 * visibility cannot be reconstructed from a terminal action envelope, so
 * broad member-facing activity/history surfaces hide module-task links. A
 * caller that separately proves requester/assigned-reviewer ownership may opt
 * them back in (approval inboxes do this after their own predicate).
 */
export function visibleModuleActionSql(
  role?: string,
  options?: {
    userId?: string | SQL;
    orgId?: string | SQL;
    agentEmployeeId?: string;
  },
): SQL {
  // Read at query time: a member or guest who lost a room a Defty action came
  // from (removed, or left) stops seeing it; owners/admins keep the history.
  // The review gate composes the first two parts with its own room rule.
  // DFX3: a plan step also needs the reader to read its plan's rooms (the
  // step's own row may name fewer).
  const room = role === 'owner' || role === 'admin' || !options?.userId
    ? sql`true`
    : sql`(${sourceMessageRoomSql(options.userId, 'history')} AND ${actionPlanRoomsReadableSql(sql`${options.userId}`)})`;
  return sql`${visibleAgentActionSourceSql(options)} and ${moduleRoleAudienceSql(role, options)} and ${room}`;
}

/** The role-dependent part of `visibleModuleActionSql` (module writes and private Defty actions). */
export function moduleRoleAudienceSql(
  role?: string,
  options?: { userId?: string | SQL; orgId?: string | SQL; agentEmployeeId?: string },
): SQL {
  return sql`(${moduleRoleVisibilitySql(role, options)}) and (${privateDeftyActionAudienceSql(role, options)})`;
}

/**
 * A Defty action (no employee, or the canonical Defty envelope) is private to
 * the member who asked for it. Its params/result/before/after state can carry
 * content from private spaces, notes and wiki pages, so for every reader of
 * this predicate (action history, recent, pending, dashboard feeds, inbox,
 * MCP approval reads) the row is visible only to its requester, an assigned
 * approver who is a reviewer of it (lib/agent-action-requester.ts), and org
 * owners/admins; a guest only ever sees rows it requested. In action reads
 * (`visibleModuleActionSql`) a requester or approver who is not an
 * owner/admin also needs to read, now, every room the action came from
 * (`sourceMessageRoomSql`, history rule).
 * Every other member and guest does not receive the row. BYOA employee actions keep their source-audience rule.
 */
function privateDeftyActionAudienceSql(
  role?: string,
  options?: { userId?: string | SQL; orgId?: string | SQL; agentEmployeeId?: string },
): SQL {
  if (role === 'owner' || role === 'admin') return sql`true`;
  // A guest sees only actions it requested; an approver assignment (for
  // example one made before the user became a guest) opens nothing.
  const audience = role === 'guest'
    ? requesterSql(options)
    : requesterOrReviewerSql(options);
  return sql`(
    NOT (${agentActions.agent_employee_id} IS NULL OR ${canonicalDeftyActionSql()})
    OR ${audience}
  )`;
}

function requesterSql(options?: { userId?: string | SQL }): SQL {
  return options?.userId
    ? sql`(${actionRequesterIdSql()} = ${options.userId})`
    : sql`false`;
}

/** The requester, or a user whose approver assignment names a reviewer of the action. */
function requesterOrReviewerSql(
  options?: { userId?: string | SQL; orgId?: string | SQL; agentEmployeeId?: string },
): SQL {
  return options?.userId
    ? sql`(
        ${actionRequesterIdSql()} = ${options.userId}
        OR (
          EXISTS (
            SELECT 1
            FROM ${agentActionApprovers}
            WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
              AND ${agentActionApprovers.org_id} = ${agentActions.org_id}
              ${options.orgId
                ? sql`AND ${agentActionApprovers.org_id} = ${options.orgId}`
                : sql``}
              AND ${agentActionApprovers.user_id} = ${options.userId}
          )
          AND ${actionReviewerSql(sql`${options.userId}`)}
        )
      )`
    : options?.agentEmployeeId
      ? sql`${agentActions.agent_employee_id} = ${options.agentEmployeeId}`
      : sql`false`;
}

function moduleRoleVisibilitySql(
  role?: string,
  options?: { userId?: string | SQL; orgId?: string | SQL; agentEmployeeId?: string },
): SQL {
  if (role === 'guest') {
    return notInArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES]);
  }
  if (role === 'owner' || role === 'admin') return sql`true`;

  const requesterOrReviewer = requesterOrReviewerSql(options);
  return sql`(
    ${notInArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES])}
    OR ${requesterOrReviewer}
  )`;
}

export function visibleModuleActionScopeSql(
  scopes: readonly string[],
  access: 'read' | 'write' = 'read',
): SQL {
  const canRead = scopes.includes('read:modules');
  const canWrite = scopes.includes('write:modules');
  if (!canRead || (access === 'write' && !canWrite)) {
    return notInArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES]);
  }
  // Approval is a mutation entry point too: Module authority alone cannot
  // authorize changing a native task's record links.
  return access === 'write' && !scopes.includes('write:tasks')
    ? notInArray(agentActions.action, [...MODULE_TASK_LINK_WRITE_ACTION_NAMES])
    : sql`true`;
}

export function visibleModuleAttentionScopeSql(
  scopes: readonly string[],
  access: 'read' | 'write' = 'read',
): SQL {
  const canRead = scopes.includes('read:modules');
  const canWrite = scopes.includes('write:modules');
  if (canRead && (access === 'read' || canWrite)) return sql`true`;
  return sql`NOT (
    ${attentionItems.source_type} = 'agent_action'
    AND EXISTS (
      SELECT 1
      FROM ${agentActions}
      WHERE ${agentActions.id} = ${attentionItems.source_id}
        AND ${inArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES])}
    )
  )`;
}
