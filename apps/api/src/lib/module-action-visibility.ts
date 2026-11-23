import { inArray, notInArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { agentActionApprovers, agentActions, attentionItems } from '@deft/db/schema';
import { currentAgentActionSourceAuthoritySql, currentUserSpaceAuthoritySql } from './agent-channel-authority.js';
import { actionRequesterIdSql, actionReviewerSql } from './agent-action-requester.js';
import { DEFTY_SYSTEM_EMPLOYEE_SLUG, DEFTY_SYSTEM_RUNTIME_KIND } from './defty-identity.js';
import { publicSpaceVisibleSql } from './space-visibility.js';

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
 * `history` also lets a member read an archived room, as the room itself does
 * (`readableSpaceSql`), so archiving a room does not empty its members'
 * action history. Captures carry their room in params
 * (`visibleCaptureActionSql`); employee actions follow their own source rule
 * (`currentAgentActionSourceAuthoritySql`).
 */
export function sourceMessageRoomSql(userId: string | SQL, rule: 'review' | 'history' = 'review'): SQL {
  const readable = (room: string) => rule === 'history'
    ? sql`(EXISTS (SELECT 1 FROM space_members ${sql.raw(room)}_member
          WHERE ${sql.raw(room)}_member.space_id = ${sql.raw(room)}.id AND ${sql.raw(room)}_member.user_id = ${userId})
        OR (${sql.raw(room)}.is_archived = false
          AND ${publicSpaceVisibleSql(sql.raw(`${room}.type`), sql.raw(`${room}.org_id`), userId)}))`
    : currentUserSpaceAuthoritySql(sql.raw(`${room}.org_id`), sql`${userId}`, sql.raw(`${room}.id`));
  // CASE keeps the order: rows without a room reference, captures and
  // employee actions never run the room lookups.
  return sql`(CASE
    WHEN ${agentActions.conversation_id} IS NULL AND ${agentActions.message_id} IS NULL
      AND (${agentActions.params}->>'source_message_id') IS NULL THEN true
    WHEN COALESCE(${agentActions.source} = 'defty_capture', false) THEN true
    WHEN ${agentActions.agent_employee_id} IS NOT NULL AND NOT ${canonicalDeftyActionSql()} THEN true
    ELSE NOT EXISTS (
        SELECT 1 FROM spaces conversation_room
        WHERE conversation_room.id = ${agentActions.conversation_id}
          AND conversation_room.org_id = ${agentActions.org_id}
          AND NOT ${readable('conversation_room')}
      )
      AND NOT EXISTS (
        SELECT 1 FROM messages room_message
        INNER JOIN spaces message_room ON message_room.id = room_message.space_id
        WHERE room_message.id IN (${agentActions.message_id}, ${agentActions.params}->>'source_message_id')
          AND room_message.org_id = ${agentActions.org_id}
          AND message_room.org_id = ${agentActions.org_id}
          AND NOT ${readable('message_room')}
      )
    END)`;
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
  const room = role === 'owner' || role === 'admin' || !options?.userId
    ? sql`true`
    : sourceMessageRoomSql(options.userId, 'history');
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
