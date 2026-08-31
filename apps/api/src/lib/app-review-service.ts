import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  appActionBindings,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appRuns,
  appVersions,
  auditLog,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpToolOverrides,
  moduleInstallations,
  moduleVersions,
} from '@deft/db/schema';
import {
  canonicalAppPrivateInterfaceIdentity,
  type DeftAppManifestV1,
  type DeftAppPackageV1,
  type DeftAppPrivateInterfaceDescriptorV1,
} from '@deft/app-kit';
import type { MCPTool, MCPToolOverride } from '@deft/mcp';
import {
  CapabilityProviderDiscoverySnapshotSchema,
  type CapabilityProviderDiscoverySnapshot,
} from '@deft/shared';
import {
  digestSupportedModuleManifest as digestModuleManifest,
  parseSupportedDeftModuleManifest,
  type DeftModuleManifest,
  type ModuleActor,
} from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import {
  APP_GRANT_SNAPSHOT_VERSION,
  canonicalizeAppGrantValue,
  digestAppGrantValue,
} from './app-grant-service.js';
import { capabilityService, type CapabilityDiscoveryResult } from './capability-service.js';
import { persistCapabilityProviderSnapshotWithExecutor } from './capability-provider-snapshot-repository.js';
import { isMcpToolEnabled } from './mcp-tool-identity.js';
import {
  CONNECTED_APP_ACTION_BINDING_VERSION,
  connectedAppActionBindingMatches,
  connectedAppOperationMatches,
  connectedAppPrivateInterfaceRegistryKey,
  connectedAppToolMatches,
  getConnectedAppPrivateInterface,
  normalizeConnectedMcpOverrides,
} from './app-connected-contract.js';
import {
  assertCurrentModuleManagerWithExecutor,
  installModuleFromManifestWithExecutor,
  invalidateModuleCatalogCaches,
  upgradeAppOwnedModuleAdditivelyWithExecutor,
  type ModuleLifecyclePostCommit,
} from './module-service.js';
import { getIO } from '../socket.js';
import { compareAppSemver } from './app-service.js';
import { safeRunSelection } from './app-run-repository.js';

type ReviewExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;
type Installation = typeof appInstallations.$inferSelect;
type Version = typeof appVersions.$inferSelect;
type RequestedSnapshot = typeof appGrantSnapshots.$inferSelect;
type Connection = typeof mcpConnections.$inferSelect;

const REVIEW_VERSION = 'deft.app_grant_review.v1' as const;
const DEPENDENCY_LOCK_VERSION = 'deft.app_dependency_lock.v1' as const;

export type AppConnectorSelection = Readonly<{
  connector_requirement_key: string;
  mcp_connection_id: string;
}>;

export type ConnectedAppReviewRequest = Readonly<{
  app_version_id: string;
  expected_package_digest: string;
  expected_requested_snapshot_digest: string;
  expected_lifecycle_epoch: number;
  expected_grant_epoch: number;
  connector_selections: readonly AppConnectorSelection[];
}>;

export type ConnectedAppActivationRequest = ConnectedAppReviewRequest & Readonly<{
  expected_review_digest: string;
  accept_host_policy: boolean;
  allow_identical_carry_forward?: boolean;
}>;

export type ConnectedAppReview = Readonly<{
  review_version: typeof REVIEW_VERSION;
  app_installation_id: string;
  app_version_id: string;
  package_digest: string;
  requested_snapshot_id: string;
  requested_snapshot_digest: string;
  lifecycle_epoch: number;
  grant_epoch: number;
  permission_diff: Readonly<{
    kind: 'initial' | 'unchanged' | 'widening_or_incompatible';
    carry_forward_eligible: boolean;
    changed_atoms: readonly string[];
    prior_authority_surface_digest: string | null;
    proposed_authority_surface_digest: string;
  }>;
  classification: Readonly<Record<string, unknown>>;
  resource_rights: readonly unknown[];
  dependencies: readonly ReviewDependency[];
  action_bindings: readonly ReviewActionBinding[];
  authority_surface_digest: string;
  review_digest: string;
}>;

type ReviewDependency = Readonly<{
  dependency_key: string;
  required_app_id: string;
  required_version: string;
  dependency_installation_id: string;
  dependency_version_id: string;
  dependency_manifest_digest: string;
  dependency_package_digest: string;
  dependency_lifecycle_epoch: number;
  ownership: 'preexisting';
  canonical_lock: Readonly<Record<string, unknown>>;
  lock_digest: string;
}>;

type ReviewActionBinding = Readonly<{
  action_key: string;
  capability_requirement_key: string;
  connector_requirement_key: string;
  interface_identity: string;
  provider_kind: 'mcp';
  mcp_connection_id: string;
  provider_snapshot_digest: string;
  provider_adapter_contract_version: string;
  operation_name: DeftAppPrivateInterfaceDescriptorV1['operation_name'];
  operation_schema_digest: string;
  connector_authorization_version: number;
  canonical_binding: Readonly<Record<string, unknown>>;
  binding_digest: string;
}>;

type ModuleDescriptor = Readonly<{
  module_id: string;
  module_version: string;
  manifest_digest: string;
  manifest: DeftModuleManifest;
  module_installation_id: string | null;
  module_version_id: string | null;
}>;

type DependencyContext = Readonly<{
  dependency: DeftAppManifestV1['dependencies'][number];
  installation: Installation;
  version: Version;
  modules: ReadonlyMap<string, ModuleDescriptor>;
}>;

type ReviewContext = Readonly<{
  installation: Installation;
  version: Version;
  requested: RequestedSnapshot;
  manifest: DeftAppManifestV1;
  private_interfaces: ReadonlyMap<string, DeftAppPrivateInterfaceDescriptorV1>;
  package: DeftAppPackageV1;
  included_modules: ReadonlyMap<string, ModuleDescriptor>;
  dependencies: readonly DependencyContext[];
  connections: ReadonlyMap<string, Connection>;
  connector_overrides: ReadonlyMap<string, readonly MCPToolOverride[]>;
}>;

type ProviderEvidence = Readonly<{
  connector_requirement_key: string;
  connection: Connection;
  result: CapabilityDiscoveryResult;
  snapshot: Readonly<CapabilityProviderDiscoverySnapshot>;
  operations: ReadonlyMap<string, Readonly<CapabilityProviderDiscoverySnapshot['operations'][number]>>;
}>;

export interface AppReviewCapabilityPort {
  discover(input: {
    provider_kind: 'mcp';
    mode: 'refresh';
    org_id: string;
    provider_instance_id: string;
    overrides?: MCPToolOverride[];
  }): Promise<CapabilityDiscoveryResult>;
}

function assertHumanManager(
  actor: ModuleActor,
): asserts actor is Extract<ModuleActor, { kind: 'human' }> {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new AppError('Only workspace owners and admins can review Apps', 'APP_ACCESS_DENIED', 403);
  }
}

async function acquireAppLocks(
  executor: ReviewExecutor,
  orgId: string,
  installationIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(installationIds)].sort()) {
    await executor.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app:${orgId}:${id}`}, 0))`,
    );
  }
}

function appError(message: string, code: 'APP_STALE' | 'APP_DEPENDENCY_UNHEALTHY' | 'APP_PROVIDER_UNAVAILABLE') {
  return new AppError(message, code, 409);
}

function exactConnectorSelections(
  manifest: DeftAppManifestV1,
  selections: readonly AppConnectorSelection[],
): Map<string, string> {
  const selected = new Map<string, string>();
  for (const selection of selections) {
    if (selected.has(selection.connector_requirement_key)) {
      throw appError('A connector requirement was selected more than once', 'APP_PROVIDER_UNAVAILABLE');
    }
    selected.set(selection.connector_requirement_key, selection.mcp_connection_id);
  }
  const required = [...manifest.connector_requirements.map((item) => item.key)].sort();
  if (
    selected.size !== required.length
    || required.some((key) => !selected.has(key))
    || [...selected.keys()].some((key) => !required.includes(key))
  ) {
    throw appError('Select exactly one existing connector for every requirement', 'APP_PROVIDER_UNAVAILABLE');
  }
  return selected;
}

async function includedModuleDescriptors(packageValue: DeftAppPackageV1): Promise<Map<string, ModuleDescriptor>> {
  const descriptors = new Map<string, ModuleDescriptor>();
  for (const reference of packageValue.manifest.modules) {
    const artifact = packageValue.artifacts.find((item) => item.path === reference.manifest_path);
    if (!artifact) throw new AppError('Staged App artifact is missing', 'APP_INVALID_PACKAGE', 409);
    const manifest = parseSupportedDeftModuleManifest(JSON.parse(artifact.content) as unknown);
    const manifestDigest = await digestModuleManifest(manifest);
    if (
      manifest.id !== reference.module_id
      || manifest.version !== reference.version
      || artifact.digest !== reference.manifest_digest
    ) {
      throw new AppError('Included Module identity changed after staging', 'APP_INVALID_PACKAGE', 409);
    }
    descriptors.set(reference.module_id, {
      module_id: reference.module_id,
      module_version: reference.version,
      manifest_digest: manifestDigest,
      manifest,
      module_installation_id: null,
      module_version_id: null,
    });
  }
  return descriptors;
}

async function loadDependencyContext(
  executor: ReviewExecutor,
  orgId: string,
  dependency: DeftAppManifestV1['dependencies'][number],
): Promise<DependencyContext> {
  const [row] = await executor.select({ installation: appInstallations, version: appVersions })
    .from(appInstallations)
    .innerJoin(appVersions, and(
      eq(appVersions.org_id, appInstallations.org_id),
      eq(appVersions.installation_id, appInstallations.id),
      eq(appVersions.id, appInstallations.active_version_id),
    ))
    .where(and(
      eq(appInstallations.org_id, orgId),
      eq(appInstallations.app_id, dependency.app_id),
      eq(appInstallations.state, 'active'),
      eq(appVersions.state, 'active'),
      eq(appVersions.version, dependency.version),
    ))
    .limit(1);
  if (!row) {
    throw appError(
      `Dependency ${dependency.app_id}@${dependency.version} is not already active`,
      'APP_DEPENDENCY_UNHEALTHY',
    );
  }
  const bindings = await executor.select({
    binding: appModuleBindings,
    installation: moduleInstallations,
    version: moduleVersions,
  })
    .from(appModuleBindings)
    .innerJoin(moduleInstallations, and(
      eq(moduleInstallations.org_id, appModuleBindings.org_id),
      eq(moduleInstallations.id, appModuleBindings.module_installation_id),
    ))
    .innerJoin(moduleVersions, and(
      eq(moduleVersions.org_id, appModuleBindings.org_id),
      eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
      eq(moduleVersions.id, appModuleBindings.module_version_id),
    ))
    .where(and(
      eq(appModuleBindings.org_id, orgId),
      eq(appModuleBindings.app_installation_id, row.installation.id),
      eq(appModuleBindings.app_version_id, row.version.id),
      eq(moduleInstallations.is_enabled, true),
      eq(moduleVersions.is_active, true),
    ));
  const modules = new Map<string, ModuleDescriptor>();
  for (const binding of bindings) {
    const manifest = parseSupportedDeftModuleManifest(binding.version.manifest);
    const manifestDigest = await digestModuleManifest(manifest);
    if (manifestDigest !== binding.version.manifest_digest) {
      throw appError('A dependency Module manifest failed integrity validation', 'APP_DEPENDENCY_UNHEALTHY');
    }
    modules.set(binding.binding.module_id, {
      module_id: binding.binding.module_id,
      module_version: binding.version.version,
      manifest_digest: binding.version.manifest_digest,
      manifest,
      module_installation_id: binding.installation.id,
      module_version_id: binding.version.id,
    });
  }
  return { dependency, ...row, modules };
}

async function loadReviewContext(
  executor: ReviewExecutor,
  actor: Extract<ModuleActor, { kind: 'human' }>,
  installationId: string,
  request: ConnectedAppReviewRequest,
): Promise<ReviewContext> {
  const [installation] = await executor.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.id, installationId),
  )).limit(1);
  if (!installation) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
  if (
    installation.lifecycle_epoch !== request.expected_lifecycle_epoch
    || installation.grant_epoch !== request.expected_grant_epoch
  ) {
    throw appError('App lifecycle changed before review', 'APP_STALE');
  }
  if (!['staged', 'active', 'disabled'].includes(installation.state)) {
    throw new AppError('App cannot be reviewed in its current state', 'APP_STATE_CONFLICT', 409);
  }
  const [version] = await executor.select().from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id),
    eq(appVersions.installation_id, installation.id),
    eq(appVersions.id, request.app_version_id),
    eq(appVersions.package_digest, request.expected_package_digest),
  )).limit(1);
  const isReactivation = installation.state === 'disabled'
    && installation.active_version_id === version?.id
    && version?.state === 'active';
  if (!version || (version.state !== 'staged' && !isReactivation)) {
    throw appError('The staged App version changed before review', 'APP_STALE');
  }
  if (installation.active_version_id && installation.active_version_id !== version.id) {
    const [activeVersion] = await executor.select({ version: appVersions.version })
      .from(appVersions)
      .where(and(
        eq(appVersions.org_id, actor.org_id),
        eq(appVersions.installation_id, installation.id),
        eq(appVersions.id, installation.active_version_id),
        eq(appVersions.state, 'active'),
      ))
      .limit(1);
    if (!activeVersion || compareAppSemver(activeVersion.version, version.version) >= 0) {
      throw appError('The staged App version is no longer newer than the active version', 'APP_STALE');
    }
  }
  if (version.protocol_version !== '1' || !version.requested_grant_snapshot_id) {
    throw new AppError('Only staged App Protocol v1 versions use connected review', 'APP_PROTOCOL_UNSUPPORTED', 409);
  }
  const manifest = version.manifest as DeftAppManifestV1;
  const packageValue = version.package as unknown as DeftAppPackageV1;
  const privateInterfaces = new Map<string, DeftAppPrivateInterfaceDescriptorV1>();
  const uniquePrivateInterfaces = new Map<string, DeftAppPrivateInterfaceDescriptorV1>();
  for (const requirement of manifest.capability_requirements) {
    const privateInterface = getConnectedAppPrivateInterface(requirement.interface);
    if (!privateInterface) {
      throw new AppError('The App requires an unsupported private interface', 'APP_PROTOCOL_UNSUPPORTED', 409);
    }
    privateInterfaces.set(requirement.key, privateInterface);
    uniquePrivateInterfaces.set(
      connectedAppPrivateInterfaceRegistryKey(privateInterface),
      privateInterface,
    );
  }
  const [requested] = await executor.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, actor.org_id),
    eq(appGrantSnapshots.app_installation_id, installation.id),
    eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'requested'),
    eq(appGrantSnapshots.snapshot_digest, request.expected_requested_snapshot_digest),
  )).limit(1);
  if (!requested) throw appError('The requested grant changed before review', 'APP_STALE');

  const includedModules = await includedModuleDescriptors(packageValue);
  if (installation.active_version_id && installation.active_version_id !== version.id) {
    const priorBindings = await executor.select({ module_id: appModuleBindings.module_id })
      .from(appModuleBindings)
      .where(and(
        eq(appModuleBindings.org_id, actor.org_id),
        eq(appModuleBindings.app_installation_id, installation.id),
        eq(appModuleBindings.app_version_id, installation.active_version_id),
      ));
    const removed = priorBindings
      .map((binding) => binding.module_id)
      .filter((moduleId) => !includedModules.has(moduleId));
    if (removed.length > 0) {
      throw new AppError(
        `Connected App upgrades cannot remove App-owned Modules: ${removed.sort().join(', ')}`,
        'APP_INVALID_PACKAGE',
        409,
      );
    }
  }
  const dependencies: DependencyContext[] = [];
  for (const dependency of [...manifest.dependencies].sort((a, b) => a.key.localeCompare(b.key))) {
    dependencies.push(await loadDependencyContext(executor, actor.org_id, dependency));
  }
  const selected = exactConnectorSelections(manifest, request.connector_selections);
  const connections = new Map<string, Connection>();
  const connectorOverrides = new Map<string, readonly MCPToolOverride[]>();
  for (const connector of [...manifest.connector_requirements].sort((a, b) => a.key.localeCompare(b.key))) {
    const connectionId = selected.get(connector.key)!;
    const [connection] = await executor.select().from(mcpConnections).where(and(
      eq(mcpConnections.org_id, actor.org_id),
      eq(mcpConnections.id, connectionId),
      eq(mcpConnections.is_active, true),
    )).limit(1);
    if (!connection) throw appError('The selected connector is unavailable', 'APP_PROVIDER_UNAVAILABLE');
    const overrideRows = await executor.select({
      tool_name: mcpToolOverrides.tool_name,
      trust_tier_override: mcpToolOverrides.trust_tier_override,
      is_disabled: mcpToolOverrides.is_disabled,
    }).from(mcpToolOverrides).where(and(
      eq(mcpToolOverrides.org_id, actor.org_id),
      eq(mcpToolOverrides.mcp_connection_id, connection.id),
    ));
    const overrides = normalizeConnectedMcpOverrides(overrideRows);
    for (const privateInterface of uniquePrivateInterfaces.values()) {
      if (
        connector.provider_kind !== privateInterface.provider_kind
        || !isMcpToolEnabled(connection.enabled_tools, connection.slug, privateInterface.operation_name)
      ) {
        throw appError('The selected connector does not enable the required operation', 'APP_PROVIDER_UNAVAILABLE');
      }
      if (overrides.some((override) => (
        override.toolName === privateInterface.operation_name && override.disabled
      ))) {
        throw appError('The selected connector operation is disabled', 'APP_PROVIDER_UNAVAILABLE');
      }
    }
    connections.set(connector.key, connection);
    connectorOverrides.set(connector.key, overrides);
  }
  return {
    installation,
    version,
    requested,
    manifest,
    private_interfaces: privateInterfaces,
    package: packageValue,
    included_modules: includedModules,
    dependencies,
    connections,
    connector_overrides: connectorOverrides,
  };
}

async function discoverProviderEvidence(
  actor: Extract<ModuleActor, { kind: 'human' }>,
  context: ReviewContext,
  capability: AppReviewCapabilityPort,
): Promise<Map<string, ProviderEvidence>> {
  const privateInterfaces = new Map(
    [...context.private_interfaces.values()].map((privateInterface) => [
      connectedAppPrivateInterfaceRegistryKey(privateInterface),
      privateInterface,
    ]),
  );
  const entries = await Promise.all([...context.connections.entries()].map(async ([key, connection]) => {
    let result: CapabilityDiscoveryResult;
    try {
      result = await capability.discover({
        provider_kind: 'mcp' as const,
        mode: 'refresh',
        org_id: actor.org_id,
        provider_instance_id: connection.id,
        overrides: [...(context.connector_overrides.get(key) ?? [])],
      });
    } catch {
      throw appError('Provider discovery failed', 'APP_PROVIDER_UNAVAILABLE');
    }
    const snapshot = result.snapshot;
    if (
      !snapshot
      || snapshot.provider.org_id !== actor.org_id
      || snapshot.provider.provider_kind !== 'mcp'
      || snapshot.provider.provider_instance_id !== connection.id
    ) {
      throw appError('Provider discovery evidence is unavailable', 'APP_PROVIDER_UNAVAILABLE');
    }
    const operations = new Map<string, CapabilityProviderDiscoverySnapshot['operations'][number]>();
    for (const [interfaceKey, privateInterface] of privateInterfaces) {
      const operation = snapshot.operations.find(
        (item) => item.identity.operation_name === privateInterface.operation_name,
      );
      const filteredTool = result.tools.find((tool: MCPTool) => (
        tool.originalName === privateInterface.operation_name
      ));
      if (
        !operation
        || !filteredTool
        || !connectedAppOperationMatches(privateInterface, operation)
        || !connectedAppToolMatches(privateInterface, filteredTool)
      ) {
        throw appError('Provider does not implement the required private interface', 'APP_PROVIDER_UNAVAILABLE');
      }
      operations.set(interfaceKey, operation);
    }
    return [key, {
      connector_requirement_key: key,
      connection,
      result,
      snapshot,
      operations,
    }] as const;
  }));
  return new Map(entries);
}

function moduleForRequirement(
  context: ReviewContext,
  requirement: DeftAppManifestV1['resource_requirements'][number],
): ModuleDescriptor {
  if (requirement.source.kind === 'included_module') {
    const module = context.included_modules.get(requirement.source.module_id);
    if (!module || module.module_version !== requirement.source.version) {
      throw appError('An included resource Module is unavailable', 'APP_DEPENDENCY_UNHEALTHY');
    }
    return module;
  }
  const dependencyKey = requirement.source.dependency_key;
  const dependency = context.dependencies.find(
    (item) => item.dependency.key === dependencyKey,
  );
  const module = dependency?.modules.get(requirement.source.module_id);
  if (!module || module.module_version !== requirement.source.version) {
    throw appError('A dependency resource Module is unavailable', 'APP_DEPENDENCY_UNHEALTHY');
  }
  return module;
}

function validateResourceAndActionContracts(context: ReviewContext): void {
  const resourceModules = new Map<string, ModuleDescriptor>();
  for (const requirement of context.manifest.resource_requirements) {
    const module = moduleForRequirement(context, requirement);
    const collection = module.manifest.collections.find((item) => item.key === requirement.resource_type);
    if (!collection) throw appError('A declared resource type does not exist', 'APP_DEPENDENCY_UNHEALTHY');
    const fields = new Set(collection.fields.map((field) => field.key));
    if (requirement.fields.some((field) => !fields.has(field))) {
      throw appError('A declared resource field does not exist', 'APP_DEPENDENCY_UNHEALTHY');
    }
    resourceModules.set(requirement.key, module);
  }
  for (const action of context.manifest.actions) {
    const privateInterface = context.private_interfaces.get(action.capability_requirement_key);
    if (!privateInterface || !connectedAppActionBindingMatches(privateInterface, action)) {
      throw appError(
        'The action input mapping is outside the supported connected App contract',
        'APP_DEPENDENCY_UNHEALTHY',
      );
    }
    const inputConstraints = new Map(
      privateInterface.action_binding.inputs.map((constraint) => [constraint.input_key, constraint]),
    );
    const placement = context.manifest.resource_requirements.find(
      (item) => item.key === action.placement.resource_requirement_key,
    )!;
    for (const binding of action.input_bindings) {
      const source = binding.source;
      if (source.kind === 'selected_relation_field') {
        const sourceRequirement = context.manifest.resource_requirements.find(
          (item) => item.key === source.source_resource_requirement_key,
        )!;
        const targetRequirement = context.manifest.resource_requirements.find(
          (item) => item.key === source.target_resource_requirement_key,
        )!;
        const sourceModule = resourceModules.get(sourceRequirement.key)!;
        const targetModule = resourceModules.get(targetRequirement.key)!;
        const sourceCollection = sourceModule.manifest.collections.find(
          (item) => item.key === sourceRequirement.resource_type,
        )!;
        const relation = sourceCollection.fields.find((field) => field.key === source.relation_field_key);
        if (
          relation?.type !== 'resource_ref'
          || relation.target.module_id !== targetModule.module_id
          || relation.target.resource_type !== targetRequirement.resource_type
        ) {
          throw appError('The selected relation does not match the pinned target resource', 'APP_DEPENDENCY_UNHEALTHY');
        }
      }
      if (source.kind !== 'user_input') {
        const requirementKey = source.kind === 'selected_relation_field'
          ? source.target_resource_requirement_key
          : source.resource_requirement_key;
        const fieldKey = source.kind === 'selected_relation_field' ? source.target_field_key : source.field_key;
        const requirement = context.manifest.resource_requirements.find((item) => item.key === requirementKey)!;
        const module = resourceModules.get(requirement.key)!;
        const field = module.manifest.collections.find((item) => item.key === requirement.resource_type)!
          .fields.find((item) => item.key === fieldKey);
        const constraint = inputConstraints.get(binding.input_key);
        const validType = Boolean(
          field
          && constraint
          && (constraint.allowed_field_types as readonly string[]).includes(field.type),
        );
        if (!validType) {
          throw appError(
            `The ${binding.input_key} binding uses an incompatible resource field`,
            'APP_DEPENDENCY_UNHEALTHY',
          );
        }
      }
    }
    if (!resourceModules.has(placement.key)) {
      throw appError('Action placement resource is unavailable', 'APP_DEPENDENCY_UNHEALTHY');
    }
  }
}

function buildReview(
  context: ReviewContext,
  evidence: ReadonlyMap<string, ProviderEvidence>,
  priorAuthority: Readonly<{
    digest: string;
    surface: Readonly<Record<string, unknown>> | null;
  }> | null,
): ConnectedAppReview {
  validateResourceAndActionContracts(context);
  const dependencies: ReviewDependency[] = context.dependencies.map(({ dependency, installation, version }) => {
    const canonicalLock = canonicalizeAppGrantValue({
      lock_version: DEPENDENCY_LOCK_VERSION,
      dependency_key: dependency.key,
      required_app_id: dependency.app_id,
      required_version: dependency.version,
      dependency_installation_id: installation.id,
      dependency_version_id: version.id,
      dependency_manifest_digest: version.manifest_digest,
      dependency_package_digest: version.package_digest,
      dependency_lifecycle_epoch: installation.lifecycle_epoch,
      ownership: 'preexisting',
    }) as Record<string, unknown>;
    return {
      dependency_key: dependency.key,
      required_app_id: dependency.app_id,
      required_version: dependency.version,
      dependency_installation_id: installation.id,
      dependency_version_id: version.id,
      dependency_manifest_digest: version.manifest_digest,
      dependency_package_digest: version.package_digest,
      dependency_lifecycle_epoch: installation.lifecycle_epoch,
      ownership: 'preexisting',
      canonical_lock: canonicalLock,
      lock_digest: digestAppGrantValue(canonicalLock),
    };
  });
  const actionBindings: ReviewActionBinding[] = context.manifest.actions
    .map((action) => {
      const provider = evidence.get(action.connector_requirement_key);
      if (!provider) throw appError('Action connector evidence is missing', 'APP_PROVIDER_UNAVAILABLE');
      const privateInterface = context.private_interfaces.get(action.capability_requirement_key);
      if (!privateInterface) {
        throw new AppError('Action private interface is unsupported', 'APP_PROTOCOL_UNSUPPORTED', 409);
      }
      const operation = provider.operations.get(
        connectedAppPrivateInterfaceRegistryKey(privateInterface),
      );
      if (!operation) throw appError('Action provider evidence is missing', 'APP_PROVIDER_UNAVAILABLE');
      const interfaceIdentity = canonicalAppPrivateInterfaceIdentity({
        organization_id: context.installation.org_id,
        app_lineage_id: context.installation.id,
        interface_key: privateInterface.key,
        interface_version: privateInterface.version,
      });
      const canonicalBinding = canonicalizeAppGrantValue({
        binding_version: CONNECTED_APP_ACTION_BINDING_VERSION,
        action_key: action.key,
        capability_requirement_key: action.capability_requirement_key,
        connector_requirement_key: action.connector_requirement_key,
        interface_identity: interfaceIdentity,
        provider_kind: privateInterface.provider_kind,
        mcp_connection_id: provider.connection.id,
        provider_snapshot_digest: provider.snapshot.snapshot_digest,
        provider_adapter_contract_version: provider.snapshot.adapter_contract_version,
        operation_name: privateInterface.operation_name,
        operation_schema_digest: operation.schema_digest,
        connector_authorization_version: provider.connection.app_run_authorization_version,
        host_policy: privateInterface.host_policy,
        placement: action.placement,
        input_bindings: action.input_bindings,
      }) as Record<string, unknown>;
      return {
        action_key: action.key,
        capability_requirement_key: action.capability_requirement_key,
        connector_requirement_key: action.connector_requirement_key,
        interface_identity: interfaceIdentity,
        provider_kind: privateInterface.provider_kind,
        mcp_connection_id: provider.connection.id,
        provider_snapshot_digest: provider.snapshot.snapshot_digest,
        provider_adapter_contract_version: provider.snapshot.adapter_contract_version,
        operation_name: privateInterface.operation_name,
        operation_schema_digest: operation.schema_digest,
        connector_authorization_version: provider.connection.app_run_authorization_version,
        canonical_binding: canonicalBinding,
        binding_digest: digestAppGrantValue(canonicalBinding),
      };
    })
    .sort((a, b) => a.action_key.localeCompare(b.action_key));
  const authoritySurface = canonicalizeAppGrantValue({
    dependencies: dependencies.map((item) => item.canonical_lock),
    resources: context.manifest.resource_requirements,
    included_modules: [...context.included_modules.values()].map((item) => ({
      module_id: item.module_id,
      module_version: item.module_version,
      manifest_digest: item.manifest_digest,
    })).sort((a, b) => a.module_id.localeCompare(b.module_id)),
    action_bindings: actionBindings.map((item) => item.canonical_binding),
  });
  const authoritySurfaceDigest = digestAppGrantValue(authoritySurface);
  const priorAuthoritySurfaceDigest = priorAuthority?.digest ?? null;
  const surfaceObject = authoritySurface as Record<string, unknown>;
  const changedAtoms = priorAuthority?.surface
    ? ['dependencies', 'resources', 'included_modules', 'action_bindings'].filter(
        (key) => digestAppGrantValue(priorAuthority.surface?.[key]) !== digestAppGrantValue(surfaceObject[key]),
      )
    : priorAuthority === null ? [] : ['unknown'];
  const permissionDiff = {
    kind: priorAuthoritySurfaceDigest === null
      ? 'initial' as const
      : priorAuthoritySurfaceDigest === authoritySurfaceDigest
        ? 'unchanged' as const
        : 'widening_or_incompatible' as const,
    carry_forward_eligible: priorAuthoritySurfaceDigest === authoritySurfaceDigest,
    changed_atoms: changedAtoms,
    prior_authority_surface_digest: priorAuthoritySurfaceDigest,
    proposed_authority_surface_digest: authoritySurfaceDigest,
  };
  const reviewPrivateInterface = context.private_interfaces.values().next().value;
  if (!reviewPrivateInterface) {
    throw new AppError('App private interface support metadata is missing', 'APP_PROTOCOL_UNSUPPORTED', 409);
  }
  const classification = canonicalizeAppGrantValue({
    authority_state: 'effective',
    execution_gate: 'app_origin_disabled',
    executable: false,
    provider_access: 'governed_only',
    review_required: true,
    host_policy: reviewPrivateInterface.host_policy,
  }) as Record<string, unknown>;
  const reviewWithoutDigest = canonicalizeAppGrantValue({
    review_version: REVIEW_VERSION,
    app_installation_id: context.installation.id,
    app_version_id: context.version.id,
    package_digest: context.version.package_digest,
    requested_snapshot_id: context.requested.id,
    requested_snapshot_digest: context.requested.snapshot_digest,
    lifecycle_epoch: context.installation.lifecycle_epoch,
    grant_epoch: context.installation.grant_epoch,
    permission_diff: permissionDiff,
    classification,
    resource_rights: context.requested.resource_rights,
    dependencies,
    action_bindings: actionBindings,
    authority_surface_digest: authoritySurfaceDigest,
  }) as Record<string, unknown>;
  return {
    review_version: REVIEW_VERSION,
    app_installation_id: context.installation.id,
    app_version_id: context.version.id,
    package_digest: context.version.package_digest,
    requested_snapshot_id: context.requested.id,
    requested_snapshot_digest: context.requested.snapshot_digest,
    lifecycle_epoch: context.installation.lifecycle_epoch,
    grant_epoch: context.installation.grant_epoch,
    permission_diff: permissionDiff,
    classification,
    resource_rights: context.requested.resource_rights,
    dependencies,
    action_bindings: actionBindings,
    authority_surface_digest: authoritySurfaceDigest,
    review_digest: digestAppGrantValue(reviewWithoutDigest),
  };
}

async function latestEffectiveSnapshot(
  executor: ReviewExecutor,
  installation: Installation,
): Promise<typeof appGrantSnapshots.$inferSelect | null> {
  const conditions = [
    eq(appGrantSnapshots.org_id, installation.org_id),
    eq(appGrantSnapshots.app_installation_id, installation.id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  ];
  if (installation.active_grant_snapshot_id) {
    conditions.push(eq(appGrantSnapshots.id, installation.active_grant_snapshot_id));
  } else {
    // A disabled connected App deliberately clears its active authority
    // pointer. Follow the immutable supersession chain to its sole leaf rather
    // than guessing from timestamps (which can legitimately tie).
    conditions.push(sql`NOT EXISTS (
      SELECT 1
        FROM app_grant_snapshots AS successor
       WHERE successor.org_id = ${appGrantSnapshots.org_id}
         AND successor.app_installation_id = ${appGrantSnapshots.app_installation_id}
         AND successor.snapshot_kind = 'effective'
         AND successor.supersedes_snapshot_id = ${appGrantSnapshots.id}
    )`);
  }
  const [snapshot] = await executor.select()
    .from(appGrantSnapshots)
    .where(and(...conditions))
    .orderBy(desc(appGrantSnapshots.created_at), desc(appGrantSnapshots.id))
    .limit(1);
  return snapshot ?? null;
}

async function priorAuthoritySurface(
  executor: ReviewExecutor,
  installation: Installation,
): Promise<Readonly<{
  digest: string;
  surface: Readonly<Record<string, unknown>> | null;
}> | null> {
  const snapshot = await latestEffectiveSnapshot(executor, installation);
  const value = snapshot?.canonical_snapshot.authority_surface_digest;
  if (typeof value !== 'string') return null;
  const surface = snapshot?.canonical_snapshot.authority_surface;
  return {
    digest: value,
    surface: surface !== null && typeof surface === 'object' && !Array.isArray(surface)
      ? surface as Record<string, unknown>
      : null,
  };
}

export async function prepareConnectedAppReview(
  actorValue: ModuleActor,
  installationId: string,
  request: ConnectedAppReviewRequest,
  capability: AppReviewCapabilityPort = capabilityService,
): Promise<ConnectedAppReview> {
  assertHumanManager(actorValue);
  const context = await loadReviewContext(db, actorValue, installationId, request);
  const evidence = await discoverProviderEvidence(actorValue, context, capability);
  return buildReview(
    context,
    evidence,
    await priorAuthoritySurface(db, context.installation),
  );
}

async function lockReviewInputs(
  executor: ReviewExecutor,
  context: ReviewContext,
): Promise<void> {
  await acquireAppLocks(executor, context.installation.org_id, [
    context.installation.id,
    ...context.dependencies.map((item) => item.installation.id),
  ]);
  await executor.select({ id: appInstallations.id }).from(appInstallations).where(and(
    eq(appInstallations.org_id, context.installation.org_id),
    eq(appInstallations.id, context.installation.id),
  )).for('update');
  await executor.select({ id: appVersions.id }).from(appVersions).where(and(
    eq(appVersions.org_id, context.installation.org_id),
    eq(appVersions.installation_id, context.installation.id),
    eq(appVersions.id, context.version.id),
  )).for('update');
  for (const dependency of context.dependencies) {
    await executor.select({ id: appInstallations.id }).from(appInstallations).where(and(
      eq(appInstallations.org_id, context.installation.org_id),
      eq(appInstallations.id, dependency.installation.id),
    )).for('update');
    await executor.select({ id: appVersions.id }).from(appVersions).where(and(
      eq(appVersions.org_id, context.installation.org_id),
      eq(appVersions.installation_id, dependency.installation.id),
      eq(appVersions.id, dependency.version.id),
    )).for('update');
  }
  const connectionIds = [...new Set(
    [...context.connections.values()].map((connection) => connection.id),
  )].sort();
  for (const connectionId of connectionIds) {
    await executor.select({ id: mcpConnections.id }).from(mcpConnections).where(and(
      eq(mcpConnections.org_id, context.installation.org_id),
      eq(mcpConnections.id, connectionId),
    )).for('update');
  }
}

async function installOrCarryIncludedModules(
  executor: ReviewExecutor,
  actor: Extract<ModuleActor, { kind: 'human' }>,
  context: ReviewContext,
  postCommit: ModuleLifecyclePostCommit[],
): Promise<void> {
  for (const descriptor of [...context.included_modules.values()].sort((a, b) => a.module_id.localeCompare(b.module_id))) {
    if (context.installation.active_version_id === context.version.id) {
      const bindings = await executor.select().from(appModuleBindings).where(and(
        eq(appModuleBindings.org_id, actor.org_id),
        eq(appModuleBindings.app_installation_id, context.installation.id),
        eq(appModuleBindings.app_version_id, context.version.id),
        eq(appModuleBindings.module_id, descriptor.module_id),
      ));
      if (bindings.length !== 1) {
        throw new AppError('Connected App Module ownership is incomplete', 'APP_STATE_CONFLICT', 409);
      }
      await executor.update(moduleInstallations).set({
        is_enabled: true,
        disabled_at: null,
        updated_by_actor_type: actor.kind,
        updated_by_actor_id: actor.actor_id,
      }).where(and(
        eq(moduleInstallations.org_id, actor.org_id),
        eq(moduleInstallations.id, bindings[0]!.module_installation_id),
      ));
      continue;
    }
    if (!context.installation.active_version_id) {
      const installed = await installModuleFromManifestWithExecutor(
        executor,
        actor,
        descriptor.manifest,
        { source: 'sideloaded' },
      );
      postCommit.push(installed.postCommit);
      await executor.insert(appModuleBindings).values({
        org_id: actor.org_id,
        app_installation_id: context.installation.id,
        app_version_id: context.version.id,
        module_installation_id: installed.row.installation.id,
        module_version_id: installed.row.version.id,
        module_id: descriptor.module_id,
        ownership: 'app',
      });
      continue;
    }
    const [prior] = await executor.select({ binding: appModuleBindings, version: moduleVersions })
      .from(appModuleBindings)
      .innerJoin(moduleVersions, and(
        eq(moduleVersions.org_id, appModuleBindings.org_id),
        eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
        eq(moduleVersions.id, appModuleBindings.module_version_id),
      ))
      .where(and(
        eq(appModuleBindings.org_id, actor.org_id),
        eq(appModuleBindings.app_installation_id, context.installation.id),
        eq(appModuleBindings.app_version_id, context.installation.active_version_id),
        eq(appModuleBindings.module_id, descriptor.module_id),
      ))
      .limit(1);
    if (!prior) throw new AppError('App-owned Module binding is missing', 'APP_STATE_CONFLICT', 409);
    if (
      prior.version.version !== descriptor.module_version
      || prior.version.manifest_digest !== descriptor.manifest_digest
    ) {
      const upgraded = await upgradeAppOwnedModuleAdditivelyWithExecutor(executor, actor, {
        app_installation_id: context.installation.id,
        module_installation_id: prior.binding.module_installation_id,
        expected_active_manifest_digest: prior.version.manifest_digest,
        manifest: descriptor.manifest,
      });
      postCommit.push(upgraded.postCommit);
      await executor.insert(appModuleBindings).values({
        org_id: actor.org_id,
        app_installation_id: context.installation.id,
        app_version_id: context.version.id,
        module_installation_id: upgraded.row.installation.id,
        module_version_id: upgraded.row.version.id,
        module_id: descriptor.module_id,
        ownership: 'app',
      });
      continue;
    }
    await executor.update(moduleInstallations).set({
      is_enabled: true,
      disabled_at: null,
      updated_by_actor_type: actor.kind,
      updated_by_actor_id: actor.actor_id,
    }).where(and(
      eq(moduleInstallations.org_id, actor.org_id),
      eq(moduleInstallations.id, prior.binding.module_installation_id),
    ));
    await executor.insert(appModuleBindings).values({
      org_id: actor.org_id,
      app_installation_id: context.installation.id,
      app_version_id: context.version.id,
      module_installation_id: prior.binding.module_installation_id,
      module_version_id: prior.binding.module_version_id,
      module_id: descriptor.module_id,
      ownership: 'app',
    });
  }
}

export async function activateConnectedAppInstallation(
  actorValue: ModuleActor,
  installationId: string,
  request: ConnectedAppActivationRequest,
  capability: AppReviewCapabilityPort = capabilityService,
  testHooks?: { failBeforePointerSwap?: boolean },
): Promise<ConnectedAppReview> {
  assertHumanManager(actorValue);
  const before = await loadReviewContext(db, actorValue, installationId, request);
  const discovered = await discoverProviderEvidence(actorValue, before, capability);
  const postCommit: ModuleLifecyclePostCommit[] = [];
  const activated = await db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actorValue);
    await lockReviewInputs(tx, before);
    const context = await loadReviewContext(tx, actorValue, installationId, request);
    const evidence = new Map<string, ProviderEvidence>();
    for (const [key, currentConnection] of context.connections) {
      const item = discovered.get(key);
      if (
        !item
        || item.connection.id !== currentConnection.id
        || item.connection.app_run_authorization_version !== currentConnection.app_run_authorization_version
      ) {
        throw appError('Connector authorization changed during review', 'APP_STALE');
      }
      evidence.set(key, { ...item, connection: currentConnection });
    }
    const review = buildReview(
      context,
      evidence,
      await priorAuthoritySurface(tx, context.installation),
    );
    if (review.review_digest !== request.expected_review_digest) {
      throw appError('Reviewed App authority changed before activation', 'APP_STALE');
    }
    if (
      !request.accept_host_policy
      && !(request.allow_identical_carry_forward === true && review.permission_diff.carry_forward_eligible)
    ) {
      throw new AppError('The host-owned policy must be accepted', 'APP_REVIEW_REQUIRED', 409);
    }

    const providerSnapshotIds = new Map<string, string>();
    for (const [key, item] of evidence) {
      providerSnapshotIds.set(
        key,
        await persistCapabilityProviderSnapshotWithExecutor(tx, item.snapshot),
      );
    }
    const effectiveId = randomUUID();
    const priorEffective = await latestEffectiveSnapshot(tx, context.installation);
    const effectiveCanonical = canonicalizeAppGrantValue({
      snapshot_version: APP_GRANT_SNAPSHOT_VERSION,
      snapshot_kind: 'effective',
      app: {
        installation_id: context.installation.id,
        version_id: context.version.id,
        id: context.installation.app_id,
        version: context.version.version,
        protocol_version: '1',
        manifest_digest: context.version.manifest_digest,
        package_digest: context.version.package_digest,
      },
      requested_snapshot_id: context.requested.id,
      requested_snapshot_digest: context.requested.snapshot_digest,
      resource_rights: review.resource_rights,
      classification: review.classification,
      authority_surface_digest: review.authority_surface_digest,
      authority_surface: {
        dependencies: review.dependencies.map((item) => item.canonical_lock),
        resources: context.manifest.resource_requirements,
        included_modules: [...context.included_modules.values()].map((item) => ({
          module_id: item.module_id,
          module_version: item.module_version,
          manifest_digest: item.manifest_digest,
        })).sort((a, b) => a.module_id.localeCompare(b.module_id)),
        action_bindings: review.action_bindings.map((item) => item.canonical_binding),
      },
      dependency_lock_digests: review.dependencies.map((item) => item.lock_digest),
      action_binding_digests: review.action_bindings.map((item) => item.binding_digest),
      reviewed_by: { actor_type: actorValue.kind, actor_id: actorValue.actor_id },
    }) as Record<string, unknown>;
    await tx.insert(appGrantSnapshots).values({
      id: effectiveId,
      org_id: actorValue.org_id,
      app_installation_id: context.installation.id,
      app_version_id: context.version.id,
      app_id: context.installation.app_id,
      app_version: context.version.version,
      manifest_digest: context.version.manifest_digest,
      package_digest: context.version.package_digest,
      snapshot_kind: 'effective',
      snapshot_version: APP_GRANT_SNAPSHOT_VERSION,
      requested_snapshot_id: context.requested.id,
      supersedes_snapshot_id: priorEffective?.id ?? null,
      resource_rights: [...review.resource_rights],
      classification: review.classification,
      canonical_snapshot: effectiveCanonical,
      snapshot_digest: digestAppGrantValue(effectiveCanonical),
      reviewed_by_actor_type: actorValue.kind,
      reviewed_by_actor_id: actorValue.actor_id,
      reviewed_at: new Date(),
    });
    for (const dependency of review.dependencies) {
      await tx.insert(appDependencyLocks).values({
        id: randomUUID(),
        org_id: actorValue.org_id,
        app_installation_id: context.installation.id,
        app_version_id: context.version.id,
        grant_snapshot_id: effectiveId,
        grant_snapshot_kind: 'effective',
        ...dependency,
      });
    }
    for (const binding of review.action_bindings) {
      const providerSnapshotId = providerSnapshotIds.get(binding.connector_requirement_key);
      if (!providerSnapshotId) throw new Error('Provider snapshot persistence returned no identity');
      const privateInterface = context.private_interfaces.get(binding.capability_requirement_key);
      if (!privateInterface) throw new Error('Private interface support metadata is missing');
      await tx.insert(appActionBindings).values({
        id: randomUUID(),
        org_id: actorValue.org_id,
        app_installation_id: context.installation.id,
        app_version_id: context.version.id,
        grant_snapshot_id: effectiveId,
        grant_snapshot_kind: 'effective',
        action_key: binding.action_key,
        capability_requirement_key: binding.capability_requirement_key,
        connector_requirement_key: binding.connector_requirement_key,
        interface_identity: binding.interface_identity,
        provider_kind: binding.provider_kind,
        mcp_connection_id: binding.mcp_connection_id,
        provider_snapshot_id: providerSnapshotId,
        operation_name: binding.operation_name,
        operation_schema_digest: binding.operation_schema_digest,
        connector_authorization_version: binding.connector_authorization_version,
        ...privateInterface.host_policy,
        canonical_binding: binding.canonical_binding,
        binding_digest: binding.binding_digest,
      });
    }
    await installOrCarryIncludedModules(tx, actorValue, context, postCommit);
    if (testHooks?.failBeforePointerSwap) throw new Error('Injected connected App activation failure');
    const now = new Date();
    if (context.installation.active_version_id && context.installation.active_version_id !== context.version.id) {
      await tx.update(appVersions).set({ state: 'superseded', superseded_at: now }).where(and(
        eq(appVersions.org_id, actorValue.org_id),
        eq(appVersions.installation_id, context.installation.id),
        eq(appVersions.id, context.installation.active_version_id),
        eq(appVersions.state, 'active'),
      ));
    }
    const [activeVersion] = context.installation.active_version_id === context.version.id
      ? await tx.select().from(appVersions).where(and(
          eq(appVersions.org_id, actorValue.org_id),
          eq(appVersions.installation_id, context.installation.id),
          eq(appVersions.id, context.version.id),
          eq(appVersions.state, 'active'),
        )).limit(1)
      : await tx.update(appVersions).set({
          state: 'active',
          activated_at: now,
        }).where(and(
          eq(appVersions.org_id, actorValue.org_id),
          eq(appVersions.installation_id, context.installation.id),
          eq(appVersions.id, context.version.id),
          eq(appVersions.state, 'staged'),
        )).returning();
    const [activeInstallation] = await tx.update(appInstallations).set({
      state: 'active',
      active_version_id: context.version.id,
      active_grant_snapshot_id: effectiveId,
      active_grant_snapshot_kind: 'effective',
      lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`,
      grant_epoch: sql`${appInstallations.grant_epoch} + 1`,
      disabled_at: null,
      updated_by_actor_type: actorValue.kind,
      updated_by_actor_id: actorValue.actor_id,
    }).where(and(
      eq(appInstallations.org_id, actorValue.org_id),
      eq(appInstallations.id, context.installation.id),
      eq(appInstallations.lifecycle_epoch, request.expected_lifecycle_epoch),
      eq(appInstallations.grant_epoch, request.expected_grant_epoch),
    )).returning();
    if (!activeVersion || !activeInstallation) throw appError('App activation lost its lifecycle CAS', 'APP_STALE');
    await tx.insert(auditLog).values({
      org_id: actorValue.org_id,
      actor_type: actorValue.kind,
      actor_id: actorValue.actor_id,
      action: 'app.review_activate',
      entity_type: 'app_installation',
      entity_id: context.installation.id,
      before_state: {
        state: context.installation.state,
        active_version_id: context.installation.active_version_id,
        active_grant_snapshot_id: context.installation.active_grant_snapshot_id,
        lifecycle_epoch: context.installation.lifecycle_epoch,
        grant_epoch: context.installation.grant_epoch,
      },
      after_state: {
        state: activeInstallation.state,
        active_version_id: activeInstallation.active_version_id,
        active_grant_snapshot_id: activeInstallation.active_grant_snapshot_id,
        lifecycle_epoch: activeInstallation.lifecycle_epoch,
        grant_epoch: activeInstallation.grant_epoch,
        review_digest: review.review_digest,
      },
      metadata: { source: actorValue.source },
    });
    return review;
  });
  for (const effect of postCommit) effect.emit();
  await Promise.all(postCommit.map((effect) => effect.invalidate()));
  if (postCommit.length === 0) await invalidateModuleCatalogCaches(actorValue.org_id);
  getIO()?.to(`org-members:${actorValue.org_id}`).emit('app:changed', {
    change: 'activated',
    installation_id: installationId,
  });
  return activated;
}

export async function getConnectedAppGrantManagement(
  actorValue: ModuleActor,
  installationId: string,
) {
  assertHumanManager(actorValue);
  const [installation] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actorValue.org_id),
    eq(appInstallations.id, installationId),
  )).limit(1);
  if (!installation) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
  const versions = await db.select({
    id: appVersions.id,
    version: appVersions.version,
    protocol_version: appVersions.protocol_version,
    state: appVersions.state,
    package_digest: appVersions.package_digest,
    manifest_digest: appVersions.manifest_digest,
    requested_grant_snapshot_id: appVersions.requested_grant_snapshot_id,
    staged_at: appVersions.staged_at,
    activated_at: appVersions.activated_at,
    superseded_at: appVersions.superseded_at,
  }).from(appVersions).where(and(
    eq(appVersions.org_id, actorValue.org_id),
    eq(appVersions.installation_id, installation.id),
  )).orderBy(desc(appVersions.created_at));
  const snapshots = await db.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, actorValue.org_id),
    eq(appGrantSnapshots.app_installation_id, installation.id),
  )).orderBy(desc(appGrantSnapshots.created_at), desc(appGrantSnapshots.id));
  const effectiveIds = snapshots
    .filter((snapshot) => snapshot.snapshot_kind === 'effective')
    .map((snapshot) => snapshot.id);
  const dependencies = effectiveIds.length === 0
    ? []
    : (await db.select().from(appDependencyLocks).where(and(
        eq(appDependencyLocks.org_id, actorValue.org_id),
        eq(appDependencyLocks.app_installation_id, installation.id),
      ))).map((lock) => ({
        id: lock.id,
        grant_snapshot_id: lock.grant_snapshot_id,
        dependency_key: lock.dependency_key,
        required_app_id: lock.required_app_id,
        required_version: lock.required_version,
        dependency_installation_id: lock.dependency_installation_id,
        dependency_version_id: lock.dependency_version_id,
        dependency_lifecycle_epoch: lock.dependency_lifecycle_epoch,
        ownership: lock.ownership,
        lock_digest: lock.lock_digest,
      }));
  const bindings = effectiveIds.length === 0
    ? []
    : (await db.select().from(appActionBindings).where(and(
        eq(appActionBindings.org_id, actorValue.org_id),
        eq(appActionBindings.app_installation_id, installation.id),
      ))).map((binding) => ({
        id: binding.id,
        grant_snapshot_id: binding.grant_snapshot_id,
        action_key: binding.action_key,
        capability_requirement_key: binding.capability_requirement_key,
        connector_requirement_key: binding.connector_requirement_key,
        interface_identity: binding.interface_identity,
        provider_kind: binding.provider_kind,
        mcp_connection_id: binding.mcp_connection_id,
        provider_snapshot_id: binding.provider_snapshot_id,
        operation_name: binding.operation_name,
        operation_schema_digest: binding.operation_schema_digest,
        connector_authorization_version: binding.connector_authorization_version,
        binding_digest: binding.binding_digest,
        host_policy: {
          risk_class: binding.risk_class,
          review_requirement: binding.review_requirement,
          review_scope: binding.review_scope,
          egress_class: binding.egress_class,
          retry_class: binding.retry_class,
          retention_class: binding.retention_class,
          automation_eligibility: binding.automation_eligibility,
          provider_idempotency_key_required: binding.provider_idempotency_key_required,
        },
      }));
  const recentRuns = await db.select(safeRunSelection).from(appRuns).where(and(
    eq(appRuns.org_id, actorValue.org_id),
    eq(appRuns.origin_kind, 'app'),
    eq(appRuns.origin_app_installation_id, installation.id),
  )).orderBy(desc(appRuns.created_at), desc(appRuns.id)).limit(5);
  return {
    installation: {
      id: installation.id,
      app_id: installation.app_id,
      state: installation.state,
      active_version_id: installation.active_version_id,
      active_grant_snapshot_id: installation.active_grant_snapshot_id,
      lifecycle_epoch: installation.lifecycle_epoch,
      grant_epoch: installation.grant_epoch,
    },
    versions: versions.map((version) => ({
      ...version,
      staged_at: version.staged_at.toISOString(),
      activated_at: version.activated_at?.toISOString() ?? null,
      superseded_at: version.superseded_at?.toISOString() ?? null,
    })),
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      app_version_id: snapshot.app_version_id,
      snapshot_kind: snapshot.snapshot_kind,
      requested_snapshot_id: snapshot.requested_snapshot_id,
      supersedes_snapshot_id: snapshot.supersedes_snapshot_id,
      resource_rights: snapshot.resource_rights,
      classification: snapshot.classification,
      snapshot_digest: snapshot.snapshot_digest,
      reviewed_by_actor_type: snapshot.reviewed_by_actor_type,
      reviewed_by_actor_id: snapshot.reviewed_by_actor_id,
      reviewed_at: snapshot.reviewed_at?.toISOString() ?? null,
      created_at: snapshot.created_at.toISOString(),
    })),
    dependencies,
    action_bindings: bindings,
    recent_runs: recentRuns,
  };
}

export type ConnectedAppHealth = Readonly<{
  status: 'healthy' | 'unhealthy';
  installation_id: string;
  active_grant_snapshot_id: string | null;
  lifecycle_epoch: number;
  grant_epoch: number;
  checked_provider_schemas: boolean;
  issues: readonly Readonly<{ code: string; subject_id: string; message: string }>[];
}>;

export async function inspectConnectedAppHealth(
  actorValue: ModuleActor,
  installationId: string,
  options: { refresh_provider_schemas: boolean },
  capability: AppReviewCapabilityPort = capabilityService,
): Promise<ConnectedAppHealth> {
  assertHumanManager(actorValue);
  const [installation] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actorValue.org_id),
    eq(appInstallations.id, installationId),
  )).limit(1);
  if (!installation) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
  const issues: Array<{ code: string; subject_id: string; message: string }> = [];
  if (installation.state !== 'active') {
    issues.push({
      code: 'APP_NOT_ACTIVE',
      subject_id: installation.id,
      message: 'The App installation is not active',
    });
  }
  const effective = installation.active_grant_snapshot_id
    ? await latestEffectiveSnapshot(db, installation)
    : null;
  if (!effective || effective.id !== installation.active_grant_snapshot_id) {
    issues.push({
      code: 'APP_EFFECTIVE_GRANT_MISSING',
      subject_id: installation.id,
      message: 'No active effective grant is pinned',
    });
  }
  const locks = !effective ? [] : await db.select().from(appDependencyLocks).where(and(
    eq(appDependencyLocks.org_id, actorValue.org_id),
    eq(appDependencyLocks.app_installation_id, installation.id),
    eq(appDependencyLocks.grant_snapshot_id, effective.id),
  ));
  for (const lock of locks) {
    const [dependency] = await db.select({ installation: appInstallations, version: appVersions })
      .from(appInstallations)
      .innerJoin(appVersions, and(
        eq(appVersions.org_id, appInstallations.org_id),
        eq(appVersions.installation_id, appInstallations.id),
        eq(appVersions.id, appInstallations.active_version_id),
      ))
      .where(and(
        eq(appInstallations.org_id, actorValue.org_id),
        eq(appInstallations.id, lock.dependency_installation_id),
      ))
      .limit(1);
    if (
      !dependency
      || dependency.installation.state !== 'active'
      || dependency.installation.lifecycle_epoch !== lock.dependency_lifecycle_epoch
      || dependency.version.id !== lock.dependency_version_id
      || dependency.version.version !== lock.required_version
      || dependency.version.manifest_digest !== lock.dependency_manifest_digest
      || dependency.version.package_digest !== lock.dependency_package_digest
    ) {
      issues.push({
        code: 'APP_DEPENDENCY_DRIFT',
        subject_id: lock.dependency_installation_id,
        message: `Dependency ${lock.required_app_id}@${lock.required_version} no longer matches its reviewed lock`,
      });
    }
  }
  const bindings = !effective ? [] : await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, actorValue.org_id),
    eq(appActionBindings.app_installation_id, installation.id),
    eq(appActionBindings.grant_snapshot_id, effective.id),
  ));
  for (const binding of bindings) {
    const [connection] = await db.select().from(mcpConnections).where(and(
      eq(mcpConnections.org_id, actorValue.org_id),
      eq(mcpConnections.id, binding.mcp_connection_id),
    )).limit(1);
    const overrideRows = await db.select({
      tool_name: mcpToolOverrides.tool_name,
      trust_tier_override: mcpToolOverrides.trust_tier_override,
      is_disabled: mcpToolOverrides.is_disabled,
    }).from(mcpToolOverrides).where(and(
      eq(mcpToolOverrides.org_id, actorValue.org_id),
      eq(mcpToolOverrides.mcp_connection_id, binding.mcp_connection_id),
    ));
    const overrides = normalizeConnectedMcpOverrides(overrideRows);
    if (
      !connection
      || !connection.is_active
      || connection.app_run_authorization_version !== binding.connector_authorization_version
      || !isMcpToolEnabled(connection.enabled_tools, connection.slug, binding.operation_name)
      || overrides.some((override) => override.toolName === binding.operation_name && override.disabled)
    ) {
      issues.push({
        code: 'APP_CONNECTOR_DRIFT',
        subject_id: binding.mcp_connection_id,
        message: `Connector authorization for ${binding.operation_name} changed after review`,
      });
      continue;
    }
    const [storedSnapshot] = await db.select().from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, actorValue.org_id),
      eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_kind, 'mcp'),
      eq(capabilityProviderSnapshots.provider_instance_id, binding.mcp_connection_id),
    )).limit(1);
    const parsed = storedSnapshot
      ? CapabilityProviderDiscoverySnapshotSchema.safeParse(storedSnapshot.safe_snapshot)
      : null;
    const storedOperation = parsed?.success
      ? parsed.data.operations.find((item) => item.identity.operation_name === binding.operation_name)
      : null;
    if (
      !storedSnapshot
      || !parsed?.success
      || parsed.data.snapshot_digest !== storedSnapshot.snapshot_digest
      || storedOperation?.schema_digest !== binding.operation_schema_digest
    ) {
      issues.push({
        code: 'APP_PROVIDER_SNAPSHOT_INVALID',
        subject_id: binding.provider_snapshot_id,
        message: 'The pinned provider snapshot is missing or invalid',
      });
      continue;
    }
    if (options.refresh_provider_schemas) {
      try {
        const live = await capability.discover({
          provider_kind: 'mcp',
          mode: 'refresh',
          org_id: actorValue.org_id,
          provider_instance_id: binding.mcp_connection_id,
          overrides,
        });
        const liveOperation = live.snapshot?.operations.find(
          (item) => item.identity.operation_name === binding.operation_name,
        );
        if (
          !live.snapshot
          || live.snapshot.snapshot_digest !== storedSnapshot.snapshot_digest
          || liveOperation?.schema_digest !== binding.operation_schema_digest
          || !live.tools.some((tool) => tool.originalName === binding.operation_name)
        ) {
          issues.push({
            code: 'APP_PROVIDER_SCHEMA_DRIFT',
            subject_id: binding.mcp_connection_id,
            message: `Provider schema for ${binding.operation_name} changed after review`,
          });
        }
      } catch {
        issues.push({
          code: 'APP_PROVIDER_UNAVAILABLE',
          subject_id: binding.mcp_connection_id,
          message: 'Provider schema refresh failed',
        });
      }
    }
  }
  return {
    status: issues.length === 0 ? 'healthy' : 'unhealthy',
    installation_id: installation.id,
    active_grant_snapshot_id: installation.active_grant_snapshot_id,
    lifecycle_epoch: installation.lifecycle_epoch,
    grant_epoch: installation.grant_epoch,
    checked_provider_schemas: options.refresh_provider_schemas,
    issues,
  };
}
