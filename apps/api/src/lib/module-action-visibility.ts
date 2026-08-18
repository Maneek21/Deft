import { notInArray, sql, type SQL } from 'drizzle-orm';
import { agentActions, attentionItems } from '@deft/db/schema';

export const MODULE_WRITE_ACTION_NAMES = [
  'module_record_create',
  'module_record_update',
  'module_record_archive',
] as const;

export type ModuleWriteActionName = (typeof MODULE_WRITE_ACTION_NAMES)[number];

export function isModuleWriteActionName(action: string): action is ModuleWriteActionName {
  return (MODULE_WRITE_ACTION_NAMES as readonly string[]).includes(action);
}

/** Current-role visibility guard for every agent-action projection. */
export function visibleModuleActionSql(role?: string): SQL {
  return role === 'guest'
    ? notInArray(agentActions.action, [...MODULE_WRITE_ACTION_NAMES])
    : sql`true`;
}

export function visibleModuleActionScopeSql(
  scopes: readonly string[],
  access: 'read' | 'write' = 'read',
): SQL {
  const canRead = scopes.includes('read:modules');
  const canWrite = scopes.includes('write:modules');
  return canRead && (access === 'read' || canWrite)
    ? sql`true`
    : notInArray(agentActions.action, [...MODULE_WRITE_ACTION_NAMES]);
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
        AND ${agentActions.action} IN (
          'module_record_create',
          'module_record_update',
          'module_record_archive'
        )
    )
  )`;
}
