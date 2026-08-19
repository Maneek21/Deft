import { inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { agentActionApprovers, agentActions, attentionItems } from '@deft/db/schema';

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

export const MODULE_GOVERNED_WRITE_ACTION_NAMES = [
  ...MODULE_WRITE_ACTION_NAMES,
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
    userId?: string;
    orgId?: string;
    agentEmployeeId?: string;
  },
): SQL {
  if (role === 'guest') {
    return notInArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES]);
  }
  if (role === 'owner' || role === 'admin') return sql`true`;

  const requesterOrReviewer = options?.userId
    ? sql`(
        ${agentActions.user_id} = ${options.userId}
        OR COALESCE(
          ${agentActions.params}->>'source_user_id',
          ${agentActions.params}->>'origin_user_id'
        ) = ${options.userId}
        OR EXISTS (
          SELECT 1
          FROM ${agentActionApprovers}
          WHERE ${agentActionApprovers.action_id} = ${agentActions.id}
            ${options.orgId
              ? sql`AND ${agentActionApprovers.org_id} = ${options.orgId}`
              : sql``}
            AND ${agentActionApprovers.user_id} = ${options.userId}
        )
      )`
    : options?.agentEmployeeId
      ? sql`${agentActions.agent_employee_id} = ${options.agentEmployeeId}`
      : sql`false`;

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
  return canRead && (access === 'read' || canWrite)
    ? sql`true`
    : notInArray(agentActions.action, [...MODULE_GOVERNED_WRITE_ACTION_NAMES]);
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
