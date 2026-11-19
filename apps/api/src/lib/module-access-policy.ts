import type { moduleInstallations } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { ModuleError } from './module-errors.js';

// Who may read or write a module installation. Kept apart from
// module-service.ts, which imports the app's database client, so offline
// tools (the workspace exporter) apply the same rule.

type InstallationRow = typeof moduleInstallations.$inferSelect;
type AccessMode = 'read' | 'write';

export function isAdmin(actor: ModuleActor): boolean {
  return actor.kind === 'human' && (actor.role === 'owner' || actor.role === 'admin');
}

export function assertBaseReadAccess(actor: ModuleActor): void {
  if ((actor.kind === 'human' || actor.kind === 'defty') && actor.role === 'guest') {
    throw new ModuleError('Guests cannot access workspace modules', 'MODULE_ACCESS_DENIED', 403);
  }
  if (
    actor.kind === 'human'
    && actor.source === 'mcp'
    && !actor.scopes.includes('read:modules')
  ) {
    throw new ModuleError('Missing MCP scope: read:modules', 'MODULE_SCOPE_REQUIRED', 403);
  }
}

export function assertBaseWriteAccess(actor: ModuleActor): void {
  if ((actor.kind === 'human' || actor.kind === 'defty') && actor.role === 'guest') {
    throw new ModuleError('Guests cannot access workspace modules', 'MODULE_ACCESS_DENIED', 403);
  }
  if (
    actor.kind === 'human'
    && actor.source === 'mcp'
    && !actor.scopes.includes('write:modules')
  ) {
    throw new ModuleError('Missing MCP scope: write:modules', 'MODULE_SCOPE_REQUIRED', 403);
  }
}

export function assertInstallationAccess(
  actor: ModuleActor,
  installation: Pick<InstallationRow, 'is_enabled' | 'agent_access'>,
  mode: AccessMode,
  options?: { allowDisabledForAdmin?: boolean },
): void {
  if (mode === 'write') assertBaseWriteAccess(actor);
  else assertBaseReadAccess(actor);

  if (!installation.is_enabled) {
    if (!(options?.allowDisabledForAdmin && isAdmin(actor))) {
      throw new ModuleError('Module is disabled', 'MODULE_DISABLED', 409);
    }
  }

  if (actor.kind === 'defty' || actor.kind === 'agent_employee') {
    if (installation.agent_access === 'none') {
      throw new ModuleError('Agent access is not enabled for this module', 'MODULE_ACCESS_DENIED', 403);
    }
    if (mode === 'write' && installation.agent_access !== 'write') {
      throw new ModuleError('Agent write access is not enabled for this module', 'MODULE_ACCESS_DENIED', 403);
    }
  }
}
