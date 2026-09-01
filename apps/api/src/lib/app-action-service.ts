import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  appActionBindings,
  appDependencyLocks,
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appVersions,
  capabilityProviderSnapshots,
  mcpConnections,
  mcpToolOverrides,
  moduleInstallations,
  moduleVersions,
} from '@deft/db/schema';
import {
  APP_AUTOMATION_POLICY_V1,
  DeftAppManifestV1Schema,
  DeftAppManifestV2Schema,
  type DeftAppPrivateInterfaceDescriptorV1,
} from '@deft/app-kit';
import type { MCPToolOverride } from '@deft/mcp';
import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunSafePreviewSchema,
  CapabilityProviderDiscoverySnapshotSchema,
  ModuleResourceRefV1Schema,
  RESOURCE_CONTRACT_VERSIONS,
  canonicalCapabilityJson,
  resourceRefIdentity,
  type AppRunActor,
  type AppRunAuthorizationSnapshot,
  type AppRunSafePreview,
  type ModuleResourceRefV1,
  type ResourceSafeProjectionV1,
} from '@deft/shared';
import { ModuleActorSchema, type ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import {
  canonicalizeAppGrantValue,
  digestAppGrantValue,
} from './app-grant-service.js';
import {
  CONNECTED_APP_ACTION_BINDING_VERSION,
  connectedAppActionBindingMatches,
  connectedAppOperationMatches,
  connectedAppToolMatches,
  getConnectedAppPrivateInterface,
  isConnectedAppProtocolVersion,
  normalizeConnectedMcpOverrides,
  parseConnectedAppProviderInput,
  type ConnectedDeftAppManifest,
} from './app-connected-contract.js';
import type { CapabilityDiscoveryResult } from './capability-service.js';
import {
  PostgresAppRunLiveAuthorization,
  type AppRunAuthorizationCapture,
  type AppRunTokenScopeAuthorization,
} from './app-run-live-authorization.js';
import type { AppRunReadAuthorityRef } from './app-run-authorization.js';
import type {
  AppRunPreparedInputCandidate,
  AppRunPreparedInputPayload,
} from './app-run-prepared-input.js';
import {
  digestPreparedAppAuthority,
  type AppRunPreparedAuthorityVectorV2,
} from './app-run-prepared-input.js';
import type { AppRunSafeView } from './app-run-repository.js';
import type { AppRunReceiptReader, AppRunVerifiedReceiptView } from './app-run-receipts.js';
import { isMcpToolEnabled } from './mcp-tool-identity.js';
import { readModuleRecordScalarFields } from './module-service.js';
import { resourceAuthorizationService } from './resource-provider-adapters.js';
import { listResourceRelation } from './resource-relation-service.js';
import { APP_AUTOMATIONS_ENABLED } from './env.js';
import {
  postgresAppAutomationVerificationReadPort,
  type AppAutomationVerificationContext,
  type AppAutomationVerificationReadPort,
} from './app-automation-repository.js';
import { APP_AUTOMATION_POLICY_DIGEST } from './app-automation-definition-service.js';

const APP_ACTION_AUTHORITY_VERSION = 'deft.app_action_authority.v1' as const;
const APP_ACTION_REPLAY_VERSION = 'deft.app_action_replay.v2' as const;
const APP_MCP_DISCOVERY_SCOPES = Object.freeze(['read:modules', 'read:apps'] as const);
const APP_MCP_INVOKE_SCOPES = Object.freeze(['read:modules', 'invoke:apps'] as const);
const APP_MCP_RUN_READ_SCOPES = Object.freeze(['read:app-runs'] as const);

type BindingRow = typeof appActionBindings.$inferSelect;
type DependencyLockRow = typeof appDependencyLocks.$inferSelect;
type GrantRow = typeof appGrantSnapshots.$inferSelect;
type InstallationRow = typeof appInstallations.$inferSelect;
type VersionRow = typeof appVersions.$inferSelect;

export type AppActionTokenAuthority = Readonly<{
  token_kind: 'mcp' | 'oauth';
  token_id: string;
}>;

export type AppActionCaller = Readonly<{
  actor: ModuleActor;
  token_authorities?: readonly AppActionTokenAuthority[];
}>;

export type AppActionListItem = Readonly<{
  binding_id: string;
  installation_id: string;
  app_id: string;
  app_version_id: string;
  action_key: string;
  label: string;
  automation_requests: readonly Readonly<{ key: string; label: string }>[];
}>;

export type AppActionListResult = Readonly<{
  resource: ResourceSafeProjectionV1;
  actions: readonly AppActionListItem[];
}>;

export type AppActionResolvedInput = Readonly<
  | { input_key: 'to' | 'subject' | 'body_text'; kind: 'resource_field' }
  | {
      input_key: 'to' | 'subject' | 'body_text';
      kind: 'selected_relation_field';
      relation_key: string;
      relation_revision: number;
      options: readonly ResourceSafeProjectionV1[];
    }
  | {
      input_key: 'to' | 'subject' | 'body_text';
      kind: 'user_input';
      input_type: 'email' | 'text';
      label: string;
      required: true;
    }
>;

export type AppActionResolveResult = Readonly<{
  action: AppActionListItem;
  resource: ResourceSafeProjectionV1;
  inputs: readonly AppActionResolvedInput[];
}>;

export type AppActionResourceEvidence = Readonly<{
  ref: ModuleResourceRefV1;
  revision: number;
  active_manifest_digest: string;
  validated_manifest_digest: string;
  updated_at: string;
}>;

export type AppActionAuthorityVector = Readonly<{
  schema_version: typeof APP_ACTION_AUTHORITY_VERSION;
  caller_surface: string;
  installation: Readonly<{
    id: string;
    lifecycle_epoch: number;
    grant_epoch: number;
  }>;
  app_version: Readonly<{
    id: string;
    manifest_digest: string;
    package_digest: string;
  }>;
  grant: Readonly<{ id: string; snapshot_digest: string }>;
  binding: Readonly<{
    id: string;
    action_key: string;
    binding_digest: string;
    connector_authorization_version: number;
  }>;
  dependencies: readonly Readonly<{
    dependency_key: string;
    installation_id: string;
    version_id: string;
    lifecycle_epoch: number;
    lock_digest: string;
  }>[];
  provider: Readonly<{
    connection_id: string;
    snapshot_id: string;
    snapshot_digest: string;
    operation_name: string;
    operation_schema_digest: string;
  }>;
  run_authorization: AppRunAuthorizationSnapshot;
  resources: readonly AppActionResourceEvidence[];
  relations: readonly Readonly<{
    source_ref: ModuleResourceRefV1;
    relation_key: string;
    revision: number;
    selected_ref: ModuleResourceRefV1;
  }>[];
}>;

export type AppActionPrepareResult = Readonly<{
  action: AppActionListItem;
  safe_preview: AppRunSafePreview;
  input_candidate: AppRunPreparedInputCandidate;
  replay_identity: `sha256:${string}`;
  authority_vector: AppActionAuthorityVector;
  authority_digest: `sha256:${string}`;
}>;

export type AppActionPrepareInput = Readonly<{
  binding_id: string;
  resource_ref: unknown;
  selections?: readonly Readonly<{ input_key: string; resource_ref: unknown }>[];
  user_inputs?: Readonly<Record<string, string>>;
  idempotency_key: string;
}>;

export type AppActionAutomationInvokeInput = Readonly<{
  organization_id: string;
  definition_id: string;
  fire_id: string;
  claim_token: string;
}>;

export type AppActionAutomationPreflightInput = Omit<
  AppActionAutomationInvokeInput,
  'claim_token'
>;

type ActionContext = Readonly<{
  installation: InstallationRow;
  version: VersionRow;
  grant: GrantRow;
  binding: BindingRow;
  manifest: ConnectedDeftAppManifest;
  action: ConnectedDeftAppManifest['actions'][number];
  private_interface: DeftAppPrivateInterfaceDescriptorV1;
  dependencies: readonly DependencyLockRow[];
  resources: ReadonlyMap<string, Readonly<{
    requirement: ConnectedDeftAppManifest['resource_requirements'][number];
    module_installation_id: string;
    module_version_id: string;
    module_manifest_digest: string;
  }>>;
  provider_snapshot: ReturnType<typeof CapabilityProviderDiscoverySnapshotSchema.parse>;
  provider_snapshot_id: string;
  provider_snapshot_digest: string;
  overrides: readonly MCPToolOverride[];
}>;

type CallerContext = Readonly<{
  actor: ModuleActor;
  surface: string;
  authenticated_subject: AppRunActor;
  execution_actor: AppRunActor;
  token_authorities: readonly AppActionTokenAuthority[];
}>;

export interface AppActionCapabilityPort {
  discover(input: {
    provider_kind: 'mcp';
    mode: 'refresh';
    org_id: string;
    provider_instance_id: string;
    overrides?: MCPToolOverride[];
  }): Promise<CapabilityDiscoveryResult>;
}

export interface AppActionLiveAuthorityPort {
  captureForPreparation(input: AppRunAuthorizationCapture): Promise<AppRunAuthorizationSnapshot>;
  assertTokenScopes(input: AppRunTokenScopeAuthorization): Promise<AppRunReadAuthorityRef>;
}

export interface AppActionPreparedInputPort {
  protect(input: Readonly<{
    org_id: string;
    replay_identity: string;
    binding_identity: Readonly<{
      app_installation_id: string;
      app_version_id: string;
      grant_snapshot_id: string;
      binding_id: string;
      binding_digest: string;
    }>;
    provider_input: unknown;
    app_run?: Readonly<{
      initiating_actor: AppRunActor;
      execution_actor: AppRunActor;
      safe_preview: unknown;
      authority_vector: unknown;
      authority_digest: string;
    }>;
  }>): Promise<AppRunPreparedInputCandidate> | AppRunPreparedInputCandidate;
  open(
    orgId: string,
    candidate: AppRunPreparedInputCandidate,
  ): Promise<AppRunPreparedInputPayload> | AppRunPreparedInputPayload;
}

export interface AppActionRunPort {
  submitPreparedApp(
    context: Readonly<{
      org_id: string;
      initiating_actor: AppRunActor;
      execution_actor: AppRunActor;
      automation_claim_token?: string;
    }>,
    candidate: AppRunPreparedInputCandidate,
  ): Promise<AppRunSafeView>;
}

export interface AppActionRunReadPort {
  inspect(
    orgId: string,
    runId: string,
    actor: AppRunActor,
    requiredAuthorityRef: AppRunReadAuthorityRef | null,
  ): Promise<AppRunSafeView>;
  result(
    orgId: string,
    runId: string,
    actor: AppRunActor,
    requiredAuthorityRef: AppRunReadAuthorityRef | null,
  ): Promise<Readonly<{
    run: AppRunSafeView;
    value: unknown;
  }>>;
}

export type AppActionReceiptBundle = Readonly<{
  run: Readonly<{
    id: string;
    state: AppRunSafeView['state'];
    operation_name: string;
    safe_preview: AppRunSafeView['safe_preview'];
    safe_outcome: AppRunSafeView['safe_outcome'];
    risk_class: AppRunSafeView['risk_class'];
    review_requirement: AppRunSafeView['review_requirement'];
    review_scope: AppRunSafeView['review_scope'];
    retry_class: AppRunSafeView['retry_class'];
    retention_class: AppRunSafeView['retention_class'];
    result_expires_at: string;
    result_purged_at: string | null;
  }>;
  receipts: readonly AppRunVerifiedReceiptView[];
}>;

export interface AppActionFieldReaderPort {
  read(
    actor: ModuleActor,
    ref: ModuleResourceRefV1,
    fieldKeys: readonly string[],
  ): ReturnType<typeof readModuleRecordScalarFields>;
}

const defaultFieldReader: AppActionFieldReaderPort = Object.freeze({
  read: readModuleRecordScalarFields,
});

const lazyCapability: AppActionCapabilityPort = Object.freeze({
  async discover(input: Parameters<AppActionCapabilityPort['discover']>[0]) {
    const { capabilityService } = await import('./capability-service.js');
    return capabilityService.discover(input);
  },
});

const lazyPreparedInput: AppActionPreparedInputPort = Object.freeze({
  async protect(input: Parameters<AppActionPreparedInputPort['protect']>[0]) {
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    return (await getAppRunRuntime()).inputPreparation.protect(input);
  },
  async open(
    orgId: Parameters<AppActionPreparedInputPort['open']>[0],
    candidate: Parameters<AppActionPreparedInputPort['open']>[1],
  ) {
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    return (await getAppRunRuntime()).inputPreparation.open(orgId, candidate);
  },
});

const lazyRuns: AppActionRunPort = Object.freeze({
  async submitPreparedApp(
    context: Parameters<AppActionRunPort['submitPreparedApp']>[0],
    candidate: Parameters<AppActionRunPort['submitPreparedApp']>[1],
  ) {
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    return (await getAppRunRuntime()).service.submitPreparedApp(context, candidate);
  },
});

const lazyRunReads: AppActionRunReadPort = Object.freeze({
  async inspect(
    orgId: Parameters<AppActionRunReadPort['inspect']>[0],
    runId: Parameters<AppActionRunReadPort['inspect']>[1],
    actor: Parameters<AppActionRunReadPort['inspect']>[2],
    requiredAuthorityRef: Parameters<AppActionRunReadPort['inspect']>[3],
  ) {
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    return (await getAppRunRuntime()).service.inspect(orgId, runId, actor, requiredAuthorityRef);
  },
  async result(
    orgId: Parameters<AppActionRunReadPort['result']>[0],
    runId: Parameters<AppActionRunReadPort['result']>[1],
    actor: Parameters<AppActionRunReadPort['result']>[2],
    requiredAuthorityRef: Parameters<AppActionRunReadPort['result']>[3],
  ) {
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    return (await getAppRunRuntime()).service.result(orgId, runId, actor, requiredAuthorityRef);
  },
});

const lazyReceiptReads: AppRunReceiptReader = Object.freeze({
  async readVerified(orgId: string, runId: string) {
    const { getAppRunRuntime } = await import('./app-run-runtime.js');
    return (await getAppRunRuntime()).receiptReader.readVerified(orgId, runId);
  },
});

function actionError(message: string, code: 'APP_ACTION_INVALID' | 'APP_ACTION_UNAVAILABLE' | 'APP_ACCESS_DENIED' | 'APP_DEPENDENCY_UNHEALTHY' | 'APP_PROVIDER_UNAVAILABLE' | 'APP_NOT_FOUND' | 'APP_STALE', status: 400 | 403 | 404 | 409 | 503 = 409) {
  return new AppError(message, code, status);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalCapabilityJson(left) === canonicalCapabilityJson(right);
}

function preparedActionFacts(payload: AppRunPreparedInputPayload) {
  return {
    schema_version: payload.schema_version,
    replay_identity: payload.replay_identity,
    binding_identity: payload.binding_identity,
    provider_input: payload.provider_input,
    app_run: payload.app_run,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArrayValue(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : null;
}

function callerContext(value: AppActionCaller): CallerContext {
  const actor = ModuleActorSchema.parse(value.actor);
  if (actor.kind === 'system') {
    throw actionError('System actors cannot prepare App actions', 'APP_ACCESS_DENIED', 403);
  }
  const tokenAuthorities = [...(value.token_authorities ?? [])];
  const seenTokens = new Set<string>();
  for (const token of tokenAuthorities) {
    if (!token.token_id || token.token_id !== token.token_id.trim()) {
      throw actionError('App action token authority is invalid', 'APP_ACCESS_DENIED', 403);
    }
    const identity = `${token.token_kind}\0${token.token_id}`;
    if (seenTokens.has(identity)) throw actionError('App action token authority is duplicated', 'APP_ACCESS_DENIED', 403);
    seenTokens.add(identity);
  }
  const tokenRequired = (actor.kind === 'human' && actor.source === 'mcp')
    || (actor.kind === 'agent_employee' && actor.source === 'mcp');
  if (tokenRequired && tokenAuthorities.length !== 1) {
    throw actionError('MCP App actions require one exact live token authority', 'APP_ACCESS_DENIED', 403);
  }
  if (
    tokenRequired
    && actor.kind === 'agent_employee'
    && tokenAuthorities.some((token) => token.token_kind !== 'mcp')
  ) {
    throw actionError('Employee MCP App actions require MCP token authority', 'APP_ACCESS_DENIED', 403);
  }
  if (!tokenRequired && tokenAuthorities.length !== 0) {
    throw actionError('This App action surface cannot carry token authority', 'APP_ACCESS_DENIED', 403);
  }
  const principal: AppRunActor = actor.kind === 'agent_employee'
    ? { actor_type: 'agent_employee', agent_employee_id: actor.actor_id }
    : { actor_type: 'human', user_id: actor.actor_id };
  return {
    actor,
    surface: actor.kind === 'defty' ? 'defty' : `${actor.kind}:${actor.source}`,
    authenticated_subject: principal,
    execution_actor: principal,
    token_authorities: tokenAuthorities,
  };
}

function actionItem(context: ActionContext): AppActionListItem {
  const automationRequests = context.version.protocol_version === '2'
    && 'automation_requests' in context.manifest
    ? context.manifest.automation_requests
      .filter((request) => request.action_key === context.action.key)
      .map((request) => ({ key: request.key, label: request.label }))
    : [];
  return Object.freeze({
    binding_id: context.binding.id,
    installation_id: context.installation.id,
    app_id: context.installation.app_id,
    app_version_id: context.version.id,
    action_key: context.action.key,
    label: context.action.label,
    automation_requests: automationRequests,
  });
}

function actionResourceProjection(resource: ResourceSafeProjectionV1): ResourceSafeProjectionV1 {
  const identitySuffix = resource.ref.resource_id.slice(0, 8);
  return Object.freeze({
    ...resource,
    // A Module's ordinary display label may be backed by a field that becomes
    // provider input. App action responses therefore use only host-owned
    // identity copy.
    label: `${resource.ref.resource_type} record ${identitySuffix}`,
  });
}

function actionResourceEvidence(
  value: Awaited<ReturnType<AppActionFieldReaderPort['read']>>,
): AppActionResourceEvidence {
  return Object.freeze({
    ref: value.ref,
    revision: value.revision,
    active_manifest_digest: value.active_manifest_digest,
    validated_manifest_digest: value.validated_manifest_digest,
    updated_at: value.updated_at,
  });
}

function replayIdentity(context: ActionContext, caller: CallerContext, idempotencyKey: string): `sha256:${string}` {
  const principalId = caller.execution_actor.actor_type === 'human'
    ? caller.execution_actor.user_id
    : caller.execution_actor.actor_type === 'agent_employee'
      ? caller.execution_actor.agent_employee_id
      : '';
  const tokenAuthorities = [...caller.token_authorities]
    .sort((left, right) => `${left.token_kind}\0${left.token_id}`.localeCompare(
      `${right.token_kind}\0${right.token_id}`,
    ));
  const digest = createHash('sha256')
    .update(`${APP_ACTION_REPLAY_VERSION}\0`)
    .update(canonicalCapabilityJson({
      organization_id: caller.actor.org_id,
      principal_type: caller.execution_actor.actor_type,
      principal_id: principalId,
      caller_surface: caller.surface,
      token_authorities: tokenAuthorities,
      app_installation_id: context.installation.id,
      app_version_id: context.version.id,
      grant_snapshot_id: context.grant.id,
      binding_id: context.binding.id,
      idempotency_key: idempotencyKey,
    }))
    .digest('hex');
  return `sha256:${digest}`;
}

async function loadRequirementModule(
  orgId: string,
  appInstallationId: string,
  appVersionId: string,
  requirement: ConnectedDeftAppManifest['resource_requirements'][number],
  locks: ReadonlyMap<string, DependencyLockRow>,
): Promise<ActionContext['resources'] extends ReadonlyMap<string, infer T> ? T : never> {
  const ownerInstallationId = requirement.source.kind === 'included_module'
    ? appInstallationId
    : locks.get(requirement.source.dependency_key)?.dependency_installation_id;
  const ownerVersionId = requirement.source.kind === 'included_module'
    ? appVersionId
    : locks.get(requirement.source.dependency_key)?.dependency_version_id;
  if (!ownerInstallationId || !ownerVersionId) {
    throw actionError('A reviewed App dependency is unavailable', 'APP_DEPENDENCY_UNHEALTHY');
  }
  const [row] = await db.select({
    binding: appModuleBindings,
    installation: moduleInstallations,
    version: moduleVersions,
  }).from(appModuleBindings)
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
      eq(appModuleBindings.app_installation_id, ownerInstallationId),
      eq(appModuleBindings.app_version_id, ownerVersionId),
      eq(appModuleBindings.module_id, requirement.source.module_id),
    )).limit(1);
  if (
    !row
    || row.installation.is_deleted
    || !row.installation.is_enabled
    || !row.version.is_active
    || row.binding.module_id !== requirement.source.module_id
    || row.version.version !== requirement.source.version
  ) throw actionError('A reviewed App resource Module is unavailable', 'APP_DEPENDENCY_UNHEALTHY');
  return {
    requirement,
    module_installation_id: row.installation.id,
    module_version_id: row.version.id,
    module_manifest_digest: row.version.manifest_digest,
  };
}

async function assertGrantAuthoritySurface(input: Readonly<{
  org_id: string;
  installation: InstallationRow;
  version: VersionRow;
  grant: GrantRow;
  manifest: ConnectedDeftAppManifest;
  dependencies: readonly DependencyLockRow[];
}>): Promise<void> {
  const [bindingRows, includedRows] = await Promise.all([
    db.select().from(appActionBindings).where(and(
      eq(appActionBindings.org_id, input.org_id),
      eq(appActionBindings.app_installation_id, input.installation.id),
      eq(appActionBindings.app_version_id, input.version.id),
      eq(appActionBindings.grant_snapshot_id, input.grant.id),
    )),
    db.select({ binding: appModuleBindings, version: moduleVersions })
      .from(appModuleBindings)
      .innerJoin(moduleVersions, and(
        eq(moduleVersions.org_id, appModuleBindings.org_id),
        eq(moduleVersions.installation_id, appModuleBindings.module_installation_id),
        eq(moduleVersions.id, appModuleBindings.module_version_id),
      ))
      .where(and(
        eq(appModuleBindings.org_id, input.org_id),
        eq(appModuleBindings.app_installation_id, input.installation.id),
        eq(appModuleBindings.app_version_id, input.version.id),
      )),
  ]);
  const sortedBindings = [...bindingRows].sort((left, right) => left.action_key.localeCompare(right.action_key));
  const actionsByKey = new Map(input.manifest.actions.map((action) => [action.key, action]));
  if (
    sortedBindings.length !== input.manifest.actions.length
    || sortedBindings.some((row) => (
      !actionsByKey.has(row.action_key)
      || digestAppGrantValue(row.canonical_binding) !== row.binding_digest
    ))
  ) throw actionError('App grant action membership is stale', 'APP_STALE');

  const modulesById = new Map(input.manifest.modules.map((module) => [module.module_id, module]));
  const sortedIncluded = [...includedRows]
    .sort((left, right) => left.binding.module_id.localeCompare(right.binding.module_id));
  if (
    sortedIncluded.length !== input.manifest.modules.length
    || sortedIncluded.some(({ binding, version }) => {
      const declared = modulesById.get(binding.module_id);
      return !declared
        || version.version !== declared.version;
    })
  ) throw actionError('App grant Module membership is stale', 'APP_STALE');

  const locksByKey = new Map(input.dependencies.map((lock) => [lock.dependency_key, lock]));
  const sortedDependencies = [...input.manifest.dependencies]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((requirement) => locksByKey.get(requirement.key)!);
  const expectedSurface = canonicalizeAppGrantValue({
    dependencies: sortedDependencies.map((lock) => lock.canonical_lock),
    resources: input.manifest.resource_requirements,
    included_modules: sortedIncluded.map(({ binding, version }) => ({
      module_id: binding.module_id,
      module_version: version.version,
      // Effective review pins the canonical supported-Module manifest digest,
      // not the package artifact digest stored in the App manifest reference.
      manifest_digest: version.manifest_digest,
    })),
    action_bindings: sortedBindings.map((row) => row.canonical_binding),
  });
  const canonicalSnapshot = objectValue(input.grant.canonical_snapshot);
  const storedSurface = objectValue(canonicalSnapshot?.authority_surface);
  const storedDependencyDigests = stringArrayValue(canonicalSnapshot?.dependency_lock_digests);
  const storedBindingDigests = stringArrayValue(canonicalSnapshot?.action_binding_digests);
  const expectedSurfaceDigest = digestAppGrantValue(expectedSurface);
  if (
    !canonicalSnapshot
    || !storedSurface
    || canonicalSnapshot.authority_surface_digest !== expectedSurfaceDigest
    || !sameCanonical(storedSurface, expectedSurface)
    || !sameCanonical(canonicalSnapshot.resource_rights, input.grant.resource_rights)
    || !sameCanonical(canonicalSnapshot.classification, input.grant.classification)
    || !sameCanonical(
      storedDependencyDigests,
      sortedDependencies.map((lock) => lock.lock_digest),
    )
    || !sameCanonical(
      storedBindingDigests,
      sortedBindings.map((row) => row.binding_digest),
    )
  ) throw actionError('App effective grant authority surface failed integrity validation', 'APP_STALE');
}

async function loadActionContext(orgId: string, bindingId: string): Promise<ActionContext> {
  const [binding] = await db.select().from(appActionBindings).where(and(
    eq(appActionBindings.org_id, orgId),
    eq(appActionBindings.id, bindingId),
  )).limit(1);
  if (!binding) throw actionError('App action not found', 'APP_NOT_FOUND', 404);
  const [[installation], [version], [grant], [connection], [storedProvider]] = await Promise.all([
    db.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, orgId),
      eq(appInstallations.id, binding.app_installation_id),
    )).limit(1),
    db.select().from(appVersions).where(and(
      eq(appVersions.org_id, orgId),
      eq(appVersions.id, binding.app_version_id),
      eq(appVersions.installation_id, binding.app_installation_id),
    )).limit(1),
    db.select().from(appGrantSnapshots).where(and(
      eq(appGrantSnapshots.org_id, orgId),
      eq(appGrantSnapshots.id, binding.grant_snapshot_id),
      eq(appGrantSnapshots.app_installation_id, binding.app_installation_id),
    )).limit(1),
    db.select().from(mcpConnections).where(and(
      eq(mcpConnections.org_id, orgId),
      eq(mcpConnections.id, binding.mcp_connection_id),
    )).limit(1),
    db.select().from(capabilityProviderSnapshots).where(and(
      eq(capabilityProviderSnapshots.org_id, orgId),
      eq(capabilityProviderSnapshots.id, binding.provider_snapshot_id),
      eq(capabilityProviderSnapshots.provider_kind, 'mcp'),
      eq(capabilityProviderSnapshots.provider_instance_id, binding.mcp_connection_id),
    )).limit(1),
  ]);
  if (
    !installation
    || installation.state !== 'active'
    || installation.active_version_id !== binding.app_version_id
    || installation.active_grant_snapshot_id !== binding.grant_snapshot_id
    || installation.active_grant_snapshot_kind !== 'effective'
    || !version
    || version.state !== 'active'
    || !isConnectedAppProtocolVersion(version.protocol_version)
    || !grant
    || grant.snapshot_kind !== 'effective'
    || grant.app_version_id !== version.id
    || grant.manifest_digest !== version.manifest_digest
    || grant.package_digest !== version.package_digest
  ) throw actionError('App action authority is inactive or stale', 'APP_ACTION_UNAVAILABLE');
  if (digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest) {
    throw actionError('App effective grant failed integrity validation', 'APP_STALE');
  }
  const manifest = version.protocol_version === '2'
    ? DeftAppManifestV2Schema.parse(version.manifest)
    : DeftAppManifestV1Schema.parse(version.manifest);
  const action = manifest.actions.find((candidate) => candidate.key === binding.action_key);
  const capabilityRequirement = action
    ? manifest.capability_requirements.find((candidate) => candidate.key === action.capability_requirement_key)
    : null;
  const privateInterface = capabilityRequirement
    ? getConnectedAppPrivateInterface(capabilityRequirement.interface)
    : null;
  const connectorRequirement = action
    ? manifest.connector_requirements.find((candidate) => candidate.key === action.connector_requirement_key)
    : null;
  if (
    !action
    || !privateInterface
    || !connectorRequirement
    || connectorRequirement.provider_kind !== privateInterface.provider_kind
    || !connectedAppActionBindingMatches(privateInterface, action)
  ) {
    throw actionError('App action contract is unavailable', 'APP_ACTION_UNAVAILABLE');
  }
  const expectedRights = manifest.resource_requirements.map((requirement) => ({
    requirement_key: requirement.key,
    source: requirement.source,
    resource_type: requirement.resource_type,
    fields: requirement.fields,
    right: 'read',
  }));
  if (!sameCanonical(expectedRights, grant.resource_rights)) {
    throw actionError('App resource grant no longer matches the active contract', 'APP_STALE');
  }
  if (
    !connection
    || !connection.is_active
    || connection.app_run_authorization_version !== binding.connector_authorization_version
    || !isMcpToolEnabled(connection.enabled_tools, connection.slug, binding.operation_name)
  ) throw actionError('App connector authority changed after review', 'APP_PROVIDER_UNAVAILABLE', 503);
  const overrideRows = await db.select({
    tool_name: mcpToolOverrides.tool_name,
    trust_tier_override: mcpToolOverrides.trust_tier_override,
    is_disabled: mcpToolOverrides.is_disabled,
  }).from(mcpToolOverrides).where(and(
    eq(mcpToolOverrides.org_id, orgId),
    eq(mcpToolOverrides.mcp_connection_id, connection.id),
  ));
  const overrides = normalizeConnectedMcpOverrides(overrideRows);
  if (overrides.some((override) => override.toolName === binding.operation_name && override.disabled)) {
    throw actionError('App connector operation is disabled', 'APP_PROVIDER_UNAVAILABLE', 503);
  }
  const providerSnapshot = storedProvider
    ? CapabilityProviderDiscoverySnapshotSchema.safeParse(storedProvider.safe_snapshot)
    : null;
  const providerOperation = providerSnapshot?.success
    ? providerSnapshot.data.operations.find((item) => item.identity.operation_name === binding.operation_name)
    : null;
  if (
    !storedProvider
    || !providerSnapshot?.success
    || providerSnapshot.data.snapshot_digest !== storedProvider.snapshot_digest
    || providerSnapshot.data.adapter_contract_version !== storedProvider.adapter_contract_version
    || !providerOperation
    || providerOperation.schema_digest !== binding.operation_schema_digest
    || !connectedAppOperationMatches(privateInterface, providerOperation)
  ) throw actionError('Pinned App provider schema is unavailable', 'APP_PROVIDER_UNAVAILABLE', 503);
  if (
    binding.provider_kind !== privateInterface.provider_kind
    || binding.operation_name !== privateInterface.operation_name
    || binding.risk_class !== privateInterface.host_policy.risk_class
    || binding.review_requirement !== privateInterface.host_policy.review_requirement
    || binding.review_scope !== privateInterface.host_policy.review_scope
    || binding.egress_class !== privateInterface.host_policy.egress_class
    || binding.retry_class !== privateInterface.host_policy.retry_class
    || binding.retention_class !== privateInterface.host_policy.retention_class
    || binding.automation_eligibility !== privateInterface.host_policy.automation_eligibility
    || binding.provider_idempotency_key_required
      !== privateInterface.host_policy.provider_idempotency_key_required
  ) throw actionError('App action host policy is invalid', 'APP_STALE');
  const expectedCanonicalBinding = canonicalizeAppGrantValue({
    binding_version: CONNECTED_APP_ACTION_BINDING_VERSION,
    action_key: action.key,
    capability_requirement_key: action.capability_requirement_key,
    connector_requirement_key: action.connector_requirement_key,
    interface_identity: binding.interface_identity,
    provider_kind: privateInterface.provider_kind,
    mcp_connection_id: binding.mcp_connection_id,
    provider_snapshot_digest: storedProvider.snapshot_digest,
    provider_adapter_contract_version: storedProvider.adapter_contract_version,
    operation_name: privateInterface.operation_name,
    operation_schema_digest: providerOperation.schema_digest,
    connector_authorization_version: connection.app_run_authorization_version,
    host_policy: privateInterface.host_policy,
    placement: action.placement,
    input_bindings: action.input_bindings,
  });
  if (
    digestAppGrantValue(binding.canonical_binding) !== binding.binding_digest
    || digestAppGrantValue(expectedCanonicalBinding) !== binding.binding_digest
  ) throw actionError('App action binding failed integrity validation', 'APP_STALE');

  const dependencies = await db.select().from(appDependencyLocks).where(and(
    eq(appDependencyLocks.org_id, orgId),
    eq(appDependencyLocks.app_installation_id, installation.id),
    eq(appDependencyLocks.app_version_id, version.id),
    eq(appDependencyLocks.grant_snapshot_id, grant.id),
  ));
  if (dependencies.length !== manifest.dependencies.length) {
    throw actionError('App dependency locks no longer match the active contract', 'APP_DEPENDENCY_UNHEALTHY');
  }
  const locks = new Map(dependencies.map((lock) => [lock.dependency_key, lock]));
  for (const requirement of manifest.dependencies) {
    const lock = locks.get(requirement.key);
    if (
      !lock
      || lock.required_app_id !== requirement.app_id
      || lock.required_version !== requirement.version
      || digestAppGrantValue(lock.canonical_lock) !== lock.lock_digest
    ) throw actionError('App dependency lock failed integrity validation', 'APP_DEPENDENCY_UNHEALTHY');
    const [[dependencyInstallation], [dependencyVersion]] = await Promise.all([
      db.select().from(appInstallations).where(and(
        eq(appInstallations.org_id, orgId),
        eq(appInstallations.id, lock.dependency_installation_id),
      )).limit(1),
      db.select().from(appVersions).where(and(
        eq(appVersions.org_id, orgId),
        eq(appVersions.id, lock.dependency_version_id),
        eq(appVersions.installation_id, lock.dependency_installation_id),
      )).limit(1),
    ]);
    if (
      !dependencyInstallation
      || dependencyInstallation.state !== 'active'
      || dependencyInstallation.active_version_id !== lock.dependency_version_id
      || dependencyInstallation.lifecycle_epoch !== lock.dependency_lifecycle_epoch
      || !dependencyVersion
      || dependencyVersion.state !== 'active'
      || dependencyVersion.version !== lock.required_version
      || dependencyVersion.manifest_digest !== lock.dependency_manifest_digest
      || dependencyVersion.package_digest !== lock.dependency_package_digest
    ) throw actionError('App dependency changed after review', 'APP_DEPENDENCY_UNHEALTHY');
  }
  const resources = new Map<string, Awaited<ReturnType<typeof loadRequirementModule>>>();
  for (const requirement of manifest.resource_requirements) {
    resources.set(requirement.key, await loadRequirementModule(
      orgId,
      installation.id,
      version.id,
      requirement,
      locks,
    ));
  }
  await assertGrantAuthoritySurface({
    org_id: orgId,
    installation,
    version,
    grant,
    manifest,
    dependencies,
  });
  return {
    installation,
    version,
    grant,
    binding,
    manifest,
    action,
    private_interface: privateInterface,
    dependencies: [...dependencies].sort((left, right) => left.dependency_key.localeCompare(right.dependency_key)),
    resources,
    provider_snapshot: providerSnapshot.data,
    provider_snapshot_id: storedProvider.id,
    provider_snapshot_digest: storedProvider.snapshot_digest,
    overrides,
  };
}

function assertPlacement(context: ActionContext, refValue: unknown): ModuleResourceRefV1 {
  const parsed = ModuleResourceRefV1Schema.safeParse(refValue);
  if (!parsed.success) {
    throw actionError('App action placement resource is invalid', 'APP_ACTION_INVALID', 400);
  }
  const placement = context.resources.get(context.action.placement.resource_requirement_key);
  if (
    !placement
    || parsed.data.provider.provider_instance_id !== placement.module_installation_id
    || parsed.data.resource_type !== placement.requirement.resource_type
  ) throw actionError('App action does not apply to this resource', 'APP_ACTION_UNAVAILABLE');
  return parsed.data;
}

function automationExecutionIdentity(context: AppAutomationVerificationContext): unknown {
  return {
    definition: {
      id: context.definition.id,
      org_id: context.definition.org_id,
      state: context.definition.state,
      epoch: context.definition.definition_epoch,
      digest: context.definition.definition_digest,
      authorization_digest: context.definition.authorization_digest,
      approved_by_user_id: context.definition.approved_by_user_id,
      approver_authorization_version: context.definition.approver_authorization_version,
      valid_from: context.definition.valid_from.toISOString(),
      valid_until: context.definition.valid_until.toISOString(),
    },
    fire: {
      id: context.fire.id,
      definition_id: context.fire.definition_id,
      definition_epoch: context.fire.definition_epoch,
      state: context.fire.state,
      claim_token: context.fire.claim_token,
      fire_identity: context.fire.fire_identity,
      app_run_id: context.fire.app_run_id,
      resolved_at_utc: context.fire.resolved_at_utc?.toISOString() ?? null,
    },
    approver: context.approver,
  };
}

export class AppActionService {
  constructor(
    private readonly capability: AppActionCapabilityPort = lazyCapability,
    private readonly liveAuthority: AppActionLiveAuthorityPort = new PostgresAppRunLiveAuthorization(),
    private readonly preparedInput: AppActionPreparedInputPort = lazyPreparedInput,
    private readonly fieldReader: AppActionFieldReaderPort = defaultFieldReader,
    private readonly runs: AppActionRunPort = lazyRuns,
    private readonly runReads: AppActionRunReadPort = lazyRunReads,
    private readonly receiptReads: AppRunReceiptReader = lazyReceiptReads,
    private readonly automationVerification: AppAutomationVerificationReadPort =
      postgresAppAutomationVerificationReadPort,
    private readonly appAutomationsEnabled: () => boolean = () => APP_AUTOMATIONS_ENABLED,
  ) {}

  async list(callerValue: AppActionCaller, input: Readonly<{ resource_ref: unknown }>): Promise<AppActionListResult> {
    const caller = callerContext(callerValue);
    const resource = await resourceAuthorizationService.resolve(
      { org_id: caller.actor.org_id, actor: caller.actor },
      input.resource_ref,
    );
    const candidates = await db.select({ id: appActionBindings.id }).from(appActionBindings)
      .where(eq(appActionBindings.org_id, caller.actor.org_id));
    const actions: AppActionListItem[] = [];
    for (const candidate of candidates) {
      try {
        const context = await loadActionContext(caller.actor.org_id, candidate.id);
        assertPlacement(context, resource.ref);
        await this.#captureAuthority(caller, context, APP_MCP_DISCOVERY_SCOPES);
        actions.push(actionItem(context));
      } catch {
        // Discovery is availability-filtered. An inaccessible or stale binding
        // is indistinguishable from absence and reveals no authority detail.
      }
    }
    return Object.freeze({
      resource: actionResourceProjection(resource),
      actions: actions.sort((left, right) => left.action_key.localeCompare(right.action_key)),
    });
  }

  async resolve(
    callerValue: AppActionCaller,
    input: Readonly<{ binding_id: string; resource_ref: unknown }>,
  ): Promise<AppActionResolveResult> {
    const resolved = await this.#resolve(
      callerContext(callerValue),
      input,
      APP_MCP_DISCOVERY_SCOPES,
    );
    return resolved.safe;
  }

  async prepare(callerValue: AppActionCaller, input: AppActionPrepareInput): Promise<AppActionPrepareResult> {
    const caller = callerContext(callerValue);
    const resolved = await this.#resolve(caller, input, APP_MCP_INVOKE_SCOPES);
    const selectionMap = new Map<string, ModuleResourceRefV1>();
    for (const selection of input.selections ?? []) {
      if (selectionMap.has(selection.input_key)) {
        throw actionError('App action selection keys must be unique', 'APP_ACTION_INVALID', 400);
      }
      const ref = ModuleResourceRefV1Schema.safeParse(selection.resource_ref);
      if (!ref.success) {
        throw actionError('App action selection is invalid', 'APP_ACTION_INVALID', 400);
      }
      selectionMap.set(selection.input_key, ref.data);
    }
    const userInputs = input.user_inputs ?? {};
    const expectedSelectionKeys = new Set<string>(resolved.context.action.input_bindings
      .filter((binding) => binding.source.kind === 'selected_relation_field')
      .map((binding) => binding.input_key));
    const expectedUserKeys = new Set<string>(resolved.context.action.input_bindings
      .filter((binding) => binding.source.kind === 'user_input')
      .map((binding) => binding.input_key));
    if (
      selectionMap.size !== expectedSelectionKeys.size
      || [...selectionMap.keys()].some((key) => !expectedSelectionKeys.has(key))
      || Object.keys(userInputs).length !== expectedUserKeys.size
      || Object.keys(userInputs).some((key) => !expectedUserKeys.has(key))
    ) throw actionError('App action inputs do not match the reviewed binding', 'APP_ACTION_INVALID', 400);

    const selected = new Map<string, Readonly<{
      ref: ModuleResourceRefV1;
      resource: ResourceSafeProjectionV1;
      relation_key: string;
      relation_revision: number;
    }>>();
    for (const descriptor of resolved.safe.inputs) {
      if (descriptor.kind !== 'selected_relation_field') continue;
      const ref = selectionMap.get(descriptor.input_key);
      const option = ref && descriptor.options.find(
        (candidate) => resourceRefIdentity(candidate.ref) === resourceRefIdentity(ref),
      );
      if (!ref || !option || option.ref.provider.kind !== 'module') {
        throw actionError('Selected resource is not in the current declared relation', 'APP_ACTION_UNAVAILABLE');
      }
      selected.set(descriptor.input_key, {
        ref,
        resource: option,
        relation_key: descriptor.relation_key,
        relation_revision: descriptor.relation_revision,
      });
    }

    // Sensitive materialization starts only after installation, dependency,
    // caller, connector, provider schema, resource, and relation checks pass.
    const currentFieldKeys = resolved.context.action.input_bindings.flatMap((binding) => (
      binding.source.kind === 'resource_field' ? [binding.source.field_key] : []
    ));
    const currentFields = await this.fieldReader.read(caller.actor, resolved.resourceRef, currentFieldKeys);
    if (resolved.safe.resource.revision !== String(currentFields.revision)) {
      throw actionError('App action resource changed during preparation', 'APP_STALE');
    }
    const selectedFields = new Map<string, Awaited<ReturnType<AppActionFieldReaderPort['read']>>>();
    for (const binding of resolved.context.action.input_bindings) {
      if (binding.source.kind !== 'selected_relation_field') continue;
      const item = selected.get(binding.input_key)!;
      const fields = await this.fieldReader.read(caller.actor, item.ref, [binding.source.target_field_key]);
      if (item.resource.revision !== String(fields.revision)) {
        throw actionError('Selected App action resource changed during preparation', 'APP_STALE');
      }
      selectedFields.set(binding.input_key, fields);
    }
    const providerInput: Record<string, unknown> = { idempotency_key: input.idempotency_key };
    for (const binding of resolved.context.action.input_bindings) {
      const source = binding.source;
      providerInput[binding.input_key] = source.kind === 'resource_field'
        ? currentFields.fields[source.field_key]
        : source.kind === 'selected_relation_field'
          ? selectedFields.get(binding.input_key)?.fields[source.target_field_key]
          : userInputs[binding.input_key];
    }
    const parsedProviderInput = parseConnectedAppProviderInput(
      resolved.context.private_interface,
      providerInput,
    );
    if (!parsedProviderInput.success) {
      throw actionError('Resolved App action input is invalid', 'APP_ACTION_INVALID', 400);
    }
    const resourceEvidence: AppActionResourceEvidence[] = [actionResourceEvidence(currentFields)];
    for (const value of selectedFields.values()) {
      resourceEvidence.push(actionResourceEvidence(value));
    }
    resourceEvidence.sort((left, right) => resourceRefIdentity(left.ref).localeCompare(resourceRefIdentity(right.ref)));
    const relationEvidence = [...selected.values()].map((item) => ({
      source_ref: resolved.resourceRef,
      relation_key: item.relation_key,
      revision: item.relation_revision,
      selected_ref: item.ref,
    })).sort((left, right) => left.relation_key.localeCompare(right.relation_key));
    const authorityVector: AppActionAuthorityVector = Object.freeze({
      schema_version: APP_ACTION_AUTHORITY_VERSION,
      caller_surface: caller.surface,
      installation: {
        id: resolved.context.installation.id,
        lifecycle_epoch: resolved.context.installation.lifecycle_epoch,
        grant_epoch: resolved.context.installation.grant_epoch,
      },
      app_version: {
        id: resolved.context.version.id,
        manifest_digest: resolved.context.version.manifest_digest,
        package_digest: resolved.context.version.package_digest,
      },
      grant: { id: resolved.context.grant.id, snapshot_digest: resolved.context.grant.snapshot_digest },
      binding: {
        id: resolved.context.binding.id,
        action_key: resolved.context.binding.action_key,
        binding_digest: resolved.context.binding.binding_digest,
        connector_authorization_version: resolved.context.binding.connector_authorization_version,
      },
      dependencies: resolved.context.dependencies.map((lock) => ({
        dependency_key: lock.dependency_key,
        installation_id: lock.dependency_installation_id,
        version_id: lock.dependency_version_id,
        lifecycle_epoch: lock.dependency_lifecycle_epoch,
        lock_digest: lock.lock_digest,
      })),
      provider: {
        connection_id: resolved.context.binding.mcp_connection_id,
        snapshot_id: resolved.context.provider_snapshot_id,
        snapshot_digest: resolved.context.provider_snapshot_digest,
        operation_name: resolved.context.binding.operation_name,
        operation_schema_digest: resolved.context.binding.operation_schema_digest,
      },
      run_authorization: resolved.runAuthorization,
      resources: resourceEvidence,
      relations: relationEvidence,
    });
    const replay = replayIdentity(resolved.context, caller, input.idempotency_key);
    const safePreview = AppRunSafePreviewSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      title: resolved.context.action.label,
      summary: 'One reviewed external action for one selected related resource.',
      resource_refs: [
        resolved.safe.resource,
        ...[...selected.values()].map((item) => item.resource),
      ].map((item) => ({
        resource_kind: `${item.ref.provider.kind}:${item.ref.provider.provider_instance_id}:${item.ref.resource_type}`,
        resource_id: item.ref.resource_id,
        label: item.label,
      })),
      fields: {
        app_id: resolved.context.installation.app_id,
        action_key: resolved.context.action.key,
        selected_resource_count: selected.size,
      },
    });
    const inputCandidate = await this.preparedInput.protect({
      org_id: caller.actor.org_id,
      replay_identity: replay,
      binding_identity: {
        app_installation_id: resolved.context.installation.id,
        app_version_id: resolved.context.version.id,
        grant_snapshot_id: resolved.context.grant.id,
        binding_id: resolved.context.binding.id,
        binding_digest: resolved.context.binding.binding_digest,
      },
      provider_input: parsedProviderInput.data,
      app_run: {
        initiating_actor: caller.authenticated_subject,
        execution_actor: caller.execution_actor,
        safe_preview: safePreview,
        authority_vector: authorityVector,
        authority_digest: digestAppGrantValue(authorityVector),
      },
    });
    return Object.freeze({
      action: actionItem(resolved.context),
      safe_preview: safePreview,
      input_candidate: inputCandidate,
      replay_identity: replay,
      authority_vector: authorityVector,
      authority_digest: digestAppGrantValue(authorityVector),
    });
  }

  async invoke(
    callerValue: AppActionCaller,
    input: AppActionPrepareInput & Readonly<{ input_candidate: AppRunPreparedInputCandidate }>,
  ): Promise<AppRunSafeView> {
    const caller = callerContext(callerValue);
    let original: AppRunPreparedInputPayload;
    try {
      original = await this.preparedInput.open(caller.actor.org_id, input.input_candidate);
    } catch {
      throw actionError('Prepared App action input is invalid or expired', 'APP_ACTION_INVALID', 400);
    }
    const app = original.app_run;
    if (
      !app
      || app.authority_vector.caller_surface !== caller.surface
      || !sameCanonical(app.initiating_actor, caller.authenticated_subject)
      || !sameCanonical(app.execution_actor, caller.execution_actor)
    ) throw actionError('Prepared App action belongs to a different caller surface', 'APP_ACCESS_DENIED', 403);

    const current = await this.prepare(callerValue, {
      binding_id: input.binding_id,
      resource_ref: input.resource_ref,
      selections: input.selections,
      user_inputs: input.user_inputs,
      idempotency_key: input.idempotency_key,
    });
    let currentPayload: AppRunPreparedInputPayload;
    try {
      currentPayload = await this.preparedInput.open(caller.actor.org_id, current.input_candidate);
    } catch {
      throw actionError('Revalidated App action input could not be authenticated', 'APP_STALE');
    }
    if (!sameCanonical(preparedActionFacts(original), preparedActionFacts(currentPayload))) {
      throw actionError('Prepared App action changed before invocation', 'APP_STALE');
    }

    // submitPreparedApp owns another authenticated open and the in-transaction
    // re-derivation of every pinned authority. This seam cannot call a provider.
    return this.runs.submitPreparedApp({
      org_id: caller.actor.org_id,
      initiating_actor: caller.authenticated_subject,
      execution_actor: caller.execution_actor,
    }, current.input_candidate);
  }

  /** Host-only, effect-free eligibility check immediately before claim. */
  async preflightApprovedAutomation(input: AppActionAutomationPreflightInput): Promise<void> {
    if (!this.appAutomationsEnabled()) {
      throw actionError('App automations are disabled', 'APP_ACCESS_DENIED', 403);
    }
    const current = await this.automationVerification.load(input);
    const checkedAt = new Date();
    if (
      !current
      || current.definition.org_id !== input.organization_id
      || current.definition.id !== input.definition_id
      || current.definition.state !== 'active'
      || current.definition.valid_from > checkedAt
      || current.definition.valid_until <= checkedAt
      || current.definition.policy_version !== APP_AUTOMATION_POLICY_V1.version
      || current.definition.policy_digest !== APP_AUTOMATION_POLICY_DIGEST
      || current.fire.state !== 'pending'
      || current.fire.app_run_id !== null
      || current.fire.definition_id !== current.definition.id
      || current.fire.definition_epoch !== current.definition.definition_epoch
      || current.fire.resolved_at_utc === null
      || current.approver.user_id !== current.definition.approved_by_user_id
      || current.approver.authorization_version
        !== current.definition.approver_authorization_version
    ) throw actionError('App automation fire authority is stale', 'APP_STALE');

    const actor: Extract<ModuleActor, { kind: 'human' }> = {
      kind: 'human',
      org_id: input.organization_id,
      actor_id: current.approver.user_id,
      role: current.approver.role,
      source: 'ui',
      scopes: [],
    };
    const placementRef = ModuleResourceRefV1Schema.parse(current.definition.placement_resource_ref);
    const selectedRef = ModuleResourceRefV1Schema.parse(current.definition.selected_resource_ref);
    const prepared = await this.prepare({ actor }, {
      binding_id: current.definition.action_binding_id,
      resource_ref: placementRef,
      selections: [{
        input_key: current.definition.selected_relation_input_key,
        resource_ref: selectedRef,
      }],
      idempotency_key: `app-automation:${current.fire.fire_identity}`,
    });
    const vector = prepared.authority_vector;
    if (
      vector.installation.id !== current.definition.app_installation_id
      || vector.installation.lifecycle_epoch !== current.definition.installation_lifecycle_epoch
      || vector.installation.grant_epoch !== current.definition.installation_grant_epoch
      || vector.app_version.id !== current.definition.app_version_id
      || vector.app_version.manifest_digest !== current.definition.app_manifest_digest
      || vector.app_version.package_digest !== current.definition.app_package_digest
      || vector.grant.id !== current.definition.grant_snapshot_id
      || vector.grant.snapshot_digest !== current.definition.grant_snapshot_digest
      || vector.binding.id !== current.definition.action_binding_id
      || vector.binding.action_key !== current.definition.action_key
      || vector.binding.binding_digest !== current.definition.binding_digest
      || vector.binding.connector_authorization_version
        !== current.definition.connector_authorization_version
      || vector.provider.connection_id !== current.definition.mcp_connection_id
      || vector.provider.snapshot_id !== current.definition.provider_snapshot_id
      || vector.provider.snapshot_digest !== current.definition.provider_snapshot_digest
      || vector.provider.operation_name !== current.definition.operation_name
      || vector.provider.operation_schema_digest !== current.definition.operation_schema_digest
    ) throw actionError('Pinned automation action changed before claim', 'APP_STALE');

    const placementIdentity = resourceRefIdentity(placementRef);
    const selectedIdentity = resourceRefIdentity(selectedRef);
    const placement = vector.resources.find(
      (resource) => resourceRefIdentity(resource.ref) === placementIdentity,
    );
    const selected = vector.resources.find(
      (resource) => resourceRefIdentity(resource.ref) === selectedIdentity,
    );
    const relation = vector.relations.find((candidate) => (
      resourceRefIdentity(candidate.source_ref) === placementIdentity
      && candidate.relation_key === current.definition.selected_relation_key
      && resourceRefIdentity(candidate.selected_ref) === selectedIdentity
    ));
    if (
      vector.resources.length !== 2
      || !placement
      || String(placement.revision) !== current.definition.placement_resource_revision
      || !selected
      || String(selected.revision) !== current.definition.selected_resource_revision
      || !relation
      || relation.revision !== current.definition.selected_relation_revision
    ) throw actionError('Pinned automation resources changed before claim', 'APP_STALE');
  }

  /** Host-only execution seam for an exact, already-claimed automation fire;
   * it enters the same prepare -> AppRun path used by interactive actions. */
  async invokeApprovedAutomation(input: AppActionAutomationInvokeInput): Promise<AppRunSafeView> {
    if (!this.appAutomationsEnabled()) {
      throw actionError('App automations are disabled', 'APP_ACCESS_DENIED', 403);
    }
    const initial = await this.automationVerification.load({
      organization_id: input.organization_id,
      definition_id: input.definition_id,
      fire_id: input.fire_id,
    });
    const checkedAt = new Date();
    if (
      !initial
      || initial.definition.org_id !== input.organization_id
      || initial.definition.id !== input.definition_id
      || initial.definition.state !== 'active'
      || initial.definition.valid_from > checkedAt
      || initial.definition.valid_until <= checkedAt
      || initial.fire.definition_id !== initial.definition.id
      || initial.fire.definition_epoch !== initial.definition.definition_epoch
      || initial.fire.claim_token !== input.claim_token
      || !(
        (initial.fire.state === 'claimed'
          && initial.fire.app_run_id === null
          && initial.fire.lease_expires_at !== null
          && initial.fire.lease_expires_at > checkedAt)
        || (initial.fire.state === 'run_created' && initial.fire.app_run_id !== null)
      )
      || initial.fire.resolved_at_utc === null
      || initial.approver.user_id !== initial.definition.approved_by_user_id
      || initial.approver.authorization_version !== initial.definition.approver_authorization_version
    ) throw actionError('App automation fire authority is stale', 'APP_STALE');

    const actor: Extract<ModuleActor, { kind: 'human' }> = {
      kind: 'human',
      org_id: input.organization_id,
      actor_id: initial.approver.user_id,
      role: initial.approver.role,
      source: 'ui',
      scopes: [],
    };
    const placementRef = ModuleResourceRefV1Schema.parse(initial.definition.placement_resource_ref);
    const selectedRef = ModuleResourceRefV1Schema.parse(initial.definition.selected_resource_ref);
    const idempotencyKey = `app-automation:${initial.fire.fire_identity}`;
    const prepared = await this.prepare({ actor }, {
      binding_id: initial.definition.action_binding_id,
      resource_ref: placementRef,
      selections: [{
        input_key: initial.definition.selected_relation_input_key,
        resource_ref: selectedRef,
      }],
      idempotency_key: idempotencyKey,
    });
    let payload: AppRunPreparedInputPayload;
    try {
      payload = await this.preparedInput.open(input.organization_id, prepared.input_candidate);
    } catch {
      throw actionError('Prepared automation input could not be authenticated', 'APP_STALE');
    }
    if (!payload.app_run) throw actionError('Prepared automation input is incomplete', 'APP_STALE');

    const placementIdentity = resourceRefIdentity(placementRef);
    const selectedIdentity = resourceRefIdentity(selectedRef);
    const resources = prepared.authority_vector.resources.map((resource) => {
      const identity = resourceRefIdentity(resource.ref);
      const expectedRevision = identity === placementIdentity
        ? initial.definition.placement_resource_revision
        : identity === selectedIdentity
          ? initial.definition.selected_resource_revision
          : null;
      const contentDigest = identity === placementIdentity
        ? initial.definition.placement_content_digest
        : identity === selectedIdentity
          ? initial.definition.selected_content_digest
          : null;
      if (expectedRevision === null || contentDigest === null
        || String(resource.revision) !== expectedRevision) {
        throw actionError('Pinned automation resources changed before execution', 'APP_STALE');
      }
      return { ...resource, content_digest: contentDigest };
    });
    const relation = prepared.authority_vector.relations.find((candidate) => (
      resourceRefIdentity(candidate.source_ref) === placementIdentity
      && candidate.relation_key === initial.definition.selected_relation_key
      && resourceRefIdentity(candidate.selected_ref) === selectedIdentity
    ));
    if (
      resources.length !== 2
      || new Set(resources.map((resource) => resourceRefIdentity(resource.ref))).size !== 2
      || !relation
      || relation.revision !== initial.definition.selected_relation_revision
    ) throw actionError('Pinned automation relation changed before execution', 'APP_STALE');

    const initiatingActor: AppRunActor = { actor_type: 'human', user_id: initial.approver.user_id };
    const executionActor: AppRunActor = {
      actor_type: 'automation',
      automation_id: initial.definition.id,
      user_id: initial.approver.user_id,
    };
    let runAuthorization: AppRunAuthorizationSnapshot;
    try {
      runAuthorization = await this.liveAuthority.captureForPreparation({
        org_id: input.organization_id,
        authenticated_subject: initiatingActor,
        execution_actor: executionActor,
        provider_instance_id: prepared.authority_vector.provider.connection_id,
        provider_snapshot_id: prepared.authority_vector.provider.snapshot_id,
        operation_name: prepared.authority_vector.provider.operation_name,
        policy: {
          risk_class: APP_AUTOMATION_POLICY_V1.base_host_policy.risk_class,
          review_requirement: APP_AUTOMATION_POLICY_V1.base_host_policy.review_requirement,
          review_scope: APP_AUTOMATION_POLICY_V1.review_scope,
          retry_class: APP_AUTOMATION_POLICY_V1.base_host_policy.retry_class,
        },
        required_token_scopes: [],
        token_authorities: [],
        allow_automation_execution: true,
      });
    } catch {
      throw actionError('Current automation authority does not permit this App action', 'APP_STALE');
    }

    const authorityVector: AppRunPreparedAuthorityVectorV2 = {
      ...prepared.authority_vector,
      schema_version: 'deft.app_action_authority.v2',
      caller_surface: 'automation',
      run_authorization: runAuthorization,
      dependencies: prepared.authority_vector.dependencies.map((dependency) => ({ ...dependency })),
      resources,
      relations: prepared.authority_vector.relations.map((candidate) => ({ ...candidate })),
      automation: {
        request: {
          key: initial.definition.automation_request_key,
          digest: initial.definition.automation_request_digest,
        },
        definition: {
          id: initial.definition.id,
          epoch: initial.definition.definition_epoch,
          digest: initial.definition.definition_digest,
          authorization_digest: initial.definition.authorization_digest,
          approved_by_user_id: initial.definition.approved_by_user_id,
          approved_at: initial.definition.approved_at.toISOString(),
          valid_from: initial.definition.valid_from.toISOString(),
          valid_until: initial.definition.valid_until.toISOString(),
        },
        fire: {
          id: initial.fire.id,
          identity: initial.fire.fire_identity,
          logical_local_date: initial.fire.logical_local_date,
          local_time: initial.fire.local_time,
          timezone: initial.fire.timezone,
          resolved_at_utc: initial.fire.resolved_at_utc.toISOString(),
        },
        policy: {
          key: APP_AUTOMATION_POLICY_V1.key,
          version: APP_AUTOMATION_POLICY_V1.version,
          digest: APP_AUTOMATION_POLICY_DIGEST,
        },
        budgets: {
          max_actions_per_fire: 1,
          max_org_runs_per_utc_day: initial.definition.max_org_runs_per_utc_day,
          max_pending_org_fires: initial.definition.max_pending_org_fires,
        },
      },
    };
    const candidate = await this.preparedInput.protect({
      org_id: input.organization_id,
      replay_identity: prepared.replay_identity,
      binding_identity: payload.binding_identity,
      provider_input: payload.provider_input,
      app_run: {
        initiating_actor: initiatingActor,
        execution_actor: executionActor,
        safe_preview: prepared.safe_preview,
        authority_vector: authorityVector,
        authority_digest: digestPreparedAppAuthority(authorityVector),
      },
    });

    const current = await this.automationVerification.load({
      organization_id: input.organization_id,
      definition_id: input.definition_id,
      fire_id: input.fire_id,
    });
    if (!current || !sameCanonical(
      automationExecutionIdentity(initial),
      automationExecutionIdentity(current),
    ) || current.fire.claim_token !== input.claim_token) {
      throw actionError('App automation fire changed before Run creation', 'APP_STALE');
    }
    return this.runs.submitPreparedApp({
      org_id: input.organization_id,
      initiating_actor: initiatingActor,
      execution_actor: executionActor,
      automation_claim_token: input.claim_token,
    }, candidate);
  }

  async inspectRun(callerValue: AppActionCaller, runId: string): Promise<AppRunSafeView> {
    const caller = callerContext(callerValue);
    const requiredAuthorityRef = await this.#assertRunReadAuthority(caller);
    return this.runReads.inspect(
      caller.actor.org_id,
      runId,
      caller.authenticated_subject,
      requiredAuthorityRef,
    );
  }

  async result(callerValue: AppActionCaller, runId: string): Promise<Readonly<{
    run: AppRunSafeView;
    value: unknown;
  }>> {
    const caller = callerContext(callerValue);
    const requiredAuthorityRef = await this.#assertRunReadAuthority(caller);
    return this.runReads.result(
      caller.actor.org_id,
      runId,
      caller.authenticated_subject,
      requiredAuthorityRef,
    );
  }

  async inspectReceipts(callerValue: AppActionCaller, runId: string): Promise<AppActionReceiptBundle> {
    const caller = callerContext(callerValue);
    const requiredAuthorityRef = await this.#assertRunReadAuthority(caller);
    const run = await this.runReads.inspect(
      caller.actor.org_id,
      runId,
      caller.authenticated_subject,
      requiredAuthorityRef,
    );
    const receipts = await this.receiptReads.readVerified(caller.actor.org_id, runId);
    return Object.freeze({
      run: Object.freeze({
        id: run.id,
        state: run.state,
        operation_name: run.operation_name,
        safe_preview: run.safe_preview,
        safe_outcome: run.safe_outcome,
        risk_class: run.risk_class,
        review_requirement: run.review_requirement,
        review_scope: run.review_scope,
        retry_class: run.retry_class,
        retention_class: run.retention_class,
        result_expires_at: run.result_expires_at.toISOString(),
        result_purged_at: run.result_purged_at?.toISOString() ?? null,
      }),
      receipts: Object.freeze([...receipts]),
    });
  }

  async #assertRunReadAuthority(caller: CallerContext): Promise<AppRunReadAuthorityRef | null> {
    if (!caller.surface.endsWith(':mcp')) return null;
    try {
      return await this.liveAuthority.assertTokenScopes({
        org_id: caller.actor.org_id,
        authenticated_subject: caller.authenticated_subject,
        required_token_scopes: APP_MCP_RUN_READ_SCOPES,
        token_authorities: caller.token_authorities,
      });
    } catch {
      throw actionError('Current caller authority does not permit App Run access', 'APP_ACCESS_DENIED', 403);
    }
  }

  async #captureAuthority(
    caller: CallerContext,
    context: ActionContext,
    requiredTokenScopes: readonly string[],
  ) {
    try {
      return await this.liveAuthority.captureForPreparation({
        org_id: caller.actor.org_id,
        authenticated_subject: caller.authenticated_subject,
        execution_actor: caller.execution_actor,
        provider_instance_id: context.binding.mcp_connection_id,
        provider_snapshot_id: context.binding.provider_snapshot_id,
        operation_name: context.binding.operation_name,
        policy: {
          risk_class: context.binding.risk_class,
          review_requirement: context.binding.review_requirement,
          review_scope: context.binding.review_scope,
          retry_class: context.binding.retry_class,
        },
        required_token_scopes: caller.actor.source === 'mcp' ? requiredTokenScopes : [],
        token_authorities: caller.token_authorities,
      });
    } catch {
      throw actionError('Current caller authority does not permit this App action', 'APP_ACCESS_DENIED', 403);
    }
  }

  async #assertLiveProvider(context: ActionContext): Promise<void> {
    let live: CapabilityDiscoveryResult;
    try {
      live = await this.capability.discover({
        provider_kind: 'mcp',
        mode: 'refresh',
        org_id: context.installation.org_id,
        provider_instance_id: context.binding.mcp_connection_id,
        overrides: [...context.overrides],
      });
    } catch {
      throw actionError('App action provider discovery failed', 'APP_PROVIDER_UNAVAILABLE', 503);
    }
    const operation = live.snapshot?.operations.find(
      (candidate) => candidate.identity.operation_name === context.binding.operation_name,
    );
    const tool = live.tools.find((candidate) => candidate.originalName === context.binding.operation_name);
    if (
      !live.snapshot
      || live.snapshot.provider.org_id !== context.installation.org_id
      || live.snapshot.provider.provider_kind !== 'mcp'
      || live.snapshot.provider.provider_instance_id !== context.binding.mcp_connection_id
      || live.snapshot.snapshot_digest !== context.provider_snapshot_digest
      || !operation
      || operation.schema_digest !== context.binding.operation_schema_digest
      || !connectedAppOperationMatches(context.private_interface, operation)
      || !tool
      || !connectedAppToolMatches(context.private_interface, tool)
    ) throw actionError('App action provider schema changed after review', 'APP_PROVIDER_UNAVAILABLE', 503);
  }

  async #resolve(caller: CallerContext, input: Readonly<{
    binding_id: string;
    resource_ref: unknown;
  }>, requiredTokenScopes: readonly string[]): Promise<Readonly<{
    context: ActionContext;
    resourceRef: ModuleResourceRefV1;
    runAuthorization: AppRunAuthorizationSnapshot;
    safe: AppActionResolveResult;
  }>> {
    if (!input.binding_id || input.binding_id !== input.binding_id.trim()) {
      throw actionError('App action binding identity is invalid', 'APP_ACTION_INVALID', 400);
    }
    const context = await loadActionContext(caller.actor.org_id, input.binding_id);
    const resourceRef = assertPlacement(context, input.resource_ref);
    const runAuthorization = await this.#captureAuthority(caller, context, requiredTokenScopes);
    await this.#assertLiveProvider(context);
    const resource = actionResourceProjection(await resourceAuthorizationService.resolve(
      { org_id: caller.actor.org_id, actor: caller.actor },
      resourceRef,
    ));
    const inputs: AppActionResolvedInput[] = [];
    for (const binding of context.action.input_bindings) {
      const source = binding.source;
      if (source.kind === 'resource_field') {
        inputs.push({ input_key: binding.input_key, kind: 'resource_field' });
        continue;
      }
      if (source.kind === 'user_input') {
        inputs.push({
          input_key: binding.input_key,
          kind: 'user_input',
          input_type: source.input_type,
          label: source.label,
          required: true,
        });
        continue;
      }
      const target = context.resources.get(source.target_resource_requirement_key);
      if (!target) throw actionError('App action relation target is unavailable', 'APP_DEPENDENCY_UNHEALTHY');
      const relation = await listResourceRelation(caller.actor, {
        schema_version: RESOURCE_CONTRACT_VERSIONS.relation,
        source: resourceRef,
        relation_key: source.relation_field_key,
      });
      const options = relation.items.flatMap((item) => (
        item.state === 'available'
        && item.ref.provider.kind === 'module'
        && item.ref.provider.provider_instance_id === target.module_installation_id
        && item.ref.resource_type === target.requirement.resource_type
          ? [actionResourceProjection(item.resource)]
          : []
      ));
      inputs.push({
        input_key: binding.input_key,
        kind: 'selected_relation_field',
        relation_key: source.relation_field_key,
        relation_revision: relation.revision,
        options,
      });
    }
    return Object.freeze({
      context,
      resourceRef,
      runAuthorization,
      safe: Object.freeze({ action: actionItem(context), resource, inputs }),
    });
  }
}

export const appActionService = new AppActionService();
