import { and, eq, inArray } from 'drizzle-orm';
import {
  appActionBindings,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appVersions,
  agentEmployees,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpToolOverrides,
  moduleVersions,
  orgMembers,
} from '@deft/db/schema';
import {
  DeftAppManifestSchema,
  type DeftAppManifest,
} from '@deft/app-kit';
import { CapabilityProviderDiscoverySnapshotSchema } from '@deft/shared';
import type { ModuleActor, ModuleSummary } from '@deft/shared/modules';
import { db } from './db.js';
import { canonicalMcpToolName, isMcpToolEnabled } from './mcp-tool-identity.js';

const MAX_DISCOVERED_APPS = 25;

export type AppDiscoveryEmployeeAuthority = Readonly<{
  id: string;
  org_id: string;
  is_active: boolean;
  is_deleted: boolean;
  unhealthy: boolean;
  daily_action_count: number;
  max_daily_actions: number;
  mcp_connection_ids: readonly string[] | null;
  disabled_tools: readonly string[] | null;
  membership_active: boolean | null;
}>;

/** Keep the catalog's persisted readiness no broader than capability_list. */
export function appDiscoveryActorCanUseBinding(
  actor: ModuleActor,
  binding: Readonly<{
    mcp_connection_id: string;
    operation_name: string;
    risk_class: string;
  }>,
  employee: AppDiscoveryEmployeeAuthority | null,
): boolean {
  if (actor.kind === 'system') return false;
  if (actor.kind !== 'agent_employee') return true;
  return Boolean(
    employee
    && employee.id === actor.actor_id
    && employee.org_id === actor.org_id
    && employee.is_active
    && !employee.is_deleted
    && !employee.unhealthy
    && employee.membership_active
    && (employee.mcp_connection_ids ?? []).includes(binding.mcp_connection_id)
    && !(employee.disabled_tools ?? []).some(
      (toolName) => canonicalMcpToolName(toolName) === binding.operation_name,
    )
    && (binding.risk_class === 'read' || employee.daily_action_count < employee.max_daily_actions),
  );
}

export type AppDiscoveryCandidate = Readonly<{
  org_id: string;
  installation_id: string;
  version_id: string;
  grant_snapshot_id: string | null;
  app_id: string;
  version: string;
  manifest: unknown;
  authority_healthy: boolean;
  module_bindings: readonly Readonly<{
    owner_installation_id: string;
    owner_version_id: string;
    module_id: string;
    module_installation_id: string;
    module_version: string;
    module_manifest_digest: string;
  }>[];
  dependency_locks: readonly Readonly<{
    dependency_key: string;
    dependency_installation_id: string;
    dependency_version_id: string;
    healthy: boolean;
  }>[];
  action_setup: Readonly<Record<string, boolean>>;
}>;

export type AppDiscoveryProjection = Readonly<{
  installed_apps: readonly Readonly<{
    app_id: string;
    installation_id: string;
    name: string;
    version: string;
    untrusted_metadata: true;
    modules: readonly Readonly<{
      module_id: string;
      installation_id: string;
      collections: readonly Readonly<{
        collection_key: string;
        actions: readonly Readonly<{
          action_key: string;
          label: string;
          setup_state: 'available' | 'setup_required';
        }>[];
        record_retrieval_hint: Readonly<{
          tool: 'module_record_search';
          args_template: Readonly<{ module_id: string; collection_key: string; query: '<query>' }>;
        }>;
        action_retrieval_hint: Readonly<{
          tool: 'capability_list';
          args_template: Readonly<{ resource_ref: '<resource ref from an authorized record result>' }>;
        }>;
      }>[];
    }>[];
  }>[];
  app_discovery: Readonly<({
    status: 'ready';
    has_more: false;
  } | {
    status: 'partial';
    code: 'TRUNCATED';
    has_more: true;
    message: 'More authorized Apps are installed than fit in this context response.';
  }) & {
    authority: 'discovery_only';
    setup_message: 'Use capability_list on an authorized record for current binding availability.';
  }>;
}>;

function parseManifest(value: unknown): DeftAppManifest | null {
  const parsed = DeftAppManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Pure, bounded projection. Candidate metadata is untrusted and only survives
 * when its exact Module installation is already visible to the caller.
 */
export function projectAuthorizedAppDiscovery(
  orgId: string,
  visibleModules: readonly ModuleSummary[],
  candidates: readonly AppDiscoveryCandidate[],
): AppDiscoveryProjection {
  const visibleByInstallation = new Map(visibleModules.map((module) => [module.installation_id, module]));
  const authorizedApps: AppDiscoveryProjection['installed_apps'][number][] = [];

  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const orderedCandidates = [...candidates].sort((left, right) => (
    compare(left.app_id, right.app_id) || compare(left.installation_id, right.installation_id)
  ));
  for (const candidate of orderedCandidates) {
    if (candidate.org_id !== orgId) continue;
    const manifest = parseManifest(candidate.manifest);
    if (!manifest || manifest.id !== candidate.app_id || manifest.version !== candidate.version) continue;

    const dependencyByKey = new Map(candidate.dependency_locks.map((lock) => [lock.dependency_key, lock]));
    const connectedManifest = 'actions' in manifest ? manifest : null;
    const dependenciesHealthy = connectedManifest !== null
      && candidate.dependency_locks.length === connectedManifest.dependencies.length
      && connectedManifest.dependencies.every((dependency) => (
        dependencyByKey.get(dependency.key)?.healthy === true
      ));
    const modules = new Map<string, {
      module_id: string;
      installation_id: string;
      collections: Map<string, {
        collection_key: string;
        actions: Array<{ action_key: string; label: string; setup_state: 'available' | 'setup_required' }>;
      }>;
    }>();

    const addVisibleModule = (binding: AppDiscoveryCandidate['module_bindings'][number]) => {
      const visibleModule = visibleByInstallation.get(binding.module_installation_id);
      if (
        !visibleModule
        || visibleModule.module_id !== binding.module_id
        || visibleModule.version !== binding.module_version
        || visibleModule.manifest_digest !== binding.module_manifest_digest
      ) return null;
      let moduleProjection = modules.get(visibleModule.installation_id);
      if (!moduleProjection) {
        moduleProjection = {
          module_id: visibleModule.module_id,
          installation_id: visibleModule.installation_id,
          collections: new Map(visibleModule.collections.map((collection) => [
            collection.key,
            { collection_key: collection.key, actions: [] },
          ])),
        };
        modules.set(visibleModule.installation_id, moduleProjection);
      }
      return { visibleModule, moduleProjection };
    };

    // App/Module visibility does not depend on connected authority. Protocol 0
    // Apps and connected Apps awaiting review still own useful Module surfaces.
    for (const moduleReference of manifest.modules) {
      const binding = candidate.module_bindings.find((item) => (
        item.owner_installation_id === candidate.installation_id
        && item.owner_version_id === candidate.version_id
        && item.module_id === moduleReference.module_id
      ));
      if (binding) addVisibleModule(binding);
    }

    for (const action of connectedManifest?.actions ?? []) {
      const resource = connectedManifest!.resource_requirements.find(
        (item) => item.key === action.placement.resource_requirement_key,
      );
      if (!resource) continue;
      const owner = resource.source.kind === 'included_module'
        ? { installation_id: candidate.installation_id, version_id: candidate.version_id }
        : dependencyByKey.get(resource.source.dependency_key)?.healthy
          ? {
              installation_id: dependencyByKey.get(resource.source.dependency_key)!.dependency_installation_id,
              version_id: dependencyByKey.get(resource.source.dependency_key)!.dependency_version_id,
            }
          : null;
      if (!owner) continue;
      const binding = candidate.module_bindings.find((item) => (
        item.owner_installation_id === owner.installation_id
        && item.owner_version_id === owner.version_id
        && item.module_id === resource.source.module_id
      ));
      if (!binding) continue;
      const projected = addVisibleModule(binding);
      if (!projected || projected.visibleModule.module_id !== resource.source.module_id) continue;
      const collection = projected.moduleProjection.collections.get(resource.resource_type);
      if (!collection) continue;
      collection.actions.push({
        action_key: action.key,
        label: action.label,
        setup_state: candidate.authority_healthy
          && candidate.action_setup[action.key] === true
          && dependenciesHealthy
          ? 'available'
          : 'setup_required',
      });
    }

    const moduleList = [...modules.values()].map((module) => ({
      module_id: module.module_id,
      installation_id: module.installation_id,
      collections: [...module.collections.values()].map((collection) => ({
        collection_key: collection.collection_key,
        actions: collection.actions,
        record_retrieval_hint: {
          tool: 'module_record_search' as const,
          args_template: {
            module_id: module.module_id,
            collection_key: collection.collection_key,
            query: '<query>' as const,
          },
        },
        action_retrieval_hint: {
          tool: 'capability_list' as const,
          args_template: {
            resource_ref: '<resource ref from an authorized record result>' as const,
          },
        },
      })),
    }));
    if (moduleList.length === 0) continue;
    authorizedApps.push({
      app_id: candidate.app_id,
      installation_id: candidate.installation_id,
      name: manifest.name,
      version: candidate.version,
      untrusted_metadata: true,
      modules: moduleList,
    });
    if (authorizedApps.length > MAX_DISCOVERED_APPS) break;
  }

  const hasMore = authorizedApps.length > MAX_DISCOVERED_APPS;
  return {
    installed_apps: authorizedApps.slice(0, MAX_DISCOVERED_APPS),
    app_discovery: hasMore ? {
      status: 'partial',
      code: 'TRUNCATED',
      has_more: true,
      authority: 'discovery_only',
      setup_message: 'Use capability_list on an authorized record for current binding availability.',
      message: 'More authorized Apps are installed than fit in this context response.',
    } : {
      status: 'ready',
      has_more: false,
      authority: 'discovery_only',
      setup_message: 'Use capability_list on an authorized record for current binding availability.',
    },
  };
}

function operationMatchesSnapshot(
  stored: {
    safe_snapshot: unknown;
    snapshot_digest: string;
    adapter_contract_version: string;
    provider_kind: string;
    provider_instance_id: string;
  },
  binding: { operation_name: string; operation_schema_digest: string; mcp_connection_id: string },
  orgId: string,
): boolean {
  const parsed = CapabilityProviderDiscoverySnapshotSchema.safeParse(stored.safe_snapshot);
  if (!parsed.success) return false;
  if (
    stored.provider_kind !== 'mcp'
    || stored.provider_instance_id !== binding.mcp_connection_id
    || parsed.data.snapshot_digest !== stored.snapshot_digest
    || parsed.data.adapter_contract_version !== stored.adapter_contract_version
    || parsed.data.provider.org_id !== orgId
    || parsed.data.provider.provider_kind !== 'mcp'
    || parsed.data.provider.provider_instance_id !== binding.mcp_connection_id
  ) return false;
  return parsed.data.operations.some((operation) => (
    operation.identity.operation_name === binding.operation_name
    && operation.schema_digest === binding.operation_schema_digest
  ));
}

/** Query tenant-local rows, then leave the authority intersection to the pure projector. */
export async function loadAuthorizedAppDiscovery(
  actor: ModuleActor,
  visibleModules: readonly ModuleSummary[],
): Promise<AppDiscoveryProjection> {
  if (visibleModules.length === 0) return projectAuthorizedAppDiscovery(actor.org_id, visibleModules, []);
  const active = await db.select({
    org_id: appInstallations.org_id,
    installation_id: appInstallations.id,
    app_id: appInstallations.app_id,
    version_id: appVersions.id,
    version: appVersions.version,
    manifest: appVersions.manifest,
    protocol_version: appVersions.protocol_version,
    manifest_digest: appVersions.manifest_digest,
    package_digest: appVersions.package_digest,
    grant_snapshot_id: appGrantSnapshots.id,
    grant_app_id: appGrantSnapshots.app_id,
    grant_app_version: appGrantSnapshots.app_version,
    grant_manifest_digest: appGrantSnapshots.manifest_digest,
    grant_package_digest: appGrantSnapshots.package_digest,
  }).from(appInstallations)
    .innerJoin(appVersions, and(
      eq(appVersions.org_id, appInstallations.org_id),
      eq(appVersions.installation_id, appInstallations.id),
      eq(appVersions.id, appInstallations.active_version_id),
      eq(appVersions.state, 'active'),
    ))
    .leftJoin(appGrantSnapshots, and(
      eq(appGrantSnapshots.org_id, appInstallations.org_id),
      eq(appGrantSnapshots.app_installation_id, appInstallations.id),
      eq(appGrantSnapshots.app_version_id, appVersions.id),
      eq(appGrantSnapshots.id, appInstallations.active_grant_snapshot_id),
      eq(appGrantSnapshots.snapshot_kind, 'effective'),
    ))
    .where(and(
      eq(appInstallations.org_id, actor.org_id),
      eq(appInstallations.state, 'active'),
    ));
  if (active.length === 0) return projectAuthorizedAppDiscovery(actor.org_id, visibleModules, []);

  const installationIds = active.map((item) => item.installation_id);
  const versionIds = active.map((item) => item.version_id);
  const grantIds = active
    .map((item) => item.grant_snapshot_id)
    .filter((id): id is string => id !== null);
  const visibleInstallationIds = visibleModules.map((item) => item.installation_id);

  const ownedBindings = await db.select({
      owner_installation_id: appModuleBindings.app_installation_id,
      owner_version_id: appModuleBindings.app_version_id,
      module_id: appModuleBindings.module_id,
      module_installation_id: appModuleBindings.module_installation_id,
      module_version: moduleVersions.version,
      module_manifest_digest: moduleVersions.manifest_digest,
    }).from(appModuleBindings).innerJoin(moduleVersions, and(
      eq(moduleVersions.org_id, appModuleBindings.org_id),
      eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
      eq(moduleVersions.id, appModuleBindings.module_version_id),
    )).where(and(
      eq(appModuleBindings.org_id, actor.org_id),
      inArray(appModuleBindings.module_installation_id, visibleInstallationIds),
    ));
  const [dependencyLocks, actionBindings] = grantIds.length === 0
    ? [[], []] as const
    : await Promise.all([
        db.select().from(appDependencyLocks).where(and(
          eq(appDependencyLocks.org_id, actor.org_id),
          inArray(appDependencyLocks.grant_snapshot_id, grantIds),
        )),
        db.select().from(appActionBindings).where(and(
          eq(appActionBindings.org_id, actor.org_id),
          inArray(appActionBindings.app_installation_id, installationIds),
          inArray(appActionBindings.app_version_id, versionIds),
          inArray(appActionBindings.grant_snapshot_id, grantIds),
        )),
      ]);

  const dependencyInstallationIds = dependencyLocks.map((lock) => lock.dependency_installation_id);
  const dependencyVersionIds = dependencyLocks.map((lock) => lock.dependency_version_id);
  const dependencyState = dependencyLocks.length === 0 ? [] : await db.select({
    installation_id: appInstallations.id,
    app_id: appInstallations.app_id,
    state: appInstallations.state,
    active_version_id: appInstallations.active_version_id,
    lifecycle_epoch: appInstallations.lifecycle_epoch,
    version_id: appVersions.id,
    version: appVersions.version,
    manifest_digest: appVersions.manifest_digest,
    package_digest: appVersions.package_digest,
    version_state: appVersions.state,
  }).from(appInstallations).innerJoin(appVersions, and(
    eq(appVersions.org_id, appInstallations.org_id),
    eq(appVersions.installation_id, appInstallations.id),
  )).where(and(
    eq(appInstallations.org_id, actor.org_id),
    inArray(appInstallations.id, dependencyInstallationIds),
    inArray(appVersions.id, dependencyVersionIds),
  ));

  const connectionIds = actionBindings.map((binding) => binding.mcp_connection_id);
  const snapshotIds = actionBindings.map((binding) => binding.provider_snapshot_id);
  const [connections, overrides, snapshots] = actionBindings.length === 0
    ? [[], [], []] as const
    : await Promise.all([
        db.select().from(mcpConnections).where(and(
          eq(mcpConnections.org_id, actor.org_id),
          inArray(mcpConnections.id, connectionIds),
        )),
        db.select().from(mcpToolOverrides).where(and(
          eq(mcpToolOverrides.org_id, actor.org_id),
          inArray(mcpToolOverrides.mcp_connection_id, connectionIds),
        )),
        db.select().from(capabilityProviderSnapshots).where(and(
          eq(capabilityProviderSnapshots.org_id, actor.org_id),
          inArray(capabilityProviderSnapshots.id, snapshotIds),
        )),
      ]);

  const employeeAuthority: AppDiscoveryEmployeeAuthority | null = actor.kind === 'agent_employee'
    ? (await db.select({
        id: agentEmployees.id,
        org_id: agentEmployees.org_id,
        is_active: agentEmployees.is_active,
        is_deleted: agentEmployees.is_deleted,
        unhealthy: agentEmployees.unhealthy,
        daily_action_count: agentEmployees.daily_action_count,
        max_daily_actions: agentEmployees.max_daily_actions,
        mcp_connection_ids: agentEmployees.mcp_connection_ids,
        disabled_tools: agentEmployees.disabled_tools,
        membership_active: orgMembers.is_active,
      }).from(agentEmployees).leftJoin(orgMembers, and(
        eq(orgMembers.org_id, agentEmployees.org_id),
        eq(orgMembers.user_id, agentEmployees.user_id),
      )).where(and(
        eq(agentEmployees.org_id, actor.org_id),
        eq(agentEmployees.id, actor.actor_id),
      )).limit(1))[0] ?? null
    : null;

  const candidates: AppDiscoveryCandidate[] = active.map((item) => {
    const locks = dependencyLocks.filter((lock) => lock.app_installation_id === item.installation_id && lock.grant_snapshot_id === item.grant_snapshot_id);
    const actionSetup: Record<string, boolean> = {};
    for (const binding of actionBindings.filter((row) => (
      row.app_installation_id === item.installation_id
      && row.app_version_id === item.version_id
      && row.grant_snapshot_id === item.grant_snapshot_id
    ))) {
      const connection = connections.find((row) => row.id === binding.mcp_connection_id);
      const operationOverrides = overrides.filter((row) => (
        row.mcp_connection_id === binding.mcp_connection_id
        && canonicalMcpToolName(row.tool_name) === binding.operation_name
      ));
      const snapshot = snapshots.find((row) => (
        row.id === binding.provider_snapshot_id
        && row.provider_instance_id === binding.mcp_connection_id
      ));
      actionSetup[binding.action_key] = Boolean(
        connection?.is_active
        && connection.connection_error === null
        && connection.app_run_authorization_version === binding.connector_authorization_version
        && isMcpToolEnabled(connection.enabled_tools, connection.slug, binding.operation_name)
        && !operationOverrides.some((row) => row.is_disabled)
        && appDiscoveryActorCanUseBinding(actor, binding, employeeAuthority)
        && snapshot
        && operationMatchesSnapshot(snapshot, binding, actor.org_id),
      );
    }
    return {
      ...item,
      authority_healthy: (item.protocol_version === '1' || item.protocol_version === '2')
        && item.grant_snapshot_id !== null
        && item.grant_app_id === item.app_id
        && item.grant_app_version === item.version
        && item.grant_manifest_digest === item.manifest_digest
        && item.grant_package_digest === item.package_digest,
      module_bindings: ownedBindings,
      dependency_locks: locks.map((lock) => {
        const current = dependencyState.find((row) => (
          row.installation_id === lock.dependency_installation_id
          && row.version_id === lock.dependency_version_id
        ));
        return {
          dependency_key: lock.dependency_key,
          dependency_installation_id: lock.dependency_installation_id,
          dependency_version_id: lock.dependency_version_id,
          healthy: Boolean(
            current
            && current.app_id === lock.required_app_id
            && current.state === 'active'
            && current.active_version_id === lock.dependency_version_id
            && current.lifecycle_epoch === lock.dependency_lifecycle_epoch
            && current.version_state === 'active'
            && current.version === lock.required_version
            && current.manifest_digest === lock.dependency_manifest_digest
            && current.package_digest === lock.dependency_package_digest,
          ),
        };
      }),
      action_setup: actionSetup,
    };
  });
  return projectAuthorizedAppDiscovery(actor.org_id, visibleModules, candidates);
}
