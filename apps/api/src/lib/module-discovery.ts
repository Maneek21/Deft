import { employeeModuleActor, listModuleSummaries } from './module-service.js';
import type { ToolContext } from './mcp-tools/types.js';
import { loadAuthorizedAppDiscovery } from './app-discovery.js';

/** Re-evaluate installation access even when the rest of a context packet is cached. */
export async function readEmployeeModuleDiscovery(
  ctx: ToolContext,
  load = listModuleSummaries,
  loadApps = loadAuthorizedAppDiscovery,
) {
  if (ctx.scopes !== undefined && !ctx.scopes.includes('read:modules')) {
    return { installed_modules: [], module_discovery: {
      status: 'unavailable' as const, code: 'SCOPE_REQUIRED',
      message: 'Module discovery requires read:modules. Do not infer that no Apps are installed.',
    }, installed_apps: [], app_discovery: {
      status: 'unavailable' as const, code: 'SCOPE_REQUIRED',
      message: 'App discovery requires read:modules and read:apps.',
    } };
  }
  try {
    const actor = employeeModuleActor({
      orgId: ctx.org_id, employeeId: ctx.employee_id, trustLevel: ctx.trust_level, source: 'mcp', scopes: ctx.scopes,
    });
    const modules = await load(actor);
    const moduleProjection = modules.map((module) => ({
        module_id: module.module_id, installation_id: module.installation_id, name: module.name,
        version: module.version, manifest_digest: module.manifest_digest, collections: module.collections,
        url: `/modules/${encodeURIComponent(module.slug)}`, untrusted_metadata: true,
        retrieval_hint: { tool: 'module_schema_get', args_template: { caller_employee_slug: ctx.employee_slug, module_id: module.module_id } },
      }));
    if (ctx.scopes !== undefined && !ctx.scopes.includes('read:apps')) {
      return {
        installed_modules: moduleProjection,
        module_discovery: { status: 'ready' as const },
        installed_apps: [],
        app_discovery: {
          status: 'unavailable' as const,
          code: 'SCOPE_REQUIRED' as const,
          message: 'App discovery requires read:apps. Do not infer that no Apps are installed.',
        },
      };
    }
    try {
      return {
        installed_modules: moduleProjection,
      module_discovery: { status: 'ready' as const },
        ...await loadApps(actor, modules),
      };
    } catch {
      return {
        installed_modules: moduleProjection,
        module_discovery: { status: 'ready' as const },
        installed_apps: [],
        app_discovery: {
          status: 'unavailable' as const,
          code: 'LOOKUP_FAILED' as const,
          message: 'App discovery failed. Retry platform_context before describing installed Apps.',
        },
      };
    }
  } catch {
    return { installed_modules: [], module_discovery: {
      status: 'unavailable' as const, code: 'LOOKUP_FAILED',
      message: 'Module discovery failed. Retry module_list before describing the installed Apps.',
    }, installed_apps: [], app_discovery: {
      status: 'unavailable' as const, code: 'LOOKUP_FAILED',
      message: 'App discovery could not run because Module discovery failed.',
    } };
  }
}
